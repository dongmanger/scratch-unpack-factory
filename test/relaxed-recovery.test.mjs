import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProject, comparableFactory} from '../src/recompile-oracle.mjs';
import {recoverWithOracle} from '../src/relaxed-recovery.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';

// These tests close the loop with the REAL 02 compiler. The "shipped" factories are produced by compiling a
// real project, never hand-written, so they have exactly the shape a packaged artifact has.

const block = (opcode, parent, next, fields = {}, inputs = {}, topLevel = false) =>
  ({opcode, parent, next, fields, inputs, topLevel, shadow: false, ...(topLevel ? {x: 0, y: 0} : {})});
const text = (value) => [1, [10, String(value)]];
const num = (value) => [1, [4, String(value)]];
const reporter = (id) => [3, id, [10, '']];

/** Source project: flag -> set `out` to (item (`idx`) of `list`) -> change `idx` by 1. */
function sourceProject() {
  const stage = {isStage: true, name: 'Stage', variables: {vOut: ['out', 0], vIdx: ['idx', 1]}, lists: {lList: ['list', ['a', 'b', 'c']]},
    broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0, tempo: 60,
    videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null};
  stage.blocks = {
    hat: block('event_whenflagclicked', null, 'set', {}, {}, true),
    set: block('data_setvariableto', 'hat', 'chg', {VARIABLE: ['out', 'vOut']}, {VALUE: reporter('item')}),
    item: {...block('data_itemoflist', 'set', null, {LIST: ['list', 'lList']}, {INDEX: reporter('idx')}), shadow: false},
    idx: {...block('data_variable', 'item', null, {VARIABLE: ['idx', 'vIdx']}), shadow: false},
    chg: block('data_changevariableby', 'set', null, {VARIABLE: ['idx', 'vIdx']}, {VALUE: num(1)})
  };
  stage.blocks.set.next = 'chg';
  return {targets: [stage], monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}};
}

/** Make the compiled bundle an artifact would carry: blocks stripped from targets, factories from the compiler. */
async function shippedBundle(project) {
  const {bundle} = await compileProject(project);
  return bundle;
}
const strip = (bundle) => {
  const project = structuredClone({targets: bundle.targets, monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}});
  for (const target of project.targets) { target.blocks = {}; target.comments = {}; }
  return project;
};

test('strict decoding refuses what relaxed decoding accepts, and reports the assumption', async () => {
  const bundle = await shippedBundle(sourceProject());
  const entry = Object.values(bundle.compiledTargets[0].scripts)[0];
  const stripped = strip(bundle);
  assert.throws(() => decodeCompiledFactory(entry.factorySource, stripped, 0), /动态列表索引|列表折叠|原生数组索引/,
    'strict mode must keep refusing an unproven dynamic list index');
  const relaxed = decodeCompiledFactory(entry.factorySource, stripped, 0, {relaxed: true});
  assert.ok(relaxed.assumptions.length > 0, 'relaxed mode must say what it assumed');
  assert.ok(relaxed.operations.length >= 2);
});

test('strict recovery output is unchanged by the relaxed switch being absent', async () => {
  const bundle = await shippedBundle(sourceProject());
  const a = strip(bundle), b = strip(bundle);
  const first = recoverCompiledCode(a, bundle, {beautify: false});
  const second = recoverCompiledCode(b, bundle, {beautify: false, relaxed: false});
  assert.deepEqual(first.unresolved.map(u => u.reason), second.unresolved.map(u => u.reason));
  assert.deepEqual(a, b);
  assert.ok(first.scripts.every(s => !s.assumptions), 'strict recovery never records assumptions');
});

test('the oracle keeps a relaxed recovery only because the real compiler reproduces the shipped factory', async () => {
  const bundle = await shippedBundle(sourceProject());
  const { project, result, oracle } = await recoverWithOracle(strip(bundle), bundle);
  const script = result.scripts.find(s => s.status === 'reconstructed-unverified');
  assert.ok(script, 'the dynamic-index script must be recovered under the oracle');
  assert.equal(script.recompilation.status, 'match');
  assert.ok(script.assumptions.length > 0, 'it needed a relaxed assumption, so it was put to the vote');
  assert.equal(oracle.unverifiedAfterFinal, 0);
  // The result really does compile back to the shipped program.
  const again = await compileProject(project);
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);
  assert.equal(comparableFactory(again.bundle.compiledTargets[0].scripts[id].factorySource),
    comparableFactory(bundle.compiledTargets[0].scripts[id].factorySource));
  assert.equal(script.body.confidence.score, 0.95);
});

test('the oracle REJECTS a relaxed recovery when the compiler does not reproduce the shipped factory', async () => {
  const bundle = await shippedBundle(sourceProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);

  // A compiler that returns a different program for the recovered blocks: it behaves like the real one
  // except that every `+ 1` it emits is `+ 9`. This is exactly the situation a wrong relaxed decoding
  // produces, and the oracle must not keep such a script.
  const brokenCompiler = async (project, archive) => {
    const result = await compileProject(project, archive);
    for (const entry of Object.values(result.bundle.compiledTargets)) {
      for (const script of Object.values(entry.scripts)) script.factorySource = script.factorySource.replace('+ 1)', '+ 9)');
    }
    return result;
  };
  const judged = await recoverWithOracle(strip(bundle), bundle, {compile: brokenCompiler});
  const record = judged.result.scripts.find(s => s.scriptId === id);
  assert.ok(record.recompilation === undefined || record.recompilation.status !== 'match');
  assert.notEqual(record.status, 'reconstructed-unverified', 'a recovery the compiler cannot reproduce must not be kept');
  const kept = Object.values(judged.project.targets[0].blocks).filter(b => b.opcode === 'data_itemoflist' || b.opcode === 'data_changevariableby');
  assert.equal(kept.length, 0, 'no block of the rejected script may remain in the returned project');
  assert.equal(judged.oracle.verified, 0);

  // Control: the same input with the genuine compiler is accepted, so the rejection above came from the mismatch.
  const genuine = await recoverWithOracle(strip(bundle), bundle);
  assert.equal(genuine.result.scripts.find(s => s.scriptId === id).recompilation.status, 'match');
});

test('an item that passed earlier rounds but fails the final recompilation is dropped, not returned unverified', async () => {
  const bundle = await shippedBundle(sourceProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);

  // Count how many compilations a normal run needs, then break only the LAST ones. This models two
  // accepted items interacting so that the final recompilation disagrees with the convergence rounds.
  let normalCalls = 0;
  await recoverWithOracle(strip(bundle), bundle, {compile: async (project, archive) => { normalCalls++; return compileProject(project, archive); }});
  assert.ok(normalCalls >= 3, 'a normal run compiles at least: rounds, unwrap trial, final pass');

  let call = 0;
  const lateBreak = async (project, archive) => {
    const result = await compileProject(project, archive);
    if (++call >= normalCalls) {
      for (const entry of Object.values(result.bundle.compiledTargets)) {
        for (const script of Object.values(entry.scripts)) script.factorySource = script.factorySource.replace('+ 1)', '+ 9)');
      }
    }
    return result;
  };
  const judged = await recoverWithOracle(strip(bundle), bundle, {compile: lateBreak});
  const record = judged.result.scripts.find(s => s.scriptId === id);
  assert.notEqual(record.status, 'reconstructed-unverified', 'a relaxed item the final pass could not confirm must not be returned');
  assert.equal(judged.oracle.unverifiedAfterFinal, 0, 'nothing resting on an assumption may remain unverified');
  assert.ok(judged.oracle.prunedInFinalPass >= 1, 'the final pass must report that it pruned');
  assert.equal(judged.oracle.converged, false, 'pruning means the rounds had not truly converged');
  assert.equal(Object.values(judged.project.targets[0].blocks).filter(b => b.opcode === 'data_itemoflist').length, 0);
});

test('a shipped factory that differs by one constant is a different program to the canonical form', async () => {
  const bundle = await shippedBundle(sourceProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);
  const source = bundle.compiledTargets[0].scripts[id].factorySource;
  assert.notEqual(comparableFactory(source), comparableFactory(source.replace('+ 1)', '+ 2)')));
  assert.equal(comparableFactory(source), comparableFactory(source.replace('factory0', 'renamedFactory').replace('gen0', 'renamedGen')),
    'renaming the factory and its inner function is not a behavioural change');
});
/** Source project: flag -> delete all of `list` -> set `out` to "done". Strict decoding handles all of it. */
function deleteAllProject() {
  const project = sourceProject();
  project.targets[0].blocks = {
    hat: block('event_whenflagclicked', null, 'del', {}, {}, true),
    del: block('data_deletealloflist', 'hat', 'set', {LIST: ['list', 'lList']}),
    set: block('data_setvariableto', 'del', null, {VARIABLE: ['out', 'vOut']}, {VALUE: text('done')})
  };
  return project;
}

test('a preferred spelling the compiler does not reproduce falls back to the strict one; the item is not lost', async () => {
  const bundle = await shippedBundle(deleteAllProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);
  assert.match(bundle.compiledTargets[0].scripts[id].factorySource, /\.value = \[\]/);

  // Strict recovery decodes this script, so it is a strict item.
  const strictOnly = recoverCompiledCode(strip(bundle), bundle, {beautify: false});
  assert.equal(strictOnly.scripts.find(s => s.scriptId === id).status, 'reconstructed-unverified');

  // The preferred spelling is `delete (all) of list`. Make the compiler reject exactly that spelling, as if
  // it compiled to something else, while compiling every other graph truthfully.
  const rejectsPreferred = async (project, archive) => {
    const result = await compileProject(project, archive);
    const usesPreferred = Object.values(project.targets[0].blocks).some(b => b.opcode === 'data_deleteoflist');
    if (usesPreferred) for (const entry of Object.values(result.bundle.compiledTargets)) {
      for (const script of Object.values(entry.scripts)) script.factorySource = script.factorySource.replace('.value = []', '.value = [0]');
    }
    return result;
  };
  const judged = await recoverWithOracle(strip(bundle), bundle, {compile: rejectsPreferred});
  const record = judged.result.scripts.find(s => s.scriptId === id);
  assert.equal(record.status, 'reconstructed-unverified', 'a strict item must survive its preferred spelling being refused');
  assert.equal(record.recompilation.status, 'match', 'and it is confirmed in its strict spelling');
  const opcodes = Object.values(judged.project.targets[0].blocks).map(b => b.opcode);
  assert.ok(opcodes.includes('data_deletealloflist'), 'the strict spelling is what ends up in the project');
  assert.ok(!opcodes.includes('data_deleteoflist'), 'the refused preferred spelling must not remain');
  assert.ok(judged.oracle.strictOnly >= 1);
});

test('when the compiler accepts the preferred spelling it is the one used (the form authors write)', async () => {
  const bundle = await shippedBundle(deleteAllProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);
  const judged = await recoverWithOracle(strip(bundle), bundle);
  assert.equal(judged.result.scripts.find(s => s.scriptId === id).recompilation.status, 'match');
  const ops = Object.values(judged.project.targets[0].blocks).filter(b => b.opcode === 'data_deleteoflist');
  assert.equal(ops.length, 1, 'delete (all) of list is the spelling used 77:5 over the dedicated block in real projects');
  assert.deepEqual(ops[0].inputs.INDEX[1], [10, 'all']);
});

test('an item recovered without any assumption is never put to the vote or removed', async () => {
  const project = sourceProject();
  // A script that strict decoding handles: flag -> set var to a literal.
  project.targets[0].blocks = {
    hat: block('event_whenflagclicked', null, 'set', {}, {}, true),
    set: block('data_setvariableto', 'hat', null, {VARIABLE: ['out', 'vOut']}, {VALUE: text('hello')})
  };
  const bundle = await shippedBundle(project);
  const { result, oracle } = await recoverWithOracle(strip(bundle), bundle);
  const script = result.scripts.find(s => s.status === 'reconstructed-unverified');
  assert.ok(script);
  assert.equal(script.assumptions?.length ?? 0, 0);
  assert.ok(oracle.strictOnly >= 1);
  assert.equal(script.recompilation.status, 'match', 'strict items are still checked and reported, just never removed');
});

/** Source project: flag -> delete all of `list` -> change `idx` by 1. Two different preferred spellings in one script. */
function twoPreferencesProject() {
  const project = sourceProject();
  project.targets[0].blocks = {
    hat: block('event_whenflagclicked', null, 'del', {}, {}, true),
    del: block('data_deletealloflist', 'hat', 'chg', {LIST: ['list', 'lList']}),
    chg: block('data_changevariableby', 'del', null, {VARIABLE: ['idx', 'vIdx']}, {VALUE: num(1)})
  };
  // The author drew `delete all of list` here, but the compiler cannot tell it from `delete (all) of list`.
  return project;
}

test('an item gives up only the preferred spelling the compiler refuses, and keeps the others', async () => {
  const bundle = await shippedBundle(twoPreferencesProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);

  // Both preferences are used: `delete (all)` and `change by`.
  const baseline = await recoverWithOracle(strip(bundle), bundle);
  const baselineOps = Object.values(baseline.project.targets[0].blocks).map(b => b.opcode);
  assert.ok(baselineOps.includes('data_deleteoflist') && baselineOps.includes('data_changevariableby'));
  assert.deepEqual(baseline.oracle.preferencesGivenUp, {});

  // A compiler that does not reproduce `change by` (any script with one compiles differently) but is fine with the rest.
  const rejectsChange = async (project, archive) => {
    const result = await compileProject(project, archive);
    const hasChange = Object.values(project.targets[0].blocks).some(b => b.opcode === 'data_changevariableby');
    if (hasChange) for (const entry of Object.values(result.bundle.compiledTargets)) {
      for (const script of Object.values(entry.scripts)) script.factorySource = script.factorySource.replace('+ 1)', '+ 9)');
    }
    return result;
  };
  const judged = await recoverWithOracle(strip(bundle), bundle, {compile: rejectsChange});
  const ops = Object.values(judged.project.targets[0].blocks).map(b => b.opcode);
  assert.ok(!ops.includes('data_changevariableby'), 'the refused spelling is gone');
  assert.ok(ops.includes('data_setvariableto'), 'and the plain spelling took its place');
  assert.ok(ops.includes('data_deleteoflist'), 'the other preference is kept: one refusal does not cost the item all of them');
  assert.ok(!ops.includes('data_deletealloflist'));
  assert.deepEqual(judged.oracle.preferencesGivenUp, {'change-by': 1});
  const record = judged.result.scripts.find(s => s.scriptId === id);
  assert.equal(record.recompilation.status, 'match');
  assert.deepEqual(record.recompilation.preferencesGivenUp, ['change-by']);
  // Everything else the item used is still on: the delete (all) spelling, and the `+ 0` cast it no longer writes out.
  assert.ok(record.recompilation.preferencesKept.includes('delete-all'));
  assert.ok(!record.recompilation.preferencesKept.includes('change-by'));
  assert.ok(record.recompilation.preferencesKept.length >= 1);
});

test('an item with several preferences gives them up one at a time, in a fixed order, until the compiler agrees', async () => {
  const bundle = await shippedBundle(twoPreferencesProject());
  const [id] = Object.keys(bundle.compiledTargets[0].scripts);
  // Refuses `delete (all)`: the first kind in the give-up order is change-by, which is not the culprit, so the item
  // loses it in vain before delete-all goes too. The result still matches and still has no assumption left unverified.
  const rejectsDeleteAll = async (project, archive) => {
    const result = await compileProject(project, archive);
    if (Object.values(project.targets[0].blocks).some(b => b.opcode === 'data_deleteoflist')) {
      for (const entry of Object.values(result.bundle.compiledTargets)) {
        for (const script of Object.values(entry.scripts)) script.factorySource = script.factorySource.replace('.value = []', '.value = [0]');
      }
    }
    return result;
  };
  const judged = await recoverWithOracle(strip(bundle), bundle, {compile: rejectsDeleteAll});
  const ops = Object.values(judged.project.targets[0].blocks).map(b => b.opcode);
  assert.ok(ops.includes('data_deletealloflist'), 'the refused spelling is replaced by the strict one');
  assert.equal(judged.result.scripts.find(s => s.scriptId === id).recompilation.status, 'match');
  assert.ok(judged.oracle.preferencesGivenUp['delete-all'] === 1);
  assert.ok(judged.oracle.rounds.length >= 3, 'each give-up costs a round: ' + JSON.stringify(judged.oracle.rounds.map(r => r.demotedToFaithful)));
});

test('with preferences switched off the oracle returns the plain spelling for every item', async () => {
  const bundle = await shippedBundle(twoPreferencesProject());
  const judged = await recoverWithOracle(strip(bundle), bundle, {unwrap: false});
  const ops = Object.values(judged.project.targets[0].blocks).map(b => b.opcode);
  assert.ok(ops.includes('data_deletealloflist') && ops.includes('data_setvariableto'));
  assert.ok(!ops.includes('data_deleteoflist') && !ops.includes('data_changevariableby'));
});
