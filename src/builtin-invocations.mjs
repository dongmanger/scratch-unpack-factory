import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default || traverseModule;
const builtinMethods = new Set([
  'Reflect.deleteProperty', 'Reflect.set', 'Reflect.defineProperty',
  'Object.defineProperty', 'Object.defineProperties', 'Object.assign'
]);
const UNKNOWN = Symbol('unknown argument');
const MAX_ARGUMENTS = 32;
const MAX_DEPTH = 40;
const MAX_RESOLUTION_STEPS = 20000;

/** Method facts converge separately from argument resolution, including cyclic bind chains. */
export function analyzeBuiltinInvocations(ast, {possibleBuiltins, literalProperty, remember}) {
  const inputs = new Map();
  const successors = new Map();
  const aliases = new Map();
  const seeds = [];
  const keyOf = member => member.node.computed ? literalProperty(member.node.property) : member.node.property.name;
  const memberMethods = (object, property) => {
    const methods = new Set();
    for (const name of possibleBuiltins(object, object.node)) {
      for (const method of builtinMethods) {
        if (method.startsWith(`${name}.`) && (property === null || method === `${name}.${property}`)) methods.add(method);
      }
    }
    return methods;
  };
  const collectDependencies = (destination, source, depth = 0) => {
    if (depth > MAX_DEPTH) {
      for (const method of builtinMethods) seeds.push([destination, method]);
      return;
    }
    if (source.isIdentifier()) {
      const binding = remember(source.scope.getBinding(source.node.name));
      if (!binding) return;
      if (!successors.has(binding)) successors.set(binding, new Set());
      successors.get(binding).add(destination);
    } else if (source.isMemberExpression()) {
      for (const method of memberMethods(source.get('object'), keyOf(source))) seeds.push([destination, method]);
    } else if (source.isCallExpression() && source.get('callee').isMemberExpression() && (keyOf(source.get('callee')) === 'bind' || keyOf(source.get('callee')) === null)) {
      collectDependencies(destination, source.get('callee.object'), depth + 1);
    } else if (source.isConditionalExpression()) {
      collectDependencies(destination, source.get('consequent'), depth + 1);
      collectDependencies(destination, source.get('alternate'), depth + 1);
    } else if (source.isLogicalExpression()) {
      collectDependencies(destination, source.get('left'), depth + 1);
      collectDependencies(destination, source.get('right'), depth + 1);
    } else if (source.isSequenceExpression()) {
      collectDependencies(destination, source.get('expressions').at(-1), depth + 1);
    }
  };
  const addInput = (destination, input) => {
    if (!inputs.has(destination)) inputs.set(destination, []);
    inputs.get(destination).push(input);
    if (input.kind === 'member') {
      for (const method of memberMethods(input.object, input.key)) seeds.push([destination, method]);
    } else collectDependencies(destination, input.path);
  };
  const collect = (left, right) => {
    if (!right?.node) return;
    if (left.isIdentifier()) {
      const destination = remember(left.scope.getBinding(left.node.name));
      if (destination) addInput(destination, {kind: 'expression', path: right});
      return;
    }
    if (!left.isObjectPattern()) return;
    for (const property of left.get('properties')) {
      if (!property.isObjectProperty()) continue;
      const key = property.node.computed ? literalProperty(property.node.key) :
        (t.isIdentifier(property.node.key) ? property.node.key.name : literalProperty(property.node.key));
      const value = property.get('value');
      const target = value.isAssignmentPattern() ? value.get('left') : value;
      if (!target.isIdentifier()) continue;
      const destination = remember(target.scope.getBinding(target.node.name));
      if (!destination) continue;
      addInput(destination, {kind: 'member', object: right, key});
      if (value.isAssignmentPattern()) addInput(destination, {kind: 'expression', path: value.get('right')});
    }
  };
  traverse(ast, {
    VariableDeclarator(path) { collect(path.get('id'), path.get('init')); },
    AssignmentExpression(path) {
      if (path.node.operator === '=') collect(path.get('left'), path.get('right'));
    }
  });

  const queue = [];
  const addFact = (binding, method) => {
    if (!aliases.has(binding)) aliases.set(binding, new Set());
    if (aliases.get(binding).has(method)) return;
    aliases.get(binding).add(method);
    queue.push([binding, method]);
  };
  for (const [binding, method] of seeds) addFact(binding, method);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [binding, method] = queue[cursor];
    for (const destination of successors.get(binding) || []) addFact(destination, method);
  }

  let resolutionSteps = 0;
  let resolutionLimited = false;
  const enter = depth => {
    if (++resolutionSteps > MAX_RESOLUTION_STEPS || depth > MAX_DEPTH) {
      resolutionLimited = true;
      return false;
    }
    return true;
  };
  const unknownHandles = methods => [...methods].map(method => ({method, prefix: [], unknownPrefix: true, unknownTail: true}));
  const knownMethods = (path, depth = 0) => {
    if (depth > MAX_DEPTH) {
      resolutionLimited = true;
      return builtinMethods;
    }
    if (path.isIdentifier()) return aliases.get(path.scope.getBinding(path.node.name)?.identifier) || new Set();
    if (path.isMemberExpression()) return memberMethods(path.get('object'), keyOf(path));
    if (path.isCallExpression() && path.get('callee').isMemberExpression() && (keyOf(path.get('callee')) === 'bind' || keyOf(path.get('callee')) === null)) {
      return knownMethods(path.get('callee.object'), depth + 1);
    }
    if (path.isConditionalExpression() || path.isLogicalExpression()) {
      const branches = path.isConditionalExpression() ? ['consequent', 'alternate'] : ['left', 'right'];
      return new Set(branches.flatMap(branch => [...knownMethods(path.get(branch), depth + 1)]));
    }
    if (path.isSequenceExpression()) return knownMethods(path.get('expressions').at(-1), depth + 1);
    return new Set();
  };
  const argumentList = paths => {
    const items = [];
    for (const path of paths) {
      if (path.isSpreadElement() || items.length === MAX_ARGUMENTS) return {items, unknownTail: true};
      items.push(path);
    }
    return {items, unknownTail: false};
  };
  const arrayList = (path, active = new Set(), depth = 0) => {
    if (!path?.node || !enter(depth)) return {items: [], unknownTail: true};
    if (path.isArrayExpression()) {
      const items = [];
      for (const element of path.get('elements')) {
        // Spread consults an iterator, even for a literal array.
        if (element.isSpreadElement() || items.length === MAX_ARGUMENTS) return {items, unknownTail: true};
        items.push(element.node ? element : UNKNOWN);
      }
      return {items, unknownTail: false};
    }
    if (!path.isIdentifier()) return {items: [], unknownTail: true};
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator() || active.has(binding.identifier) ||
        binding.referencePaths.length !== 1) return {items: [], unknownTail: true};
    // Only apply-argument reads are accepted; member writes, escapes and aliasing widen the list.
    if (binding.referencePaths.some(ref => !ref.parentPath.isCallExpression() ||
        ref.parentPath.get('arguments')[1] !== ref || !ref.parentPath.get('callee').isMemberExpression() ||
        keyOf(ref.parentPath.get('callee')) !== 'apply' ||
        !knownMethods(ref.parentPath.get('callee.object')).size)) return {items: [], unknownTail: true};
    const next = new Set(active).add(binding.identifier);
    return arrayList(binding.path.get('init'), next, depth + 1);
  };
  const combine = (handle, args) => {
    if (handle.unknownPrefix) return {method: handle.method, args: [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN], unknownTail: true};
    if (handle.unknownTail) return {method: handle.method, args: handle.prefix, unknownTail: true};
    const combined = [...handle.prefix, ...args.items];
    return {method: handle.method, args: combined.slice(0, MAX_ARGUMENTS), unknownTail: args.unknownTail || combined.length > MAX_ARGUMENTS};
  };
  const handlesFor = (path, active = new Set(), depth = 0) => {
    if (!path?.node) return [];
    const methods = knownMethods(path);
    if (!enter(depth)) return unknownHandles(methods);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !methods.size) return [];
      if (active.has(binding.identifier)) return unknownHandles(methods);
      const next = new Set(active).add(binding.identifier);
      const handles = [];
      for (const input of inputs.get(binding.identifier) || []) {
        if (input.kind === 'member') {
          for (const method of memberMethods(input.object, input.key)) handles.push({method, prefix: [], unknownTail: false});
        } else handles.push(...handlesFor(input.path, next, depth + 1));
        if (resolutionSteps > MAX_RESOLUTION_STEPS || handles.length > 128) {
          resolutionLimited = true;
          return unknownHandles(methods);
        }
      }
      return handles;
    }
    if (path.isMemberExpression()) return [...methods].map(method => ({method, prefix: [], unknownTail: false}));
    if (path.isCallExpression() && path.get('callee').isMemberExpression() && (keyOf(path.get('callee')) === 'bind' || keyOf(path.get('callee')) === null)) {
      const source = handlesFor(path.get('callee.object'), active, depth + 1);
      if (keyOf(path.get('callee')) === null) return unknownHandles(new Set(source.map(handle => handle.method)));
      const raw = path.get('arguments');
      const args = raw[0]?.isSpreadElement() ? {items: [], unknownTail: true} : argumentList(raw.slice(1));
      return source.map(handle => {
        const call = combine(handle, args);
        return {method: call.method, prefix: call.args, unknownPrefix: handle.unknownPrefix, unknownTail: call.unknownTail};
      });
    }
    if (path.isConditionalExpression()) return [
      ...handlesFor(path.get('consequent'), active, depth + 1),
      ...handlesFor(path.get('alternate'), active, depth + 1)
    ];
    if (path.isLogicalExpression()) return [
      ...handlesFor(path.get('left'), active, depth + 1),
      ...handlesFor(path.get('right'), active, depth + 1)
    ];
    if (path.isSequenceExpression()) return handlesFor(path.get('expressions').at(-1), active, depth + 1);
    return [];
  };

  return {
    resolveCall(path) {
      const callee = path.get('callee');
      let methodSource = callee;
      let args = argumentList(path.get('arguments'));
      if (callee.isMemberExpression()) {
        const operation = keyOf(callee);
        if (operation === 'bind') return [];
        if (operation === null) {
          const methods = knownMethods(callee.get('object'));
          if (methods.size) return [...methods].map(method => ({method, args: [], unknownTail: true}));
        }
        if (operation === 'call' || operation === 'apply') {
          methodSource = callee.get('object');
          const raw = path.get('arguments');
          args = raw[0]?.isSpreadElement() || (operation === 'apply' && raw[1]?.isSpreadElement()) ?
            {items: [], unknownTail: true} : operation === 'call' ? argumentList(raw.slice(1)) : arrayList(raw[1]);
        }
      }
      return handlesFor(methodSource).map(handle => combine(handle, args));
    },
    unknownArgument: UNKNOWN,
    isUnknownArgument(argument) { return argument === UNKNOWN; },
    aliasSummary: [...aliases].map(([id, methods]) => ({
      name: id.name, declarationStart: id.start ?? null, possibleMethods: [...methods].sort()
    })),
    stats() {
      return {
        methodProcessedFacts: queue.length,
        finiteMethodFactLimit: inputs.size * builtinMethods.size,
        invocationResolutionSteps: resolutionSteps,
        invocationResolutionLimited: resolutionLimited
      };
    }
  };
}
