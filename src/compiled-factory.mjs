import {parse} from 'acorn';
import {scopedDefinition, broadcastByLiteral, failRecovery as fail} from './recovery-symbols.mjs';
import {decodeCompatibilityArguments} from './recovery-opcode-schema.mjs';
import {decodeNativeCommand} from './recovery-native-commands.mjs';
import {decodeAdditionalReporter} from './recovery-reporters.mjs';
import {decodeExecutableHat} from './recovery-executable-hats.mjs';
import {populateRecoveredMenus} from './recovery-menus.mjs';

const identifier = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);
const propertyName = node => node?.type === 'MemberExpression' ?
  (node.computed ? node.property?.type === 'Literal' ? String(node.property.value) : null : node.property?.name) : null;
const member = (node, object, key) => node?.type === 'MemberExpression' && identifier(node.object, object) && propertyName(node) === key;
const call = (node, name) => node?.type === 'CallExpression' && identifier(node.callee, name);
const chain = node => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && propertyName(node) !== null ? `${chain(node.object)}.${propertyName(node)}` : null;
const literal = node => node?.type === 'Literal' ? node.value : undefined;
const same = (left, right) => {
  const clean = node => JSON.stringify(node, (key, value) => ['start', 'end', 'loc', 'raw'].includes(key) ? undefined : value);
  return !!left && !!right && clean(left) === clean(right);
};
const expression = (opcode, inputs = {}, fields = {}) => ({opcode, inputs, fields});
const command = (opcode, inputs = {}, fields = {}, substacks = {}) => ({opcode, inputs, fields, substacks});
const reservedHelpers = new Set(['Math', 'retire', 'startHats', 'waitThreads', 'isStuck', 'toBoolean', 'toNotNaN',
  'compareEqual', 'compareGreaterThan', 'compareLessThan', 'random', 'randomInt', 'randomFloat', 'mod',
  'listGet', 'listContents', 'listContains', 'listIndexOf', 'listDelete', 'listInsert', 'listReplace',
  'executeInCompatibilityLayer', 'limitPrecision', 'tan', 'timer', 'hasResumedFromPromise', 'Date', 'distance', 'daysSince2000', 'colorToList']);

/**
 * Spelling preferences relaxed decoding can apply. Each is a choice between blocks that compute the same thing,
 * made in favour of the one authors write more often, and each can be switched off independently for an item.
 * 'unwrap-times' (`x * 1` -> x) and 'unwrap-plus' (`x + 0` -> x) are applied after decoding
 * (src/coercion-unwrap.mjs) but are listed here so the oracle treats every preference the same way. The order is
 * the order in which the oracle gives them up when an item is not reproduced: the one most often responsible first.
 */
export const PREFERENCE_KINDS = Object.freeze(['unwrap-times', 'unwrap-plus', 'halving', 'boolean-slot', 'boolean-constant', 'stop-this-script', 'change-by', 'delete-all']);

/** Decode explicit compiler patterns without running factorySource or guessing unknown statements. */
export function decodeCompiledFactory(source, project, targetIndex, {procedure = null, signatures = new Map(), executableHat = null, relaxed = false, preferencesOff = null} = {}) {
  if (typeof source !== 'string' || source.length > 2_000_000) fail('factorySource 缺失或超过静态分析上限');
  // Strict mode refuses any construct whose JavaScript semantics could differ from the Scratch block it
  // resembles (int32 vs floor indices, NaN handling, native string comparison...). Relaxed mode records
  // the unproven step in `assumptions` and decodes the most likely block instead. The result is only a
  // hypothesis: the caller must not accept it without confirming that the real compiler turns the
  // recovered blocks back into this very factory (src/recompile-oracle.mjs). Structural failures, such
  // as an unknown statement or an unresolved variable, always stay fatal in both modes.
  const assumptions = [];
  const assume = reason => { if (!relaxed) fail(reason); assumptions.push(reason); };
  // A *preference* is not an assumption. The strict spelling is perfectly decodable; relaxed mode merely
  // swaps it for the one authors use more often (`change v by x` instead of `set v to (v + x)`). If the
  // oracle does not confirm the preferred spelling, the item falls back to the strict one instead of being
  // dropped, so an item that strict recovery could decode is never lost to a preference.
  // Every preference has a kind (PREFERENCE_KINDS). The caller turns kinds off per item with `preferencesOff`
  // (a Set of kinds; '*' switches all of them off), so one spelling the compiler does not reproduce does not
  // cost the item the other spellings that it does.
  const preferences = [];
  const preferenceKinds = new Set();
  const prefer = (kind, reason) => {
    if (!relaxed || preferencesOff?.has('*') || preferencesOff?.has(kind)) return false;
    preferences.push(reason);
    preferenceKinds.add(kind);
    return true;
  };
  const ast = parse(source, {ecmaVersion: 'latest'});
  const factory = ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement' ? ast.body[0].expression : null;
  if (factory?.type !== 'FunctionExpression' || factory.async || factory.generator ||
      factory.params.length !== 1 || !identifier(factory.params[0], 'thread')) fail('不是已支持的明文 factory 模板；可能仍有混淆');
  if (factory.id && (reservedHelpers.has(factory.id.name) || ['thread', 'target', 'runtime', 'stage'].includes(factory.id.name))) fail('factory命名遮蔽核心作用域/运行时helper');
  const aliases = new Map();
  const opcodeAliases = new Map();
  const targetAliases = new Map([['stage', '_stage_']]);
  const attributeAliases = new Map();
  const declared = new Set(['thread']);
  let hasTarget = false, hasRuntime = false, hasStage = false, script;
  for (const statement of factory.body.body) {
    if (statement.type === 'ReturnStatement') {
      if (script || statement !== factory.body.body.at(-1)) fail('factory 有额外返回/执行代码');
      script = statement.argument;
      continue;
    }
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') fail('未知 factory 初始化语句');
    for (const declaration of statement.declarations) {
      const name = declaration.id?.name;
      const init = declaration.init;
      if (!identifier(declaration.id) || declared.has(name) || reservedHelpers.has(name)) fail('未知/重复初始化绑定或helper被遮蔽');
      declared.add(name);
      if (name === 'target' && member(init, 'thread', 'target')) { hasTarget = true; continue; }
      if (name === 'runtime' && hasTarget && member(init, 'target', 'runtime')) { hasRuntime = true; continue; }
      if (name === 'stage' && hasRuntime && init?.type === 'CallExpression' &&
          member(init.callee, 'runtime', 'getTargetForStage') && !init.arguments.length) { hasStage = true; continue; }
      if (init?.type === 'MemberExpression' && propertyName(init) !== null &&
          (member(init.object, 'target', 'variables') || member(init.object, 'stage', 'variables'))) {
        const scope = init.object.object.name;
        if (scope === 'target' ? !hasTarget : !hasStage) fail('变量作用域尚未初始化');
        const id = propertyName(init);
        const index = scope === 'stage' ? project.targets.findIndex(target => target.isStage) : targetIndex;
        const kind = Object.hasOwn(project.targets[index]?.variables || {}, id) ? 'variables' : 'lists';
        aliases.set(name, scopedDefinition(project, targetIndex, scope, kind, id));
        continue;
      }
      if (init?.type === 'CallExpression' && member(init.callee, 'runtime', 'getSpriteTargetByName') &&
          init.arguments.length === 1 && typeof literal(init.arguments[0]) === 'string') {
        if (literal(init.arguments[0]) === '_stage_') fail('sensing_of角色名称与保留舞台标记_stage_冲突，拒绝猜测对象归属');
        const matches = project.targets.filter(target => !target.isStage && target.name === literal(init.arguments[0]));
        if (matches.length !== 1) fail('sensing_of角色名称缺失或不唯一');
        targetAliases.set(name, matches[0].name);
        continue;
      }
      if (init?.type === 'LogicalExpression' && init.operator === '&&' && identifier(init.left) && targetAliases.has(init.left.name) &&
          init.right?.type === 'CallExpression' && member(init.right.callee, init.left.name, 'lookupVariableByNameAndType') &&
          init.right.arguments.length === 3 && typeof literal(init.right.arguments[0]) === 'string' && literal(init.right.arguments[1]) === '' && literal(init.right.arguments[2]) === true) {
        attributeAliases.set(name, {target: targetAliases.get(init.left.name), property: literal(init.right.arguments[0])});
        continue;
      }
      if (init?.type === 'CallExpression' && member(init.callee, 'runtime', 'getOpcodeFunction') &&
          init.arguments.length === 1 && typeof literal(init.arguments[0]) === 'string') {
        opcodeAliases.set(name, literal(init.arguments[0]));
        continue;
      }
      fail(`不支持的 factory 初始化 ${name}`);
    }
  }
  if (!hasTarget || !hasRuntime || !hasStage || script?.type !== 'FunctionExpression' || script.async ||
      script.params.length !== (procedure?.types.length || 0) || script.params.some(parameter => parameter.type !== 'Identifier')) {
    // Parameter *names* are not part of the shape: strong obfuscation renames `p0` to `_0x3e36b5`, and only
    // the arity and the position of each argument carry meaning. The names are read positionally below.
    fail('factory/script 结构不完整或过程参数形状不一致');
  }
  const isWarp = !!procedure?.warp;
  if (script.id && (declared.has(script.id.name) || reservedHelpers.has(script.id.name))) fail('返回函数命名遮蔽变量或运行时helper');
  for (const parameter of script.params) {
    if (declared.has(parameter.name) || reservedHelpers.has(parameter.name)) fail('过程参数遮蔽绑定');
    declared.add(parameter.name);
  }
  const syntheticMenuDefaults = [];
  const menus = operation => populateRecoveredMenus(operation, project, targetIndex, data => syntheticMenuDefaults.push(data));
  let steps = 0;
  const tick = depth => { if (++steps > 50000 || depth > 64) fail('积木恢复 AST 预算耗尽'); };
  const definitionOf = node => identifier(node) ? aliases.get(node.name) : undefined;
  const valueDefinition = node => node?.type === 'MemberExpression' && propertyName(node) === 'value' ? definitionOf(node.object) : undefined;
  const literalValue = node => {
    if (node?.type === 'Literal' && ['number', 'string'].includes(typeof node.value)) {
      if (typeof node.value === 'number' && (!Number.isFinite(node.value) || Object.is(node.value, -0))) fail('非有限数值或负零不在精确保真模板内');
      return {literal: node.value};
    }
    if (node?.type === 'UnaryExpression' && node.operator === '-' && typeof literal(node.argument) === 'number') {
      const number = -literal(node.argument);
      if (!Number.isFinite(number) || Object.is(number, -0)) fail('负零/非有限值不能在当前literal模板中精确保真');
      return {literal: number};
    }
    return null;
  };
  const numberCast = node => node?.type === 'LogicalExpression' && node.operator === '||' && literal(node.right) === 0 &&
    node.left?.type === 'UnaryExpression' && node.left.operator === '+' ? node.left.argument :
    call(node, 'toNotNaN') && node.arguments.length === 1 ? node.arguments[0] : null;
  const stringCast = node => node?.type === 'BinaryExpression' && node.operator === '+' && literal(node.left) === '' ? node.right : null;
  // `letter N of S` compiles to `(S)[N - 1] || ""` (jsgen OP_LETTER_OF): the result is always a string.
  const isLetterOf = node => node?.type === 'LogicalExpression' && node.operator === '||' && literal(node.right) === '' &&
    node.left?.type === 'MemberExpression' && node.left.computed && !node.left.optional;
  const isStringTyped = node => typeof literal(node) === 'string' || !!stringCast(node) || isLetterOf(node);
  const numeric = (node, depth = 0) => {
    tick(depth);
    return !!numberCast(node) || !!(node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) ||
      typeof literal(node) === 'number' || ['target.x', 'target.y', 'target.direction', 'target.size', 'target.volume', 'stage.tempo'].includes(chain(node)) ||
      node?.type === 'CallExpression' && ['Math.abs', 'Math.floor', 'Math.ceil', 'Math.round', 'Math.sqrt', 'Math.log', 'Math.exp', 'random', 'mod', 'listIndexOf'].includes(chain(node.callee)) ||
      node?.type === 'MemberExpression' && propertyName(node) === 'length' ||
      // jsgen OP_ADD/SUBTRACT/MULTIPLY/DIVIDE return numbers for numeric
      // operands, possibly NaN. This is a type proof only, NOT nonNaN proof;
      // reporter() still checks every arithmetic operand before emitting it.
      node?.type === 'BinaryExpression' && ['+', '-', '*', '/'].includes(node.operator) &&
        numeric(node.left, depth + 1) && numeric(node.right, depth + 1);
  };
  const nonNaN = (node, depth = 0) => {
    if (++steps > 50000) fail('积木恢复 AST 预算耗尽');
    if (!node || depth > 40) return false;
    if (numberCast(node)) return true;
    if (typeof literal(node) === 'number') return Number.isFinite(literal(node));
    if (node.type === 'UnaryExpression' && node.operator === '-') return nonNaN(node.argument, depth + 1);
    if (node.type === 'CallExpression' && ['Math.abs', 'Math.floor', 'Math.ceil', 'Math.round'].includes(chain(node.callee))) return node.arguments.length === 1 && nonNaN(node.arguments[0], depth + 1);
    return ['target.x', 'target.y', 'target.direction', 'target.size'].includes(chain(node));
  };
  const toLower = node => node?.type === 'CallExpression' && propertyName(node.callee) === 'toLowerCase' && !node.arguments.length ? node.callee.object : null;
  const isBoolean = (node, depth = 0) => {
    if (++steps > 50000) fail('积木恢复 AST 预算耗尽');
    if (!node || depth > 40) return false;
    if (typeof literal(node) === 'boolean') return true;
    if (procedure && identifier(node) && script.params.some(parameter => parameter.name === node.name)) return procedure.types[Number(node.name.slice(1))] === 'b';
    if (node.type === 'UnaryExpression' && node.operator === '!') return isBoolean(node.argument, depth + 1);
    if (node.type === 'LogicalExpression' && ['&&', '||'].includes(node.operator)) return isBoolean(node.left, depth + 1) && isBoolean(node.right, depth + 1);
    if (node.type === 'BinaryExpression' && ['===', '!==', '<', '>', '<=', '>='].includes(node.operator)) return true;
    return node.type === 'CallExpression' && ['toBoolean', 'compareEqual', 'compareGreaterThan', 'compareLessThan', 'listContains',
      'runtime.ioDevices.keyboard.getKeyIsDown', 'runtime.ioDevices.mouse.getIsDown', 'target.isTouchingObject', 'target.isTouchingColor',
      'target.colorIsTouchingColor'].includes(chain(node.callee));
  };
  const sensingOf = (object, property) => {
    if (typeof property !== 'string' || !property) fail('sensing_of属性名缺失');
    const result = expression('sensing_of', {OBJECT: object}, {PROPERTY: [property, null]});
    if (Object.hasOwn(object, 'literal')) result.shadowInputs = {OBJECT: {opcode: 'sensing_of_object_menu', fields: {OBJECT: [String(object.literal), null]}}};
    return result;
  };
  // A condition slot converts its input to boolean itself, so a toBoolean(x) filling it is just x.
  const slotKind = node => call(node, 'toBoolean') ? 'boolean-slot' : 'boolean';
  /**
   * The inputs of a custom-block call, one per parameter. An empty boolean slot is compiled to the string
   * "false" (the parameter's default), so a boolean parameter given exactly that is left empty, as the author
   * left it, instead of being filled with a text shadow that no author typed into a boolean slot.
   */
  const callInputs = (signature, argumentNodes, depth) => Object.fromEntries(signature.ids.flatMap((id, i) => {
    const boolean = signature.types[i] === 'b';
    if (boolean && literal(argumentNodes[i]) === 'false' && prefer('boolean-constant', '空的布尔槽编译为字符串 "false"，作者留空')) return [];
    return [[id, reporter(argumentNodes[i], boolean ? 'boolean' : 'value', depth)]];
  }));
  const reporter = (node, context = 'value', depth = 0) => {
    tick(depth);
    // A bare expression in a condition is whatever block fed the slot; Scratch converts it with its own
    // truthiness rules, which JavaScript's do not always match (the string "false", "0" and "" differ).
    if (context === 'boolean' && !isBoolean(node)) assume('原生JS truthiness与Scratch布尔转换不等价，条件必须有明确转换模板');
    const additional = decodeAdditionalReporter(node, {project, targetIndex, reporter: (child, nextContext) => reporter(child, nextContext, depth + 1),
      chain, literal, identifier, member, numeric, nonNaN, fail, assume});
    if (additional) return additional;
    if (procedure && identifier(node) && script.params.some(parameter => parameter.name === node.name)) {
      const index = Number(node.name.slice(1));
      if (index >= procedure.types.length) fail('过程参数位置超出元数据');
      return expression(procedure.types[index] === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number', {}, {VALUE: [procedure.names[index], null]});
    }
    const constant = literalValue(node);
    if (constant) return constant;
    if (node?.type === 'Literal' && typeof node.value === 'boolean') {
      // The compiler writes `not <>` (an empty `not`) as `!false`, which folds to `true`, and so does `<1 = 1>`.
      // Authors reach for the empty `not`: 110 times as a procedure argument in the sample against 8 comparisons.
      if (node.value === true && prefer('boolean-constant', 'true 常量作者用空的 not <> 表示')) return expression('operator_not', {});
      return expression('operator_equals', {OPERAND1: {literal: 1}, OPERAND2: {literal: node.value ? 1 : 0}});
    }
    const castNumber = numberCast(node);
    if (call(node, 'toNotNaN') && castNumber && !numeric(castNumber)) assume('toNotNaN输入缺少数值类型证明');
    // toNotNaN preserves -0; adding zero does not. Multiplication by one
    // applies Scratch's NaN->0 cast while retaining signed zero/infinities.
    if (castNumber) return expression(call(node, 'toNotNaN') ? 'operator_multiply' : 'operator_add',
      {NUM1: reporter(castNumber, 'value', depth + 1), NUM2: {literal: call(node, 'toNotNaN') ? 1 : 0}});
    if (node?.type === 'UnaryExpression' && node.operator === '+') {
      if (!nonNaN(node.argument) && !isBoolean(node.argument)) assume('number-or-NaN转换无法以现有积木证明，不能省略强制转换');
      return expression('operator_add', {NUM1: reporter(node.argument, 'value', depth + 1), NUM2: {literal: 0}});
    }
    const castString = stringCast(node);
    if (castString) return context === 'string' ? reporter(castString, 'value', depth + 1) :
      expression('operator_join', {STRING1: {literal: ''}, STRING2: reporter(castString, 'value', depth + 1)});
    if (node?.type === 'ConditionalExpression' && identifier(node.test) && literal(node.alternate) === 0) {
      const alias = node.test.name;
      if (attributeAliases.has(alias) && member(node.consequent, alias, 'value')) {
        const data = attributeAliases.get(alias);
        return sensingOf({literal: data.target}, data.property);
      }
      if (targetAliases.has(alias)) {
        let property = {x: 'x position', y: 'y position', direction: 'direction', volume: 'volume', size: 'size'}[propertyName(node.consequent)];
        if (node.consequent?.object?.name !== alias) property = null;
        if (node.consequent?.type === 'BinaryExpression' && node.consequent.operator === '+' && member(node.consequent.left, alias, 'currentCostume') && literal(node.consequent.right) === 1) property = 'costume #';
        const costumes = node.consequent?.object?.object;
        if (propertyName(node.consequent) === 'name' && costumes?.type === 'CallExpression' && member(costumes.callee, alias, 'getCostumes') && !costumes.arguments.length && member(node.consequent.object.property, alias, 'currentCostume')) property = 'costume name';
        if (property) return sensingOf({literal: targetAliases.get(alias)}, property);
      }
      fail('sensing_of条件引用未完全匹配');
    }
    const definition = valueDefinition(node);
    if (definition?.kind === 'variables') return {variable: {name: definition.name, id: definition.id}};
    if (node?.type === 'CallExpression' && call(node, 'limitPrecision') && node.arguments.length === 1 &&
        ['target.x', 'target.y'].includes(chain(node.arguments[0]))) return expression(chain(node.arguments[0]) === 'target.x' ? 'motion_xposition' : 'motion_yposition');
    if (node?.type === 'MemberExpression' && propertyName(node) === 'length') {
      const list = valueDefinition(node.object);
      if (list?.kind === 'lists') return expression('data_lengthoflist', {}, {LIST: [list.name, list.id]});
      return expression('operator_length', {STRING: reporter(node.object, 'string', depth + 1)});
    }
    const direct = {
      'target.direction': 'motion_direction',
      'runtime.ext_scratch3_sensing._answer': 'sensing_answer',
      'runtime.ext_scratch3_control._counter': 'control_get_counter'
    }[chain(node)];
    if (direct) return expression(direct);
    if (node?.type === 'UnaryExpression' && node.operator === '!') {
      // This is the only place the compiler writes `<=` / `>=` (jsgen OP_GREATER / OP_LESS): the Scratch block
      // `a > b` becomes `!(a <= b)` when `a` may be NaN, and `a < b` becomes `!(a >= b)` when `b` may be NaN. So a
      // negated `<=` / `>=` is the strict comparison itself, not `not(not(a > b))`. Strict mode accepts it when both
      // operands are provably numeric. Otherwise the compiler's own typing is what made it write this form, which
      // a decoder cannot see; that is an assumption, and the oracle checks it by recompiling.
      if (node.argument?.type === 'BinaryExpression' && ['<=', '>='].includes(node.argument.operator)) {
        const {left, right, operator} = node.argument;
        if (!(numeric(left) && numeric(right))) assume('!(a <= b) / !(a >= b) 对应严格比较积木，操作数的数值类型由编译器推断而非本地可证');
        return expression(operator === '<=' ? 'operator_gt' : 'operator_lt',
          {OPERAND1: reporter(left, 'number', depth + 1), OPERAND2: reporter(right, 'number', depth + 1)});
      }
      // `!toBoolean(x)`: pass the slot kind down so the inner call can drop its redundant double negation.
      return expression('operator_not', {OPERAND: reporter(node.argument, call(node.argument, 'toBoolean') ? 'boolean-slot' : 'boolean', depth + 1)});
    }
    if (node?.type === 'UnaryExpression' && node.operator === '-') return expression('operator_subtract', {NUM1: {literal: 0}, NUM2: reporter(node.argument, 'number', depth + 1)});
    if (node?.type === 'LogicalExpression') {
      // Compiler numeric/boolean casts are matched before Scratch logical operations.
      if (node.operator === '??' && literal(node.right) === '' && node.left?.type === 'MemberExpression') {
        const list = valueDefinition(node.left.object);
        if (list?.kind === 'lists') {
          const index = node.left.property;
          let item;
          if (index?.type === 'BinaryExpression' && index.operator === '-' && literal(index.right) === 1) {
            if (same(index.left, {type: 'MemberExpression', object: node.left.object, property: {type: 'Identifier', name: 'length'}, computed: false, optional: false})) item = {literal: 'last'};
            else {
              const integer = index.left?.type === 'BinaryExpression' && literal(index.left.right) === 0 && index.left.operator === '|' ? index.left.left : index.left;
              const constantIndex = literalValue(integer);
              if (index.left === integer && (!constantIndex || !Number.isInteger(Number(constantIndex.literal)))) assume('原生数组索引需要整数证明，不能按列表floor恢复');
              if (typeof constantIndex?.literal === 'string' && ['last', 'random', 'any', 'all'].includes(constantIndex.literal)) fail('原生数组索引不支持Scratch特殊索引词');
              item = listIndex(integer, depth + 1);
            }
          } else {
            // Constant folding turns `N - 1` into a zero-based literal array index.
            // Only literal nonnegative indices are accepted; dynamic JS indexing can
            // differ from Scratch's floor/special-index semantics and stays unresolved.
            const zeroBased = literalValue(index);
            if (!zeroBased || typeof zeroBased.literal !== 'number' || !Number.isInteger(zeroBased.literal) ||
                zeroBased.literal < 0 || zeroBased.literal > 2147483646) {
              // Constant folding turned `N - 1` into a zero-based literal, or the index is dynamic.
              // Only a bare literal outside the safe range reaches here: the dynamic `<expr> - 1` shape is
              // handled by the branch above. A zero-based dynamic expression with no `- 1` has no
              // unambiguous Scratch index (it would need `+ 1`, and the compiler may have folded either
              // way), so it stays a hard failure in both modes.
              if (!zeroBased || typeof zeroBased.literal !== 'number') fail('列表折叠索引缺少有限非负整数证明');
              assume('列表折叠索引缺少有限非负整数证明');
              item = {literal: zeroBased.literal + 1};
            } else item = {literal: zeroBased.literal + 1};
          }
          return expression('data_itemoflist', {INDEX: item}, {LIST: [list.name, list.id]});
        }
      }
      if (!['&&', '||'].includes(node.operator)) fail('逻辑表达式尚未支持');
      return expression(node.operator === '&&' ? 'operator_and' : 'operator_or',
        {OPERAND1: reporter(node.left, slotKind(node.left), depth + 1), OPERAND2: reporter(node.right, slotKind(node.right), depth + 1)});
    }
    if (node?.type === 'BinaryExpression') {
      if (['+', '-', '*', '/'].includes(node.operator)) {
        let opcode = {'+': 'operator_add', '-': 'operator_subtract', '*': 'operator_multiply', '/': 'operator_divide'}[node.operator];
        // The compiler rewrites constant halving in both directions (jsgen tryStrengthReduction): the block
        // `x ÷ 2` is emitted as `x * 0.5`, and the block `x × 0.5` as `x / 2`. Read literally, `x * 0.5` would give
        // `x × 0.5`, which the compiler turns into `x / 2` and never back into `x * 0.5`. Both blocks compute the
        // same number for every input (halving is exact in binary floating point), so this only picks the spelling
        // whose compilation reproduces the text. The oracle confirms it; a refusal falls back to the literal block.
        let rightOverride = null;
        const variableLeft = literal(node.left) === undefined;
        if (node.operator === '*' && variableLeft && literal(node.right) === 0.5 && prefer('halving', 'x * 0.5 是编译器对 x ÷ 2 的强度削减，选除法')) {
          opcode = 'operator_divide';
          rightOverride = 2;
        } else if (node.operator === '/' && variableLeft && literal(node.right) === 2 && prefer('halving', 'x / 2 是编译器对 x × 0.5 的强度削减，选乘 0.5')) {
          opcode = 'operator_multiply';
          rightOverride = 0.5;
        }
        if (node.operator === '+' && !(numeric(node.left) && numeric(node.right))) {
          // A bare `+` with a string operand is a join: an `operator_add` casts each operand to a number first
          // (`(+x || 0)`), so a string never reaches it uncast. The string operands the compiler emits are a
          // literal, `"" + x`, and the letter-of idiom `(s)[i] || ""`.
          if (isStringTyped(node.left) || isStringTyped(node.right)) opcode = 'operator_join';
          // The compiler emits a bare `a + b` only after typing both operands as numbers; with a
          // string operand it writes `"" + a` instead. So an unproven bare `+` is `operator_add`.
          else assume('加法/字符串拼接类型无法确定，不能猜测积木');
        }
        if (opcode !== 'operator_join' && (!nonNaN(node.left) || !nonNaN(node.right))) assume('原生算术的NaN输入与Scratch重转换差异尚未证明');
        const names = opcode === 'operator_join' ? ['STRING1', 'STRING2'] : ['NUM1', 'NUM2'];
        const inputContext = opcode === 'operator_join' ? 'string' : 'number';
        return expression(opcode, {[names[0]]: reporter(node.left, inputContext, depth + 1),
          [names[1]]: rightOverride === null ? reporter(node.right, inputContext, depth + 1) : {literal: rightOverride}});
      }
      if (['===', '<', '>'].includes(node.operator)) {
        const a = toLower(node.left), b = toLower(node.right);
        if (!a && !(numeric(node.left) && numeric(node.right))) assume('比较类型尚未证明，原生字符串比较不等于Scratch比较');
        // `x.toLowerCase() === "lit"` is how the compiler writes a case-insensitive string compare whose
        // right side it already lower-cased while folding constants, so one visible toLowerCase is the
        // expected shape for a Scratch `=` against a literal.
        if (!!a !== !!b) assume('非对称字符串比较不在Scratch模板内');
        // Strict mode has always refused every string comparison here (a Scratch `=` also equates "1"
        // and "1.0"), so this stays an assumption, which strict mode turns back into a failure.
        if (a) assume('原生字符串排序对数字字符串与Scratch比较不等价，暂保留原代码');
        const stringSide = !!(a || b);
        return expression({'===': 'operator_equals', '<': 'operator_lt', '>': 'operator_gt'}[node.operator],
          {OPERAND1: reporter(a || node.left, stringSide ? 'string' : 'number', depth + 1), OPERAND2: reporter(b || node.right, stringSide ? 'string' : 'number', depth + 1)});
      }
      // Scratch has no <= or >= block. The compiler turns `not (a > b)` into `a <= b` and `not (a < b)`
      // into `a >= b` (jsgen OP_GREATER / OP_LESS, "we can negate <="), so a bare occurrence is the
      // negation of the opposite strict comparison. Numeric operands are required, as in the strict-
      // comparison branch above; the oracle then checks that the compiler folds the pair back.
      if (['<=', '>='].includes(node.operator)) {
        // Always an assumption, even for numeric operands: `numeric()` proves a number type but not that it
        // is non-NaN, and `NaN <= 1` is false while `not (NaN > 1)` is true. Strict mode therefore keeps
        // refusing a bare <= / >= exactly as before; only the oracle can vouch for it.
        assume('二元操作 <=/>= 对应 not(>)/not(<)，NaN 下语义不同，未证明');
        return expression('operator_not', {OPERAND: expression(node.operator === '<=' ? 'operator_gt' : 'operator_lt',
          {OPERAND1: reporter(node.left, 'number', depth + 1), OPERAND2: reporter(node.right, 'number', depth + 1)})});
      }
      if (node.operator === '**' && literal(node.left) === 10) return expression('operator_mathop', {NUM: reporter(node.right, 'number', depth + 1)}, {OPERATOR: ['10 ^', null]});
      fail(`二元操作 ${node.operator} 尚未支持`);
    }
    if (node?.type === 'YieldExpression' && node.delegate) {
      const invoke = node.argument;
      if (invoke?.type === 'CallExpression' && member(invoke.callee?.object, 'thread', 'procedures')) {
        const variant = propertyName(invoke.callee);
        const signature = signatures.get(variant?.slice(1));
        if (!signature || variant[0] !== (signature.warp || isWarp ? 'W' : 'Z') || signature.ids.length !== invoke.arguments.length || !signature.variants.find(entry => entry.variant === variant)?.yields) fail('reporter过程签名/yield模式不符');
        const result = expression('procedures_call', callInputs(signature, invoke.arguments, depth + 1));
        result.mutation = {tagName: 'mutation', children: [], proccode: signature.code, argumentids: JSON.stringify(signature.ids), warp: String(!!signature.warp), return: 'true'};
        return result;
      }
      if (call(invoke, 'executeInCompatibilityLayer') && invoke.arguments.length === 6 && invoke.arguments[0]?.type === 'ObjectExpression' &&
          identifier(invoke.arguments[1]) && opcodeAliases.has(invoke.arguments[1].name) && typeof literal(invoke.arguments[2]) === 'boolean' &&
          typeof literal(invoke.arguments[3]) === 'boolean' && typeof literal(invoke.arguments[4]) === 'string' && literal(invoke.arguments[5]) === null) {
        const opcode = opcodeAliases.get(invoke.arguments[1].name);
        if (!['sound_volume', 'sensing_loud', 'sensing_loudness', 'sensing_userid', 'motion_xscroll', 'motion_yscroll',
          'music_getTempo', 'videoSensing_videoOn', 'translate_getTranslate', 'translate_getViewerLanguage'].includes(opcode)) fail('兼容层reporter缺少明确类型模板');
        return menus(decodeCompatibilityArguments(opcode, invoke.arguments[0].properties, (child) => reporter(child, 'value', depth + 1)));
      }
      fail('yield reporter尚未匹配过程或兼容层模板');
    }
    if (node?.type === 'CallExpression') {
      if (member(node.callee?.object, 'thread', 'procedures')) {
        const variant = propertyName(node.callee);
        const signature = signatures.get(variant?.slice(1));
        if (!signature || variant[0] !== (signature.warp || isWarp ? 'W' : 'Z') || signature.ids.length !== node.arguments.length || signature.variants.find(entry => entry.variant === variant)?.yields !== false) fail('reporter过程签名/调度模式不符');
        const result = expression('procedures_call', Object.fromEntries(signature.ids.map((id, i) => [id, reporter(node.arguments[i], signature.types[i] === 'b' ? 'boolean' : 'value', depth + 1)])));
        result.mutation = {tagName: 'mutation', children: [], proccode: signature.code, argumentids: JSON.stringify(signature.ids), warp: String(!!signature.warp), return: 'true'};
        return result;
      }
      if (chain(node.callee) === 'runtime.ext_scratch3_sensing.getAttributeOf' && node.arguments.length === 1 && node.arguments[0]?.type === 'ObjectExpression') {
        const properties = node.arguments[0].properties;
        const entries = new Map();
        for (const property of properties) {
          if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method || !['OBJECT', 'PROPERTY'].includes(property.key.name || property.key.value) || entries.has(property.key.name || property.key.value)) fail('sensing_of动态对象参数未完全匹配');
          entries.set(property.key.name || property.key.value, property.value);
        }
        if (entries.size !== 2 || typeof literal(entries.get('PROPERTY')) !== 'string') fail('sensing_of属性元数据缺失');
        return sensingOf(reporter(entries.get('OBJECT'), 'string', depth + 1), literal(entries.get('PROPERTY')));
      }
      if (node.arguments.some(argument => argument.type === 'SpreadElement')) fail('reporter展开参数尚未支持');
      if (call(node, 'toBoolean') && node.arguments.length === 1) {
        // `toBoolean(x)` is what the compiler writes when a block feeds a boolean slot: the slot itself
        // performs the conversion. Strict recovery spells it as not(not(x)), which is exact but compiles
        // to `!!x`. When the call fills a boolean slot (the operand of a negation, `and` or `or`), relaxed
        // recovery uses the block itself, because the slot converts it the same way. This is a spelling
        // preference, so a refusal by the oracle returns the item to the exact spelling.
        if (context === 'boolean-slot' && prefer('boolean-slot', 'toBoolean(x) 位于布尔槽内等价于把 x 直接放入该槽，按常见写法选后者')) {
          return reporter(node.arguments[0], 'value', depth + 1);
        }
        return expression('operator_not', {OPERAND: expression('operator_not', {OPERAND: reporter(node.arguments[0], 'value', depth + 1)})});
      }
      const comparisons = {compareEqual: 'operator_equals', compareGreaterThan: 'operator_gt', compareLessThan: 'operator_lt'};
      if (comparisons[node.callee.name] && identifier(node.callee) && node.arguments.length === 2) return expression(comparisons[node.callee.name],
        {OPERAND1: reporter(node.arguments[0], 'value', depth + 1), OPERAND2: reporter(node.arguments[1], 'value', depth + 1)});
      if (['random', 'randomInt', 'randomFloat', 'mod'].some(name => call(node, name)) ||
          chain(node.callee) === 'runtime.ext_scratch3_operators._random') {
        if (node.arguments.length !== 2) fail('随机数/mod helper参数不符');
        const random = !call(node, 'mod');
        // `pick random 0 to 1` compiles to randomInt, but `pick random 0.0 to 1.0` to randomFloat: the compiler asks
        // whether the constants are written as integers (Cast.isInt looks for a decimal point in the text). The
        // two give different results (0 or 1 against any fraction in between), so reading `randomFloat(0, 1)` as
        // plain `0 to 1` would change what the project does. Whole-number bounds that must stay floats are
        // therefore written with a decimal point.
        const floatBound = argument => call(node, 'randomFloat') && Number.isInteger(literal(argument)) ? {literal: `${literal(argument)}.0`} : null;
        return expression(random ? 'operator_random' : 'operator_mod',
          {[random ? 'FROM' : 'NUM1']: floatBound(node.arguments[0]) ?? reporter(node.arguments[0], 'number', depth + 1),
            [random ? 'TO' : 'NUM2']: floatBound(node.arguments[1]) ?? reporter(node.arguments[1], 'number', depth + 1)});
      }
      const mathOp = {'Math.abs': 'abs', 'Math.floor': 'floor', 'Math.ceil': 'ceiling', 'Math.sqrt': 'sqrt', 'Math.log': 'ln', 'Math.exp': 'e ^', tan: 'tan'}[chain(node.callee)];
      if (mathOp && node.arguments.length === 1) return expression('operator_mathop', {NUM: reporter(node.arguments[0], 'number', depth + 1)}, {OPERATOR: [mathOp, null]});
      if (chain(node.callee) === 'Math.round' && node.arguments.length === 1) {
        if (chain(node.arguments[0]) === 'target.size') return expression('looks_size');
        return expression('operator_round', {NUM: reporter(node.arguments[0], 'number', depth + 1)});
      }
      if (identifier(node.callee) && ['listContents', 'listContains', 'listIndexOf'].includes(node.callee.name)) {
        const list = definitionOf(node.arguments[0]);
        if (!list || list.kind !== 'lists') fail('列表ID/作用域无法确认');
        const expected = call(node, 'listContents') ? 1 : 2;
        if (node.arguments.length !== expected) fail('列表helper参数数量不符');
        if (call(node, 'listContents')) fail('02列表内容helper与解释器数字项拼接语义不同，尚未证明通用重建');
        if (call(node, 'listIndexOf')) fail('02列表索引helper与解释器混合数字/字符串相等语义不同，尚未证明通用重建');
        return expression(call(node, 'listContains') ? 'data_listcontainsitem' : 'data_itemnumoflist',
          {ITEM: reporter(node.arguments[1], 'value', depth + 1)}, {LIST: [list.name, list.id]});
      }
      if (call(node, 'listGet') && node.arguments.length === 2) {
        const list = valueDefinition(node.arguments[0]);
        if (!list || list.kind !== 'lists') fail('列表ID/作用域无法确认');
        return expression('data_itemoflist', {INDEX: listIndex(node.arguments[1], depth + 1)}, {LIST: [list.name, list.id]});
      }
      const sensing = {'runtime.ioDevices.clock.projectTimer': 'sensing_timer', 'runtime.ioDevices.keyboard.getLastKeyPressed': 'tw_getLastKeyPressed',
        'runtime.ioDevices.mouse.getScratchX': 'sensing_mousex', 'runtime.ioDevices.mouse.getScratchY': 'sensing_mousey', 'runtime.ioDevices.mouse.getIsDown': 'sensing_mousedown'}[chain(node.callee)];
      if (sensing && !node.arguments.length) return expression(sensing);
    }
    fail(`表达式 ${node?.type || 'missing'} 尚未支持，保留factorySource`);
  };
  const broadcast = node => {
    if (!call(node, 'startHats') || node.arguments.length !== 2 || literal(node.arguments[0]) !== 'event_whenbroadcastreceived' ||
        node.arguments[1]?.type !== 'ObjectExpression' || node.arguments[1].properties.length !== 1) fail('广播调用不匹配官方模板');
    const property = node.arguments[1].properties[0];
    if (property.type !== 'Property' || property.computed || property.kind !== 'init' || (property.key.name || property.key.value) !== 'BROADCAST_OPTION') fail('广播参数结构未知');
    const result = reporter(property.value);
    if ('literal' in result) {
      if (typeof result.literal !== 'string') fail('广播名不是字符串');
      return {broadcast: broadcastByLiteral(project, result.literal)};
    }
    return result;
  };
  const scheduling = statement => statement?.type === 'ExpressionStatement' && statement.expression?.type === 'YieldExpression' &&
    !statement.expression.delegate && !statement.expression.argument || statement?.type === 'IfStatement' && call(statement.test, 'isStuck') &&
    statement.test.arguments.length === 0 && !statement.alternate && statement.consequent?.type === 'ExpressionStatement' &&
    statement.consequent.expression?.type === 'YieldExpression' && !statement.consequent.expression.argument;
  const listIndex = (node, depth = 0) => {
    const constant = literalValue(node);
    if (!constant) {
      // The compiler wraps every list index in an int32 conversion, so the index expression is whatever
      // numeric block fed the slot. Strict mode cannot show that the interpreter's floor() agrees.
      assume('动态列表索引的int32转换与解释器floor差异尚未证明');
      return reporter(node, 'number', depth + 1);
    }
    if (typeof constant.literal === 'string' && ['last', 'random', 'any', 'all'].includes(constant.literal)) return constant;
    const number = Number(constant.literal);
    if (!Number.isFinite(number) || number < 0 || number > 2147483647) {
      assume('列表索引超出安全int32正数范围，不能丢弃编译器转换');
      return {literal: constant.literal};
    }
    return {literal: number | 0};
  };
  const listFields = list => ({LIST: [list.name, list.id]});
  const scalarFields = variable => ({VARIABLE: [variable.name, variable.id]});
  /** Turn one expression of a guarded body into the statement stack it stands for. */
  const expressionStack = (node, depth) => {
    if (!node) return [];
    const expressions = node.type === 'SequenceExpression' ? node.expressions : [node];
    return decodeStatements(expressions.map(expression =>
      ({type: 'ExpressionStatement', expression, start: expression.start, end: expression.end})), depth + 1);
  };
  const getSubstack = (node, inLoop, depth) => {
    const statements = node?.type === 'BlockStatement' ? [...node.body] : node ? [node] : [];
    if (inLoop) {
      const last = statements.at(-1);
      if (isWarp) {
        if (scheduling(last)) {
          if (last.type !== 'IfStatement') fail('warp循环出现非warp调度');
          statements.pop();
        }
      } else {
        if (!scheduling(last) || last.type !== 'ExpressionStatement') fail('循环缺少无条件调度yield，warp语义尚未保留');
        statements.pop();
      }
    }
    return decodeStatements(statements, depth + 1);
  };
  const decodeStatements = (statements, depth = 0) => {
    tick(depth);
    // A procedure that ends in a run of statements was emitted by the older compiler as one comma
    // expression inside the return: `return a = [], b = [], ... , ''`. Each element before the trailing
    // empty string is a statement in its own right, so expand them and decode as usual; the `''` is the
    // procedure's empty return and is dropped by the caller.
    statements = statements.flatMap(statement => {
      if (statement.type !== 'ReturnStatement' || statement.argument?.type !== 'SequenceExpression') return [statement];
      const {expressions} = statement.argument;
      const tail = expressions.at(-1);
      if (literal(tail) !== '') return [statement];
      return [...expressions.slice(0, -1).map(expression =>
        ({type: 'ExpressionStatement', expression, start: expression.start, end: expression.end})),
      {type: 'ReturnStatement', argument: tail, start: tail.start, end: statement.end}];
    });
    // `return cond ? (a, b, '') : (c, d, '')` is how the older compiler wrote a procedure whose two arms
    // each end the script. It is an `if/else` whose arms fall through to the implicit return, so decode it
    // as one statement rather than as a value. The `''` arms are dropped for the same reason as above.
    statements = statements.flatMap(statement => {
      if (statement.type !== 'ReturnStatement' || statement.argument?.type !== 'ConditionalExpression') return [statement];
      const {test, consequent, alternate} = statement.argument;
      const arm = expression => {
        const list = expression.type === 'SequenceExpression' ? expression.expressions : [expression];
        const last = list.at(-1);
        const body = literal(last) === '' ? list.slice(0, -1) : list;
        return {type: 'BlockStatement', start: expression.start, end: expression.end,
          body: body.map(item => ({type: 'ExpressionStatement', expression: item, start: item.start, end: item.end}))};
      };
      return [{type: 'IfStatement', test, consequent: arm(consequent), alternate: arm(alternate),
        start: statement.start, end: statement.end}];
    });
    const operations = [];
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index];
      tick(depth);
      let operation;
      if (statement.type === 'ExpressionStatement' && statement.expression?.type === 'AssignmentExpression' &&
          statement.expression.operator === '=' && member(statement.expression.left, 'thread', 'timer') &&
          call(statement.expression.right, 'timer') && !statement.expression.right.arguments.length) {
        const duration = statements[index + 1];
        const declaration = duration?.type === 'VariableDeclaration' && duration.kind === 'var' && duration.declarations.length === 1 ? duration.declarations[0] : null;
        const redraw = statements[index + 2]?.expression;
        const initialYield = statements[index + 3];
        const wait = statements[index + 4];
        const clear = statements[index + 5]?.expression;
        if (!declaration || !identifier(declaration.id) || declared.has(declaration.id.name) || reservedHelpers.has(declaration.id.name) ||
            chain(redraw?.callee) !== 'runtime.requestRedraw' || redraw.arguments.length || !scheduling(initialYield) ||
            wait?.type !== 'WhileStatement' || wait.test?.type !== 'BinaryExpression' || wait.test.operator !== '<' ||
            chain(wait.test.left?.callee) !== 'thread.timer.timeElapsed' || wait.test.left.arguments.length || !identifier(wait.test.right, declaration.id.name) ||
            wait.body?.type !== 'BlockStatement' || wait.body.body.length !== 1 || !scheduling(wait.body.body[0]) ||
            clear?.type !== 'AssignmentExpression' || clear.operator !== '=' || !member(clear.left, 'thread', 'timer') || literal(clear.right) !== null) fail('等待计时语句组未完全匹配');
        if (initialYield.type !== 'ExpressionStatement' || wait.body.body[0].type !== 'ExpressionStatement') fail('warp等待调度尚未验证');
        let seconds;
        const init = declaration.init;
        if (chain(init?.callee) === 'Math.max' && init.arguments.length === 2 && literal(init.arguments[0]) === 0 &&
            init.arguments[1]?.type === 'BinaryExpression' && init.arguments[1].operator === '*' && literal(init.arguments[1].left) === 1000) seconds = reporter(init.arguments[1].right, 'number');
        else if (chain(init?.callee) === 'Math.max' && init.arguments.length === 2 && literal(init.arguments[0]) === 0 &&
            typeof literal(init.arguments[1]) === 'number' && Number.isFinite(literal(init.arguments[1]))) seconds = {literal: Math.max(0, literal(init.arguments[1])) / 1000};
        else if (typeof literal(init) === 'number' && literal(init) >= 0 && Number.isFinite(literal(init))) seconds = {literal: literal(init) / 1000};
        else fail('等待时间转换尚未支持');
        declared.add(declaration.id.name);
        index += 5;
        operation = command('control_wait', {DURATION: seconds});
      } else if (statement.type === 'ReturnStatement' && procedure) {
        if (index !== statements.length - 1 || !statement.argument) fail('过程早退/返回形状尚未支持');
        operation = command('procedures_return', {VALUE: reporter(statement.argument)});
        // `return ""` is also what `stop this script` compiles to inside a procedure. A procedure that reports a
        // value has a non-empty `return`, so an empty one ends a command procedure early, and that is spelled
        // `stop this script` (119 times in the sample project, against no `report` block at all).
        if (literal(statement.argument) === '' && prefer('stop-this-script', '过程内的 return "" 与 stop this script 编译为同一代码，按常见写法选后者')) {
          operation = command('control_stop', {}, {STOP_OPTION: ['this script', null]});
          operation.mutation = {tagName: 'mutation', children: [], hasnext: 'false'};
        }
      } else if (statement.type === 'VariableDeclaration' && statement.kind === 'var' && statement.declarations.length === 1 &&
          literal(statement.declarations[0].init) === 0 && identifier(statement.declarations[0].id)) {
        const counter = statement.declarations[0].id.name;
        const loop = statements[index + 1];
        const increment = loop?.body?.body?.[0]?.expression;
        const assignment = loop?.body?.body?.[1]?.expression;
        const variable = valueDefinition(assignment?.left);
        if (declared.has(counter) || reservedHelpers.has(counter) || loop?.type !== 'WhileStatement' || loop.test?.type !== 'BinaryExpression' ||
            loop.test.operator !== '<' || !identifier(loop.test.left, counter) || loop.body?.type !== 'BlockStatement' ||
            increment?.type !== 'UpdateExpression' || increment.operator !== '++' || !identifier(increment.argument, counter) ||
            assignment?.type !== 'AssignmentExpression' || assignment.operator !== '=' || !identifier(assignment.right, counter) || variable?.kind !== 'variables') fail('for-each计数/赋值组未完全匹配');
        declared.add(counter);
        const inner = {type: 'BlockStatement', body: loop.body.body.slice(2)};
        operation = command('control_for_each', {VALUE: reporter(loop.test.right, 'number')}, scalarFields(variable), {SUBSTACK: getSubstack(inner, true, depth)});
        index++;
      } else if (statement.type === 'IfStatement' && statement.test?.type === 'UnaryExpression' && statement.test.operator === '!' && member(statement.test.argument, 'target', 'isOriginal')) {
        const body = statement.consequent?.body;
        if (statement.alternate || !Array.isArray(body) || body.length !== 4 || chain(body[0].expression?.callee) !== 'runtime.disposeTarget' ||
            body[0].expression.arguments.length !== 1 || !identifier(body[0].expression.arguments[0], 'target') ||
            chain(body[1].expression?.callee) !== 'runtime.stopForTarget' || body[1].expression.arguments.length !== 1 || !identifier(body[1].expression.arguments[0], 'target') ||
            !call(body[2].expression, 'retire') || body[2].expression.arguments.length ||
            (!procedure && (body[3].type !== 'ReturnStatement' || body[3].argument)) || (procedure && !scheduling(body[3]))) fail('删除克隆退出组未完整匹配');
        operation = command('control_delete_this_clone');
      } else if (statement.type === 'IfStatement') {
        operation = command(statement.alternate ? 'control_if_else' : 'control_if', {CONDITION: reporter(statement.test, slotKind(statement.test))}, {},
          {SUBSTACK: getSubstack(statement.consequent, false, depth), ...(statement.alternate ? {SUBSTACK2: getSubstack(statement.alternate, false, depth)} : {})});
      } else if (statement.type === 'ForStatement') {
        const init = statement.init;
        const counter = init?.type === 'VariableDeclaration' && ['var', 'let'].includes(init.kind) && init.declarations.length === 1 ? init.declarations[0] : null;
        if (!counter || !identifier(counter.id) || declared.has(counter.id.name) || reservedHelpers.has(counter.id.name) || statement.test?.type !== 'BinaryExpression' ||
            !identifier(statement.test.left, counter.id.name) || !((statement.test.operator === '>' && literal(statement.test.right) === 0) ||
            (statement.test.operator === '>=' && literal(statement.test.right) === 0.5)) || statement.update?.type !== 'UpdateExpression' ||
            statement.update.operator !== '--' || !identifier(statement.update.argument, counter.id.name)) fail('for循环尚未匹配官方repeat模板');
        if (statement.test.operator === '>' && !Number.isInteger(literalValue(counter.init)?.literal)) assume('repeat >0阈值缺少整数次数证明');
        declared.add(counter.id.name);
        operation = command('control_repeat', {TIMES: reporter(counter.init, 'number')}, {}, {SUBSTACK: getSubstack(statement.body, true, depth)});
      } else if (statement.type === 'WhileStatement') {
        const body = getSubstack(statement.body, true, depth);
        if (literal(statement.test) === true) operation = command('control_forever', {}, {}, {SUBSTACK: body});
        else if (statement.test?.type === 'UnaryExpression' && statement.test.operator === '!') {
          operation = body.length ? command('control_repeat_until', {CONDITION: reporter(statement.test.argument, 'boolean')}, {}, {SUBSTACK: body}) :
            command('control_wait_until', {CONDITION: reporter(statement.test.argument, 'boolean')});
        } else operation = command('control_while', {CONDITION: reporter(statement.test, slotKind(statement.test))}, {}, {SUBSTACK: body});
      } else if (statement.type === 'ExpressionStatement') {
        let node = statement.expression;
        if (procedure && node.type === 'YieldExpression' && !node.delegate && !node.argument) {
          const next = statements[index + 1]?.expression;
          const invoke = next?.type === 'YieldExpression' && next.delegate ? next.argument : next;
          if (invoke?.type === 'CallExpression' && member(invoke.callee?.object, 'thread', 'procedures') && propertyName(invoke.callee) === `${isWarp ? 'W' : 'Z'}${procedure.code}`) continue;
          fail('过程孤立yield尚未支持');
        }
        if (node.type === 'ConditionalExpression') {
          operation = command('control_if_else', {CONDITION: reporter(node.test, slotKind(node.test))}, {}, {
            SUBSTACK: decodeStatements([{type: 'ExpressionStatement', expression: node.consequent, start: node.consequent.start, end: node.consequent.end}], depth + 1),
            SUBSTACK2: decodeStatements([{type: 'ExpressionStatement', expression: node.alternate, start: node.alternate.start, end: node.alternate.end}], depth + 1)});
          operation.span = [statement.start, statement.end];
          operations.push(operation);
          continue;
        }
        // An older 02 compiler emitted `if (A) { if (B) {...} else {...} }` as the short-circuit expression
        // `A && (B ? {...} : {...})`, and a lone `if (A) {...}` as `A && (a = 1, b())`. Both are the same
        // program as the nested statements, but the current compiler spells them out as `if`, so a decoder
        // that only understands the statement form leaves every procedure written that way unresolved.
        // The left operand is a boolean condition either way (that is what makes `&&` valid here), so the
        // discriminator has to be the right operand: only a conditional expression or a sequence of side
        // effects is a body. `a && b` with two plain conditions stays an `operator_and`.
        if (node.type === 'LogicalExpression' && node.operator === '&&' && isBoolean(node.left) &&
            (node.right.type === 'ConditionalExpression' || node.right.type === 'SequenceExpression')) {
          const condition = reporter(node.left, slotKind(node.left));
          const right = node.right;
          const nested = right.type === 'ConditionalExpression' ?
            command('control_if_else', {CONDITION: reporter(right.test, slotKind(right.test))}, {}, {
              SUBSTACK: expressionStack(right.consequent, depth),
              SUBSTACK2: expressionStack(right.alternate, depth)}) :
            null;
          operation = command('control_if', {CONDITION: condition}, {},
            {SUBSTACK: nested ? [{...nested, span: [right.start, right.end]}] : expressionStack(right, depth)});
          operation.span = [statement.start, statement.end];
          operations.push(operation);
          continue;
        }
        if (node.type === 'SequenceExpression') {
          const expanded = node.expressions.map(expression => ({type: 'ExpressionStatement', expression, start: expression.start, end: expression.end}));
          operations.push(...decodeStatements(expanded, depth + 1));
          continue;
        }
        const yielded = node.type === 'YieldExpression' && node.delegate;
        if (yielded) node = node.argument;
        if (call(node, 'retire') && node.arguments.length === 0) {
          const stop = statements[index + 1];
          if ((!procedure && stop?.type === 'ReturnStatement' && !stop.argument) ||
              (procedure && scheduling(stop))) {
            index++;
            operation = command('control_stop', {}, {STOP_OPTION: ['this script', null]});
            operation.mutation = {tagName: 'mutation', children: [], hasnext: 'false'};
          } else fail('retire缺少完整调度退出组');
        }
        if (chain(node?.callee) === 'runtime.stopAll' && !node.arguments.length) {
          const retired = statements[index + 1]?.expression;
          const returned = statements[index + 2];
          // jsgen retire(): a script ends `retire(); return;`, a procedure ends `retire(); yield;` because a
          // `return` there would only go back to the calling procedure, not to the sequencer.
          const exits = procedure ? scheduling(returned) : returned?.type === 'ReturnStatement' && !returned.argument;
          if (!call(retired, 'retire') || retired.arguments.length || !exits) fail('stopAll缺少完整退出组');
          index += 2;
          operation = command('control_stop', {}, {STOP_OPTION: ['all', null]});
          operation.mutation = {tagName: 'mutation', children: [], hasnext: 'false'};
        }
        if (!operation && !yielded) operation = decodeNativeCommand(node, {project, targetIndex,
          reporter: (child, context) => reporter(child, context, depth + 1), chain, literal, identifier, member, numeric, fail, assume});
        if (operation) {}
        else if (node?.type === 'AssignmentExpression' && member(node.left, node.left.object?.name, 'value')) {
          if (yielded) fail('yield*赋值包含额外调度，不能当成普通赋值');
          const definition = valueDefinition(node.left);
          if (!definition) fail('赋值变量ID/作用域无法确认');
          if (definition.kind === 'lists') {
            if (node.operator !== '=' || node.right?.type !== 'ArrayExpression' || node.right.elements.length) fail('列表赋值尚未支持');
            operation = command('data_deletealloflist', {}, listFields(definition));
            // `delete all of [list]` and `delete (all) of [list]` both compile to `list.value = []`. In the
            // sample project authors used the second form 77 times and the first only 5 (bench/diagnostics/
            // opcode-choice-stats.mjs), so relaxed mode takes the common spelling. The oracle checks the result.
            if (prefer('delete-all', 'delete all of list 与 delete (all) of list 编译为同一代码，按常见写法选后者')) {
              operation = command('data_deleteoflist', {INDEX: {literal: 'all'}}, listFields(definition));
            }
          } else {
            if (node.operator !== '=') fail('变量复合赋值尚未支持');
            operation = command('data_setvariableto', {VALUE: reporter(node.right)}, scalarFields(definition));
            // The compiler writes `change v by X` as `v.value = (+v.value || 0) + X` (irgen.js: change -> set to
            // sum). That is the same program as `set v to (v + X)`, but the author almost certainly used the
            // change block, so relaxed mode prefers it. X is evaluated before the assignment in both, so this
            // needs no extra condition; the oracle confirms that the compiler turns it back into this text.
            // The left operand is the variable read, spelled by how the compiler typed it: `(+v || 0)` when it
            // could be anything, `toNotNaN(v)` when it is a number that may be NaN, and plain `v` when it is a
            // known number. A plain `v + x` that decoded as a join (a string operand) is an append, not a change.
            if (relaxed && node.right?.type === 'BinaryExpression' && node.right.operator === '+' && operation.inputs.VALUE?.opcode === 'operator_add') {
              const left = node.right.left;
              const isTarget = candidate => member(candidate, node.left.object?.name, 'value');
              const readsVariable = left?.type === 'LogicalExpression' && left.operator === '||' && literal(left.right) === 0 &&
                  left.left?.type === 'UnaryExpression' && left.left.operator === '+' && isTarget(left.left.argument) ||
                call(left, 'toNotNaN') && left.arguments.length === 1 && isTarget(left.arguments[0]) ||
                isTarget(left);
              if (readsVariable && prefer('change-by', 'change by 与 set to (变量+x) 编译为同一代码，按常见写法选 change')) {
                operation = command('data_changevariableby', {VALUE: reporter(node.right.right, 'number')}, scalarFields(definition));
              }
            }
            if (project.targets[definition.targetIndex].variables[definition.id][2]) {
              const update = statements[index + 1]?.expression;
              if (chain(update?.callee) !== 'runtime.ioDevices.cloud.requestUpdateVariable' || update.arguments.length !== 2 ||
                  literal(update.arguments[0]) !== definition.name || !same(update.arguments[1], node.left)) fail('云变量同步语义暂未匹配');
              index++;
            }
          }
        } else if (node?.type === 'CallExpression' && member(node.callee?.object, 'thread', 'procedures')) {
          const variant = propertyName(node.callee);
          const signature = typeof variant === 'string' && signatures.get(variant.slice(1));
          if (!signature || variant[0] !== (signature.warp || isWarp ? 'W' : 'Z') || signature.ids.length !== node.arguments.length ||
              !signature.variants.some(entry => entry.variant === variant)) fail('过程调用缺少唯一非warp定义或参数数量不符');
          if (yielded !== !!signature.variants.find(entry => entry.variant === variant).yields) fail('过程调用yield模式与定义不一致');
          operation = command('procedures_call', callInputs(signature, node.arguments, 0));
          operation.mutation = {tagName: 'mutation', children: [], proccode: signature.code, argumentids: JSON.stringify(signature.ids), warp: String(!!signature.warp)};
        } else if (call(node, 'startHats') && !yielded) operation = command('event_broadcast', {BROADCAST_INPUT: broadcast(node)});
        else if (call(node, 'waitThreads') && yielded && node.arguments.length === 1) operation = command('event_broadcastandwait', {BROADCAST_INPUT: broadcast(node.arguments[0])});
        else if (call(node, 'executeInCompatibilityLayer') && yielded && node.arguments.length === 6 && node.arguments[0]?.type === 'ObjectExpression' &&
            identifier(node.arguments[1]) && opcodeAliases.has(node.arguments[1].name) && typeof literal(node.arguments[2]) === 'boolean' &&
            typeof literal(node.arguments[3]) === 'boolean' && typeof literal(node.arguments[4]) === 'string' && literal(node.arguments[5]) === null) {
          operation = decodeCompatibilityArguments(opcodeAliases.get(node.arguments[1].name), node.arguments[0].properties, reporter);
          menus(operation);
        } else if (identifier(node.callee) && ['listDelete', 'listInsert', 'listReplace'].includes(node.callee.name) && !yielded) {
          const list = definitionOf(node.arguments[0]);
          if (!list || list.kind !== 'lists' || node.arguments.length !== (call(node, 'listDelete') ? 2 : 3)) fail('列表helper参数/ID不符');
          operation = command({listDelete: 'data_deleteoflist', listInsert: 'data_insertatlist', listReplace: 'data_replaceitemoflist'}[node.callee.name],
            {INDEX: listIndex(node.arguments[1]), ...(!call(node, 'listDelete') ? {ITEM: reporter(node.arguments[2])} : {})}, listFields(list));
        } else if (node?.type === 'CallExpression' && !yielded) {
          const name = chain(node.callee);
          const args = node.arguments;
          if (args.some(argument => argument.type === 'SpreadElement')) fail('指令展开参数尚未支持');
          const list = valueDefinition(node.callee?.object);
          if (list?.kind === 'lists' && ['push', 'pop', 'shift', 'unshift'].includes(propertyName(node.callee))) {
            const method = propertyName(node.callee);
            if (args.length !== (['push', 'unshift'].includes(method) ? 1 : 0)) fail('列表内联操作参数不符');
            const monitor = statements[index + 1]?.expression;
            if (monitor?.type !== 'AssignmentExpression' || monitor.operator !== '=' || !member(monitor.left, node.callee.object.object.name, '_monitorUpToDate') ||
                literal(monitor.right) !== false) fail('列表内联操作缺少monitor失效标记');
            index++;
            operation = command(['push', 'unshift'].includes(method) ? method === 'push' ? 'data_addtolist' : 'data_insertatlist' : 'data_deleteoflist',
              {...(['push', 'unshift'].includes(method) ? {ITEM: reporter(args[0])} : {}), ...(method !== 'push' ? {INDEX: {literal: method === 'pop' ? 'last' : 1}} : {})}, listFields(list));
          } else if (name === 'target.setXY' && args.length === 2) {
            if (member(args[1], 'target', 'y')) {
              const changed = args[0]?.type === 'BinaryExpression' && args[0].operator === '+' && member(args[0].left, 'target', 'x');
              if (changed && !numeric(args[0].right)) assume('changex右值缺少数值类型证明');
              operation = command(changed ? 'motion_changexby' : 'motion_setx', {[changed ? 'DX' : 'X']: reporter(changed ? args[0].right : args[0], 'number')});
            } else if (member(args[0], 'target', 'x')) {
              const changed = args[1]?.type === 'BinaryExpression' && args[1].operator === '+' && member(args[1].left, 'target', 'y');
              if (changed && !numeric(args[1].right)) assume('changey右值缺少数值类型证明');
              operation = command(changed ? 'motion_changeyby' : 'motion_sety', {[changed ? 'DY' : 'Y']: reporter(changed ? args[1].right : args[1], 'number')});
            } else operation = command('motion_gotoxy', {X: reporter(args[0], 'number'), Y: reporter(args[1], 'number')});
          } else if (name === 'runtime.ext_scratch3_motion._moveSteps' && args.length === 2 && identifier(args[1], 'target')) operation = command('motion_movesteps', {STEPS: reporter(args[0], 'number')});
          else if (name === 'runtime.ext_scratch3_motion._ifOnEdgeBounce' && args.length === 1 && identifier(args[0], 'target')) operation = command('motion_ifonedgebounce');
          else if (name === 'target.setDirection' && args.length === 1) {
            const changed = args[0]?.type === 'BinaryExpression' && ['+', '-'].includes(args[0].operator) && member(args[0].left, 'target', 'direction');
            if (changed && !numeric(args[0].right)) assume('turn右值缺少数值类型证明');
            operation = command(changed ? args[0].operator === '+' ? 'motion_turnright' : 'motion_turnleft' : 'motion_pointindirection',
              {[changed ? 'DEGREES' : 'DIRECTION']: reporter(changed ? args[0].right : args[0], 'number')});
          } else if (name === 'target.setRotationStyle' && args.length === 1 && ['all around', 'left-right', "don't rotate"].includes(literal(args[0]))) operation = command('motion_setrotationstyle', {}, {STYLE: [literal(args[0]), null]});
          else if (name === 'target.setSize' && args.length === 1) {
            const changed = args[0]?.type === 'BinaryExpression' && args[0].operator === '+' && member(args[0].left, 'target', 'size');
            if (changed && !numeric(args[0].right)) assume('changesize右值缺少数值类型证明');
            operation = command(changed ? 'looks_changesizeby' : 'looks_setsizeto', {[changed ? 'CHANGE' : 'SIZE']: reporter(changed ? args[0].right : args[0], 'number')});
          } else if (name === 'target.setVisible' && args.length === 1 && typeof literal(args[0]) === 'boolean') {
            const render = statements[index + 1]?.expression;
            if (chain(render?.callee) !== 'runtime.ext_scratch3_looks._renderBubble' || render.arguments.length !== 1 || !identifier(render.arguments[0], 'target')) fail('显示/隐藏缺少bubble同步');
            index++;
            operation = command(literal(args[0]) ? 'looks_show' : 'looks_hide');
          } else if (name === 'target.clearEffects' && !args.length) operation = command('looks_cleargraphiceffects');
          else if (['runtime.ext_scratch3_looks._say', 'runtime.ext_scratch3_looks._think'].includes(name) && args.length === 2 && identifier(args[1], 'target')) operation = command(name.endsWith('_say') ? 'looks_say' : 'looks_think', {MESSAGE: reporter(args[0], 'string')});
          else if (name === 'target.setCostume' && args.length === 1 && args[0]?.type === 'BinaryExpression' && args[0].operator === '+' && member(args[0].left, 'target', 'currentCostume') && literal(args[0].right) === 1) operation = command('looks_nextcostume');
          else if (name === 'runtime.ext_scratch3_looks._setCostume' && args.length === 2 && identifier(args[0], 'target')) operation = command('looks_switchcostumeto', {COSTUME: reporter(args[1])});
          else if (name === 'runtime.ext_scratch3_looks._setBackdrop' && [2, 3].includes(args.length) && identifier(args[0], 'stage')) {
            if (args.length === 3 && literal(args[2]) === true && args[1]?.type === 'BinaryExpression' && args[1].operator === '+' && member(args[1].left, 'stage', 'currentCostume') && literal(args[1].right) === 1) operation = command('looks_nextbackdrop');
            else if (args.length === 2) operation = command('looks_switchbackdropto', {BACKDROP: reporter(args[1])});
          } else if (['target.goForwardLayers', 'target.goBackwardLayers'].includes(name) && args.length === 1) operation = command('looks_goforwardbackwardlayers', {NUM: reporter(args[0], 'number')}, {FORWARD_BACKWARD: [name.endsWith('goForwardLayers') ? 'forward' : 'backward', null]});
          else if (['target.goToFront', 'target.goToBack'].includes(name) && !args.length) operation = command('looks_gotofrontback', {}, {FRONT_BACK: [name.endsWith('goToFront') ? 'front' : 'back', null]});
          else if (name === 'runtime.ioDevices.clock.resetProjectTimer' && !args.length) operation = command('sensing_resettimer');
        }
        if (!operation && !yielded) operation = decodeNativeCommand(node, {project, targetIndex,
          reporter: (child, context) => reporter(child, context, depth + 1), chain, literal, identifier, member, numeric, fail, assume});
        if (!operation) fail('脚本体含尚未支持或仍混淆的操作，保留完整原代码而不跳过语句');
      } else fail(`不支持 ${statement.type}，整段脚本体不作猜测恢复`);
      operation.span = [statement.start, statements[index].end];
      operations.push(operation);
    }
    return operations;
  };
  const unwrapStatements = (body, depth = 0) => {
    if (depth > 64) fail('嵌套语句块超过恢复上限');
    if (body.some(statement => statement.type === 'VariableDeclaration' && statement.kind !== 'var' && statement.declarations.some(declaration => identifier(declaration.id) && declared.has(declaration.id.name)))) fail('嵌套词法绑定遮蔽factory');
    return body.flatMap(statement => statement.type === 'BlockStatement' ? unwrapStatements(statement.body, depth + 1) : [statement]);
  };
  let statements = executableHat ? [...script.body.body] : unwrapStatements(script.body.body);
  let recoveredHat = null;
  if (executableHat) {
    const decodedHat = decodeExecutableHat({statements, opcodeAliases, hatOpcode: executableHat.opcode, scriptId: executableHat.scriptId,
      reporter: (node, context) => reporter(node, context || 'value', 0)});
    recoveredHat = decodedHat.hat;
    statements.splice(0, decodedHat.consumed);
    statements = unwrapStatements(statements);
  }
  if (procedure && statements.at(-1)?.type === 'ReturnStatement' && literal(statements.at(-1).argument) === '') statements.pop();
  else if (procedure && statements.at(-1)?.type === 'ReturnStatement' && statements.at(-1).argument) {}
  else if (statements.at(-1)?.type === 'ReturnStatement' && !statements.at(-1).argument &&
      call(statements.at(-2)?.expression, 'retire') && statements.at(-2).expression.arguments.length === 0) statements.splice(-2);
  else if (!statements.length || statements.at(-1)?.type !== 'WhileStatement' || literal(statements.at(-1).test) !== true) fail('脚本缺少受支持的retire/return尾部');
  const operations = decodeStatements(statements);
  return {operations, hat: recoveredHat, syntheticMenuDefaults, analysisSteps: steps, grammar: 'recursive-02-compiler-templates', semanticReconstruction: true,
    assumptions: [...new Set(assumptions)], preferences: [...new Set(preferences)], preferenceKinds: [...preferenceKinds]};
}
