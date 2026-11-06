// A small builder for "what the author drew", used by the round-trip tests: blocks go in as trees, come out as
// an sb3 project that the REAL 02 compiler can compile. Nothing here knows how recovery works.
import {compileProject} from '../src/recompile-oracle.mjs';
import {recoverWithOracle} from '../src/relaxed-recovery.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

/** A literal input. */
export const lit = value => ({literal: value});
/** A variable reporter. */
export const variable = name => ({variable: name});
/** A list reporter is not needed; lists are named in fields. */
/** A reporter block (an expression); `inputs` map input names to literals, `variable(...)`, `rep(...)`. */
export const rep = (opcode, inputs = {}, fields = {}) => ({tree: 'reporter', opcode, inputs, fields});
/** A stack block; `substacks` map SUBSTACK / SUBSTACK2 to arrays of stack blocks. */
export const cmd = (opcode, {fields = {}, inputs = {}, substacks = {}, mutation} = {}) => ({tree: 'stack', opcode, fields, inputs, substacks, mutation});
/** `procedures_call` by proccode; `args` follow the order of the procedure's parameters (absent = leave the slot empty). */
export const call = (proccode, ...args) => ({tree: 'stack', opcode: 'procedures_call', fields: {}, inputs: {}, substacks: {}, call: {proccode, args}});
/** A custom block definition with `params` like `{name: 'n', type: 'n'|'s'|'b'}`. */
export const procedure = (proccode, params, body, {warp = false} = {}) => ({proccode, params, body, warp});
/** A parameter reporter for use inside a procedure body. */
export const param = (name, type = 'n') => ({tree: 'reporter', opcode: type === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number', inputs: {}, fields: {VALUE: name}, isParam: true});

const isTree = value => value && typeof value === 'object' && (value.tree === 'reporter' || value.tree === 'stack');

/**
 * @param {{variables?: string[], lists?: string[], scripts?: object[][], procedures?: object[]}} spec
 *   scripts: arrays whose first element is a hat `cmd('event_whenflagclicked')` and the rest the stack under it.
 */
export function authorProject({variables = ['out', 'idx', 'a', 'b'], lists = ['list'], scripts = [], procedures = []} = {}) {
  const blocks = {};
  let counter = 0;
  const nextId = () => `b${++counter}`;
  const varIds = Object.fromEntries(variables.map(name => [name, `var_${name}`]));
  const listIds = Object.fromEntries(lists.map(name => [name, `list_${name}`]));
  const proceduresByCode = new Map(procedures.map(entry => [entry.proccode, {...entry, ids: entry.params.map((_, i) => `arg${i}`)}]));

  /** Emit an input value; returns the SB3 input array and creates any block it needs. */
  const emitInput = (value, parentId) => {
    if (value === undefined) return null;
    if (value?.literal !== undefined) return [1, [typeof value.literal === 'number' ? 4 : 10, String(value.literal)]];
    if (value?.variable) return [3, [12, value.variable, varIds[value.variable]], [10, '']];
    if (isTree(value)) {
      const id = emitBlock(value, parentId, false);
      const boolean = /^operator_(and|or|not|equals|gt|lt|contains)$|^argument_reporter_boolean$/.test(value.opcode);
      return boolean ? [2, id] : [3, id, [10, '']];
    }
    throw new TypeError(`unsupported input ${JSON.stringify(value)}`);
  };
  const fieldValue = (name, value) => {
    if (name === 'VARIABLE') return [value, varIds[value]];
    if (name === 'LIST') return [value, listIds[value]];
    return [value, null];
  };
  const emitBlock = (tree, parentId, topLevel) => {
    const id = nextId();
    const block = {opcode: tree.opcode, next: null, parent: parentId, inputs: {}, fields: {}, shadow: false, topLevel};
    blocks[id] = block;
    for (const [name, value] of Object.entries(tree.fields || {})) block.fields[name] = fieldValue(name, value);
    for (const [name, value] of Object.entries(tree.inputs || {})) {
      const input = emitInput(value, id);
      if (input) block.inputs[name] = input;
    }
    if (tree.call) {
      const target = proceduresByCode.get(tree.call.proccode);
      block.mutation = {tagName: 'mutation', children: [], proccode: tree.call.proccode, argumentids: JSON.stringify(target.ids), warp: String(target.warp)};
      tree.call.args.forEach((arg, i) => { const input = emitInput(arg, id); if (input) block.inputs[target.ids[i]] = input; });
    }
    if (tree.mutation) block.mutation = tree.mutation;
    for (const [name, stack] of Object.entries(tree.substacks || {})) {
      const first = emitStack(stack, id);
      if (first) block.inputs[name] = [2, first];
    }
    return id;
  };
  const emitStack = (stack, parentId) => {
    let first = null, previous = null;
    for (const tree of stack) {
      const id = emitBlock(tree, previous ?? parentId, false);
      if (previous) blocks[previous].next = id; else first = id;
      previous = id;
    }
    return first;
  };

  scripts.forEach((script, index) => {
    const [hat, ...rest] = script;
    const id = emitBlock(hat, null, true);
    Object.assign(blocks[id], {x: 20, y: 20 + index * 300});
    const first = emitStack(rest, id);
    if (first) blocks[id].next = first;
  });
  procedures.forEach((entry, index) => {
    const defId = nextId(), protoId = nextId();
    const argumentIds = entry.params.map((_, i) => `arg${i}`);
    blocks[defId] = {opcode: 'procedures_definition', next: null, parent: null, inputs: {custom_block: [1, protoId]}, fields: {}, shadow: false, topLevel: true, x: 400, y: 20 + index * 300};
    const proto = {opcode: 'procedures_prototype', next: null, parent: defId, inputs: {}, fields: {}, shadow: true, topLevel: false,
      mutation: {tagName: 'mutation', children: [], proccode: entry.proccode, argumentids: JSON.stringify(argumentIds),
        argumentnames: JSON.stringify(entry.params.map(p => p.name)),
        argumentdefaults: JSON.stringify(entry.params.map(p => p.type === 'b' ? 'false' : '')), warp: String(entry.warp)}};
    blocks[protoId] = proto;
    entry.params.forEach((p, i) => {
      const reporterId = nextId();
      blocks[reporterId] = {opcode: p.type === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number', next: null, parent: protoId,
        inputs: {}, fields: {VALUE: [p.name, null]}, shadow: true, topLevel: false};
      proto.inputs[argumentIds[i]] = [1, reporterId];
    });
    const first = emitStack(entry.body, defId);
    if (first) blocks[defId].next = first;
  });

  const stage = {isStage: true, name: 'Stage', variables: Object.fromEntries(variables.map(name => [varIds[name], [name, 0]])),
    lists: Object.fromEntries(lists.map(name => [listIds[name], [name, ['a', 'b', 'c']]])), broadcasts: {}, blocks, comments: {},
    currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null};
  return {targets: [stage], monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}};
}

/** The blocks of an author project's only target, in a stable order, for assertions. */
export const opcodesOf = project => Object.values(project.targets[0].blocks).map(block => block.opcode);

/** What an artifact ships: the compiled bundle (deobfuscated like the pipeline does) and the project without blocks. */
export async function shipped(project, {deobfuscateFactories = false} = {}) {
  const {bundle} = await compileProject(project);
  if (deobfuscateFactories) {
    for (const entry of Object.values(bundle.compiledTargets)) {
      for (const item of [...Object.values(entry.scripts), ...Object.values(entry.procedures)]) item.factorySource = deobfuscate(item.factorySource).code;
    }
  }
  const stripped = structuredClone({targets: bundle.targets, monitors: [], extensions: [], meta: project.meta});
  for (const target of stripped.targets) { target.blocks = {}; target.comments = {}; }
  return {bundle, stripped};
}

/** Compile what the author drew, throw the blocks away, and recover them with the recompilation oracle. */
export async function roundTrip(project, options = {}) {
  const {bundle, stripped} = await shipped(project, options);
  const recovered = await recoverWithOracle(stripped, bundle, options.oracle);
  return {...recovered, bundle, stripped};
}
