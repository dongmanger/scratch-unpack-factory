import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {unwrapCoercions} from '../src/coercion-unwrap.mjs';
import {NUMBER_CAST_SLOTS, INDEX_CAST_SLOTS, TYPE_DRIVEN_SLOTS, UNWRAP_SLOTS, deriveCastSlots} from '../src/irgen-slots.mjs';

// IR helpers. `x` is a variable reference, `plus0(x)` is the `x + 0` recovery writes for the compiler's `(+x || 0)`.
const x = {variable: {name: 'x', id: 'vx'}};
const expression = (opcode, inputs = {}, fields = {}) => ({opcode, inputs, fields});
const plus0 = operand => expression('operator_add', {NUM1: operand, NUM2: {literal: 0}});
const times1 = operand => expression('operator_multiply', {NUM1: operand, NUM2: {literal: 1}});
const command = (opcode, inputs = {}, fields = {}, substacks = {}) => ({opcode, inputs, fields, substacks});

test('a wrapper in a slot that converts to a number is removed, and counted by kind', () => {
  const ops = [command('motion_movesteps', {STEPS: plus0(x)}), command('motion_changexby', {DX: times1(x)})];
  const out = unwrapCoercions(ops);
  assert.deepEqual(out.operations[0].inputs.STEPS, x);
  assert.deepEqual(out.operations[1].inputs.DX, x);
  assert.deepEqual(out.stats, {unwrapped: 2, add: 1, multiply: 1});
});

test('wrappers nested inside arithmetic are removed, as are stacked wrappers', () => {
  const nested = expression('operator_subtract', {NUM1: plus0(x), NUM2: expression('operator_multiply', {NUM1: times1(x), NUM2: {literal: 3}})});
  const out = unwrapCoercions([command('motion_setx', {X: nested})]).operations[0].inputs.X;
  assert.deepEqual(out, expression('operator_subtract', {NUM1: x, NUM2: expression('operator_multiply', {NUM1: x, NUM2: {literal: 3}})}));
  const stacked = unwrapCoercions([command('motion_setx', {X: plus0(plus0(x))})]);
  assert.deepEqual(stacked.operations[0].inputs.X, x);
  assert.equal(stacked.stats.unwrapped, 2);
});

test('a cast in a slot that passes its value on unconverted is the author\'s own block and stays', () => {
  // These compile a bare x as x, so `(+x || 0)` there can only come from an arithmetic block the author placed.
  const kept = [
    command('data_setvariableto', {VALUE: plus0(x)}, {VARIABLE: ['v', 'vv']}),
    command('data_replaceitemoflist', {INDEX: plus0(x), ITEM: plus0(x)}, {LIST: ['l', 'll']}),
    command('data_insertatlist', {INDEX: times1(x), ITEM: {literal: 'a'}}, {LIST: ['l', 'll']}),
    command('data_deleteoflist', {INDEX: plus0(x)}, {LIST: ['l', 'll']}),
    command('procedures_call', {arg0: plus0(x)}),
    command('looks_say', {MESSAGE: plus0(x)}),
    command('sound_setvolumeto', {VOLUME: plus0(x)})  // a compatibility-layer block: its inputs go through as they are
  ];
  const out = unwrapCoercions(kept);
  assert.deepEqual(out.operations, kept);
  assert.equal(out.stats.unwrapped, 0);
});

test('slots where the code generator adds the cast itself are unwrapped: item of list, comparisons, random, letter', () => {
  const ops = [command('data_setvariableto', {VALUE: expression('data_itemoflist', {INDEX: plus0(x)}, {LIST: ['l', 'll']})}, {VARIABLE: ['v', 'vv']}),
    command('control_if', {CONDITION: expression('operator_gt', {OPERAND1: plus0(x), OPERAND2: {literal: 5}})}, {}, {SUBSTACK: []}),
    command('data_setvariableto', {VALUE: expression('operator_random', {FROM: plus0(x), TO: {literal: 9}})}, {VARIABLE: ['v', 'vv']}),
    command('data_setvariableto', {VALUE: expression('operator_letter_of', {LETTER: plus0(x), STRING: {literal: 'abc'}})}, {VARIABLE: ['v', 'vv']})];
  const out = unwrapCoercions(ops).operations;
  assert.deepEqual(out[0].inputs.VALUE.inputs.INDEX, x);
  assert.deepEqual(out[1].inputs.CONDITION.inputs.OPERAND1, x);
  assert.deepEqual(out[2].inputs.VALUE.inputs.FROM, x);
  assert.deepEqual(out[3].inputs.VALUE.inputs.LETTER, x);
});

test('the same wrapper is kept in one slot and removed in another within one statement', () => {
  // set v to (x + 0) + ... : the outer value is raw (keep), the add's own operand converts (remove).
  const value = expression('operator_add', {NUM1: plus0(x), NUM2: {literal: 7}});
  const out = unwrapCoercions([command('data_setvariableto', {VALUE: value}, {VARIABLE: ['v', 'vv']})]).operations[0];
  assert.deepEqual(out.inputs.VALUE, expression('operator_add', {NUM1: x, NUM2: {literal: 7}}));
  const kept = unwrapCoercions([command('data_setvariableto', {VALUE: plus0(x)}, {VARIABLE: ['v', 'vv']})]).operations[0];
  assert.deepEqual(kept.inputs.VALUE, plus0(x));
});

test('substacks are searched with the slot rules of their own blocks', () => {
  const ops = [command('control_repeat', {TIMES: {literal: 3}}, {}, {SUBSTACK: [command('motion_movesteps', {STEPS: plus0(x)}), command('data_setvariableto', {VALUE: plus0(x)}, {VARIABLE: ['v', 'vv']})]})];
  const [loop] = unwrapCoercions(ops).operations;
  assert.deepEqual(loop.substacks.SUBSTACK[0].inputs.STEPS, x);
  assert.deepEqual(loop.substacks.SUBSTACK[1].inputs.VALUE, plus0(x));
});

test('each kind of wrapper can be switched off on its own', () => {
  const ops = [command('motion_movesteps', {STEPS: plus0(x)}), command('motion_changexby', {DX: times1(x)})];
  const onlyAdd = unwrapCoercions(ops, {multiply: false});
  assert.deepEqual(onlyAdd.operations[0].inputs.STEPS, x);
  assert.deepEqual(onlyAdd.operations[1].inputs.DX, times1(x));
  assert.deepEqual(onlyAdd.stats, {unwrapped: 1, add: 1, multiply: 0});
  const onlyMultiply = unwrapCoercions(ops, {add: false});
  assert.deepEqual(onlyMultiply.operations[0].inputs.STEPS, plus0(x));
  assert.deepEqual(onlyMultiply.operations[1].inputs.DX, x);
  assert.deepEqual(unwrapCoercions(ops, {add: false, multiply: false}).operations, ops);
});

test('only a real cast is removed: a literal operand, other constants, extra inputs and mutations are left alone', () => {
  const ops = [
    command('motion_movesteps', {STEPS: expression('operator_add', {NUM1: {literal: 4}, NUM2: {literal: 0}})}),    // 4 + 0 is a constant
    command('motion_movesteps', {STEPS: expression('operator_add', {NUM1: x, NUM2: {literal: 1}})}),               // x + 1
    command('motion_movesteps', {STEPS: expression('operator_multiply', {NUM1: x, NUM2: {literal: 2}})}),          // x * 2
    command('motion_movesteps', {STEPS: expression('operator_add', {NUM1: x, NUM2: {literal: 0}, NUM3: x})}),      // not a binary add
    command('motion_movesteps', {STEPS: {...plus0(x), mutation: {tagName: 'mutation'}}}),
    command('motion_movesteps', {STEPS: expression('operator_add', {NUM1: {literal: 0}, NUM2: x})})                // 0 + x: the neutral literal is on the left
  ];
  const out = unwrapCoercions(ops);
  assert.deepEqual(out.operations, ops);
  assert.equal(out.stats.unwrapped, 0);
});

test('the input IR is never modified', () => {
  const ops = [command('motion_movesteps', {STEPS: plus0(plus0(x))})];
  const before = JSON.stringify(ops);
  unwrapCoercions(ops);
  assert.equal(JSON.stringify(ops), before);
});

// The slot tables are read off the vendored compiler. If the vendored bundle changes, this fails until they are re-derived.
test('the slot tables equal what the vendored compiler declares', () => {
  const bundle = fs.readFileSync(new URL('../vendor/02-vm.cjs', import.meta.url), 'utf8');
  const derived = deriveCastSlots(bundle);
  assert.deepEqual([...derived.number].sort(), [...NUMBER_CAST_SLOTS].sort(), 'NUMBER_CAST_SLOTS');
  assert.deepEqual([...derived.index].sort(), [...INDEX_CAST_SLOTS].sort(), 'INDEX_CAST_SLOTS');
  assert.ok(derived.number.size > 30, 'the derivation found the arithmetic and motion slots');
});

test('the pass-through slots are not unwrap slots, and the type-driven ones are', () => {
  for (const slot of ['data_setvariableto.VALUE', 'data_replaceitemoflist.INDEX', 'data_replaceitemoflist.ITEM', 'data_addtolist.ITEM',
    'data_insertatlist.INDEX', 'data_deleteoflist.INDEX', 'looks_say.MESSAGE', 'procedures_return.VALUE', 'procedures_call.arg0']) {
    assert.equal(UNWRAP_SLOTS.has(slot), false, slot);
  }
  for (const slot of TYPE_DRIVEN_SLOTS) assert.ok(UNWRAP_SLOTS.has(slot), slot);
  for (const slot of NUMBER_CAST_SLOTS) assert.ok(UNWRAP_SLOTS.has(slot), slot);
  assert.equal(NUMBER_CAST_SLOTS.has('data_changevariableby.VALUE'), true, 'change by converts its amount itself');
});
