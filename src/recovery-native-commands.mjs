import {RECOVERY_OPCODE_SCHEMA} from './recovery-opcode-schema.mjs';

// Source evidence: 02engine/scratch-vm/src/compiler/jsgen.js:38-39,
// 918-925, 1014-1053, 1089-1107, 1118-1167, 1210-1247, 1290-1302.
// Helper semantics: blocks/scratch3_looks.js:392-556,
// extensions/scratch3_pen/index.js:157-163, 521-788,
// blocks/scratch3_data.js:67-90, blocks/scratch3_control.js:140-192.
const effects = new Set(['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost']);
const colorParams = new Set(['color', 'saturation', 'brightness', 'transparency']);
const penHelpers = new Map([
  ['clear', ['pen_clear', 0]],
  ['_stamp', ['pen_stamp', 1]],
  ['_penDown', ['pen_penDown', 1]],
  ['_penUp', ['pen_penUp', 1]],
  ['_setPenColorToColor', ['pen_setPenColorToColor', 2, 'COLOR', 'value']],
  ['_changePenSizeBy', ['pen_changePenSizeBy', 2, 'SIZE', 'number']],
  ['_setPenSizeTo', ['pen_setPenSizeTo', 2, 'SIZE', 'number']],
  ['_changePenHueBy', ['pen_changePenHueBy', 2, 'HUE', 'number']],
  ['_setPenHueToNumber', ['pen_setPenHueToNumber', 2, 'HUE', 'number']],
  ['_changePenShadeBy', ['pen_changePenShadeBy', 2, 'SHADE', 'number']],
  ['_setPenShadeToNumber', ['pen_setPenShadeToNumber', 2, 'SHADE', 'number']]
]);
const knownCalls = new Set([
  'target.setEffect', 'target.setCostume',
  'runtime.ext_scratch3_looks._setCostume', 'runtime.ext_scratch3_looks._setBackdrop',
  'runtime.ext_scratch3_control._createClone', 'runtime.stopForTarget',
  'runtime.monitorBlocks.changeBlock', 'runtime.ext_pen._setOrChangeColorParam',
  ...[...penHelpers.keys()].map(name => `runtime.ext_pen.${name}`)
]);
const counterPath = 'runtime.ext_scratch3_control._counter';
const operation = (opcode, inputs = {}, fields = {}, shadowInputs) => {
  const schema = RECOVERY_OPCODE_SCHEMA[opcode];
  if (!schema || schema.inputs.length !== Object.keys(inputs).length ||
      schema.fields.length !== Object.keys(fields).length ||
      schema.inputs.some(key => !Object.hasOwn(inputs, key)) ||
      schema.fields.some(key => !Object.hasOwn(fields, key))) {
    throw new Error(`Native command schema mismatch: ${opcode}`);
  }
  return {opcode, inputs, fields, ...(shadowInputs ? {shadowInputs} : {})};
};

/**
 * Decode one expression AST, never source execution. Unknown expressions return
 * null; a recognized helper with unproved arguments calls fail. The containing
 * factory must establish unshadowed target/runtime/stage/thread bindings and
 * reject extra yields, side effects, and unknown statements. Paired visibility,
 * retirement, clone disposal, scheduling, and reporters belong to that caller.
 * Menu defaults are recoverable only for literal inputs.
 */
export function decodeNativeCommand(node, {project, targetIndex, reporter, chain, literal, identifier, member, numeric, fail, assume = fail}) {
  // chain() in the factory intentionally accepts static computed properties.
  // Check each segment as well, so optional calls/access and dynamic keys cannot
  // masquerade as the unconditional compiler helpers.
  const staticPath = value => {
    if (identifier(value)) return value.name;
    if (value?.type !== 'MemberExpression' || value.optional) return null;
    const base = staticPath(value.object);
    const key = value.computed ? (value.property?.type === 'Literal' && typeof literal(value.property) === 'string' ? literal(value.property) : null) :
      identifier(value.property) ? value.property.name : null;
    return base !== null && key !== null ? `${base}.${key}` : null;
  };
  const pathIs = (value, name) => chain(value) === name && staticPath(value) === name;
  const requireCall = (value, name, arity) => {
    if (value?.type !== 'CallExpression' || value.optional || !pathIs(value.callee, name) ||
        value.arguments.length !== arity || value.arguments.some(arg => !arg || arg.type === 'SpreadElement')) {
      fail(`${name}: expected exactly ${arity} ordinary arguments and an unconditional helper call`);
    }
  };
  const isLiteral = (value, expected) => value?.type === 'Literal' && literal(value) === expected;
  const isMember = (value, object, key) => member(value, object, key) && pathIs(value, `${object}.${key}`);
  const target = () => {
    const value = Number.isInteger(targetIndex) && project?.targets?.[targetIndex];
    if (!value || typeof value.isStage !== 'boolean') fail('Native command targetIndex/isStage is missing');
    return value;
  };

  // numeric() is a useful type hint, but includes number-or-NaN expressions.
  // Interpreter primitives cast NaN to zero; direct helpers do not all do so.
  // Only permit explicit Scratch casts or the same non-NaN proof used by the
  // factory reporter. Unknown arithmetic/math stays with the caller's fallback.
  const nonNaN = (value, depth = 0) => {
    if (!value || depth > 40) return false;
    if (value.type === 'Literal') return typeof literal(value) === 'number' && Number.isFinite(literal(value)) && !Object.is(literal(value), -0);
    if (value.type === 'UnaryExpression' && ['+', '-'].includes(value.operator)) return nonNaN(value.argument, depth + 1);
    if (value.type === 'LogicalExpression' && value.operator === '||' && isLiteral(value.right, 0) &&
        value.left?.type === 'UnaryExpression' && value.left.operator === '+') return true;
    if (value.type === 'CallExpression' && !value.optional) {
      const name = staticPath(value.callee);
      if (name === 'toNotNaN' && value.arguments.length === 1 && numeric(value.arguments[0])) return true;
      if (['Math.abs', 'Math.floor', 'Math.ceil', 'Math.round'].includes(name) && value.arguments.length === 1) return nonNaN(value.arguments[0], depth + 1);
    }
    return ['target.x', 'target.y', 'target.direction', 'target.size', 'target.volume', 'stage.tempo'].includes(staticPath(value));
  };
  const numberInput = value => {
    if (!numeric(value) || !nonNaN(value)) assume('Native numeric helper input lacks a non-NaN numeric type proof');
    return reporter(value, 'number');
  };
  const menuValue = value => {
    if (value?.type === 'Literal' && ['number', 'string'].includes(typeof literal(value)) &&
        (typeof literal(value) !== 'number' || Number.isFinite(literal(value)) && !Object.is(literal(value), -0))) return literal(value);
    if (value?.type === 'UnaryExpression' && value.operator === '-' && typeof literal(value.argument) === 'number') {
      const number = -literal(value.argument);
      if (Number.isFinite(number) && !Object.is(number, -0)) return number;
    }
    // A menu fed by a dynamic expression has no recoverable default: the saved default of the shadow
    // menu block is gone after compilation. The shadow is only read when no block covers the slot, and
    // here a block does, so any valid default recompiles identically. Strict mode still refuses.
    assume('Native menu input must be a finite numeric or string literal; dynamic saved defaults are unavailable');
    return '';
  };
  const menuOperation = (opcode, inputName, value, context = 'value', decodedInputs = {}) => {
    const defaultValue = menuValue(value);
    const definition = RECOVERY_OPCODE_SCHEMA[opcode].shadowInputs[inputName];
    return operation(opcode, {...decodedInputs, [inputName]: reporter(value, context)}, {}, {
      [inputName]: {opcode: definition.opcode, fields: {[definition.field]: [String(defaultValue), null]}}
    });
  };

  if (node?.type === 'AssignmentExpression' && chain(node.left) === counterPath) {
    if (node.operator !== '=' || !pathIs(node.left, counterPath) || !isLiteral(node.right, 0)) fail('Counter clear must be the exact _counter = 0 assignment');
    return operation('control_clear_counter');
  }
  if (node?.type === 'UpdateExpression' && chain(node.argument) === counterPath) {
    if (node.operator !== '++' || node.prefix !== false || !pathIs(node.argument, counterPath)) fail('Counter increment must be the exact postfix _counter++ expression');
    return operation('control_incr_counter');
  }
  if (node?.type !== 'CallExpression') return null;
  const name = chain(node.callee);
  if (!knownCalls.has(name)) return null;
  const args = node.arguments;

  if (name === 'target.setEffect') {
    requireCall(node, name, 2);
    const effect = literal(args[0]);
    if (args[0]?.type !== 'Literal' || !effects.has(effect)) fail('Effect must be a known lowercase literal');
    const clamp = args[1];
    requireCall(clamp, 'runtime.ext_scratch3_looks.clampEffect', 2);
    if (!isLiteral(clamp.arguments[0], effect)) fail('Effect clamp companion must name the same effect');
    const value = clamp.arguments[1];
    const change = value?.type === 'BinaryExpression' && value.operator === '+' && pathIs(value.right, `target.effects.${effect}`);
    return operation(change ? 'looks_changeeffectby' : 'looks_seteffectto', {
      [change ? 'CHANGE' : 'VALUE']: numberInput(change ? value.left : value)
    }, {EFFECT: [effect.toUpperCase(), null]});
  }

  if (name.startsWith('runtime.ext_pen.')) {
    if (name === 'runtime.ext_pen._setOrChangeColorParam') {
      requireCall(node, name, 4);
      if (args[0]?.type !== 'Literal' || !colorParams.has(literal(args[0]))) fail('Pen color parameter must be a known string literal');
      requireCall(args[2], 'runtime.ext_pen._getPenState', 1);
      if (!identifier(args[2].arguments[0], 'target')) fail('Pen state must be _getPenState(target)');
      if (args[3]?.type !== 'Literal' || typeof literal(args[3]) !== 'boolean') fail('Pen change flag must be a boolean literal');
      const value = numberInput(args[1]);
      return menuOperation(literal(args[3]) ? 'pen_changePenColorParamBy' : 'pen_setPenColorParamTo',
        'COLOR_PARAM', args[0], 'string', {VALUE: value});
    }
    const [opcode, arity, inputName, context] = penHelpers.get(name.slice('runtime.ext_pen.'.length));
    requireCall(node, name, arity);
    if (arity && !identifier(args.at(-1), 'target')) fail(`${name}: final argument must be target`);
    return operation(opcode, inputName ? {[inputName]: context === 'number' ? numberInput(args[0]) : reporter(args[0], context)} : {});
  }

  if (name === 'runtime.monitorBlocks.changeBlock') {
    requireCall(node, name, 2);
    if (!identifier(args[1], 'runtime') || args[0]?.type !== 'ObjectExpression' || args[0].properties.length !== 3) fail('Monitor helper requires the exact checkbox object and runtime argument');
    const values = new Map();
    for (const property of args[0].properties) {
      const key = identifier(property?.key) ? property.key.name : property?.key?.type === 'Literal' ? literal(property.key) : null;
      if (property?.type !== 'Property' || property.computed || property.method || property.shorthand || property.kind !== 'init' ||
          !['id', 'element', 'value'].includes(key) || values.has(key) || property.value?.type !== 'Literal') fail('Monitor checkbox object must contain distinct literal id/element/value data properties');
      values.set(key, literal(property.value));
    }
    const id = values.get('id');
    if (typeof id !== 'string' || !id || values.get('element') !== 'checkbox' || typeof values.get('value') !== 'boolean') fail('Monitor id/checkbox/boolean value types do not match compiler emissions');
    target();
    // monitorBlocks is indexed globally by ID, not by the executing target.
    // One owner and kind must also be reachable by the reconstructed SB3 field.
    const matches = [];
    for (const [index, owner] of project.targets.entries()) {
      for (const kind of ['variables', 'lists']) {
        if (Object.hasOwn(owner[kind] || {}, id)) matches.push({index, owner, kind, definition: owner[kind][id]});
      }
    }
    if (matches.length !== 1) fail(`Monitor ID ${id} has no unique original definition/kind/scope`);
    const {index, owner, kind, definition} = matches[0];
    if (index !== targetIndex && !owner.isStage) fail(`Monitor ID ${id} belongs to another sprite scope`);
    if (project.targets.filter(item => item.isStage).length !== 1 || !Array.isArray(definition) || typeof definition[0] !== 'string') fail('Monitor definition or stage scope is malformed');
    const field = kind === 'variables' ? 'VARIABLE' : 'LIST';
    const monitorOpcode = kind === 'variables' ? 'data_variable' : 'data_listcontents';
    const monitors = (project.monitors || []).filter(item => item.id === id);
    if (monitors.length > 1) fail(`Monitor ID ${id} has duplicate runtime metadata`);
    if (monitors.length && (monitors[0].opcode !== monitorOpcode || monitors[0].params?.[field] !== definition[0] ||
        (owner.isStage ? monitors[0].spriteName != null : monitors[0].spriteName !== owner.name))) fail(`Monitor ID ${id} runtime metadata conflicts with its original definition/scope`);
    return operation(kind === 'variables' ? values.get('value') ? 'data_showvariable' : 'data_hidevariable' :
      values.get('value') ? 'data_showlist' : 'data_hidelist', {}, {[field]: [definition[0], id]});
  }

  if (name === 'runtime.stopForTarget') {
    requireCall(node, name, 2);
    if (!identifier(args[0], 'target') || !identifier(args[1], 'thread')) fail('Stop others requires exactly target and thread exception');
    return operation('control_stop', {}, {STOP_OPTION: [target().isStage ? 'other scripts in stage' : 'other scripts in sprite', null]});
  }
  if (name === 'runtime.ext_scratch3_control._createClone') {
    requireCall(node, name, 2);
    if (!identifier(args[1], 'target') || args[0]?.type !== 'Literal' || typeof literal(args[0]) !== 'string') fail('Clone helper requires a literal string menu and target');
    return menuOperation('control_create_clone_of', 'CLONE_OPTION', args[0], 'string');
  }
  if (name === 'target.setCostume') {
    requireCall(node, name, 1);
    const value = args[0];
    if (value?.type !== 'BinaryExpression' || value.operator !== '+' || !isMember(value.left, 'target', 'currentCostume') || !isLiteral(value.right, 1)) fail('Next costume requires target.currentCostume + 1');
    return operation('looks_nextcostume');
  }
  if (name === 'runtime.ext_scratch3_looks._setCostume') {
    requireCall(node, name, 2);
    if (!identifier(args[0], 'target')) fail('Costume helper requires target');
    return menuOperation('looks_switchcostumeto', 'COSTUME', args[1]);
  }
  // Only next backdrop has the compiler's third, zero-index flag.
  requireCall(node, name, args.length === 3 ? 3 : 2);
  if (!identifier(args[0], 'stage')) fail('Backdrop helper requires stage');
  if (args.length === 3) {
    const value = args[1];
    if (!isLiteral(args[2], true) || value?.type !== 'BinaryExpression' || value.operator !== '+' ||
        !isMember(value.left, 'stage', 'currentCostume') || !isLiteral(value.right, 1)) fail('Next backdrop requires stage.currentCostume + 1 and true zero-index flag');
    return operation('looks_nextbackdrop');
  }
  return menuOperation('looks_switchbackdropto', 'BACKDROP', args[1]);
}
