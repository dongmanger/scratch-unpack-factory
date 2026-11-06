import {parse} from 'acorn';

const FACTORY_SOURCE_LIMIT = 2_000_000;
const YIELD_HELPERS = new Set(['yieldThenCall', 'yieldThenCallGenerator']);

const isNode = value => !!value && typeof value === 'object' && typeof value.type === 'string';
const isIdentifier = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);

const bindingNames = pattern => {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'RestElement') return bindingNames(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(bindingNames);
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(property => {
    if (property.type === 'RestElement') return bindingNames(property.argument);
    return bindingNames(property.value);
  });
  return [];
};

const staticString = node => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }
  return null;
};

const propertyName = node => {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  return staticString(node.property);
};

const childNodes = node => {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc', 'raw'].includes(key)) continue;
    if (Array.isArray(value)) children.push(...value.filter(isNode));
    else if (isNode(value)) children.push(value);
  }
  return children;
};

const hasDirectBlockThreadBinding = block => {
  if (block?.type !== 'BlockStatement') return false;
  return block.body.some(statement => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      return statement.declarations.some(declaration => bindingNames(declaration.id).includes('thread'));
    }
    return (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
      isIdentifier(statement.id, 'thread');
  });
};

const functionHasVarThreadBinding = (functionNode, rootBody) => {
  let found = false;
  const scan = node => {
    if (!isNode(node) || found) return;
    if (node !== rootBody && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression')) return;
    if (node.type === 'VariableDeclaration' && node.kind === 'var' &&
        node.declarations.some(declaration => bindingNames(declaration.id).includes('thread'))) {
      found = true;
      return;
    }
    for (const child of childNodes(node)) scan(child);
  };
  scan(rootBody);
  return found;
};

const functionShadowsThread = node => {
  if (node.id && isIdentifier(node.id, 'thread')) return true;
  if (node.params.some(parameter => bindingNames(parameter).includes('thread'))) return true;
  return functionHasVarThreadBinding(node, node.body);
};

const factoryFromSource = source => {
  if (typeof source !== 'string' || source.length > FACTORY_SOURCE_LIMIT) {
    throw new Error('factorySource missing or exceeds static analysis limit');
  }
  const ast = parse(source, {ecmaVersion: 'latest'});
  if (ast.body.length !== 1) throw new Error('factorySource must contain one factory expression');
  const statement = ast.body[0];
  const factory = statement.type === 'ExpressionStatement' ? statement.expression :
    statement.type === 'FunctionDeclaration' ? statement : null;
  if (!['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(factory?.type) ||
      factory.params.length !== 1 || !isIdentifier(factory.params[0], 'thread')) {
    throw new Error('factory must have exactly one outer parameter named thread');
  }
  return {factory, ast};
};

const procedureObject = node => {
  if (node?.type !== 'MemberExpression' || propertyName(node) !== 'procedures') return false;
  return isIdentifier(node.object, 'thread');
};

const procedureMember = node => {
  if (node?.type !== 'MemberExpression' || !procedureObject(node.object)) return null;
  if (!node.computed && node.property?.type === 'Identifier') return {key: node.property.name, known: true};
  const key = staticString(node.property);
  if (key !== null) return {key, known: true};
  return {key: null, known: false};
};

const directlySupported = (node, parent) => {
  if (parent?.type === 'CallExpression' && parent.callee === node) return true;
  return parent?.type === 'CallExpression' && YIELD_HELPERS.has(parent.callee?.name) &&
    parent.arguments[0] === node;
};

const analyzeFactory = source => {
  const {factory} = factoryFromSource(source);
  const dependencies = new Set();
  const unknown = new Set();
  const walkWithParents = (node, state, parent = null) => {
    if (!isNode(node)) return;
    if (state.threadValid) {
      const member = procedureMember(node);
      if (member) {
        if (member.known) {
          dependencies.add(member.key);
          if (!directlySupported(node, parent)) unknown.add('thread.procedures member alias is unsupported; only direct calls or yieldThenCall are supported');
        } else unknown.add('dynamic thread.procedures variant key is unsupported');
      } else if (procedureObject(node) && !(parent?.type === 'MemberExpression' && parent.object === node)) {
        unknown.add('thread.procedures object alias is unsupported');
      }
    }

    let nextState = state;
    if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
      nextState = {...state, threadValid: state.threadValid && !functionShadowsThread(node)};
      if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
        if (node.body?.type === 'BlockStatement') {
          walkWithParents(node.body, nextState, node);
        } else walkWithParents(node.body, nextState, node);
      } else walkWithParents(node.body, nextState, node);
      return;
    }
    if (node.type === 'BlockStatement') {
      nextState = {...state, threadValid: state.threadValid && !hasDirectBlockThreadBinding(node)};
    } else if (node.type === 'CatchClause') {
      nextState = {...state, threadValid: state.threadValid && !bindingNames(node.param).includes('thread')};
    }

    for (const [key, value] of Object.entries(node)) {
      if (['type', 'start', 'end', 'loc', 'raw'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (!isNode(child)) continue;
          walkWithParents(child, nextState, node);
        }
      } else if (isNode(value)) {
        walkWithParents(value, nextState, node);
      }
    }
  };

  // Start at the factory body so the outer parameter is the only valid thread binding.
  const initial = {threadValid: true};
  if (factory.body?.type === 'BlockStatement') walkWithParents(factory.body, initial);
  else walkWithParents(factory.body, initial);
  return {dependencies, unknown};
};

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const stronglyConnectedComponents = (nodes, edges) => {
  let index = 0;
  const indexes = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];

  const visit = node => {
    indexes.set(node, index);
    lowlinks.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const dependency of [...(edges.get(node) || [])].sort(compare)) {
      // Unknown variants are reported separately and must not become graph nodes.
      if (!edges.has(dependency)) continue;
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowlinks.set(node, Math.min(lowlinks.get(node), indexes.get(dependency)));
      }
    }
    if (lowlinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    found.push(component.sort(compare));
  };

  for (const node of [...nodes].sort(compare)) if (!indexes.has(node)) visit(node);
  return found;
};

/**
 * Build a pure, variant-level recovery plan from compiled procedure factories.
 * No factory source is executed; only the narrowly recognized runtime member paths
 * are considered procedure references.
 */
export function planProcedureRecovery(signatures) {
  const records = new Map();
  const unresolved = [];
  const addUnresolved = (variant, reason) => {
    if (!unresolved.some(item => item.variant === variant && item.reason === reason)) unresolved.push({variant, reason});
  };

  if (!(signatures instanceof Map)) throw new TypeError('signatures must be a Map');
  for (const [, signature] of signatures) {
    for (const entry of signature?.variants || []) {
      const variant = entry?.variant;
      if (typeof variant !== 'string' || !variant) continue;
      if (!records.has(variant)) records.set(variant, {entry, dependencies: new Set()});
      else addUnresolved(variant, 'duplicate variant appears in more than one signature');
    }
  }

  const nodes = [...records.keys()].sort(compare);
  const edges = new Map(nodes.map(node => [node, new Set()]));
  for (const variant of nodes) {
    const record = records.get(variant);
    let analysis;
    try {
      analysis = analyzeFactory(record.entry?.entry?.factorySource ?? record.entry?.factorySource);
    } catch (error) {
      addUnresolved(variant, error.message || 'factorySource cannot be statically parsed');
      continue;
    }
    for (const dependency of analysis.dependencies) {
      record.dependencies.add(dependency);
      edges.get(variant).add(dependency);
      if (!records.has(dependency)) addUnresolved(variant, `unknown procedure variant dependency: ${dependency}`);
    }
    for (const reason of analysis.unknown) addUnresolved(variant, reason);
  }

  const dependencyObject = {};
  for (const variant of nodes) dependencyObject[variant] = [...records.get(variant).dependencies].sort(compare);

  const rawComponents = stronglyConnectedComponents(nodes, edges);
  const componentByVariant = new Map();
  rawComponents.forEach((component, index) => component.forEach(variant => componentByVariant.set(variant, index)));
  const componentDependencies = rawComponents.map(component => {
    const dependencies = new Set();
    for (const variant of component) {
      for (const dependency of edges.get(variant) || []) {
        if (!component.includes(dependency)) dependencies.add(dependency);
      }
    }
    return [...dependencies].sort(compare);
  });
  const recursive = rawComponents.map(component => component.length > 1 ||
    component.some(variant => edges.get(variant)?.has(variant)));

  const indegree = rawComponents.map(() => 0);
  const dependents = rawComponents.map(() => new Set());
  for (let index = 0; index < rawComponents.length; index++) {
    for (const dependency of componentDependencies[index]) {
      const dependencyIndex = componentByVariant.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex === index || dependents[dependencyIndex].has(index)) continue;
      dependents[dependencyIndex].add(index);
      indegree[index]++;
    }
  }
  const ready = rawComponents.map((component, index) => ({index, key: component[0]}))
    .filter(item => indegree[item.index] === 0)
    .sort((left, right) => compare(left.key, right.key));
  const ordered = [];
  while (ready.length) {
    const current = ready.shift();
    ordered.push(current.index);
    for (const dependent of [...dependents[current.index]].sort((left, right) => compare(rawComponents[left][0], rawComponents[right][0]))) {
      if (--indegree[dependent] === 0) {
        ready.push({index: dependent, key: rawComponents[dependent][0]});
        ready.sort((left, right) => compare(left.key, right.key));
      }
    }
  }

  unresolved.sort((left, right) => compare(left.variant, right.variant) || compare(left.reason, right.reason));
  return {
    components: ordered.map(index => ({
      variants: rawComponents[index].slice(),
      recursive: recursive[index],
      dependencies: componentDependencies[index]
    })),
    dependencies: dependencyObject,
    unresolved
  };
}
