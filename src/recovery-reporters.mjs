const recoveryReporterIR = (opcode, inputs = {}, fields = {}) => ({opcode, inputs, fields});
const recoveryReporterProperty = node => node?.type === 'MemberExpression' && !node.optional ?
  (node.computed ? node.property?.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null :
    node.property?.type === 'Identifier' ? node.property.name : null) : null;
const recoveryReporterCall = node => node?.type === 'CallExpression' && !node.optional;
const recoveryReporterBinary = (node, operator) => node?.type === 'BinaryExpression' && node.operator === operator;
const recoveryReporterNumber = (node, literal) => {
  if (typeof literal(node) === 'number') return literal(node);
  if (node?.type === 'UnaryExpression' && node.operator === '-' && typeof literal(node.argument) === 'number') {
    return -literal(node.argument);
  }
  return undefined;
};

/**
 * Additional, exact jsgen reporter templates. Call before the core decoder's
 * generic member/binary/call cases. Helpers and target/runtime/stage bindings
 * must already be validated by the factory decoder (including shadowing).
 * reporter must re-enter that decoder, carrying its budget/depth, with the
 * supplied 'value', 'string', or 'number' context. Unknown templates return null;
 * recognized but unproved templates fail, leaving the whole source preserved.
 * RGB arrays/casts are only decoded inside color consumers, never as scalars.
 */
export function decodeAdditionalReporter(node, {
  project, targetIndex, reporter, chain, literal, identifier, member, numeric, nonNaN, fail, assume = fail
}) {
  const arity = (callNode, count) => {
    if (!recoveryReporterCall(callNode) || callNode.arguments.length !== count ||
        callNode.arguments.some(argument => argument?.type === 'SpreadElement')) {
      fail('Additional reporter helper has unsupported arity, spread, or optional call');
    }
  };
  const staticPath = (expression, depth = 0) => {
    if (!expression || depth > 32) return null;
    if (identifier(expression)) return expression.name;
    const key = recoveryReporterProperty(expression);
    if (key === null) return null;
    const base = staticPath(expression.object, depth + 1);
    return base === null ? null : `${base}.${key}`;
  };
  const path = callNode => recoveryReporterCall(callNode) && staticPath(callNode.callee) === chain(callNode.callee) ? staticPath(callNode.callee) : null;
  const exactMember = (expression, scope, key) => member(expression, scope, key) && staticPath(expression) === `${scope}.${key}`;
  const lookup = (mapping, key) => Object.hasOwn(mapping, key) ? mapping[key] : null;
  const methodObject = (callNode, name, count) => {
    if (!recoveryReporterCall(callNode) || recoveryReporterProperty(callNode.callee) !== name) return null;
    arity(callNode, count);
    return callNode.callee.object;
  };

  const costumeNameScope = expression => {
    if (recoveryReporterProperty(expression) !== 'name') return null;
    const index = expression.object;
    if (index?.type !== 'MemberExpression' || !index.computed || index.optional) return null;
    const costumes = index.object;
    for (const scope of ['target', 'stage']) {
      if (recoveryReporterCall(costumes) && exactMember(costumes.callee, scope, 'getCostumes') &&
          exactMember(index.property, scope, 'currentCostume')) {
        arity(costumes, 0);
        return scope;
      }
    }
    return null;
  };
  const stringProof = (expression, depth = 0) => {
    if (!expression || depth > 32) return false;
    if (typeof literal(expression) === 'string') return true;
    if (recoveryReporterBinary(expression, '+')) {
      if (literal(expression.left) === '') return true;
      return stringProof(expression.left, depth + 1) && stringProof(expression.right, depth + 1);
    }
    if (chain(expression) === 'runtime.ext_scratch3_sensing._answer' || costumeNameScope(expression)) return true;
    return path(expression) === 'runtime.ioDevices.userData.getUsername' && expression.arguments.length === 0;
  };
  const stringInput = expression => {
    if (!stringProof(expression)) assume('Native string reporter needs a proven string or explicit compiler string cast');
    return reporter(expression, 'string');
  };
  const mathInput = expression => {
    // numeric() alone also admits NaN-producing Math chains and raw unary +.
    // Scratch mathop recasts NaN to zero; JS Math does not.
    if (!numeric(expression) || !nonNaN(expression)) assume('Native math input lacks numeric/non-NaN proof');
    return reporter(expression, 'number');
  };
  const mathReporter = (operator, input) => recoveryReporterIR('operator_mathop', {NUM: mathInput(input)}, {OPERATOR: [operator, null]});
  const dateMethod = expression => {
    if (!recoveryReporterCall(expression)) return null;
    const constructor = expression.callee?.object;
    if (constructor?.type !== 'NewExpression' || !identifier(constructor.callee, 'Date')) return null;
    if (constructor.arguments.length) fail('Date selector requires new Date() with no constructor arguments');
    arity(expression, 0);
    return recoveryReporterProperty(expression.callee);
  };
  const rgbArray = expression => {
    if (expression?.type !== 'ArrayExpression') return null;
    if (expression.elements.length !== 3 || expression.elements.some(element =>
      element?.type !== 'Literal' || typeof literal(element) !== 'number' ||
      !Number.isInteger(literal(element)) || literal(element) < 0 || literal(element) > 255 || Object.is(literal(element), -0))) {
      fail('RGB color constant must contain exactly three literal integer bytes');
    }
    return {literal: `#${expression.elements.map(element => literal(element).toString(16).padStart(2, '0')).join('')}`};
  };
  const literalColor = expression => {
    const direct = rgbArray(expression);
    if (direct) return direct;
    if (path(expression) === 'colorToList') {
      arity(expression, 1);
      const source = expression.arguments[0];
      const value = literal(source);
      if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) return {literal: value.toLowerCase()};
      if (typeof value === 'string' && /^#[\da-f]{3}$/i.test(value)) {
        return {literal: `#${[...value.slice(1).toLowerCase()].map(byte => byte + byte).join('')}`};
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff && !Object.is(value, -0)) {
        return {literal: `#${value.toString(16).padStart(6, '0')}`};
      }
      fail('colorToList recovery requires a strict literal hex color or unsigned 24-bit integer');
    }
    fail('Touching-color recovery requires a literal compiler RGB constant or literal colorToList cast');
  };

  const nameScope = costumeNameScope(node);
  if (nameScope) return recoveryReporterIR(nameScope === 'target' ? 'looks_costumenumbername' : 'looks_backdropnumbername', {}, {NUMBER_NAME: ['name', null]});

  if (recoveryReporterBinary(node, '+') && literal(node.right) === 1) {
    for (const scope of ['target', 'stage']) {
      if (exactMember(node.left, scope, 'currentCostume')) {
        return recoveryReporterIR(scope === 'target' ? 'looks_costumenumbername' : 'looks_backdropnumbername', {}, {NUMBER_NAME: ['number', null]});
      }
    }
    const date = lookup({getMonth: 'month', getDay: 'dayofweek'}, dateMethod(node.left));
    if (date) return recoveryReporterIR('sensing_current', {}, {CURRENTMENU: [date, null]});
  }
  const date = lookup({getFullYear: 'year', getDate: 'date', getHours: 'hour', getMinutes: 'minute', getSeconds: 'second'}, dateMethod(node));
  if (date) return recoveryReporterIR('sensing_current', {}, {CURRENTMENU: [date, null]});

  if (recoveryReporterBinary(node, '!==') && recoveryReporterNumber(node.right, literal) === -1) {
    const haystack = methodObject(node.left, 'indexOf', 1);
    if (haystack) {
      const first = methodObject(haystack, 'toLowerCase', 0);
      const second = methodObject(node.left.arguments[0], 'toLowerCase', 0);
      if (!first || !second) fail('Contains requires symmetric compiler toLowerCase calls');
      return recoveryReporterIR('operator_contains', {STRING1: stringInput(first), STRING2: stringInput(second)});
    }
  }

  if (node?.type === 'LogicalExpression' && node.operator === '||' && literal(node.right) === '' &&
      node.left?.type === 'MemberExpression' && node.left.computed && !node.left.optional) {
    let scratchIndex;
    if (recoveryReporterBinary(node.left.property, '-') && literal(node.left.property.right) === 1) {
      // Unfolded compiler output keeps the original Scratch index as N - 1.
      const index = node.left.property.left;
      const int32 = recoveryReporterBinary(index, '|') && literal(index.right) === 0;
      const rawIndex = int32 ? index.left : index;
      const input = rawIndex?.type === 'UnaryExpression' && rawIndex.operator === '+' ? rawIndex.argument : rawIndex;
      scratchIndex = recoveryReporterNumber(input, literal);
      if (typeof scratchIndex !== 'number') {
        // `letter N of S` compiles to `(S)[N - 1] || ""` (jsgen OP_LETTER_OF). The index is an arbitrary
        // numeric block, and JS indexing treats fractions, negatives and NaN differently from a
        // Scratch index, so strict mode refuses; relaxed mode takes the block and lets the oracle decide.
        assume('Letter index requires a finite literal integer in the safe nonnegative int32 range');
        return recoveryReporterIR('operator_letter_of', {LETTER: reporter(input, 'number'), STRING: stringInput(node.left.object)});
      }
    } else {
      // Constant folding turns `N - 1` into a zero-based literal array index.
      const zeroBasedIndex = recoveryReporterNumber(node.left.property, literal);
      if (typeof zeroBasedIndex !== 'number' || !Number.isFinite(zeroBasedIndex) ||
          !Number.isInteger(zeroBasedIndex) || zeroBasedIndex < 0 || zeroBasedIndex > 2147483646 ||
          Object.is(zeroBasedIndex, -0)) {
        fail('Letter index requires a finite literal integer in the safe nonnegative int32 range');
      }
      scratchIndex = zeroBasedIndex + 1;
    }
    if (typeof scratchIndex !== 'number' || !Number.isFinite(scratchIndex) || !Number.isInteger(scratchIndex) ||
        scratchIndex < 0 || scratchIndex > 2147483647 || Object.is(scratchIndex, -0)) {
      fail('Letter index requires a finite literal integer in the safe nonnegative int32 range');
    }
    // The int32 wrapper is redundant only after this range proof. Never let a
    // dynamic, fractional, NaN, Infinity, or wrapped index acquire charAt semantics.
    return recoveryReporterIR('operator_letter_of', {LETTER: {literal: scratchIndex}, STRING: stringInput(node.left.object)});
  }

  if (recoveryReporterBinary(node, '/')) {
    if (exactMember(node.right, 'Math', 'LN10') && path(node.left) === 'Math.log') {
      arity(node.left, 1);
      return mathReporter('log', node.left.arguments[0]);
    }
    if (exactMember(node.right, 'Math', 'PI') && recoveryReporterBinary(node.left, '*') && literal(node.left.right) === 180) {
      const inverse = node.left.left;
      const operator = lookup({'Math.asin': 'asin', 'Math.acos': 'acos', 'Math.atan': 'atan'}, path(inverse));
      if (operator) {
        arity(inverse, 1);
        return mathReporter(operator, inverse.arguments[0]);
      }
    }
    if (literal(node.right) === 1e10 && path(node.left) === 'Math.round') {
      arity(node.left, 1);
      const scaled = node.left.arguments[0];
      if (recoveryReporterBinary(scaled, '*') && literal(scaled.right) === 1e10) {
        const trig = scaled.left;
        const operator = lookup({'Math.sin': 'sin', 'Math.cos': 'cos'}, path(trig));
        if (operator) {
          arity(trig, 1);
          const radians = trig.arguments[0];
          if (recoveryReporterBinary(radians, '/') && literal(radians.right) === 180 &&
              recoveryReporterBinary(radians.left, '*') && exactMember(radians.left.left, 'Math', 'PI')) {
            return mathReporter(operator, radians.left.right);
          }
        }
      }
    }
  }

  const callName = path(node);
  if (callName === 'runtime.ioDevices.keyboard.getKeyIsDown') {
    arity(node, 1);
    return recoveryReporterIR('sensing_keypressed', {KEY_OPTION: reporter(node.arguments[0], 'value')});
  }
  if (callName === 'runtime.ioDevices.userData.getUsername' || callName === 'daysSince2000') {
    arity(node, 0);
    return recoveryReporterIR(callName === 'daysSince2000' ? 'sensing_dayssince2000' : 'sensing_username');
  }
  if (callName === 'distance') {
    arity(node, 1);
    return recoveryReporterIR('sensing_distanceto', {DISTANCETOMENU: stringInput(node.arguments[0])});
  }
  if (callName === 'target.isTouchingObject') {
    arity(node, 1);
    return recoveryReporterIR('sensing_touchingobject', {TOUCHINGOBJECTMENU: reporter(node.arguments[0], 'value')});
  }
  if (callName === 'target.isTouchingColor') {
    arity(node, 1);
    return recoveryReporterIR('sensing_touchingcolor', {COLOR: literalColor(node.arguments[0])});
  }
  if (callName === 'target.colorIsTouchingColor') {
    arity(node, 2);
    return recoveryReporterIR('sensing_coloristouchingcolor', {COLOR: literalColor(node.arguments[1]), COLOR2: literalColor(node.arguments[0])});
  }

  // Basic Math helpers, casts, comparisons, length, size and existing sensing
  // remain owned by compiled-factory. SENSING_OF alias/conditional templates
  // require factory initialization metadata absent from this API. Preserve them.
  return null;
}
