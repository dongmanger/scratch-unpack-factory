import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {corpusScenarios, supportedSubcases} from './recovery-opcode-corpus.mjs';
import {actualVMClass, compileReal02, runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';

const STEPS = 100;
const trustedBundles = new WeakSet();
const prepared = new Map();
const opcodeSet = project => new Set(project.targets.flatMap(target => Object.values(target.blocks).map(block => block.opcode)));
const definitions = project => project.targets.map(({name, isStage, variables, lists, broadcasts}) => ({name, isStage, variables, lists, broadcasts}));
const allScripts = bundle => Object.values(bundle.compiledTargets).flatMap(target => Object.entries(target.scripts || {}));
const sources = bundle => allScripts(bundle).map(([id, script]) => `${id}\n${script.factorySource}`).join('\n');
const verifiedScenarioOpcodes = new Set();
const structuralOpcodes = new Set();

async function validate(project, assets) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, data] of Object.entries(assets)) zip.file(name, data);
  const result = await validateSb3(await zip.generateAsync({type: 'uint8array'}));
  assert.equal(result.ok, true, result.errors.join('\n'));
}

function prepare(scenario) {
  if (!prepared.has(scenario.id)) prepared.set(scenario.id, (async () => {
    const fixture = await scenario.build();
    await validate(fixture.project, fixture.assets);
    const original = await compileReal02(fixture.project, fixture.assets);
    trustedBundles.add(original.bundle);
    assert.equal(original.provenance.kind, 'actual-02engine-vm-compiler');
    assert.equal(original.provenance.api, 'VirtualMachine.compileProjectFromJSON');
    assert.deepEqual(original.provenance.adapters, {renderer: false, audio: false, storage: false});
    assert.match(original.provenance.inputSb3Sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(original.provenance.sourceSha256).length, 6);
    assert.ok(allScripts(original.bundle).length > 0, 'actual compiler emitted scripts');
    const decoded = structuredClone(original.bundle);
    for (const target of Object.values(decoded.compiledTargets)) {
      for (const script of [...Object.values(target.scripts || {}), ...Object.values(target.procedures || {})]) {
        script.factorySource = deobfuscate(script.factorySource).code;
      }
    }
    const project = {...structuredClone(fixture.project), targets: structuredClone(decoded.targets)};
    assert.ok(project.targets.every(target => Object.keys(target.blocks).length === 0), 'recovery starts with stripped graphs');
    const recovery = recoverCompiledCode(project, decoded);
    return {fixture, original, decoded, project, recovery};
  })());
  return prepared.get(scenario.id);
}

function requireFullRecovery(context) {
  const {recovery, decoded} = context;
  const sourceById = new Map(allScripts(decoded));
  const evidence = recovery.unresolved.map(record => ({...record,
    actualFactorySource: sourceById.get(record.scriptId)?.factorySource}));
  assert.equal(recovery.unresolved.length, 0, JSON.stringify(evidence, null, 2));
  assert.equal(recovery.scripts.length, allScripts(decoded).length);
  assert.ok(recovery.scripts.every(script => script.status === 'reconstructed-unverified'));
}

function assertExpected(state, fixture) {
  assert.equal(state.remainingThreads, 0, `trusted script did not finish within ${STEPS} VM steps`);
  assert.ok(state.compiled.length > 0, 'green flag started compiled scripts');
  assert.ok(state.compiled.every(Boolean), 'no interpreter fallback');
  for (const {targetIndex, variables, state: targetState} of fixture.expected) {
    const target = state.targets.find(item => item.name === fixture.project.targets[targetIndex].name);
    assert.ok(target);
    for (const [id, value] of Object.entries(variables)) assert.deepEqual(target.variables[id]?.value, value, `${target.name} / ${id}`);
    for (const [key, value] of Object.entries(targetState)) assert.deepEqual(target[key], value, `${target.name} / ${key}`);
  }
  // Check IDs, names, and kinds on both executions, including duplicate names
  // in distinct global/local scopes. List and variable values are compared above.
  for (const source of fixture.project.targets) {
    const target = state.targets.find(item => item.name === source.name);
    const entries = [...Object.entries(source.variables).map(([id, value]) => [id, value, '']),
      ...Object.entries(source.lists).map(([id, value]) => [id, value, 'list'])];
    assert.deepEqual(Object.keys(target.variables).sort(), entries.map(([id]) => id).sort());
    for (const [id, [name], type] of entries) {
      assert.equal(target.variables[id].name, name, `${target.name} / ${id} name`);
      assert.equal(target.variables[id].type, type, `${target.name} / ${id} kind`);
    }
  }
}

async function withCalendar(fixture, action) {
  if (!fixture.frozenCalendar) return action();
  const RealDate = globalThis.Date;
  // Freeze calendar construction only: Date.now/performance and VM scheduling
  // continue to advance. Restore even when an assertion or VM execution fails.
  const instant = new RealDate(2026, 9, 11, 12, 34, 56).getTime();
  globalThis.Date = class CorpusDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
  };
  try { return await action(); }
  finally { globalThis.Date = RealDate; }
}

async function runTrusted(project, assets, bundle) {
  assert.ok(trustedBundles.has(bundle), 'only actual compiler outputs from this corpus may execute');
  return runReal02(project, assets, {bundle, steps: STEPS});
}

// runReal02 intentionally exposes a small snapshot. A second real VM run reads
// appearance/sound state without replacing primitives, renderer, or audio.
async function extendedState(project, assets, bundle) {
  assert.ok(trustedBundles.has(bundle));
  const VM = actualVMClass();
  const machine = new VM();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(project));
  for (const [name, data] of Object.entries(assets)) archive.file(name, data);
  try {
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    await machine.loadCompiledProject(structuredClone(bundle), archive);
    assert.equal(Boolean(machine.runtime.renderer), false, 'actual VM has no attached renderer');
    assert.equal(machine.runtime.runtimeOptions.miscLimits, true, 'sound commands exercise Promise.resolve paths');
    machine.greenFlag();
    const compiled = machine.runtime.threads.filter(thread => !thread.updateMonitor).map(thread => thread.isCompiled);
    for (let step = 0; step < STEPS && machine.runtime.threads.length; step++) {
      machine.runtime._step();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(compiled.length > 0 && compiled.every(Boolean));
    assert.equal(machine.runtime.threads.filter(thread => !thread.updateMonitor).length, 0);
    return Object.fromEntries(machine.runtime.targets.filter(target => target.isOriginal).map(target => [target.getName(), {
      effects: structuredClone(target.effects), currentCostume: target.currentCostume,
      rotationStyle: target.rotationStyle, volume: target.volume,
      soundEffects: structuredClone(target.getCustomState('Scratch.sound')?.effects || null)
    }]));
  } finally { machine.quit(); }
}

for (const scenario of corpusScenarios) {
  test(`actual opcode corpus / ${scenario.id} / compiler → deobfuscate → recovery evidence`, {timeout: 30_000}, async t => {
    const context = await prepare(scenario);
    const {fixture, original, project, recovery} = context;
    const actualSource = sources(original.bundle);
    for (const pattern of fixture.sourcePatterns) assert.match(actualSource, pattern, `actual compiler retained ${pattern}`);
    assert.deepEqual(definitions(project), definitions(fixture.project), 'names, scope IDs, initial values, and broadcasts preserved');
    if (fixture.partial) {
      assert.deepEqual(recovery.unresolved.map(record => record.scriptId).sort(), Object.keys(fixture.partial).sort());
      for (const [id, reason] of Object.entries(fixture.partial)) {
        const record = recovery.scripts.find(script => script.scriptId === id);
        assert.equal(record.status, 'unresolved');
        assert.match(record.reason, reason);
        assert.equal(record.body.status, 'unresolved');
        assert.equal(project.targets[record.targetIndex].blocks[id].next, null, 'whole unsupported body stays absent');
      }
      assert.deepEqual([...opcodeSet(project)], ['event_whenflagclicked'], 'no invented reporter or dropped-body support');
      t.diagnostic(`Expected partial scope: ${fixture.limitations.join(' ')}`);
      return;
    }
    requireFullRecovery(context);
    for (const opcode of fixture.requiredOpcodes) assert.ok(opcodeSet(project).has(opcode), `recovered actual opcode ${opcode}`);
    if (fixture.requiredMathOperators) {
      const operators = project.targets.flatMap(target => Object.values(target.blocks))
        .filter(block => block.opcode === 'operator_mathop').map(block => block.fields.OPERATOR[0]);
      assert.deepEqual(operators.sort(), [...fixture.requiredMathOperators].sort(), 'all variable-fed math selectors survived');
    }
    if (fixture.calendarSelectors) {
      const selectors = project.targets.flatMap(target => Object.values(target.blocks))
        .filter(block => block.opcode === 'sensing_current').map(block => block.fields.CURRENTMENU[0]);
      assert.deepEqual(selectors.sort(), [...fixture.calendarSelectors].sort());
    }
    await validate(project, fixture.assets);
    if (fixture.structuralOnly) t.diagnostic(`Compile/recovery/recompile only, no renderer behavior claim: ${fixture.structuralOnly.join(', ')}`);
  });

  test(`actual opcode corpus / ${scenario.id} / ${scenario.id.startsWith('partial-') ? 'partial bodies stay absent and unexecuted' : 'real VM recompile → expected final state'}`, {timeout: 30_000}, async t => {
    const context = await prepare(scenario);
    const {fixture, original, decoded, project, recovery} = context;
    if (fixture.partial) {
      // Never execute an incomplete reconstruction or arbitrary factorySource.
      // The actual compiler output is retained byte-for-byte by recovery.
      assert.ok(recovery.scripts.every(script => script.status === 'unresolved'));
      for (const [id, script] of allScripts(decoded)) {
        assert.equal(script.factorySource, deobfuscate(allScripts(original.bundle).find(([key]) => key === id)[1].factorySource).code);
      }
      assert.ok(project.targets.flatMap(target => Object.values(target.blocks)).every(block => block.next === null));
      await validate(project, fixture.assets);
      t.diagnostic(fixture.limitations.join(' '));
      return;
    }
    await withCalendar(fixture, async () => {
      const before = await runTrusted(fixture.project, fixture.assets, original.bundle);
      assertExpected(before, fixture);
      requireFullRecovery(context);
      const regenerated = await compileReal02(project, fixture.assets);
      trustedBundles.add(regenerated.bundle);
      assert.equal(regenerated.provenance.kind, original.provenance.kind);
      assert.deepEqual(regenerated.provenance.sourceSha256, original.provenance.sourceSha256);
      assert.equal(allScripts(regenerated.bundle).length, allScripts(original.bundle).length, 'inactive structural scripts recompile too');
      const after = await runTrusted(project, fixture.assets, regenerated.bundle);
      assertExpected(after, fixture);
      assert.deepEqual(after.targets, before.targets, 'actual original and recovered/recompiled VM final state');
      assert.deepEqual(after.compiled, before.compiled);
      if (fixture.extendedState) {
        const originalState = await extendedState(fixture.project, fixture.assets, original.bundle);
        const recoveredState = await extendedState(project, fixture.assets, regenerated.bundle);
        assert.deepEqual(recoveredState, originalState);
        for (const [name, properties] of Object.entries(fixture.expectedExtended)) {
          for (const [key, value] of Object.entries(properties)) {
            assert.deepEqual(originalState[name][key], value, `${name} / actual original ${key}`);
            assert.deepEqual(recoveredState[name][key], value, `${name} / actual recovered ${key}`);
          }
        }
      }
      for (const opcode of fixture.requiredOpcodes) {
        if (fixture.structuralOnly?.includes(opcode)) structuralOpcodes.add(opcode);
        else verifiedScenarioOpcodes.add(opcode);
      }
      t.diagnostic(`Actual compiled final-state comparison; ${STEPS}-step bound, remainingThreads=0.`);
      if (fixture.limitations) t.diagnostic(fixture.limitations.join(' '));
    });
  });
}

for (const scenario of supportedSubcases) {
  test(`actual opcode corpus / independent subcase / ${scenario.id}`, {timeout: 30_000}, async t => {
    const context = await prepare(scenario);
    const {fixture, original, project} = context;
    const before = await runTrusted(fixture.project, fixture.assets, original.bundle);
    assertExpected(before, fixture);
    requireFullRecovery(context);
    for (const pattern of fixture.sourcePatterns) assert.match(sources(original.bundle), pattern);
    for (const opcode of fixture.requiredOpcodes) assert.ok(opcodeSet(project).has(opcode), opcode);
    assert.deepEqual(definitions(project), definitions(fixture.project));
    await validate(project, fixture.assets);
    const regenerated = await compileReal02(project, fixture.assets);
    trustedBundles.add(regenerated.bundle);
    const after = await runTrusted(project, fixture.assets, regenerated.bundle);
    assertExpected(after, fixture);
    assert.deepEqual(after.targets, before.targets);
    assert.deepEqual(after.compiled, before.compiled);
    for (const opcode of fixture.requiredOpcodes) verifiedScenarioOpcodes.add(opcode);
    t.diagnostic('Independent actual compiler round trip; literal-index regression remains asserted in the full fixture.');
  });
}

test('opcode corpus scope is eleven behavioral fixtures plus one conservative partial fixture', t => {
  assert.equal(corpusScenarios.length, 12);
  assert.equal(new Set(corpusScenarios.map(scenario => scenario.id)).size, 12);
  assert.equal(corpusScenarios.filter(scenario => scenario.id.startsWith('partial-')).length, 1);
  assert.equal(supportedSubcases.length, 2);
  t.diagnostic(`${verifiedScenarioOpcodes.size} selected recovered opcode keys in passing final-state scenarios: ${[...verifiedScenarioOpcodes].sort().join(', ')}`);
  t.diagnostic(`${structuralOpcodes.size} renderer opcode keys compiled/recovered/recompiled only: ${[...structuralOpcodes].sort().join(', ')}`);
  t.diagnostic('Selected scenario evidence only; menu keys and presence counts do not prove every schema key or every input domain.');
});

test('real corpus helper builds explicit bounded SB3 graphs with reciprocal parents and scope IDs', async () => {
  for (const scenario of corpusScenarios) {
    const {project} = await scenario.build();
    for (const target of project.targets) {
      for (const [id, block] of Object.entries(target.blocks)) {
        assert.notEqual(block.opcode, 'control_forever', `${scenario.id} has no unbounded loop`);
        if (block.next) assert.equal(target.blocks[block.next].parent, id);
        for (const input of Object.values(block.inputs)) {
          for (const value of input.slice(1)) {
            if (typeof value === 'string') assert.equal(target.blocks[value].parent, id, `${scenario.id} / input parent`);
            if (Array.isArray(value) && value[0] === 12) {
              const definition = target.variables[value[2]] || project.targets[0].variables[value[2]];
              assert.equal(definition?.[0], value[1]);
            }
          }
        }
        for (const [name, kind] of [['VARIABLE', 'variables'], ['LIST', 'lists']]) {
          if (block.fields[name]) {
            const [label, definitionId] = block.fields[name];
            const definition = target[kind][definitionId] || project.targets[0][kind][definitionId];
            assert.equal(definition?.[0], label);
          }
        }
      }
    }
  }
});
