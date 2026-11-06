import * as t from '@babel/types';

export class StaticUnknown extends Error {}
const unknown = message => { throw new StaticUnknown(message); };
const primitive = value => value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'caller', 'callee']);

/** Bounded AST interpretation: no eval, Function, host objects, file/network access or arbitrary calls. */
export class StaticEvaluator {
  constructor({maxSteps = 300000, maxString = 2_000_000} = {}) {
    this.steps = 0;
    this.maxSteps = maxSteps;
    this.maxString = maxString;
    this.specialBindings = new Map();
    this.cache = new Map();
    this.active = new Set();
    this.blockedBuiltins = new Set();
    this.blockedBuiltinMembers = new Set();
    // Binding identifiers map to monotonically accumulated sets of possible builtins.
    this.builtinAliases = new Map();
  }
  tick() { if (++this.steps > this.maxSteps) unknown('静态求值步数达到上限'); }
  check(value) {
    if (typeof value === 'string' && value.length > this.maxString) unknown('静态字符串超过上限');
    return value;
  }
  evaluate(path, env = new Map(), depth = 0) {
    this.tick();
    if (depth > 40 || !path?.node) unknown('不支持/过深的静态表达式');
    const node = path.node;
    const ev = child => this.evaluate(child, env, depth + 1);
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
    if (t.isNullLiteral(node)) return null;
    if (t.isIdentifier(node)) {
      if (this.blockedBuiltins.has(node.name)) unknown(`全局builtin被重写：${node.name}`);
      const binding = path.scope.getBinding(node.name);
      if (binding) {
        if (env.has(binding.identifier)) return env.get(binding.identifier);
        if (this.specialBindings.has(binding.identifier)) return this.specialBindings.get(binding.identifier);
        if (this.active.has(binding.identifier)) unknown('循环常量绑定');
        if (binding.path.isFunctionDeclaration()) return {kind: 'function', path: binding.path};
        if (!binding.constant || !binding.path.isVariableDeclarator()) unknown('可变或未支持的绑定');
        const initPath = binding.path.get('init');
        if (path.node.start !== undefined && binding.path.node.end !== undefined && path.node.start < binding.path.node.end &&
            !path.findParent(p => p === binding.path)) unknown('声明初始化前的引用不能折叠');
        if (initPath.isArrayExpression() || initPath.isObjectExpression()) {
          const readonly = binding.referencePaths.every(ref => {
            const parent = ref.parentPath;
            if (!parent.isMemberExpression() || ref.key !== 'object') return false;
            const owner = parent.parentPath;
            if ((owner.isAssignmentExpression() && owner.node.left === parent.node) || owner.isUpdateExpression() || owner.isUnaryExpression({operator: 'delete'})) return false;
            if (owner.isCallExpression() && owner.node.callee === parent.node) {
              const key = parent.node.computed ? parent.node.property.value : parent.node.property.name;
              return initPath.isArrayExpression() && ['join', 'indexOf', 'slice'].includes(key);
            }
            return true;
          });
          if (!readonly) unknown('对象/数组被修改或逃逸，不做静态常量替换');
        }
        this.active.add(binding.identifier);
        try { return ev(binding.path.get('init')); } finally { this.active.delete(binding.identifier); }
      }
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      if (['parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'decodeURIComponent', 'encodeURIComponent', 'atob'].includes(node.name)) return {kind: 'builtin', name: node.name};
      unknown(`无法静态解析标识符 ${node.name}`);
    }
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return {kind: 'function', path};
    if (t.isArrayExpression(node)) {
      if (node.elements.length > 10000) unknown('数组过大');
      return path.get('elements').map(p => p.node ? ev(p) : undefined);
    }
    if (t.isObjectExpression(node)) {
      const result = Object.create(null);
      for (const property of path.get('properties')) {
        if (!property.isObjectProperty() || property.node.method) unknown('不支持对象方法/spread');
        const key = property.node.computed ? ev(property.get('key')) : property.node.key.name ?? property.node.key.value;
        if (!primitive(key) || forbidden.has(String(key))) unknown('禁止对象属性');
        result[key] = ev(property.get('value'));
      }
      return result;
    }
    if (t.isUnaryExpression(node)) {
      const value = ev(path.get('argument'));
      if (node.operator === '!') return !value;
      if (node.operator === 'void') return undefined;
      if (node.operator === 'typeof' && primitive(value)) return typeof value;
      if (!primitive(value)) unknown('不对对象做隐式数值转换');
      if (node.operator === '+') return +value;
      if (node.operator === '-') return -value;
      if (node.operator === '~') return ~value;
      unknown('不支持unary操作');
    }
    if (t.isBinaryExpression(node)) {
      const a = ev(path.get('left')), b = ev(path.get('right'));
      if (!primitive(a) || !primitive(b)) unknown('只支持原始值二元运算');
      switch (node.operator) {
      case '+': return this.check(a + b); case '-': return a - b; case '*': return a * b;
      case '/': return a / b; case '%': return a % b; case '**': return a ** b;
      case '^': return a ^ b; case '&': return a & b; case '|': return a | b;
      case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      case '===': return a === b; case '!==': return a !== b;
      case '==': return a == b; case '!=': return a != b;
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      default: unknown('不支持binary操作');
      }
    }
    if (t.isLogicalExpression(node)) {
      const a = ev(path.get('left'));
      return node.operator === '&&' ? (a && ev(path.get('right'))) : node.operator === '||' ? (a || ev(path.get('right'))) : (a ?? ev(path.get('right')));
    }
    if (t.isConditionalExpression(node)) return ev(path.get('test')) ? ev(path.get('consequent')) : ev(path.get('alternate'));
    if (t.isSequenceExpression(node)) {
      let value;
      for (const p of path.get('expressions')) value = ev(p);
      return value;
    }
    if (t.isTemplateLiteral(node)) {
      let text = '';
      const expressions = path.get('expressions');
      for (let i = 0; i < node.quasis.length; i++) {
        text += node.quasis[i].value.cooked;
        if (i < expressions.length) {
          const value = ev(expressions[i]);
          if (!primitive(value)) unknown('不支持模板对象转换');
          text += String(value);
        }
      }
      return this.check(text);
    }
    if (t.isMemberExpression(node)) {
      if (t.isIdentifier(node.object, {name: 'String'}) && !path.scope.getBinding('String')) {
        const member = node.computed ? (t.isStringLiteral(node.property) ? node.property.value : null) : node.property.name;
        if (member === 'fromCharCode') {
          if (this.blockedBuiltins.has('String') || this.blockedBuiltinMembers.has('String.fromCharCode')) unknown('全局builtin或成员被重写/删除：String.fromCharCode');
          return {kind: 'builtin', name: 'fromCharCode'};
        }
        if (member !== null && this.blockedBuiltinMembers.has(`String.${member}`)) unknown(`全局builtin成员被重写：String.${member}`);
      }
      const object = ev(path.get('object'));
      const key = node.computed ? ev(path.get('property')) : node.property.name;
      if (!primitive(key) || forbidden.has(String(key))) unknown('禁止属性求值');
      if ((typeof object === 'string' || Array.isArray(object)) && key === 'length') return object.length;
      if ((typeof object === 'string' || Array.isArray(object)) && /^\d+$/.test(String(key))) {
        const value = object[Number(key)];
        if (!primitive(value)) unknown('嵌套对象可能被外部修改，不作为不可变常量');
        return value;
      }
      if (object && Object.getPrototypeOf(object) === null && Object.hasOwn(object, key)) {
        const value = object[key];
        if (!primitive(value) && value?.kind !== 'function') unknown('嵌套可变对象不折叠');
        return value;
      }
      if (['string', 'number'].includes(typeof object) && ['charAt', 'charCodeAt', 'indexOf', 'slice', 'substring', 'substr', 'split', 'toLowerCase', 'toUpperCase', 'toString'].includes(key)) return {kind: 'method', object, key};
      if (Array.isArray(object) && ['join', 'indexOf', 'slice'].includes(key)) return {kind: 'method', object, key};
      unknown('不支持静态成员访问');
    }
    if (t.isCallExpression(node)) {
      if (node.optional || node.arguments.some(a => t.isSpreadElement(a))) unknown('不支持optional/spread调用');
      const fn = ev(path.get('callee'));
      const args = path.get('arguments').map(ev);
      if (fn?.kind === 'decoder') return this.check(fn.decode(args));
      if (fn?.kind === 'provider') { if (args.length) unknown('provider参数未知'); return fn.array; }
      if (fn?.kind === 'builtin') {
        if (!args.every(primitive)) unknown('内置函数只允许原始参数');
        switch (fn.name) {
        case 'parseInt': return parseInt(...args); case 'parseFloat': return parseFloat(...args);
        case 'Number': return Number(...args); case 'String': return String(...args); case 'Boolean': return Boolean(...args);
        case 'decodeURIComponent': return this.check(decodeURIComponent(...args));
        case 'encodeURIComponent': return this.check(encodeURIComponent(...args));
        case 'fromCharCode': return this.check(String.fromCharCode(...args));
        case 'atob': return this.check(atob(...args));
        default: unknown('未支持builtin');
        }
      }
      if (fn?.kind === 'method') {
        if (!args.every(primitive)) unknown('方法参数必须为原始值');
        if (fn.key === 'split' && fn.object.length > this.maxString) unknown('split字符串过长');
        return this.check(fn.object[fn.key](...args));
      }
      if (fn?.kind === 'function') {
        const fnPath = fn.path;
        const body = fnPath.get('body');
        const nextEnv = new Map(env);
        if (fnPath.node.params.length > args.length) unknown('静态wrapper参数缺失');
        for (let i = 0; i < fnPath.node.params.length; i++) {
          const param = fnPath.node.params[i];
          if (!t.isIdentifier(param)) unknown('不支持解构参数');
          const binding = fnPath.scope.getBinding(param.name);
          nextEnv.set(binding?.identifier || param, args[i]);
        }
        if (!body.isBlockStatement()) return this.evaluate(body, nextEnv, depth + 1);
        const statements = body.get('body');
        if (statements.length !== 1 || !statements[0].isReturnStatement()) unknown('不是无副作用单return包装函数');
        return this.evaluate(statements[0].get('argument'), nextEnv, depth + 1);
      }
      unknown('不执行任意调用');
    }
    unknown(`不支持静态节点 ${node.type}`);
  }
}

export const literalNode = value => {
  if (value === undefined) return t.unaryExpression('void', t.numericLiteral(0));
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return null;
    return t.numericLiteral(value);
  }
  if (typeof value === 'string') return t.stringLiteral(value);
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (value === null) return t.nullLiteral();
  return null;
};
