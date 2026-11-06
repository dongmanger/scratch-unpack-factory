import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {analyzeBuiltinInvocations} from './builtin-invocations.mjs';

const traverse = traverseModule.default || traverseModule;
const builtinNames = new Set([
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean',
  'decodeURIComponent', 'encodeURIComponent', 'atob',
  'Math', 'Array', 'Object', 'JSON', 'Reflect'
]);

/** Flow-insensitive may-alias analysis: each binding can reference several builtins. */
export function analyzeBuiltinEffects(ast) {
  const aliases = new Map();
  const successors = new Map();
  const bindings = new Map();
  const seeds = [];
  const unknownBindings = new Set();
  const blockedBuiltins = new Set();
  const blockedBuiltinMembers = new Set();

  const remember = binding => {
    if (binding) bindings.set(binding.identifier, binding);
    return binding?.identifier;
  };
  const collectEdge = (path, left, right, depth = 0) => {
    if (!t.isIdentifier(left) || !right) return;
    const destination = remember(path.scope.getBinding(left.name));
    if (!destination) return;
    if (depth > 40) {
      for (const name of builtinNames) seeds.push([destination, name]);
    } else if (t.isConditionalExpression(right) || t.isLogicalExpression(right)) {
      const branches = t.isConditionalExpression(right) ? [right.consequent, right.alternate] : [right.left, right.right];
      for (const branch of branches) collectEdge(path, left, branch, depth + 1);
    } else if (t.isSequenceExpression(right)) {
      collectEdge(path, left, right.expressions.at(-1), depth + 1);
    } else if (t.isIdentifier(right)) {
      const source = remember(path.scope.getBinding(right.name));
      if (source) {
        if (!successors.has(source)) successors.set(source, new Set());
        successors.get(source).add(destination);
      } else if (builtinNames.has(right.name)) seeds.push([destination, right.name]);
      else unknownBindings.add(destination);
    } else if (!t.isObjectExpression(right) && !t.isArrayExpression(right) && !t.isFunction(right) && !t.isLiteral(right)) {
      unknownBindings.add(destination);
    }
  };

  // Collect the whole binding graph before scanning writes, including mutable assignments.
  traverse(ast, {
    VariableDeclarator(path) { collectEdge(path, path.node.id, path.node.init); },
    AssignmentExpression(path) {
      if (path.node.operator === '=') collectEdge(path, path.node.left, path.node.right);
    }
  });

  // Each (binding, builtin) fact enters the queue once, even through cycles.
  const queue = [];
  const addFact = (binding, name) => {
    if (!aliases.has(binding)) aliases.set(binding, new Set());
    if (aliases.get(binding).has(name)) return;
    aliases.get(binding).add(name);
    queue.push([binding, name]);
  };
  for (const [binding, name] of seeds) addFact(binding, name);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [source, name] = queue[cursor];
    for (const destination of successors.get(source) || []) addFact(destination, name);
  }

  const unknownQueue = [...unknownBindings];
  for (let cursor = 0; cursor < unknownQueue.length; cursor++) {
    for (const destination of successors.get(unknownQueue[cursor]) || []) {
      if (unknownBindings.has(destination)) continue;
      unknownBindings.add(destination);
      unknownQueue.push(destination);
    }
  }
  const possibleBuiltins = (path, node, depth = 0) => {
    if (!node) return new Set();
    if (depth > 40) return builtinNames;
    if (t.isSequenceExpression(node)) return possibleBuiltins(path, node.expressions.at(-1), depth + 1);
    if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
      const branches = t.isConditionalExpression(node) ? [node.consequent, node.alternate] : [node.left, node.right];
      return new Set(branches.flatMap(branch => [...possibleBuiltins(path, branch, depth + 1)]));
    }
    if (!t.isIdentifier(node)) return new Set();
    const binding = path.scope.getBinding(node.name);
    if (binding) {
      const possible = aliases.get(binding.identifier) || new Set();
      return possible.size && unknownBindings.has(binding.identifier) ? builtinNames : possible;
    }
    return builtinNames.has(node.name) ? new Set([node.name]) : new Set();
  };
  const markMemberMutation = (possible, property) => {
    for (const name of possible) {
      if (property === null) blockedBuiltins.add(name);
      else blockedBuiltinMembers.add(`${name}.${property}`);
    }
  };
  const literalProperty = node =>
    t.isStringLiteral(node) || t.isNumericLiteral(node) ? String(node.value) : null;
  const invocations = analyzeBuiltinInvocations(ast, {possibleBuiltins, literalProperty, remember});
  const unknown = argument => invocations.isUnknownArgument(argument);
  let argumentResolutionSteps = 0;
  let argumentResolutionLimited = false;
  const argumentCache = new Map();
  const argumentBuiltins = (argument, active = new Set(), depth = 0) => {
    if (unknown(argument)) return builtinNames;
    if (++argumentResolutionSteps > 20000 || depth > 40) {
      argumentResolutionLimited = true;
      return builtinNames;
    }
    if (!argument?.node) return new Set();
    if (argument.isSequenceExpression()) return argumentBuiltins(argument.get('expressions').at(-1), active, depth + 1);
    if (argument.isConditionalExpression() || argument.isLogicalExpression()) {
      const branches = argument.isConditionalExpression() ? ['consequent', 'alternate'] : ['left', 'right'];
      return new Set(branches.flatMap(branch => [...argumentBuiltins(argument.get(branch), active, depth + 1)]));
    }
    if (argument.isIdentifier()) {
      const possible = possibleBuiltins(argument, argument.node);
      if (possible.size) return possible;
      const binding = argument.scope.getBinding(argument.node.name);
      if (unknownBindings.has(binding?.identifier)) return builtinNames;
      if (!binding?.constant || !binding.path.isVariableDeclarator() || active.has(binding.identifier)) return builtinNames;
      if (argumentCache.has(binding.identifier)) return argumentCache.get(binding.identifier);
      const resolved = argumentBuiltins(binding.path.get('init'), new Set(active).add(binding.identifier), depth + 1);
      argumentCache.set(binding.identifier, resolved);
      return resolved;
    }
    if (argument.isObjectExpression() || argument.isArrayExpression() || argument.isFunctionExpression() ||
        argument.isArrowFunctionExpression() || t.isLiteral(argument.node)) return new Set();
    return builtinNames;
  };
  const argumentKey = argument => unknown(argument) ? null : literalProperty(argument?.node);
  const markWrite = (path, node) => {
    if (t.isIdentifier(node)) {
      // Rebinding a local alias does not itself change any builtin object.
      if (!path.scope.getBinding(node.name) && builtinNames.has(node.name)) blockedBuiltins.add(node.name);
      return;
    }
    if (!t.isMemberExpression(node)) return;
    const property = node.computed ? literalProperty(node.property) : node.property.name;
    markMemberMutation(possibleBuiltins(path, node.object), property);
  };
  const markObjectProperties = (targets, source) => {
    if (unknown(source) || !source?.isObjectExpression()) {
      markMemberMutation(targets, null);
      return;
    }
    for (const property of source.node.properties) {
      // Accessors and spreads can introduce unknown keys and other effects.
      if (!t.isObjectProperty(property)) {
        markMemberMutation(targets, null);
        continue;
      }
      const key = property.computed ? literalProperty(property.key) :
        (t.isIdentifier(property.key) ? property.key.name : literalProperty(property.key));
      markMemberMutation(targets, key);
    }
  };
  const markInvocation = call => {
    const {method, args, unknownTail} = call;
    const has = index => index < args.length || unknownTail;
    const argument = index => index < args.length ? args[index] : unknownTail ?
      // Unresolved positions may contain any builtin; never choose a host default.
      invocations.unknownArgument : null;
    const targets = argumentBuiltins(argument(0));
    const key = argumentKey(argument(1));
    if ((method === 'Reflect.deleteProperty' && has(1)) ||
        ((method === 'Reflect.set' || method === 'Reflect.defineProperty') && has(2)) ||
        (method === 'Object.defineProperty' && has(1))) markMemberMutation(targets, key);
    if (method === 'Reflect.set' && has(3)) markMemberMutation(argumentBuiltins(argument(3)), key);
    if (method === 'Object.defineProperties' && has(1)) markObjectProperties(targets, argument(1));
    if (method === 'Object.assign') {
      for (const source of args.slice(1)) {
        if (!unknown(source) && source?.isNullLiteral()) continue;
        markObjectProperties(targets, source);
      }
      if (unknownTail) markMemberMutation(targets, null);
    }
  };

  traverse(ast, {
    AssignmentExpression(path) { markWrite(path, path.node.left); },
    UpdateExpression(path) { markWrite(path, path.node.argument); },
    UnaryExpression(path) { if (path.node.operator === 'delete') markWrite(path, path.node.argument); },
    CallExpression(path) {
      for (const call of invocations.resolveCall(path)) markInvocation(call);
    }
  });
  const invocationStats = {...invocations.stats(), argumentResolutionSteps, argumentResolutionLimited};
  if (invocationStats.invocationResolutionLimited || argumentResolutionLimited) {
    for (const name of builtinNames) blockedBuiltins.add(name);
  }

  return {
    aliases, blockedBuiltins, blockedBuiltinMembers,
    stats: {
      bindings: bindings.size,
      edges: [...successors.values()].reduce((sum, set) => sum + set.size, 0),
      processedFacts: queue.length,
      finiteFactLimit: bindings.size * builtinNames.size,
      ...invocationStats
    },
    aliasSummary: [...aliases].map(([id, names]) => ({
      name: id.name, declarationStart: id.start ?? null, possibleBuiltins: [...names].sort()
    })),
    methodAliasSummary: invocations.aliasSummary
  };
}
