// Procedure-specific checks on SB3 project JSON; never execute or rewrite source.
const MAX_MUTATION_LENGTH = 32 * 1024;
const isDictionary = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const keyPath = (path, key) => `${path}[${JSON.stringify(key)}]`;
const isId = value => typeof value === 'string' && value.length > 0;
const isDefault = value => typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));
const isReporter = block => block.opcode === 'argument_reporter_boolean' ||
  block.opcode === 'argument_reporter_string_number';

// An escaped percent is label text. Skipping escaped characters also handles
// even/odd runs of backslashes without treating every preceding slash alike.
const placeholderCount = code => {
  let count = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === '%' && 'snb'.includes(code[i + 1] || '\0')) {
      count++;
      i++;
    }
  }
  return count;
};

/** @returns {{errors: string[], warnings: string[]}} */
export function validateProcedures(project) {
  const errors = [];
  const warnings = [];
  if (!isDictionary(project) || !Array.isArray(project.targets)) {
    errors.push('project.targets must be an array');
    return {errors, warnings};
  }

  const bounded = (value, path) => {
    if (typeof value !== 'string') {
      errors.push(`${path} must be a string`);
      return false;
    }
    if (value.length > MAX_MUTATION_LENGTH) {
      errors.push(`${path} exceeds the 32 KiB mutation validation limit`);
      return false;
    }
    return true;
  };
  const jsonArray = (mutation, key, path, validItem, description) => {
    const fieldPath = `${path}.${key}`;
    if (!bounded(mutation[key], fieldPath)) return null;
    let values;
    try { values = JSON.parse(mutation[key]); }
    catch {
      errors.push(`${fieldPath} must contain valid JSON`);
      return null;
    }
    if (!Array.isArray(values)) {
      errors.push(`${fieldPath} must contain a JSON array`);
      return null;
    }
    let valid = true;
    for (let i = 0; i < values.length; i++) {
      if (!validItem(values[i])) {
        errors.push(`${fieldPath}[${i}] must be ${description}`);
        valid = false;
      }
    }
    return valid ? values : null;
  };
  const readMutation = (block, path) => {
    if (!isDictionary(block.mutation)) {
      errors.push(`${path}.mutation must be an object`);
      return null;
    }
    const mutation = block.mutation;
    const mutationPath = `${path}.mutation`;
    const code = bounded(mutation.proccode, `${mutationPath}.proccode`) ? mutation.proccode : null;
    if (code === '') errors.push(`${mutationPath}.proccode must be nonempty`);
    // Missing warp means non-warp in the VM. Calls need not repeat the prototype's flag.
    if (hasOwn(mutation, 'warp') && typeof mutation.warp !== 'boolean' &&
        !(typeof mutation.warp === 'string' && mutation.warp.length <= MAX_MUTATION_LENGTH &&
          /^[\t\n\r ]*(?:true|false)[\t\n\r ]*$/.test(mutation.warp))) {
      errors.push(`${mutationPath}.warp must be a boolean or a JSON boolean string`);
    }
    return {mutation, path: mutationPath, code: code || null};
  };
  const readInputs = (block, path) => {
    if (block.inputs === undefined) return {};
    if (isDictionary(block.inputs)) return block.inputs;
    errors.push(`${path}.inputs must be a dictionary object`);
    return {};
  };

  for (const [targetIndex, target] of project.targets.entries()) {
    const targetPath = `targets[${targetIndex}]`;
    if (!isDictionary(target)) {
      errors.push(`${targetPath} must be an object`);
      continue;
    }
    const blocks = target.blocks ?? {};
    if (!isDictionary(blocks)) {
      errors.push(`${targetPath}.blocks must be a dictionary object`);
      continue;
    }
    const entries = Object.entries(blocks).filter(([, block]) => isDictionary(block));
    const pathFor = id => keyPath(`${targetPath}.blocks`, id);
    const blockAt = id => isId(id) && hasOwn(blocks, id) && isDictionary(blocks[id]) ? blocks[id] : null;
    const prototypes = new Map();
    const definitions = new Map();
    const definitionScopes = new Map();
    const referencedPrototypes = new Set();

    // Collect prototypes before definitions/calls, independent of block order.
    for (const [id, block] of entries) {
      if (block.opcode !== 'procedures_prototype') continue;
      const data = readMutation(block, pathFor(id));
      if (!data) { prototypes.set(id, null); continue; }
      data.ids = jsonArray(data.mutation, 'argumentids', data.path, isId, 'a nonempty ID string');
      data.names = jsonArray(data.mutation, 'argumentnames', data.path, value => typeof value === 'string', 'a name string');
      data.defaults = jsonArray(data.mutation, 'argumentdefaults', data.path, isDefault, 'a string, finite number, or boolean');
      if (data.code !== null) {
        const count = placeholderCount(data.code);
        for (const [key, values] of [['argumentids', data.ids], ['argumentnames', data.names], ['argumentdefaults', data.defaults]]) {
          if (values && values.length !== count) {
            errors.push(`${data.path}.${key} length ${values.length} does not match proccode placeholder count ${count}`);
          }
        }
      }
      if (data.ids && new Set(data.ids).size !== data.ids.length) {
        errors.push(`${data.path}.argumentids must contain unique IDs`);
      }
      data.idSet = data.ids && new Set(data.ids);
      data.nameCounts = new Map();
      for (const name of data.names || []) data.nameCounts.set(name, (data.nameCounts.get(name) || 0) + 1);
      for (const key of Object.keys(readInputs(block, pathFor(id)))) {
        if (data.idSet && !data.idSet.has(key)) {
          errors.push(`${keyPath(`${pathFor(id)}.inputs`, key)} is an unknown prototype argument ID`);
        }
      }
      prototypes.set(id, data);
    }

    for (const [id, block] of entries) {
      if (block.opcode !== 'procedures_definition') continue;
      const path = pathFor(id);
      const inputs = readInputs(block, path);
      const customBlock = hasOwn(inputs, 'custom_block') ? inputs.custom_block : null;
      definitionScopes.set(id, null);
      if (!Array.isArray(customBlock) || customBlock.length !== 2 || customBlock[0] !== 1 || !isId(customBlock[1])) {
        errors.push(`${path}.inputs.custom_block must be [1, prototypeId]`);
        continue;
      }
      const prototypeId = customBlock[1];
      if (blockAt(prototypeId)?.opcode !== 'procedures_prototype') {
        errors.push(`${path}.inputs.custom_block must reference a target-local procedures_prototype block`);
        continue;
      }
      referencedPrototypes.add(prototypeId);
      const data = prototypes.get(prototypeId);
      definitionScopes.set(id, data);
      if (!data?.code) continue;
      if (definitions.has(data.code)) {
        // Both VM lookup and TurboWarp's cache deliberately prefer the first definition.
        warnings.push(`${path} duplicates procedure proccode ${JSON.stringify(data.code)}; the VM uses the first definition at ${definitions.get(data.code).path}`);
      } else definitions.set(data.code, {...data, path});
    }
    for (const id of prototypes.keys()) {
      if (!referencedPrototypes.has(id)) warnings.push(`${pathFor(id)} has no procedures_definition reference`);
    }

    for (const [id, block] of entries) {
      if (block.opcode !== 'procedures_call') continue;
      const path = pathFor(id);
      const data = readMutation(block, path);
      if (!data) continue;
      const ids = hasOwn(data.mutation, 'argumentids') ?
        jsonArray(data.mutation, 'argumentids', data.path, isId, 'a nonempty ID string') : null;
      const inputs = readInputs(block, path);
      if (!data.code) continue;
      const definition = definitions.get(data.code);
      if (!definition) {
        errors.push(`${data.path}.proccode ${JSON.stringify(data.code)} has no target-local procedure definition`);
        continue;
      }
      if (ids && definition.ids && (ids.length !== definition.ids.length || ids.some((value, i) => value !== definition.ids[i]))) {
        errors.push(`${data.path}.argumentids must match prototype argument IDs in order`);
      }
      for (const key of Object.keys(inputs)) {
        if (definition.idSet && !definition.idSet.has(key)) {
          errors.push(`${keyPath(`${path}.inputs`, key)} is an unknown procedure argument ID`);
        }
      }
      // Omitted inputs use prototype defaults. The VM does not guarantee input
      // types; mutation.return is optional, and reporter shape is not a type contract.
    }

    // Follow parent links, with memoization and a cycle guard. These are lexical
    // scopes, not a call graph: self-recursion and mutual recursion are legal.
    const scopes = new Map();
    const scopeFor = start => {
      const chain = new Set();
      let current = start;
      let scope = null;
      while (blockAt(current) && !chain.has(current)) {
        if (scopes.has(current)) { scope = scopes.get(current); break; }
        chain.add(current);
        if (definitionScopes.has(current)) {
          scope = {data: definitionScopes.get(current), declaration: false};
          break;
        }
        if (prototypes.has(current)) {
          scope = {data: prototypes.get(current), declaration: true};
          break;
        }
        current = blockAt(current).parent;
      }
      for (const id of chain) scopes.set(id, scope);
      return scope;
    };
    for (const [id, block] of entries) {
      if (!isReporter(block)) continue;
      const path = `${pathFor(id)}.fields.VALUE`;
      const field = isDictionary(block.fields) && hasOwn(block.fields, 'VALUE') ? block.fields.VALUE : null;
      if (!Array.isArray(field) || field.length < 1 || field.length > 2 || typeof field[0] !== 'string') {
        errors.push(`${path} must contain an argument name string in [name] or [name, ID]`);
        continue;
      }
      const name = field[0];
      const scope = scopeFor(id);
      if (scope && !scope.data?.names) continue; // Signature errors already explain the missing binding.
      const count = scope?.data.nameCounts.get(name) || 0;
      if (count > 0) {
        if (count > 1 && !scope.declaration) {
          warnings.push(`${path} references duplicate argument name ${JSON.stringify(name)}; the VM uses the last matching parameter`);
        }
        continue;
      }
      const lower = name.toLowerCase();
      const special = block.opcode === 'argument_reporter_boolean' ?
        lower === 'is turbowarp?' || lower === 'is compiled?' : lower === 'last key pressed';
      if (!special) {
        warnings.push(`${path} argument ${JSON.stringify(name)} is unbound${scope ? '' : ' outside a procedure'}; the VM returns 0`);
      }
    }
  }
  return {errors, warnings};
}
