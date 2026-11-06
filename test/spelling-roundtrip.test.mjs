import test from 'node:test';
import assert from 'node:assert/strict';
import {authorProject, roundTrip, shipped, cmd, rep, lit, variable, call, procedure, param, opcodesOf} from './helpers-author.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

// Each test draws a project the way an author would, compiles it with the REAL 02 compiler, throws the blocks away
// and recovers them with the recompilation oracle. They check that the recovered blocks are the author's choice among
// blocks that compile to the same JavaScript, and that the real compiler turns them back into the shipped factory.

const flag = () => cmd('event_whenflagclicked');
const setTo = (name, value) => cmd('data_setvariableto', {fields: {VARIABLE: name}, inputs: {VALUE: value}});
const changeBy = (name, value) => cmd('data_changevariableby', {fields: {VARIABLE: name}, inputs: {VALUE: value}});
const ifThen = (condition, ...body) => cmd('control_if', {inputs: {CONDITION: condition}, substacks: {SUBSTACK: body}});
const count = (project, opcode) => opcodesOf(project).filter(o => o === opcode).length;
const everyItemMatches = result => [...result.result.scripts, ...result.result.procedures]
  .filter(record => record.status === 'reconstructed-unverified' && record.recompilation)
  .every(record => record.recompilation.status === 'match');
const blocksOf = project => Object.values(project.targets[0].blocks);

test('a change block is recovered as a change block whatever type the compiler inferred for the variable', async () => {
  // Untyped: `v = (+v || 0) + 1`. After a division: `v = toNotNaN(v) + 1`. After a number: `v = v + 1`.
  const untyped = await roundTrip(authorProject({scripts: [[flag(), changeBy('idx', lit(1))]]}));
  assert.equal(count(untyped.project, 'data_changevariableby'), 1);
  assert.equal(count(untyped.project, 'data_setvariableto'), 0);
  assert.ok(everyItemMatches(untyped));

  const afterDivision = await roundTrip(authorProject({scripts: [[flag(),
    setTo('idx', rep('operator_divide', {NUM1: variable('a'), NUM2: variable('b')})), changeBy('idx', lit(1))]]}));
  assert.equal(count(afterDivision.project, 'data_changevariableby'), 1, 'toNotNaN(v) + 1 is a change as well');

  const afterNumber = await roundTrip(authorProject({scripts: [[flag(), setTo('idx', lit(0)), changeBy('idx', lit(1))]]}));
  assert.equal(count(afterNumber.project, 'data_changevariableby'), 1, 'a plain v + 1 on a known number is a change as well');
  assert.ok(everyItemMatches(afterNumber));
});

test('a join is never read as a change: appending text keeps the join', async () => {
  // Once the compiler knows a variable holds a string it writes the join without the `"" +` cast, so the only sign
  // that `v.value + x` is a join is the string operand: a literal, or a letter-of.
  const result = await roundTrip(authorProject({scripts: [[flag(),
    setTo('out', lit('start')), setTo('a', lit('start')),
    setTo('out', rep('operator_join', {STRING1: variable('out'), STRING2: lit('x')})),
    setTo('a', rep('operator_join', {STRING1: variable('a'), STRING2: rep('operator_letter_of', {LETTER: lit(1), STRING: variable('idx')})}))]]}));
  const factory = Object.values(result.bundle.compiledTargets[0].scripts)[0].factorySource;
  assert.match(factory, /\w+\.value = \(\w+\.value \+ "x"\)/, 'the compiler really wrote a bare + here');
  assert.match(factory, /\w+\.value = \(\w+\.value \+ \(\(\(""/, 'and a bare + with a letter-of operand');
  assert.equal(count(result.project, 'operator_join'), 2, 'a string operand makes the bare + a join');
  assert.equal(count(result.project, 'data_changevariableby'), 0);
  assert.equal(count(result.project, 'operator_add'), 0);
  assert.ok(everyItemMatches(result));
});

test('constant halving is recovered in the direction the compiler rewrote it', async () => {
  // jsgen turns `x / 2` into `x * 0.5` and `x * 0.5` into `x / 2`; read literally both come back mirrored.
  const result = await roundTrip(authorProject({scripts: [[flag(),
    setTo('out', rep('operator_divide', {NUM1: variable('idx'), NUM2: lit(2)})),
    setTo('a', rep('operator_multiply', {NUM1: variable('idx'), NUM2: lit(0.5)}))]]}));
  const divide = blocksOf(result.project).filter(b => b.opcode === 'operator_divide');
  const multiply = blocksOf(result.project).filter(b => b.opcode === 'operator_multiply');
  assert.equal(divide.length, 1);
  assert.equal(multiply.length, 1);
  assert.deepEqual(divide[0].inputs.NUM2, [1, [4, 2]]);
  assert.deepEqual(multiply[0].inputs.NUM2, [1, [4, 0.5]]);
  assert.ok(everyItemMatches(result));
});

test('a comparison the compiler wrote as !(a <= b) comes back as one greater-than, not a triple negation', async () => {
  // The left operand may be NaN, so the compiler emits the negated <= form (jsgen OP_GREATER).
  const condition = rep('operator_gt', {OPERAND1: rep('operator_divide', {NUM1: variable('a'), NUM2: variable('b')}), OPERAND2: lit(5)});
  const plain = await roundTrip(authorProject({scripts: [[flag(), ifThen(condition, setTo('out', lit(1)))]]}));
  assert.equal(count(plain.project, 'operator_gt'), 1);
  assert.equal(count(plain.project, 'operator_not'), 0);
  assert.ok(everyItemMatches(plain));

  const negated = await roundTrip(authorProject({scripts: [[flag(), ifThen(rep('operator_not', {OPERAND: condition}), setTo('out', lit(1)))]]}));
  assert.equal(count(negated.project, 'operator_gt'), 1);
  assert.equal(count(negated.project, 'operator_not'), 1, 'exactly the one negation the author drew');
  assert.ok(everyItemMatches(negated));
});

test('a boolean parameter placed directly in an or is not wrapped in not(not(...))', async () => {
  const project = authorProject({
    scripts: [[flag(), call('check %b', rep('operator_not'))]],
    procedures: [procedure('check %b', [{name: 'f', type: 'b'}], [
      ifThen(rep('operator_or', {OPERAND1: param('f', 'b'), OPERAND2: rep('operator_equals', {OPERAND1: variable('idx'), OPERAND2: lit(1)})}),
        setTo('out', lit(1)))])]});
  const result = await roundTrip(project, {deobfuscateFactories: true});
  assert.equal(count(result.project, 'operator_or'), 1);
  const [orBlock] = blocksOf(result.project).filter(b => b.opcode === 'operator_or');
  assert.equal(result.project.targets[0].blocks[orBlock.inputs.OPERAND1[1]].opcode, 'argument_reporter_boolean');
  assert.ok(everyItemMatches(result));
});

test('inside a procedure an early return is stop this script, and a constant true is an empty not', async () => {
  const project = authorProject({
    scripts: [[flag(), call('work %b', rep('operator_not'))]],
    procedures: [procedure('work %b', [{name: 'f', type: 'b'}], [
      ifThen(rep('operator_equals', {OPERAND1: variable('idx'), OPERAND2: lit(1)}),
        cmd('control_stop', {fields: {STOP_OPTION: 'this script'}, mutation: {tagName: 'mutation', children: [], hasnext: 'false'}})),
      setTo('out', lit(1))])]});
  const result = await roundTrip(project, {deobfuscateFactories: true});
  assert.equal(count(result.project, 'control_stop'), 1);
  assert.equal(count(result.project, 'procedures_return'), 0);
  const [notBlock] = blocksOf(result.project).filter(b => b.opcode === 'operator_not');
  assert.deepEqual(notBlock.inputs, {}, 'the true the author passed is an empty not');
  assert.equal(count(result.project, 'operator_equals'), 1, 'the only comparison is the one in the condition');
  assert.ok(everyItemMatches(result));
});

test('an empty boolean slot stays empty instead of receiving a text shadow', async () => {
  const project = authorProject({
    scripts: [[flag(), call('two %b %b', rep('operator_not'), undefined)]],
    procedures: [procedure('two %b %b', [{name: 'p', type: 'b'}, {name: 'q', type: 'b'}], [setTo('out', lit(1))])]});
  const result = await roundTrip(project, {deobfuscateFactories: true});
  const [callBlock] = blocksOf(result.project).filter(b => b.opcode === 'procedures_call');
  assert.equal(Object.keys(callBlock.inputs).length, 1, 'only the first parameter was given a value');
  assert.ok(everyItemMatches(result));
});

test('pick random between decimals stays a float random', async () => {
  // randomFloat(0, 1) is what `pick random 0 to 1.0` compiles to; reading it as `0 to 1` would give integers.
  const result = await roundTrip(authorProject({scripts: [[flag(), setTo('out', rep('operator_random', {FROM: lit('0'), TO: lit('1.0')}))]]}));
  const [random] = blocksOf(result.project).filter(b => b.opcode === 'operator_random');
  const text = input => String(input[1][1]);
  assert.ok(text(random.inputs.FROM).includes('.') || text(random.inputs.TO).includes('.'), 'a decimal point keeps it a float random');
  assert.ok(everyItemMatches(result));
});

test('a procedure that calls a procedure the bundle lists after it is recovered (callees are decoded first)', async () => {
  const project = authorProject({
    scripts: [[flag(), call('outer')]],
    procedures: [procedure('outer', [], [call('inner'), setTo('out', lit(2))]), procedure('inner', [], [setTo('a', lit(3))])]});
  const { bundle } = await shipped(project);
  const order = Object.keys(bundle.compiledTargets[0].procedures);
  assert.ok(order.indexOf('Zouter') < order.indexOf('Zinner'), 'the compiler lists the caller first: ' + order);
  const result = await roundTrip(project);
  assert.equal(count(result.project, 'procedures_definition'), 2);
  assert.equal(count(result.project, 'procedures_call'), 2);
  assert.ok(everyItemMatches(result));
  // Strict recovery gets the same two procedures: the order is not a relaxed-mode matter.
  const strict = structuredClone(result.stripped);
  const strictResult = recoverCompiledCode(strict, result.bundle, {beautify: false});
  assert.equal(strictResult.procedures.filter(p => p.status === 'reconstructed-unverified').length, 2);
});

test('nested or blocks keep their nesting through the deobfuscator', async () => {
  // a or (b or c): Babel prints this as `a || b || c`, which reads back as (a or b) or c.
  const eq = (name, value) => rep('operator_equals', {OPERAND1: variable(name), OPERAND2: lit(value)});
  const project = authorProject({scripts: [[flag(), ifThen(
    rep('operator_or', {OPERAND1: eq('a', 1), OPERAND2: rep('operator_or', {OPERAND1: eq('b', 2), OPERAND2: eq('idx', 3)})}), setTo('out', lit(1)))]]});
  const result = await roundTrip(project, {deobfuscateFactories: true});
  const blocks = result.project.targets[0].blocks;
  const ors = Object.values(blocks).filter(b => b.opcode === 'operator_or');
  assert.equal(ors.length, 2);
  const outer = ors.find(b => blocks[b.inputs.OPERAND2[1]]?.opcode === 'operator_or');
  assert.ok(outer, 'the second operand of the outer or is the inner or, as drawn');
  assert.ok(everyItemMatches(result));
});

test('the definition script the compiler makes for a procedure is not recovered as a stack of its own', async () => {
  const project = authorProject({
    scripts: [[flag(), call('check %b', rep('operator_not'))]],
    procedures: [procedure('check %b', [{name: 'f', type: 'b'}], [
      ifThen(rep('operator_or', {OPERAND1: param('f', 'b'), OPERAND2: rep('operator_equals', {OPERAND1: variable('idx'), OPERAND2: lit(1)})}),
        setTo('out', lit(1)))])]});
  const result = await roundTrip(project, {deobfuscateFactories: true});
  const topLevel = blocksOf(result.project).filter(b => b.topLevel).map(b => b.opcode).sort();
  assert.deepEqual(topLevel, ['event_whenflagclicked', 'procedures_definition'], 'no loose copy of the procedure body');
  assert.ok(result.result.scripts.some(s => s.status === 'procedure-body-copy'));
});

test('strict recovery is unchanged by the relaxed preferences: it still spells things the exact way', async () => {
  const project = authorProject({
    scripts: [[flag(), call('check %b', rep('operator_not'))]],
    procedures: [procedure('check %b', [{name: 'f', type: 'b'}], [
      ifThen(rep('operator_or', {OPERAND1: param('f', 'b'), OPERAND2: rep('operator_equals', {OPERAND1: variable('idx'), OPERAND2: lit(1)})}),
        setTo('out', lit(1)))])]});
  const { bundle, stripped } = await shipped(project, {deobfuscateFactories: true});
  const a = structuredClone(stripped), b = structuredClone(stripped);
  const first = recoverCompiledCode(a, bundle, {beautify: false});
  const second = recoverCompiledCode(b, bundle, {beautify: false, relaxed: false});
  assert.deepEqual(a, b);
  assert.ok([...first.scripts, ...first.procedures].every(r => !r.assumptions && !r.preferences), 'strict mode records neither assumptions nor preferences');
  assert.deepEqual(first.unresolved.map(u => u.reason), second.unresolved.map(u => u.reason));
});

test('a negated <= on a variable the compiler typed is refused by strict decoding and assumed by relaxed decoding', async () => {
  // After `idx = a / b` the compiler knows idx is a number or NaN and writes `!(idx <= 16)`. The decoder cannot see
  // that typing, so it cannot prove the operand numeric: strict mode refuses, relaxed mode assumes, the oracle checks.
  const project = authorProject({scripts: [[flag(),
    setTo('idx', rep('operator_divide', {NUM1: variable('a'), NUM2: variable('b')})),
    ifThen(rep('operator_gt', {OPERAND1: variable('idx'), OPERAND2: lit(16)}), setTo('out', lit(1)))]]});
  const { bundle, stripped } = await shipped(project);
  const [entry] = Object.values(bundle.compiledTargets[0].scripts);
  assert.match(entry.factorySource, /!\(\w+\.value <= 16\)/, 'the compiler really wrote the negated <= form');
  assert.throws(() => decodeCompiledFactory(entry.factorySource, stripped, 0), /!\(a <= b\)/, 'strict mode needs a proof of numeric operands');
  const relaxed = decodeCompiledFactory(entry.factorySource, stripped, 0, {relaxed: true});
  assert.ok(relaxed.assumptions.some(text => /!\(a <= b\)/.test(text)), 'the assumption is recorded');
  const result = await roundTrip(project);
  assert.equal(count(result.project, 'operator_gt'), 1);
  assert.equal(count(result.project, 'operator_not'), 0);
  assert.ok(everyItemMatches(result), 'and the real compiler confirms it');
});

test('preferences are separate from assumptions and can be switched off kind by kind', async () => {
  // Preferences are separate from assumptions and can be turned off kind by kind.
  const change = authorProject({scripts: [[flag(), changeBy('idx', lit(1))]]});
  const shippedChange = await shipped(change);
  const [changeEntry] = Object.values(shippedChange.bundle.compiledTargets[0].scripts);
  const withPreference = decodeCompiledFactory(changeEntry.factorySource, shippedChange.stripped, 0, {relaxed: true});
  const without = decodeCompiledFactory(changeEntry.factorySource, shippedChange.stripped, 0, {relaxed: true, preferencesOff: new Set(['change-by'])});
  const strictDecode = decodeCompiledFactory(changeEntry.factorySource, shippedChange.stripped, 0);
  assert.equal(withPreference.operations[0].opcode, 'data_changevariableby');
  assert.deepEqual(withPreference.preferenceKinds, ['change-by']);
  assert.equal(without.operations[0].opcode, 'data_setvariableto');
  assert.equal(strictDecode.operations[0].opcode, 'data_setvariableto');
  assert.deepEqual(strictDecode.preferences, []);
});

test('stop all inside a procedure ends with retire and a yield, not a return, and is recovered', async () => {
  // jsgen retire(): a script ends `retire(); return;`; a procedure ends `retire(); yield;`, because a `return` there would
  // only go back to the caller, not out of the sequencer. Strict decoding handles both forms.
  const project = authorProject({
    scripts: [[flag(), call('halt')]],
    procedures: [procedure('halt', [], [cmd('control_stop', {fields: {STOP_OPTION: 'all'}, mutation: {tagName: 'mutation', children: [], hasnext: 'false'}})])]});
  const { bundle, stripped } = await shipped(project);
  const procedureSource = Object.values(bundle.compiledTargets[0].procedures)[0].factorySource;
  assert.match(procedureSource, /runtime\.stopAll\(\);\s*retire\(\);\s*yield;/, 'the compiler really wrote the procedure form');
  const strict = structuredClone(stripped);
  const strictResult = recoverCompiledCode(strict, bundle, {beautify: false});
  assert.equal(strictResult.procedures[0].status, 'reconstructed-unverified', strictResult.procedures[0].reason);
  const result = await roundTrip(project);
  const stops = blocksOf(result.project).filter(b => b.opcode === 'control_stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].fields.STOP_OPTION[0], 'all');
  assert.ok(everyItemMatches(result));
});

test('delete all of a list keeps the delete (all) spelling authors use, and the dedicated block only when the compiler needs it', async () => {
  const project = authorProject({scripts: [[flag(), cmd('data_deleteoflist', {fields: {LIST: 'list'}, inputs: {INDEX: lit('all')}})]]});
  const result = await roundTrip(project);
  assert.equal(count(result.project, 'data_deleteoflist'), 1);
  assert.equal(count(result.project, 'data_deletealloflist'), 0);
  assert.ok(everyItemMatches(result));
});
