import {createHash} from 'node:crypto';
import {buildRecoveredStack} from './recovered-blocks.mjs';
import {RECOVERY_OPCODE_SCHEMA} from './recovery-opcode-schema.mjs';

/**
 * Only rewrite a validated IR shape in an opcode-specific Boolean input, and
 * only when the retained reporter is itself proven to return a Boolean.
 * Comparison OPERAND1/OPERAND2 inputs are value inputs, despite their names.
 * The caller must first establish whole-project completeness, definition
 * resolution and semantic correctness; local IR validation cannot prove those.
 */
const BOOLEAN_INPUTS = new Map([
  ...['control_if', 'control_if_else', 'control_wait_until', 'control_repeat_until', 'control_while']
    .map(opcode => [opcode, ['CONDITION']]),
  ['operator_not', ['OPERAND']],
  ['operator_and', ['OPERAND1', 'OPERAND2']],
  ['operator_or', ['OPERAND1', 'OPERAND2']]
]);
const BOOLEAN_REPORTERS = new Set([
  'operator_not', 'operator_and', 'operator_or', 'operator_equals', 'operator_gt', 'operator_lt',
  'operator_contains', 'data_listcontainsitem', 'sensing_mousedown', 'sensing_keypressed',
  'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor', 'sensing_loud'
]);
export const BEAUTIFY_LIMITS = Object.freeze({maxDepth: 128, maxNodes: 50_000});
const isDict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, names) => Object.keys(value || {}).length === names.length &&
  names.every(name => Object.hasOwn(value || {}, name));

// Bound all traversal, including metadata and shared-node expansion, before
// structural validation or transformation. Reject accessors without reading them.
const validateOperations = operations => {
  if (!Array.isArray(operations)) throw new TypeError('operations: 必须是IR数组');
  let nodes = 0;
  const active = new Set();
  const visit = (value, depth) => {
    if (++nodes > BEAUTIFY_LIMITS.maxNodes) throw new RangeError('beautify: IR node limit exceeded');
    if (depth > BEAUTIFY_LIMITS.maxDepth) throw new RangeError('beautify: IR depth limit exceeded');
    if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return;
    if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('beautify: IR must contain plain data');
    }
    if (Array.isArray(value) && value.length > BEAUTIFY_LIMITS.maxNodes) throw new RangeError('beautify: IR node limit exceeded');
    if (active.has(value)) throw new TypeError('beautify: cyclic IR');
    active.add(value);
    try {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('beautify: IR accessors are unsupported');
        visit(descriptor.value, depth + 1);
      }
    } finally { active.delete(value); }
  };
  visit(operations, 0);
  // Reuse the graph emitter's strict IR checks before a rewrite could discard
  // invalid/ambiguous wrapper properties. This graph is private and temporary.
  const anchor = {next: null};
  buildRecoveredStack({target: {blocks: {anchor}}, operations, parentId: 'anchor',
    idFor: key => `beautify/${key}`, recordBlock() {}});
};

const provenBoolean = expression => {
  if (!isDict(expression) || !BOOLEAN_REPORTERS.has(expression.opcode) || expression.shadow || expression.mutation ||
      !sameKeys(expression.substacks, [])) return false;
  const schema = RECOVERY_OPCODE_SCHEMA[expression.opcode];
  if (!sameKeys(expression.inputs, schema.inputs) || !sameKeys(expression.fields, schema.fields)) return false;
  for (const [name, shadow] of Object.entries(expression.shadowInputs || {})) {
    const expected = schema.shadowInputs?.[name];
    if (!expected || shadow.opcode !== expected.opcode || !sameKeys(shadow.fields, [expected.field]) ||
        !sameKeys(shadow.inputs, []) || !sameKeys(shadow.shadowInputs, []) || shadow.mutation) return false;
  }
  return true;
};
const plainNot = expression => expression?.opcode === 'operator_not' && provenBoolean(expression) &&
  sameKeys(expression.shadowInputs, []);
const doubleNotInner = expression => {
  if (!plainNot(expression) || !plainNot(expression.inputs.OPERAND)) return null;
  const inner = expression.inputs.OPERAND.inputs.OPERAND;
  return provenBoolean(inner) ? inner : null;
};

const collapseBoolean = (expression, stats) => {
  const inner = doubleNotInner(expression);
  if (inner) {
    const collapsed = collapseBoolean(inner, stats);
    stats.doubleNotCollapsed++;
    return collapsed;
  }
  // Do not descend into value operands or unknown/malformed reporter shapes.
  const names = BOOLEAN_INPUTS.get(expression.opcode);
  if (!names || !provenBoolean(expression)) return expression;
  return {...expression, inputs: Object.fromEntries(Object.entries(expression.inputs).map(([name, value]) =>
    [name, names.includes(name) ? collapseBoolean(value, stats) : value]))};
};

const beautifyBlock = (node, stats) => {
  const beautified = {...node};
  const names = BOOLEAN_INPUTS.get(node.opcode) || [];
  if (node.inputs) beautified.inputs = Object.fromEntries(Object.entries(node.inputs).map(([name, value]) =>
    [name, names.includes(name) ? collapseBoolean(value, stats) : value]));
  if (node.substacks) beautified.substacks = Object.fromEntries(Object.entries(node.substacks).map(([name, stack]) =>
    [name, stack.map(child => beautifyBlock(child, stats))]));
  return beautified;
};

/** Validate the entire bounded IR first; never mutate the input or erase errors. */
export function beautifyOperations(operations) {
  validateOperations(operations);
  const stats = {doubleNotCollapsed: 0};
  return {operations: operations.map(operation => beautifyBlock(operation, stats)), stats};
}

/**
 * @deprecated Fixed-coordinate compatibility helper; it does not account for
 * graph/comment dimensions and cannot guarantee nonoverlap. Production layout
 * must use layoutRecoveredProject on the complete, validated emitted graph.
 */
export function beautifyLayout(index, scriptOrdinal, scriptCount) {
  const columns = 4;
  const columnWidth = 480;
  const rowHeight = 720;
  const ordinal = Number.isFinite(scriptOrdinal) ? scriptOrdinal : 0;
  const total = Number.isFinite(scriptCount) && scriptCount > 0 ? scriptCount : ordinal + 1;
  const x = 60 + (ordinal % columns) * columnWidth;
  const y = 60 + Math.floor(ordinal / columns) * rowHeight;
  return {x, y, ordinal, total, commentOffsetX: 300, commentOffsetY: 0};
}

/** 美化证据指纹：同一输入应产生同一计数组合。 */
export const beautifyFingerprint = stats =>
  `b1:${stats.doubleNotCollapsed}:${createHash('sha256').update(JSON.stringify(stats)).digest('hex').slice(0, 8)}`;
