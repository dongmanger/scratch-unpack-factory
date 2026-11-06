/**
 * Remove numeric-coercion wrappers that recovery adds around values.
 *
 * The compiler inserts casts on its own: `(+x || 0)` for a value used as a number, `toNotNaN(x)` where NaN
 * must become 0. A direct decode of that JavaScript is `x + 0` and `x * 1`, which is faithful but is not
 * what the author drew; the author just plugged `x` into the slot and the compiler added the cast. The
 * unwrapped graph is closer to the original, but it is only equivalent if the compiler casts it back.
 *
 * That holds only in a slot that converts its value to a number (src/irgen-slots.mjs). In a slot that passes the
 * value on as it is, a cast can only come from an arithmetic block the author wrote, so it stays.
 *
 * Nothing here is assumed safe. The transform is applied to IR that has not been emitted yet, and the
 * caller recompiles the result with the real compiler and keeps it only when the output factory is
 * unchanged (src/relaxed-recovery.mjs). A wrapper whose removal changes the generated code, such as one
 * around a literal or around an operand whose type the compiler could not infer, is rejected there.
 */
import {UNWRAP_SLOTS} from './irgen-slots.mjs';

const isDict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOpcodeNode = value => isDict(value) && typeof value.opcode === 'string';
const literalIs = (value, number) => isDict(value) && Object.hasOwn(value, 'literal') && Number(value.literal) === number &&
  (typeof value.literal === 'number' || value.literal === String(number));

/** Which wrapper `node` is: 'add' for `x + 0`, 'multiply' for `x * 1`, or null. Returns the wrapped operand too. */
function coercionOf(node) {
  if (!isOpcodeNode(node) || node.mutation || node.shadowInputs && Object.keys(node.shadowInputs).length) return null;
  const inputs = node.inputs || {};
  const isCoercion = (opcode, neutral) => node.opcode === opcode && Object.keys(inputs).length === 2 &&
    Object.hasOwn(inputs, 'NUM1') && Object.hasOwn(inputs, 'NUM2') && literalIs(inputs.NUM2, neutral);
  const kind = isCoercion('operator_add', 0) ? 'add' : isCoercion('operator_multiply', 1) ? 'multiply' : null;
  if (!kind) return null;
  const operand = inputs.NUM1;
  // A literal operand is a constant, not a cast of something typed elsewhere; leave it alone.
  if (isDict(operand) && Object.hasOwn(operand, 'literal')) return null;
  return {kind, operand};
}

/**
 * Unwrap what is nested inside `node`. `slot` is "opcode.INPUT" of the input `node` fills, or null for a
 * statement; a wrapper directly in it is only removed when that slot casts to a number itself and the wrapper's
 * kind is enabled.
 */
function unwrapNode(node, slot, enabled, stats) {
  const wrapper = slot && UNWRAP_SLOTS.has(slot) ? coercionOf(node) : null;
  const found = wrapper && enabled[wrapper.kind] ? wrapper : null;
  if (found) {
    stats.unwrapped++;
    stats[found.kind]++;
    return unwrapNode(found.operand, slot, enabled, stats);
  }
  if (!isOpcodeNode(node)) return node;
  const copy = {...node};
  if (node.inputs) {
    copy.inputs = Object.fromEntries(Object.entries(node.inputs).map(([name, value]) =>
      [name, isDict(value) ? unwrapNode(value, `${node.opcode}.${name}`, enabled, stats) : value]));
  }
  if (node.substacks) {
    copy.substacks = Object.fromEntries(Object.entries(node.substacks).map(([name, stack]) =>
      [name, Array.isArray(stack) ? stack.map(child => unwrapNode(child, null, enabled, stats)) : stack]));
  }
  return copy;
}

/**
 * @param {object[]} operations recovered IR
 * @param {{add?: boolean, multiply?: boolean}} [enabled] which wrapper kinds to remove: `x + 0` ('add') and `x * 1` ('multiply')
 * @returns {{operations:object[], stats:{unwrapped:number, add:number, multiply:number}}} a new IR; the input is not modified.
 */
export function unwrapCoercions(operations, {add = true, multiply = true} = {}) {
  const stats = {unwrapped: 0, add: 0, multiply: 0};
  const enabled = {add, multiply};
  return {operations: operations.map(operation => unwrapNode(operation, null, enabled, stats)), stats};
}
