import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import JSZip from '@turbowarp/jszip';
import * as validator from '../src/procedure-validate.mjs';
import {addProcedureDefinition} from '../src/recovery-procedures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {compiledFixture} from './compiled-fixtures.mjs';

const {validateProcedures} = validator;
const block = (opcode, extra = {}) => ({
  opcode, next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false, ...extra
});
const target = (name = 'Stage', isStage = true) => ({name, isStage, blocks: {}});
const fixture = ({code = 'test %s %b %n', types = ['s', 'b', 'n'], names = ['text', 'flag', 'number']} = {}) => {
  const sprite = target();
  const signature = {code, types, names, ids: types.map((_, i) => `arg${i}`), warp: false};
  const {definitionId, prototypeId} = addProcedureDefinition({target: sprite, targetIndex: 0, signature});
  sprite.blocks.call = block('procedures_call', {
    mutation: {proccode: code, argumentids: JSON.stringify(signature.ids), warp: 'false'}
  });
  return {project: {targets: [sprite]}, sprite, signature, definitionId, prototypeId,
    definition: sprite.blocks[definitionId], prototype: sprite.blocks[prototypeId], call: sprite.blocks.call};
};
const expectError = (project, pattern) => {
  const result = validateProcedures(project);
  assert.ok(result.errors.some(message => pattern.test(message)), JSON.stringify(result));
  return result;
};
const expectValid = project => {
  const result = validateProcedures(project);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  return result;
};
const freeze = value => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

test('exact named API returns only error/warning arrays, synchronously and without mutation', () => {
  assert.deepEqual(Object.keys(validator), ['validateProcedures']);
  const {project} = fixture();
  const before = structuredClone(project);
  const result = validateProcedures(freeze(project));
  assert.deepEqual(result, {errors: [], warnings: []});
  assert.deepEqual(project, before);
  assert.deepEqual(validateProcedures({targets: []}), {errors: [], warnings: []});
  assert.deepEqual(validateProcedures({targets: [{blocks: {}}]}), {errors: [], warnings: []});
});

test('actual recovery-emitted prototype and mixed parameter inputs are valid regardless of block order', () => {
  const f = fixture();
  f.sprite.blocks.condition = block('operator_equals');
  f.call.inputs = {arg0: [1, [10, 'value']], arg1: [2, 'condition'], arg2: [1, [4, '5']]};
  f.sprite.blocks = Object.fromEntries(Object.entries(f.sprite.blocks).reverse());
  assert.deepEqual(validateProcedures(f.project), {errors: [], warnings: []});
});

test('definition custom_block must be an SB3 shadow tuple referencing a local prototype', () => {
  for (const custom_block of [undefined, null, [], [2, 'x'], [1, 'x', null], [1, null], [1, 3], [1, '']]) {
    const f = fixture();
    f.definition.inputs = {custom_block};
    expectError(f.project, /custom_block must be \[1, prototypeId\]/);
  }
  for (const wrong of [undefined, [12, 'variable', 'id'], block('looks_say'), null]) {
    const f = fixture();
    f.sprite.blocks[f.prototypeId] = wrong;
    expectError(f.project, /target-local procedures_prototype/);
  }
  const f = fixture();
  f.project.targets.push(target('Other', false));
  f.project.targets[1].blocks[f.prototypeId] = f.prototype;
  delete f.sprite.blocks[f.prototypeId];
  expectError(f.project, /target-local procedures_prototype/);
});

test('procedure mutation and proccode must have usable structural types', () => {
  for (const opcode of ['procedures_prototype', 'procedures_call']) {
    for (const mutation of [undefined, null, [], 'mutation']) {
      const f = fixture();
      (opcode === 'procedures_call' ? f.call : f.prototype).mutation = mutation;
      expectError(f.project, /mutation must be an object/);
    }
    for (const proccode of [undefined, null, 1, {}, '']) {
      const f = fixture();
      (opcode === 'procedures_call' ? f.call : f.prototype).mutation.proccode = proccode;
      expectError(f.project, /proccode must be (a string|nonempty)/);
    }
  }
});

test('prototype metadata must be JSON strings containing arrays of the right scalar types', () => {
  for (const key of ['argumentids', 'argumentnames', 'argumentdefaults']) {
    for (const value of [undefined, [], null, '{', 'null', '{}', 'true', '"[]"']) {
      const f = fixture();
      f.prototype.mutation[key] = value;
      expectError(f.project, new RegExp(`${key} must (be a string|contain valid JSON|contain a JSON array)`));
    }
  }
  for (const [key, value] of [
    ['argumentids', '["", "arg1", "arg2"]'], ['argumentids', '[1, "arg1", "arg2"]'],
    ['argumentnames', '[null, "flag", "number"]'], ['argumentnames', '[[], "flag", "number"]'],
    ['argumentdefaults', '[{}, "false", ""]'], ['argumentdefaults', '[[], "false", ""]'],
    ['argumentdefaults', '[null, "false", ""]'], ['argumentdefaults', '[1e400, "false", ""]']
  ]) {
    const f = fixture();
    f.prototype.mutation[key] = value;
    expectError(f.project, new RegExp(`${key}\\[0\\] must be`));
  }
});

test('all signature arrays must match the placeholder count and argument IDs must be unique', () => {
  for (const key of ['argumentids', 'argumentnames', 'argumentdefaults']) {
    const f = fixture();
    f.prototype.mutation[key] = '["one"]';
    expectError(f.project, new RegExp(`${key} length 1.*placeholder count 3`));
  }
  const f = fixture();
  f.prototype.mutation.argumentids = '["arg0", "arg0", "arg2"]';
  expectError(f.project, /argumentids must contain unique IDs/);
});

test('placeholder scanner handles literal percents, escapes, and even/odd backslash runs', () => {
  for (const [code, count] of [
    ['literal 100% %x %S', 0], ['adjacent %s%n%b', 3],
    [String.raw`escaped \%s \%n \%b`, 0],
    [String.raw`even \\%s`, 1], [String.raw`odd \\\%s`, 0],
    [String.raw`four \\\\%b`, 1], [String.raw`mixed \%s %n \%b %b`, 2]
  ]) {
    const f = fixture({code, types: Array(count).fill('s'), names: Array.from({length: count}, (_, i) => `p${i}`)});
    assert.deepEqual(expectValid(f.project).warnings, [], code);
    f.prototype.mutation.argumentdefaults = JSON.stringify(Array(count + 1).fill(''));
    expectError(f.project, new RegExp(`placeholder count ${count}$`));
  }
});

test('warp accepts booleans and JSON boolean strings; absent flags and call/prototype differences are valid', () => {
  for (const warp of [true, false, 'true', 'false', ' \ntrue\t', '\rfalse ']) {
    const f = fixture();
    f.prototype.mutation.warp = warp;
    f.call.mutation.warp = warp;
    expectValid(f.project);
  }
  const f = fixture();
  delete f.prototype.mutation.warp;
  delete f.call.mutation.warp;
  expectValid(f.project);
  f.prototype.mutation.warp = true;
  f.call.mutation.warp = false;
  expectValid(f.project);
  for (const warp of [1, null, [], {}, 'TRUE', '"true"', '1', 'null', 'no']) {
    const invalid = fixture();
    invalid.prototype.mutation.warp = warp;
    invalid.call.mutation.warp = warp;
    assert.equal(expectError(invalid.project, /warp must be a boolean or a JSON boolean string/).errors.length, 2);
  }
});

test('prototype defaults accept strings, numbers, and booleans without inferring placeholder types', () => {
  for (const defaults of [['', 'false', 0], [true, 'text in boolean parameter', 'not a number'], [5, false, -2.5]]) {
    const f = fixture();
    f.prototype.mutation.argumentdefaults = JSON.stringify(defaults);
    assert.deepEqual(expectValid(f.project).warnings, []);
  }
  const f = fixture();
  f.call.inputs.arg1 = [1, [10, 'not a boolean']];
  f.call.inputs.arg2 = [1, [10, 'not a number']];
  expectValid(f.project);
});

test('calls resolve exact proccode within their target; no stage, sprite, or name fallback', () => {
  const f = fixture();
  f.project.targets.push(target('Sprite', false));
  f.project.targets[1].blocks.call = structuredClone(f.call);
  expectError(f.project, /targets\[1\].*no target-local procedure definition/);
  f.call.mutation.proccode = 'TEST %s %b %n';
  expectError(f.project, /"TEST %s %b %n" has no target-local/);
  const independent = fixture();
  f.project.targets[1].blocks = independent.sprite.blocks;
  f.call.mutation.proccode = independent.signature.code;
  assert.deepEqual(expectValid(f.project).warnings, []);
});

test('call argumentids are optional but when present must exactly match prototype IDs in order', () => {
  const f = fixture();
  delete f.call.mutation.argumentids;
  assert.deepEqual(expectValid(f.project).warnings, []);
  for (const ids of [[], ['arg0'], ['arg1', 'arg0', 'arg2'], ['arg0', 'arg1', 'wrong'], ['arg0', 'arg0', 'arg2']]) {
    f.call.mutation.argumentids = JSON.stringify(ids);
    expectError(f.project, /argumentids must match prototype argument IDs in order/);
  }
  for (const value of ['[', '{}', null, ['arg0'], '[1]']) {
    f.call.mutation.argumentids = value;
    expectError(f.project, /argumentids.*must/);
  }
});

test('supplied input keys must be known argument IDs; omitted inputs use defaults', () => {
  const f = fixture();
  assert.deepEqual(expectValid(f.project).warnings, []);
  f.call.inputs = {arg0: [1, [10, 'only one argument']], arg1: [2, null]};
  expectValid(f.project);
  f.call.inputs.extra = [1, [10, 'unexpected']];
  expectError(f.project, /inputs\["extra"\] is an unknown procedure argument ID/);
  f.prototype.inputs.extra = [1, 'unused'];
  expectError(f.project, /inputs\["extra"\] is an unknown prototype argument ID/);
  for (const owner of [f.call, f.prototype, f.definition]) {
    owner.inputs = [];
    expectError(f.project, /inputs must be a dictionary object/);
    owner.inputs = {};
  }
});

test('recursive and mutual procedure calls, reporter return flags, and return outside a procedure are accepted', () => {
  const f = fixture();
  const second = {code: 'other', types: [], names: [], ids: [], warp: false};
  const other = addProcedureDefinition({target: f.sprite, targetIndex: 0, signature: second});
  f.definition.next = 'call';
  f.call.parent = f.definitionId;
  f.call.next = 'other-call';
  f.sprite.blocks['other-call'] = block('procedures_call', {parent: 'call', mutation: {proccode: 'other'}});
  f.sprite.blocks[other.definitionId].next = 'back';
  f.sprite.blocks.back = structuredClone(f.call);
  f.sprite.blocks.back.parent = other.definitionId;
  f.sprite.blocks.back.next = null;
  f.sprite.blocks.return = block('procedures_return', {inputs: {VALUE: [1, [10, 'result']]}});
  for (const returnFlag of [undefined, true, false, 'true', 'false', '1', '2']) {
    if (returnFlag === undefined) delete f.call.mutation.return;
    else f.call.mutation.return = returnFlag;
    assert.deepEqual(expectValid(f.project).warnings, []);
  }
});

test('duplicate definitions are warnings because the VM deliberately prefers the first occurrence', () => {
  const f = fixture();
  f.sprite.blocks.duplicate = {...structuredClone(f.definition), parent: null};
  const result = expectValid(f.project);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /duplicates procedure proccode.*first definition/);
});

test('duplicate argument names are legitimate; only a body reference to that name gets an ambiguity warning', () => {
  const f = fixture({names: ['same', 'same', 'unused']});
  assert.deepEqual(validateProcedures(f.project), {errors: [], warnings: []});
  f.definition.next = 'set';
  f.sprite.blocks.set = block('data_setvariableto', {parent: f.definitionId, inputs: {VALUE: [2, 'value']}});
  f.sprite.blocks.value = block('argument_reporter_boolean', {parent: 'set', fields: {VALUE: ['same', null]}});
  const result = expectValid(f.project);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /references duplicate argument name "same".*last matching parameter/);
  f.sprite.blocks.value.fields.VALUE[0] = 'unused';
  assert.deepEqual(expectValid(f.project).warnings, [], 'reporter opcode does not impose a parameter type');
});

test('argument reporters bind through nested bodies; unbound and outside reporters warn, never error', () => {
  const f = fixture();
  f.definition.next = 'repeat';
  f.sprite.blocks.repeat = block('control_repeat', {parent: f.definitionId});
  f.sprite.blocks.set = block('data_setvariableto', {parent: 'repeat'});
  f.sprite.blocks.bound = block('argument_reporter_boolean', {parent: 'set', fields: {VALUE: ['text']}});
  assert.deepEqual(expectValid(f.project).warnings, []);
  f.sprite.blocks.bound.fields.VALUE[0] = 'Text';
  f.sprite.blocks.outside = block('argument_reporter_string_number', {fields: {VALUE: ['text', null]}});
  const result = expectValid(f.project);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some(message => /"Text" is unbound; the VM returns 0/.test(message)));
  assert.ok(result.warnings.some(message => /"text" is unbound outside a procedure; the VM returns 0/.test(message)));
});

test('special TurboWarp reporter names are allowed case-insensitively, but still bind if a parameter exists', () => {
  const f = fixture();
  for (const [id, opcode, name] of [
    ['tw', 'argument_reporter_boolean', 'IS TURBOWARP?'],
    ['compiled', 'argument_reporter_boolean', 'Is Compiled?'],
    ['key', 'argument_reporter_string_number', 'Last Key Pressed']
  ]) f.sprite.blocks[id] = block(opcode, {fields: {VALUE: [name]}});
  assert.deepEqual(expectValid(f.project).warnings, []);
  f.sprite.blocks.tw.opcode = 'argument_reporter_string_number';
  assert.equal(expectValid(f.project).warnings.length, 1, 'special names are opcode-specific');
});

test('malformed reporter fields give structural errors without treating an unbound name as invalid', () => {
  for (const VALUE of [undefined, null, 'name', [], [1], ['text', null, 'extra']]) {
    const f = fixture();
    f.sprite.blocks.reporter = block('argument_reporter_boolean', {fields: {VALUE}});
    expectError(f.project, /fields.VALUE must contain an argument name string/);
  }
});

test('orphan prototypes warn and do not satisfy the requirement for a target-local definition', () => {
  const f = fixture();
  delete f.sprite.blocks[f.definitionId];
  const result = expectError(f.project, /no target-local procedure definition/);
  assert.ok(result.warnings.some(message => /has no procedures_definition reference/.test(message)));
});

test('special own keys remain valid procedure, block, and argument IDs', () => {
  const f = fixture({code: '__proto__', types: [], names: []});
  f.prototype.mutation = {proccode: '__proto__', argumentids: '["__proto__","constructor","toString"]',
    argumentnames: '["__proto__","constructor","toString"]', argumentdefaults: '["",false,0]'};
  f.prototype.mutation.proccode = 'constructor %s %b %n';
  f.prototype.inputs = {};
  f.sprite.blocks = Object.fromEntries([['__proto__', f.definition], ['constructor', f.prototype], ['toString', f.call]]);
  f.definition.inputs.custom_block = [1, 'constructor'];
  f.prototype.parent = '__proto__';
  f.call.mutation.proccode = f.prototype.mutation.proccode;
  f.call.mutation.argumentids = f.prototype.mutation.argumentids;
  f.call.inputs = JSON.parse('{"__proto__":[1,[10,"value"]],"constructor":[2,null],"toString":[1,[4,"1"]]}');
  assert.deepEqual(validateProcedures(f.project), {errors: [], warnings: []});
  delete f.sprite.blocks.constructor;
  expectError(f.project, /target-local procedures_prototype/);
});

test('mutation JSON parsing is bounded at 32 KiB, including proccode and warp', () => {
  for (const key of ['argumentids', 'argumentnames', 'argumentdefaults']) {
    const f = fixture();
    const value = f.prototype.mutation[key];
    f.prototype.mutation[key] = value + ' '.repeat(32 * 1024 - value.length);
    expectValid(f.project);
    f.prototype.mutation[key] += ' ';
    expectError(f.project, new RegExp(`${key} exceeds the 32 KiB`));
  }
  const f = fixture();
  f.call.mutation.argumentids = '[' + ' '.repeat(32 * 1024);
  expectError(f.project, /argumentids exceeds the 32 KiB/);
  f.prototype.mutation.proccode = 'x'.repeat(32 * 1024 + 1);
  expectError(f.project, /proccode exceeds the 32 KiB/);
  f.prototype.mutation.warp = ' '.repeat(32 * 1024) + 'true';
  expectError(f.project, /warp must be a boolean/);
});

test('malformed containers and parent cycles cannot crash or cause recursive scope traversal', () => {
  for (const project of [undefined, null, [], {}, {targets: {}}, {targets: [null]}, {targets: [{blocks: []}]}]) {
    assert.ok(validateProcedures(project).errors.length > 0);
  }
  const f = fixture();
  f.sprite.blocks.primitive = [12, 'var', 'varId'];
  f.sprite.blocks.invalid = null;
  f.sprite.blocks.a = block('looks_say', {parent: 'b'});
  f.sprite.blocks.b = block('looks_say', {parent: 'a'});
  f.sprite.blocks.reporter = block('argument_reporter_boolean', {parent: 'a', fields: {VALUE: ['missing']}});
  assert.equal(expectValid(f.project).warnings.length, 1);
  f.sprite.blocks.a.parent = 'missing-parent';
  expectValid(f.project);
  for (let i = 0; i < 12000; i++) f.sprite.blocks[`depth${i}`] = block('looks_say', {parent: i ? `depth${i - 1}` : f.definitionId});
  f.sprite.blocks.reporter.parent = 'depth11999';
  f.sprite.blocks.reporter.fields.VALUE[0] = 'text';
  assert.deepEqual(expectValid(f.project).warnings, []);
});

test('unknown extension mutations and source-like strings are opaque and never executed', () => {
  const marker = '__procedure_validate_executed';
  assert.equal(Object.hasOwn(globalThis, marker), false);
  const f = fixture({code: `globalThis.${marker} = true`, types: [], names: []});
  f.prototype.mutation.factorySource = `globalThis.${marker} = true`;
  f.prototype.mutation.extra = {argumentids: '{', proccode: null};
  f.sprite.blocks.extension = block('unknownExtension_custom', {
    mutation: {proccode: null, argumentids: '[' + ' '.repeat(100000), warp: {}, return: 'arbitrary'}
  });
  assert.deepEqual(validateProcedures(f.project), {errors: [], warnings: []});
  assert.equal(Object.hasOwn(globalThis, marker), false);
  f.prototype.mutation.argumentids = `globalThis.${marker} = true`;
  expectError(f.project, /argumentids must contain valid JSON/);
  assert.equal(Object.hasOwn(globalThis, marker), false);
});

test('complete recovery emits definitions, body argument reporters, returns, and reporter calls accepted by validation', async () => {
  const f = await compiledFixture();
  f.bundle.compiledTargets[0].procedures['Zresult %s'] = {
    factorySource: '(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();return function procbody(p0){return p0;};})'
  };
  f.bundle.compiledTargets[0].scripts.a.factorySource = '(function entry(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function body(){b0.value=thread.procedures["Zresult %s"]("result");retire();return;};})';
  const project = structuredClone(f.stripped);
  const recovered = recoverCompiledCode(project, f.bundle);
  assert.deepEqual(recovered.unresolved, []);
  const opcodes = Object.values(project.targets[0].blocks).map(item => item.opcode);
  for (const opcode of ['procedures_definition', 'procedures_prototype', 'argument_reporter_string_number', 'procedures_return', 'procedures_call']) {
    assert.ok(opcodes.includes(opcode), opcode);
  }
  assert.deepEqual(validateProcedures(project), {errors: [], warnings: []});
});

const runtimeFixtures = new URL('../../research/TurboWarp/scratch-vm/test/fixtures/execute/', import.meta.url);
for (const name of [
  'tw-procedure-return-simple.sb3', 'tw-procedure-return-recursion.sb3',
  'tw-procedure-arguments-with-same-name.sb3', 'tw-safe-procedure-argument-casting.sb3',
  'tw-prefers-first-occurence-of-procedure-387608267.sb3'
]) {
  test(`real source SB3 fixture validates without errors: ${name}`, async t => {
    let bytes;
    try { bytes = await readFile(new URL(name, runtimeFixtures)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      t.skip('optional research runtime fixture is not available');
      return;
    }
    const zip = await JSZip.loadAsync(bytes);
    const project = JSON.parse(await zip.file('project.json').async('string'));
    const result = expectValid(project);
    if (name.includes('same-name')) assert.ok(result.warnings.some(message => /duplicate argument name/.test(message)));
    else if (name.includes('first-occurence')) assert.ok(result.warnings.some(message => /duplicates procedure proccode/.test(message)));
    else assert.deepEqual(result.warnings, []);
  });
}
