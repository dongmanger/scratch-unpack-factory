const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isDictionary = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const referenceFields = new Set(['VARIABLE', 'LIST', 'BROADCAST_OPTION']);
const blockKeys = ['opcode', 'fields', 'inputs', 'shadowInputs', 'mutation', 'span'];
const expressionTags = ['literal', 'variable', 'list', 'broadcast', 'opcode'];
const numericAssetInputs = new Map([
  ['looks_switchcostumeto', 'COSTUME'], ['looks_switchbackdropto', 'BACKDROP'],
  ['looks_switchbackdroptoandwait', 'BACKDROP'], ['sound_play', 'SOUND_MENU'],
  ['sound_playuntildone', 'SOUND_MENU']
]);

const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
const put = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, configurable: true, writable: true
});
const checkKeys = (object, allowed, path) => {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(path, `unknown property ${JSON.stringify(key)}`);
  }
};
const checkNumber = (value, path) => {
  if (!Number.isFinite(value) || Object.is(value, -0)) fail(path, 'number must be finite and not -0');
};
const checkId = (id, path) => {
  if (typeof id !== 'string' || !id) fail(path, 'ID must be a nonempty string');
};

// Copy JSON metadata without silently dropping values or changing nonfinite numbers/-0.
const copyJSON = (value, path, active = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    checkNumber(value, path);
    return value;
  }
  if (!isDictionary(value) && !Array.isArray(value)) fail(path, 'must contain only JSON values');
  if (active.has(value)) fail(path, 'cyclic metadata');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail(path, 'metadata must use plain objects');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) => copyJSON(item, `${path}/${index}`, active));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, copyJSON(item, `${path}/${key}`, active)]));
  } finally {
    active.delete(value);
  }
};

const readDictionary = (node, key, path) => {
  if (!hasOwn(node, key) || node[key] === undefined) return {};
  if (!isDictionary(node[key])) fail(`${path}/${key}`, 'must be a dictionary');
  return node[key];
};
const copyFields = (node, path) => Object.fromEntries(
  Object.entries(readDictionary(node, 'fields', path)).map(([name, field]) => {
    if (!name || !Array.isArray(field) || field.length !== 2) {
      fail(`${path}/fields/${name}`, 'field must be [value, ID or null]');
    }
    if (typeof field[0] !== 'string' && typeof field[0] !== 'number') {
      fail(`${path}/fields/${name}`, 'field value must be a string or finite number');
    }
    if (typeof field[0] === 'number') checkNumber(field[0], `${path}/fields/${name}`);
    if (field[1] !== null) checkId(field[1], `${path}/fields/${name}`);
    if (referenceFields.has(name) && (typeof field[0] !== 'string' || field[1] === null)) {
      fail(`${path}/fields/${name}`, 'reference field must contain a name and nonempty ID');
    }
    return [name, [...field]];
  })
);

/**
 * Emit a supported stack/reporter IR beneath an existing block, without replacing
 * target.blocks or existing block objects. The parent must have no next block.
 *
 * idFor receives numeric top-level positions, nested stack keys such as
 * "0/SUBSTACK/1", reporter keys such as "0/VALUE/NUM1", and menu shadow keys
 * such as "0/TO/shadow". It must return a unique, nonempty string for each key.
 * Empty stacks return null endpoints. blockCount includes reporters and shadows,
 * but excludes inline primitives and the existing parent.
 *
 * The complete graph is staged before target mutation or recordBlock calls.
 * Records follow graph creation order; reporters/shadows inherit their owner's
 * span unless they supply their own. recordBlock must be synchronous. A thrown
 * callback rolls back graph insertion, but its external side effects cannot be
 * rolled back. Callbacks and idFor must not themselves mutate the target.
 * Opcode semantics and definition lookup remain the caller's responsibility.
 */
export function buildRecoveredStack({target, operations, parentId, idFor, recordBlock}) {
  if (!isDictionary(target) || !isDictionary(target.blocks)) fail('target.blocks', 'must be a dictionary');
  const blocks = target.blocks;
  checkId(parentId, 'parentId');
  if (!hasOwn(blocks, parentId) || !isDictionary(blocks[parentId])) {
    fail('parentId', 'must identify an existing block object');
  }
  if (!Array.isArray(operations)) fail('operations', 'must be an array');
  if (typeof idFor !== 'function') fail('idFor', 'must be a function');
  if (typeof recordBlock !== 'function') fail('recordBlock', 'must be a function');
  const parent = blocks[parentId];
  if (operations.length && parent.next !== null && parent.next !== undefined) {
    fail('parentId', 'parent already has a next block');
  }

  const staged = new Map();
  const records = [];
  const activeNodes = new Set();
  const visit = (node, path, emit) => {
    if (!isDictionary(node)) fail(path, 'must be an IR object');
    if (activeNodes.has(node)) fail(path, 'cyclic IR');
    activeNodes.add(node);
    try {
      return emit();
    } finally {
      activeNodes.delete(node);
    }
  };

  const emitExpression = (expression, ownerId, key, span) => visit(expression, key, () => {
    const tags = expressionTags.filter((tag) => hasOwn(expression, tag));
    if (tags.length !== 1) fail(key, 'unknown or ambiguous expression');
    const tag = tags[0];
    if (tag === 'opcode') {
      const shadow = expression.shadow ?? false;
      if (typeof shadow !== 'boolean') fail(key, 'shadow must be a boolean');
      const id = emitBlock(expression, ownerId, key, shadow ? 'shadow' : 'reporter', span);
      return [shadow ? 1 : 2, id];
    }
    checkKeys(expression, [tag], key);
    if (tag === 'literal') {
      const literal = expression.literal;
      if (typeof literal === 'number') checkNumber(literal, key);
      else if (typeof literal !== 'string') fail(key, 'literal must be a string or finite number');
      // SB3 deserialization preserves the primitive payload's JSON type; the
      // numeric tag alone does not coerce a string. Asset menus distinguish an
      // index (2) from a name ("2"), and variable assignments must retain it too.
      return [1, [typeof literal === 'number' ? 4 : 10, literal]];
    }
    const reference = expression[tag];
    if (!isDictionary(reference) || typeof reference.name !== 'string') {
      fail(key, `${tag} must contain a name and ID`);
    }
    checkKeys(reference, ['name', 'id'], key);
    checkId(reference.id, key);
    if (tag === 'broadcast') return [1, [11, reference.name, reference.id]];
    return [3, [tag === 'variable' ? 12 : 13, reference.name, reference.id], [10, '']];
  });

  const emitBlock = (node, ownerId, key, kind, inheritedSpan) => {
    const path = String(key);
    checkKeys(node, [...blockKeys, kind === 'stack' ? 'substacks' : 'shadow'], path);
    if (typeof node.opcode !== 'string' || !node.opcode.trim()) fail(path, 'opcode must be a nonempty string');
    if (hasOwn(node, 'shadow') && typeof node.shadow !== 'boolean') fail(path, 'shadow must be a boolean');
    const id = idFor(key);
    checkId(id, path);
    if (hasOwn(blocks, id) || staged.has(id)) fail(path, `block ID collision: ${JSON.stringify(id)}`);
    const span = hasOwn(node, 'span') && node.span !== undefined ? copyJSON(node.span, `${path}/span`) : inheritedSpan;
    const block = {
      opcode: node.opcode, next: null, parent: ownerId,
      inputs: {}, fields: copyFields(node, path), shadow: kind === 'shadow', topLevel: false
    };
    if (hasOwn(node, 'mutation') && node.mutation !== undefined) {
      if (!isDictionary(node.mutation)) fail(`${path}/mutation`, 'must be a dictionary');
      block.mutation = copyJSON(node.mutation, `${path}/mutation`);
    }
    staged.set(id, block);
    records.push({blockId: id, opcode: node.opcode, sourceSpan: span, kind});

    const inputs = readDictionary(node, 'inputs', path);
    const shadows = readDictionary(node, 'shadowInputs', path);
    const substacks = kind === 'stack' ? readDictionary(node, 'substacks', path) : {};
    const inputNames = new Set([...Object.keys(inputs), ...Object.keys(shadows), ...Object.keys(substacks)]);
    for (const name of inputNames) {
      if (!name) fail(path, 'input name must be nonempty');
      const inputKey = `${key}/${name}`;
      if (hasOwn(substacks, name)) {
        if (hasOwn(inputs, name) || hasOwn(shadows, name)) fail(inputKey, 'substack conflicts with expression or shadow input');
        const stack = emitStack(substacks[name], id, (index) => `${inputKey}/${index}`, span);
        if (stack.firstId !== null) put(block.inputs, name, [2, stack.firstId]);
        continue;
      }
      let input = hasOwn(inputs, name) ? inputs[name] : null;
      if (numericAssetInputs.get(node.opcode) === name && typeof input?.literal === 'number') {
        // 02 irgen.createConstantInput stringifies constants before protecting
        // asset names. A numeric reporter forces numeric context before the
        // menu receives the value, preserving index 2 even with an asset "2".
        input = {opcode: 'operator_add', inputs: {NUM1: input, NUM2: {literal: 0}}};
      }
      const actual = hasOwn(inputs, name) ? emitExpression(input, id, inputKey, span) : null;
      if (hasOwn(shadows, name)) {
        const shadowKey = `${inputKey}/shadow`;
        const shadowId = visit(shadows[name], shadowKey, () => emitBlock(shadows[name], id, shadowKey, 'shadow', span));
        put(block.inputs, name, actual ? [3, actual[1], shadowId] : [1, shadowId]);
      } else {
        put(block.inputs, name, actual);
      }
    }
    return id;
  };

  const emitStack = (stack, ownerId, keyFor, span) => {
    if (!Array.isArray(stack)) fail('operations', 'substack must be an array');
    let firstId = null;
    let lastId = null;
    for (let index = 0; index < stack.length; index++) {
      const key = keyFor(index);
      const id = visit(stack[index], String(key), () => emitBlock(stack[index], lastId ?? ownerId, key, 'stack', span));
      if (lastId !== null) staged.get(lastId).next = id;
      else firstId = id;
      lastId = id;
    }
    return {firstId, lastId};
  };

  const endpoints = emitStack(operations, parentId, (index) => index, undefined);
  const result = {...endpoints, blockCount: staged.size};
  if (!staged.size) return result;

  // Preflight ordinary SB3 objects so a sealed block map or parent cannot leave
  // a partially inserted graph. defineProperty also preserves special ID keys.
  const nextDescriptor = Object.getOwnPropertyDescriptor(parent, 'next');
  if (!Object.isExtensible(blocks)) fail('target.blocks', 'must be extensible');
  if (nextDescriptor ? !hasOwn(nextDescriptor, 'value') || !nextDescriptor.writable : !Object.isExtensible(parent)) {
    fail('parentId', 'parent.next must be writable');
  }
  const inserted = [];
  let linked = false;
  try {
    for (const [id, block] of staged) {
      put(blocks, id, block);
      inserted.push(id);
    }
    Object.defineProperty(parent, 'next', nextDescriptor ? {...nextDescriptor, value: endpoints.firstId} : {
      value: endpoints.firstId, enumerable: true, configurable: true, writable: true
    });
    linked = true;
    for (const record of records) recordBlock(record);
  } catch (error) {
    if (linked) {
      if (nextDescriptor) Object.defineProperty(parent, 'next', nextDescriptor);
      else delete parent.next;
    }
    for (const id of inserted) delete blocks[id];
    throw error;
  }
  return result;
}
