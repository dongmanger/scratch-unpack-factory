import {decodeCompatibilityArguments} from './recovery-opcode-schema.mjs';

// These standard hats have executable conditions and known, static arguments.
const executableOpcodes = new Set([
  'event_whengreaterthan', 'event_whentouchingobject', 'videoSensing_whenMotionGreaterThan'
]);
const edgeBindings = new Set(['resolvedValue', 'id', 'hasOldEdgeValue', 'oldEdgeValue', 'edgeWasActivated']);
const fail = message => { throw new Error(`Executable hat: ${message}`); };
const identifier = (node, name) => node?.type === 'Identifier' && node.name === name;
const literal = (node, value) => node?.type === 'Literal' && node.value === value;
const call = (node, name, count) => node?.type === 'CallExpression' && !node.optional &&
  identifier(node.callee, name) && node.arguments.length === count;
const method = (node, name, count) => node?.type === 'CallExpression' && !node.optional &&
  node.callee?.type === 'MemberExpression' && !node.callee.optional && !node.callee.computed &&
  identifier(node.callee.object, 'target') && identifier(node.callee.property, name) && node.arguments.length === count;
const not = (node, name) => node?.type === 'UnaryExpression' && node.operator === '!' && node.prefix && identifier(node.argument, name);
const yieldStatement = node => node?.type === 'ExpressionStatement' && node.expression?.type === 'YieldExpression' &&
  node.expression.delegate === false && node.expression.argument === null;
const constInitializer = (statement, name) => {
  const declaration = statement?.type === 'VariableDeclaration' && statement.kind === 'const' &&
    statement.declarations.length === 1 ? statement.declarations[0] : null;
  if (declaration?.type !== 'VariableDeclarator' || !identifier(declaration.id, name) || !declaration.init) {
    fail(`expected the compiler's const ${name} binding`);
  }
  return declaration.init;
};
const retirementGuard = statement => {
  const body = statement?.consequent;
  return statement?.type === 'IfStatement' && statement.alternate === null && body?.type === 'BlockStatement' &&
    body.body.length === 2 && body.body[0]?.type === 'ExpressionStatement' && call(body.body[0].expression, 'retire', 0) &&
    body.body[1]?.type === 'ReturnStatement' && body.body[1].argument === null;
};

// Inputs are still decoded by the caller's reporter policy. Before calling it,
// reject references captured by the edge block's consts (including later TDZ
// bindings), and optional execution which cannot be this compiler template.
function checkInput(node, locals, depth = 0) {
  if (depth > 64) fail('input AST exceeds the supported depth');
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ChainExpression' || node.optional || node.type === 'SpreadElement') {
    fail('optional execution or spread is unsupported');
  }
  if (node.type === 'Identifier' && locals.has(node.name)) fail(`input refers to local edge binding ${node.name}`);
  for (const [key, child] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
    if (key === 'key' && node.type === 'Property' && !node.computed && !node.shorthand) continue;
    if (Array.isArray(child)) {
      for (const item of child) if (item?.type) checkInput(item, locals, depth + 1);
    } else if (child?.type) checkInput(child, locals, depth + 1);
  }
}

/**
 * Decode only an initial, complete jsgen HAT_EDGE or HAT_PREDICATE statement
 * group. consumed counts outer statements (1 for the edge block, 2 for the
 * predicate if/yield). Any mismatch throws; no arbitrary condition is skipped.
 * Factory setup/helper bindings must already be validated by the caller.
 * reporter receives input AST nodes and must carry the caller's policy/budget.
 */
export function decodeExecutableHat({statements, opcodeAliases, hatOpcode, scriptId, reporter}) {
  if (!Array.isArray(statements) || !statements.length) fail('missing initial statements');
  if (!(opcodeAliases instanceof Map) || typeof reporter !== 'function') fail('expected opcodeAliases Map and reporter callback');
  if (!executableOpcodes.has(hatOpcode)) fail(`unsupported static hat opcode ${hatOpcode}`);
  if (typeof scriptId !== 'string' || !scriptId) fail('scriptId must be a nonempty string');

  let condition, consumed;
  const first = statements[0];
  const locals = first?.type === 'BlockStatement' ? edgeBindings : new Set();
  if ([...locals].some(name => opcodeAliases.has(name))) fail('edge bindings shadow a factory opcode alias');
  if (first?.type === 'BlockStatement') {
    const body = first.body;
    if (body.length !== 7) fail('edge block must contain exactly the seven compiler statements');
    condition = constInitializer(body[0], 'resolvedValue');
    if (!literal(constInitializer(body[1], 'id'), scriptId)) fail('edge ID differs from scriptId');
    const hasOld = constInitializer(body[2], 'hasOldEdgeValue');
    const old = constInitializer(body[3], 'oldEdgeValue');
    const activated = constInitializer(body[4], 'edgeWasActivated');
    if (!method(hasOld, 'hasEdgeActivatedValue', 1) || !identifier(hasOld.arguments[0], 'id') ||
        !method(old, 'updateEdgeActivatedValue', 2) || !identifier(old.arguments[0], 'id') || !identifier(old.arguments[1], 'resolvedValue') ||
        activated.type !== 'ConditionalExpression' || !identifier(activated.test, 'hasOldEdgeValue') ||
        activated.consequent?.type !== 'LogicalExpression' || activated.consequent.operator !== '&&' ||
        !not(activated.consequent.left, 'oldEdgeValue') || !identifier(activated.consequent.right, 'resolvedValue') ||
        !identifier(activated.alternate, 'resolvedValue') || !retirementGuard(body[5]) ||
        !not(body[5].test, 'edgeWasActivated') || !yieldStatement(body[6])) {
      fail('edge state, activation, retirement, or yield companions differ from jsgen');
    }
    consumed = 1;
  } else {
    if (!retirementGuard(first) || first.test?.type !== 'UnaryExpression' || first.test.operator !== '!' || !first.test.prefix ||
        !yieldStatement(statements[1])) fail('predicate requires the exact retirement guard followed by yield');
    condition = first.test.argument;
    consumed = 2;
  }

  // ADVANCED compatibility results receive this single Scratch boolean cast.
  if (call(condition, 'toBoolean', 1)) condition = condition.arguments[0];
  const invoke = condition?.type === 'YieldExpression' && condition.delegate === true ? condition.argument : null;
  if (!call(invoke, 'executeInCompatibilityLayer', 6) || invoke.arguments[0]?.type !== 'ObjectExpression' ||
      invoke.arguments[1]?.type !== 'Identifier' || locals.has(invoke.arguments[1].name) ||
      opcodeAliases.get(invoke.arguments[1].name) !== hatOpcode || !literal(invoke.arguments[2], false) ||
      !literal(invoke.arguments[3], false) || !literal(invoke.arguments[4], scriptId) || !literal(invoke.arguments[5], null)) {
    fail('condition must delegate to the matching opcode alias with exact flags, script ID, and null frame');
  }
  checkInput(invoke.arguments[0], locals);
  const hat = decodeCompatibilityArguments(hatOpcode, invoke.arguments[0].properties, reporter);
  for (const [name, menu] of Object.entries(hat.shadowInputs)) {
    const input = hat.inputs[name];
    if (!input || !Object.hasOwn(input, 'literal') || !['string', 'number'].includes(typeof input.literal) ||
        typeof input.literal === 'number' && (!Number.isFinite(input.literal) || Object.is(input.literal, -0))) {
      fail(`menu ${name} requires a literal; its dynamic shadow default is unavailable`);
    }
    menu.fields = {[menu.field]: [String(input.literal), null]};
    delete menu.field;
  }
  return {consumed, hat};
}
