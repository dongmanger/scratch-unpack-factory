import test from 'node:test';
import assert from 'node:assert/strict';
import {beautifyOperations, beautifyLayout, BEAUTIFY_LIMITS} from '../src/beautify.mjs';
import {buildRecoveredStack} from '../src/recovered-blocks.mjs';

const not = inner => ({opcode: 'operator_not', inputs: {OPERAND: inner}});
const boolInput = inner => ({opcode: 'control_if', inputs: {CONDITION: inner}, substacks: {SUBSTACK: []}});
const mouseDown = () => ({opcode: 'sensing_mousedown'});
const equals = (left, right) => ({opcode: 'operator_equals', inputs: {OPERAND1: left, OPERAND2: right}});
const bool = value => equals({literal: 1}, {literal: value ? 1 : 0});

// Trusted, deliberately small evaluator matching Scratch Cast.toBoolean and the
// numeric comparison cases below; no source supplied to recovery is executed.
const toBoolean = value => typeof value === 'string' ?
  value !== '' && value !== '0' && value.toLowerCase() !== 'false' : !!value;
const evaluate = (node, value = false) => {
  if ('literal' in node) return node.literal;
  if ('variable' in node) return value;
  const input = key => evaluate(node.inputs[key], value);
  switch (node.opcode) {
  case 'sensing_mousedown': return value;
  case 'operator_not': return !toBoolean(input('OPERAND'));
  case 'operator_and': return toBoolean(input('OPERAND1')) && toBoolean(input('OPERAND2'));
  case 'operator_or': return toBoolean(input('OPERAND1')) || toBoolean(input('OPERAND2'));
  case 'operator_equals': return Number(input('OPERAND1')) === Number(input('OPERAND2'));
  case 'operator_gt': return Number(input('OPERAND1')) > Number(input('OPERAND2'));
  case 'operator_lt': return Number(input('OPERAND1')) < Number(input('OPERAND2'));
  default: throw new Error(`Unimplemented trusted fixture: ${node.opcode}`);
  }
};
const emit = operations => {
  const target = {blocks: {hat: {opcode: 'event_whenflagclicked', next: null}}};
  buildRecoveredStack({target, operations, parentId: 'hat', idFor: key => `r/${key}`, recordBlock() {}});
  return target.blocks;
};

test('fold double not only around a proven Boolean reporter in a Boolean input', () => {
  const value = {opcode: 'operator_gt', inputs: {OPERAND1: {literal: 1}, OPERAND2: {literal: 2}}};
  const operations = [boolInput(not(not(value)))];
  const before = structuredClone(operations);
  const {operations: out, stats} = beautifyOperations(operations);
  assert.equal(stats.doubleNotCollapsed, 1);
  assert.deepEqual(out[0].inputs.CONDITION, value);
  assert.deepEqual(operations, before);
});

test('value contexts retain Boolean conversions, including numeric/string inputs', () => {
  for (const opcode of ['data_setvariableto', 'looks_say', 'motion_movesteps']) {
    for (const name of ['VALUE', 'MESSAGE', 'STEPS']) {
      const operations = [{opcode, inputs: {[name]: not(not(mouseDown()))}}];
      const {operations: out, stats} = beautifyOperations(operations);
      assert.equal(stats.doubleNotCollapsed, 0);
      assert.deepEqual(out, operations);
    }
  }
});

test('and/or operands and nested stacks retain proven Boolean behavior', () => {
  const flag = mouseDown();
  const operations = [boolInput({opcode: 'operator_and', inputs: {
    OPERAND1: not(not(flag)), OPERAND2: {opcode: 'operator_or', inputs: {
      OPERAND1: bool(false), OPERAND2: not(not(flag))
    }}
  }})];
  operations[0].substacks = {
    SUBSTACK: [boolInput(not(not(flag)))], SUBSTACK2: [boolInput(not(not(bool(true))))]
  };
  const {operations: out, stats} = beautifyOperations(operations);
  assert.equal(stats.doubleNotCollapsed, 4);
  for (const value of [true, false]) {
    assert.equal(evaluate(out[0].inputs.CONDITION, value), evaluate(operations[0].inputs.CONDITION, value));
  }
  assert.deepEqual(out[0].substacks.SUBSTACK[0].inputs.CONDITION, flag);
});

test('all known control Boolean inputs allow a proven Boolean reporter', () => {
  for (const opcode of ['control_if', 'control_if_else', 'control_wait_until', 'control_repeat_until', 'control_while']) {
    const {operations, stats} = beautifyOperations([{opcode, inputs: {CONDITION: not(not(mouseDown()))}}]);
    assert.equal(stats.doubleNotCollapsed, 1, opcode);
    assert.deepEqual(operations[0].inputs.CONDITION, mouseDown());
  }
  const {operations, stats} = beautifyOperations([boolInput(not(not(not(not(mouseDown())))))]);
  assert.equal(stats.doubleNotCollapsed, 2);
  assert.deepEqual(operations[0].inputs.CONDITION, mouseDown());
});

test('equals/gt/lt OPERAND1 and OPERAND2 are value contexts, not Boolean slots', () => {
  for (const [opcode, left, right] of [
    ['operator_equals', not(not({literal: 2})), bool(true)],
    ['operator_gt', not(not({literal: 2})), {literal: 1}],
    ['operator_lt', not(not({literal: 2})), {literal: 2}],
    ['operator_equals', bool(true), not(not({literal: 2}))],
    ['operator_gt', {literal: 2}, not(not({literal: 2}))],
    ['operator_lt', {literal: 1}, not(not({literal: 2}))]
  ]) {
    const comparison = {opcode, inputs: {OPERAND1: left, OPERAND2: right}};
    // Also exercise a comparator reached through the Boolean traversal path.
    const operations = [comparison, boolInput(not(not(comparison)))];
    const {operations: out, stats} = beautifyOperations(operations);
    assert.deepEqual(out[0], comparison);
    assert.deepEqual(out[1].inputs.CONDITION, comparison);
    assert.equal(evaluate(out[0]), evaluate(comparison));
    assert.equal(evaluate(out[1].inputs.CONDITION), evaluate(comparison));
    assert.equal(stats.doubleNotCollapsed, 1, 'only the proven Boolean comparison wrapper may fold');
  }
});

test('unknown opcodes cannot acquire Boolean input semantics by name', () => {
  for (const opcode of ['extension_boolean', 'procedures_call']) {
    for (const name of ['CONDITION', 'OPERAND', 'OPERAND1', 'OPERAND2']) {
      const operations = [{opcode, inputs: {[name]: not(not(mouseDown()))}}];
      const out = beautifyOperations(operations);
      assert.equal(out.stats.doubleNotCollapsed, 0);
      assert.deepEqual(out.operations, operations);
    }
  }
});

test('variables, literals, and unproved reporters keep conversions even in Boolean inputs', () => {
  const values = ['', '0', 'false', 'FALSE', 'hello', 0, 1, 2, -1];
  const expressions = [
    ...values.map(literal => ({literal})),
    {variable: {name: 'flag', id: 'flag-id'}},
    {list: {name: 'flags', id: 'list-id'}},
    {broadcast: {name: 'ready', id: 'broadcast-id'}},
    {opcode: 'sensing_timer'}, {opcode: 'extension_predicate'},
    {opcode: 'procedures_call'},
    // The interpreter returns the raw parameter, not a guaranteed Boolean.
    {opcode: 'argument_reporter_boolean', fields: {VALUE: ['flag', null]}}
  ];
  for (const expression of expressions) {
    const operations = [boolInput(not(not(expression)))];
    const out = beautifyOperations(operations);
    assert.equal(out.stats.doubleNotCollapsed, 0, JSON.stringify(expression));
    assert.deepEqual(out.operations, operations);
  }
  const operations = [boolInput(not(not({variable: {name: 'flag', id: 'flag-id'}})))];
  const out = beautifyOperations(operations);
  for (const value of [...values, false, true]) {
    assert.equal(evaluate(out.operations[0].inputs.CONDITION, value), toBoolean(value));
  }
});

test('malformed Boolean reporter shapes or semantically significant wrapper metadata do not fold', () => {
  const cases = [
    {opcode: 'operator_equals', inputs: {OPERAND1: {literal: 1}}},
    {opcode: 'operator_equals', inputs: {OPERAND1: {literal: 1}, OPERAND2: {literal: 1}, EXTRA: {literal: 2}}},
    {opcode: 'sensing_mousedown', fields: {EXTRA: ['value', null]}},
    {opcode: 'sensing_mousedown', mutation: {custom: true}},
    {opcode: 'sensing_mousedown', shadow: true}
  ];
  for (const inner of cases) {
    const operations = [boolInput(not(not(inner)))];
    const out = beautifyOperations(operations);
    assert.equal(out.stats.doubleNotCollapsed, 0);
    assert.deepEqual(out.operations, operations);
  }
  for (const metadata of [
    {mutation: {custom: true}},
    {shadow: true},
    {fields: {EXTRA: ['value', null]}},
    {inputs: {OPERAND: not(mouseDown()), EXTRA: {literal: 'must not be erased'}}},
    {shadowInputs: {OPERAND: {opcode: 'text', fields: {TEXT: ['saved', null]}}}}
  ]) {
    const operations = [boolInput({...not(not(mouseDown())), ...metadata})];
    const out = beautifyOperations(operations);
    assert.equal(out.stats.doubleNotCollapsed, 0, JSON.stringify(metadata));
    assert.deepEqual(out.operations, operations);
  }
});

test('invalid IR is rejected before a valid prefix or removed wrapper can hide it', () => {
  assert.throws(() => beautifyOperations('not-an-array'), TypeError);
  const invalid = [
    {literal: true}, {opcode: 'operator_not', literal: 1, inputs: {OPERAND: mouseDown()}},
    {...not(mouseDown()), rawCode: 'unknown()'},
    {...not(mouseDown()), substacks: {SUBSTACK: [{opcode: 'looks_say', inputs: {MESSAGE: {literal: 'must not be erased'}}}]}},
    {...not(mouseDown()), fields: []},
    {...not(mouseDown()), mutation: []},
    {...not(mouseDown()), shadow: 'true'},
    {...not(mouseDown()), inputs: {OPERAND: {variable: {name: 'missing id'}}}}
  ];
  for (const value of invalid) {
    const operations = [boolInput(not(not(mouseDown()))), boolInput(not(not(value)))];
    const before = structuredClone(operations);
    assert.throws(() => beautifyOperations(operations), TypeError);
    assert.deepEqual(operations, before);
  }
});

test('bounded preflight rejects cyclic, deeply nested, and oversized IR without stack overflow', () => {
  const cycle = not(mouseDown()); cycle.inputs.OPERAND = cycle;
  assert.throws(() => beautifyOperations([boolInput(cycle)]), /cyclic IR/);
  const stackCycle = {opcode: 'control_if', substacks: {SUBSTACK: []}};
  stackCycle.substacks.SUBSTACK.push(stackCycle);
  assert.throws(() => beautifyOperations([stackCycle]), /cyclic IR/);
  let deep = mouseDown();
  for (let i = 0; i < BEAUTIFY_LIMITS.maxDepth; i++) deep = not(deep);
  assert.throws(() => beautifyOperations([boolInput(deep)]), /depth limit/);
  const shared = {opcode: 'sensing_mousedown'};
  const wide = Array.from({length: BEAUTIFY_LIMITS.maxNodes}, () => shared);
  assert.throws(() => beautifyOperations(wide), /node limit/);
  let called = false;
  const accessor = {opcode: 'control_if'};
  Object.defineProperty(accessor, 'inputs', {enumerable: true, get() {called = true; return {};}});
  assert.throws(() => beautifyOperations([accessor]), /accessors/);
  assert.equal(called, false);
});

test('safe rewrites preserve exact references, menu shadows, mutations, and special input keys', () => {
  const predicate = {opcode: 'sensing_keypressed', inputs: {KEY_OPTION: {variable: {name: 'key', id: 'key-id'}}},
    shadowInputs: {KEY_OPTION: {opcode: 'sensing_keyoptions', fields: {KEY_OPTION: ['space', null]}}}};
  const operations = [boolInput(not(not(predicate))),
    {opcode: 'procedures_call', mutation: {proccode: 'example %s', argumentids: '["arg-id"]', warp: 'false'},
      inputs: Object.fromEntries([['arg-id', {variable: {name: 'name', id: 'exact-id'}}], ['__proto__', {literal: 'text'}]])}];
  const before = structuredClone(operations);
  const out = beautifyOperations(operations);
  assert.equal(out.stats.doubleNotCollapsed, 1);
  assert.deepEqual(out.operations[0].inputs.CONDITION, predicate);
  assert.deepEqual(out.operations[1], operations[1]);
  assert.ok(Object.hasOwn(out.operations[1].inputs, '__proto__'));
  assert.deepEqual(operations, before);
  const blocks = emit(out.operations);
  assert.deepEqual(blocks['r/0/CONDITION'].inputs.KEY_OPTION, [3, [12, 'key', 'key-id'], 'r/0/CONDITION/KEY_OPTION/shadow']);
  assert.equal(blocks['r/0/CONDITION/KEY_OPTION/shadow'].parent, 'r/0/CONDITION');
  assert.equal(blocks['r/0/CONDITION/KEY_OPTION/shadow'].shadow, true);
  assert.deepEqual(blocks['r/1'].inputs['arg-id'], [3, [12, 'name', 'exact-id'], [10, '']]);
});

test('layout grid coordinates remain stable without changing the no-beautify caller path', () => {
  const a = beautifyLayout(0, 0, 6);
  const b = beautifyLayout(0, 3, 6);
  const c = beautifyLayout(0, 4, 6);
  assert.equal(a.x, 60);
  assert.equal(b.x, 60 + 3 * 480);
  assert.equal(c.y, 60 + 720);
  assert.ok(a.y < b.y || a.x !== b.x);
});
