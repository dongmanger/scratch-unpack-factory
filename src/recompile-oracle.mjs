import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import traverseModule from '@babel/traverse';
import {installedVirtualMachine, withVmLogsMuted} from './default-vm.mjs';

const generate = generatorModule.default || generatorModule;
const traverse = traverseModule.default || traverseModule;
const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Recompilation oracle.
 *
 * A recovered block graph is a *hypothesis* about the source project. Instead of proving every
 * decoder assumption statically (which forces the decoder to refuse anything whose JS semantics
 * could differ from Scratch's), we hand the hypothesis to the real 02 compiler and compare the
 * JavaScript it generates with the JavaScript that was actually shipped in the artifact. If the
 * generated factory source is alpha-equivalent to the shipped one, the recovered blocks compile to
 * exactly the program that was packaged, which is a stronger statement than any local template proof.
 *
 * What a match does and does not establish:
 *  - It does: the recovered script is behaviourally identical to the shipped one, because the VM
 *    executes the factory source and the two sources are the same program up to identifier names.
 *  - It does not: the recovered graph equals the author's original graph. The compiler folds
 *    constants, removes dead branches and unrolls loops, so several source graphs compile to one
 *    factory. Reports keep that distinction (originalStructure stays at its existing score).
 */

/**
 * Value of a sub-expression built only from literals, or `undefined` if it is anything else.
 * No identifiers, calls on unknown receivers or side effects are involved, so replacing the
 * expression with its value cannot change behaviour. Supported: numeric `+ - * / % |` and unary
 * `- +`, plus `"literal".toLowerCase()/toUpperCase()` and string concatenation.
 */
function literalValueOf(node) {
  if (node.type === 'NumericLiteral' || node.type === 'StringLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
    const value = literalValueOf(node.argument);
    return typeof value === 'number' ? (node.operator === '-' ? -value : +value) : undefined;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const value = literalValueOf(node.argument);
    return value === undefined ? undefined : !value;
  }
  if (node.type === 'BinaryExpression') {
    const left = literalValueOf(node.left), right = literalValueOf(node.right);
    if (typeof left === 'number' && typeof right === 'number' && ['+', '-', '*', '/', '%', '|'].includes(node.operator)) {
      const result = {'+': left + right, '-': left - right, '*': left * right, '/': left / right, '%': left % right, '|': left | right}[node.operator];
      return Number.isFinite(result) ? result : undefined;
    }
    if (typeof left === 'string' && typeof right === 'string' && node.operator === '+') return left + right;
    // Comparisons between two literals of the same primitive type have one fixed answer.
    if (left !== undefined && right !== undefined && typeof left === typeof right &&
        ['===', '!==', '<', '>', '<=', '>='].includes(node.operator)) {
      return {'===': left === right, '!==': left !== right, '<': left < right, '>': left > right, '<=': left <= right, '>=': left >= right}[node.operator];
    }
    return undefined;
  }
  // "literal".length is the string's UTF-16 length: a fixed number.
  if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'length') {
    const receiver = literalValueOf(node.object);
    return typeof receiver === 'string' ? receiver.length : undefined;
  }
  if (node.type === 'CallExpression' && node.arguments.length === 0 && node.callee.type === 'MemberExpression' &&
      !node.callee.computed && ['toLowerCase', 'toUpperCase'].includes(node.callee.property.name)) {
    const receiver = literalValueOf(node.callee.object);
    return typeof receiver === 'string' ? receiver[node.callee.property.name]() : undefined;
  }
  return undefined;
}

function literalNodeFor(value) {
  if (typeof value === 'string') return {type: 'StringLiteral', value};
  if (typeof value === 'boolean') return {type: 'BooleanLiteral', value};
  if (Object.is(value, -0)) return {type: 'UnaryExpression', operator: '-', prefix: true, argument: {type: 'NumericLiteral', value: 0}};
  if (value < 0) return {type: 'UnaryExpression', operator: '-', prefix: true, argument: {type: 'NumericLiteral', value: -value}};
  return {type: 'NumericLiteral', value};
}

/**
 * Short-circuit identities for a logical expression whose LEFT operand is a known literal:
 *   true  && x -> x      false && x -> false
 *   false || x -> x      true  || x -> true
 * The right operand is evaluated in exactly the cases where it survives, so dropping it when it
 * would never run, or the left literal when the right always runs, cannot change behaviour.
 */
function simplifyLogical(node) {
  if (node.type !== 'LogicalExpression' || !['&&', '||'].includes(node.operator)) return node;
  const left = literalValueOf(node.left);
  if (left === undefined) return node;
  const truthy = !!left;
  if (node.operator === '&&') return truthy ? node.right : node.left;
  return truthy ? node.left : node.right;
}

/**
 * Resolve statements whose branch is decided by a literal condition:
 *   if (true)  A else B -> A      if (false) A else B -> B      if (false) A -> (nothing)
 *   `false;` / `true;` as a bare statement -> (nothing)
 * The deobfuscator's static evaluation already removes the dead arm (or leaves a bare `false;`
 * where javascript-obfuscator had written `false && (...)`), while the compiler keeps `if (false)`.
 * Both are the same program; applying the same resolution to both sides compares them fairly.
 */
function resolveConstantBranches(body) {
  const out = [];
  for (const statement of body) {
    // Statements after an unconditional `return` in the same block can never run. The compiler emits
    // a trailing `return;` for some constructs where the obfuscated form carries it twice.
    // Function declarations are hoisted and `var` declarations still bind, so only drop statements
    // that are pure control flow or expressions.
    if (out.length && out.at(-1).type === 'ReturnStatement' &&
        !['FunctionDeclaration', 'VariableDeclaration', 'ClassDeclaration'].includes(statement.type)) continue;
    if (statement.type === 'ExpressionStatement' && ['BooleanLiteral', 'NumericLiteral', 'StringLiteral'].includes(statement.expression.type)) continue;
    if (statement.type === 'IfStatement') {
      const test = literalValueOf(statement.test);
      if (test !== undefined) {
        const taken = test ? statement.consequent : statement.alternate;
        const lexical = node => node?.type === 'BlockStatement' && node.body.some(s =>
          s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration' || s.type === 'VariableDeclaration' && s.kind !== 'var');
        // Unwrapping a branch moves its statements into the enclosing scope. If the branch declares a
        // lexical binding, that would change what the name refers to (and let two different bindings look
        // alike after renaming), so such a branch is left as written.
        if (!lexical(statement.consequent) && !lexical(statement.alternate)) {
          if (taken) out.push(...(taken.type === 'BlockStatement' ? taken.body : [taken]));
          continue;
        }
      }
    }
    out.push(statement);
  }
  return out;
}

/**
 * Fold every maximal literal-only sub-expression to its value, bottom up. Both sides of a
 * comparison go through this, so `73 - 1` and `72`, or `"#".toLowerCase()` and `"#"`, which are the
 * same program, get the same canonical spelling regardless of which side a folder already reduced.
 */
function foldLiterals(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = foldLiterals(node[i]); return node; }
  for (const [key, child] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range'].includes(key)) continue;
    if (child && typeof child === 'object') node[key] = foldLiterals(child);
  }
  if ((node.type === 'BlockStatement' || node.type === 'Program') && Array.isArray(node.body)) {
    node.body = resolveConstantBranches(node.body);
    // Flatten bare blocks left behind by an unwrapped branch.
    node.body = node.body.flatMap(statement => statement.type === 'BlockStatement' &&
      !statement.body.some(s => s.type === 'VariableDeclaration' && s.kind !== 'var' || s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration')
      ? statement.body : [statement]);
  }
  if (node.type === 'LogicalExpression') {
    const simplified = simplifyLogical(node);
    // Children were already folded above, so a simplified result is already canonical.
    if (simplified !== node) return simplified;
  }
  if (['BinaryExpression', 'UnaryExpression', 'CallExpression', 'MemberExpression'].includes(node.type)) {
    const value = literalValueOf(node);
    // A bare literal gains nothing from replacement; skip it to keep node identity stable.
    if (value !== undefined && !(node.type === 'UnaryExpression' && node.argument.type === 'NumericLiteral' && node.operator === '-' && value !== 0)) {
      return literalNodeFor(value);
    }
  }
  return node;
}

/**
 * Canonical form of a factory source. Two sources have the same canonical form exactly when they are the
 * same program up to: comments, quote and numeric spelling, braces around single statements, `a.b` vs
 * `a["b"]`, literal-only arithmetic, branches decided by literals, unreachable statements after `return`,
 * compat-layer block IDs, and the names of identifiers that are *bound inside the factory*.
 *
 * Free identifiers (`startHats`, `listGet`, `Math`...) keep their names. They are the factory's contract
 * with the runtime; alpha-renaming them would make `listDelete(...); listInsert(...)` equal
 * `listInsert(...); listDelete(...)` merely because each is "the first call, then the second". An
 * earlier version of this function did that, and the swapped-statement unit tests guard against it.
 */
export function canonicalizeFactory(source) {
  const ast = parse(source, {sourceType: 'script', allowReturnOutsideFunction: true});
  foldLiterals(ast.program);
  const isLiteral = (node, type, value) => node?.type === type && (value === undefined || node.value === value);
  const braced = child => child && child.type !== 'BlockStatement' ? {type: 'BlockStatement', body: [child], directives: []} : child;
  const spelling = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) spelling(child); return; }
    // `extra.raw` pins the original quote style / numeric spelling (`'a'` vs `"a"`, `1e3` vs `1000`).
    if (node.extra) delete node.extra;
    // `if (c) s;` and `if (c) { s; }` are the same statement; always use the braced form.
    if (node.type === 'IfStatement') {
      node.consequent = braced(node.consequent);
      if (node.alternate && node.alternate.type !== 'IfStatement') node.alternate = braced(node.alternate);
    } else if (['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      node.body = braced(node.body);
    }
    // Compat-layer calls embed the originating block's ID as a string argument. Block IDs are
    // regenerated by the packager, so that one argument can never agree between a shipped bundle and a
    // recompilation. Match by shape (not by name; obfuscation may alias the callee):
    // (inputsObject, opcodeFn, isWarp:boolean, setFlags:boolean, blockId:string, frame:null).
    if (node.type === 'CallExpression' && node.arguments.length === 6 &&
        node.arguments[0].type === 'ObjectExpression' && node.arguments[1].type === 'Identifier' &&
        node.arguments[2].type === 'BooleanLiteral' && node.arguments[3].type === 'BooleanLiteral' &&
        isLiteral(node.arguments[4], 'StringLiteral') && node.arguments[5].type === 'NullLiteral') {
      node.arguments[4].value = '#';
    }
    // `a["name"]` and `a.name` read the same property.
    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'StringLiteral' && /^[A-Za-z_$][\w$]*$/.test(node.property.value)) {
      node.property = {type: 'Identifier', name: node.property.value};
      node.computed = false;
    }
    // `{'a': 1}` and `{a: 1}` are the same object literal.
    if (node.type === 'ObjectProperty' && !node.computed && node.key.type === 'StringLiteral' && /^[A-Za-z_$][\w$]*$/.test(node.key.value)) {
      node.key = {type: 'Identifier', name: node.key.value};
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range'].includes(key)) continue;
      spelling(value);
    }
  };
  spelling(ast.program);

  // Rename bound identifiers to x0, x1, ... in order of declaration. Babel's scope.rename updates every
  // reference and avoids capture, and leaves free identifiers untouched. Two passes (placeholder names
  // first) keep a rename from colliding with a name that is about to be reassigned.
  //
  // Two things here are load-bearing for correctness, because a `match` decides whether a script is kept
  // and lifts its score:
  //  - The second pass renames only the nodes the first pass produced, tracked by identity. An earlier
  //    version rewrote every identifier matching /^__c\d+$/ regardless of binding, which renamed free
  //    variables too: `function f(){return q + __c0;}` and `function f(){return q + x0;}` compared equal.
  //  - The final names skip anything a free identifier already uses. Otherwise a renamed binding can land
  //    on a free name: `function f(a){return a + x0;}` (free x0) and `function f(a){return a + f;}`
  //    (self-reference) both became `function x0(x1){return x1+x0;}`.
  const reserved = new Set();
  traverse(ast, {Identifier(path) {
    if (path.isReferencedIdentifier() && !path.scope.getBinding(path.node.name)) reserved.add(path.node.name);
  }});
  const wanted = [];
  traverse(ast, {
    Scopable(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.scope === path.scope && !wanted.some(entry => entry.binding === binding)) wanted.push({binding, name});
      }
    }
  });
  wanted.sort((a, b) => (a.binding.identifier.start ?? 0) - (b.binding.identifier.start ?? 0));
  const renamedNodes = new Map();
  wanted.forEach(({binding, name}, i) => {
    const nodes = [binding.identifier, ...(binding.referencePaths ?? []).map(path => path.node),
      ...(binding.constantViolations ?? []).map(path => path.node)];
    binding.scope.rename(name, `__c${i}`);
    for (const node of nodes) renamedNodes.set(node, `__c${i}`);
  });
  const finals = new Map();
  const finalName = placeholder => {
    if (!finals.has(placeholder)) {
      let n = finals.size;
      while (reserved.has(`x${n}`) || [...finals.values()].includes(`x${n}`)) n++;
      finals.set(placeholder, `x${n}`);
    }
    return finals.get(placeholder);
  };
  traverse(ast, {Identifier(path) {
    if (renamedNodes.get(path.node) !== path.node.name) return;
    path.node.name = finalName(path.node.name);
  }});
  return generate(ast, {comments: false, compact: true, jsescOption: {minimal: true}}).code;
}
export const comparableFactory = source => canonicalizeFactory(source);
export const factoryDigest = source => sha256(comparableFactory(source));

/**
 * Make sure every costume/sound the project names exists in the archive. Returns the names that were added,
 * so the caller can take them out again. Only files that are absent are added; real assets are never touched.
 */
function addAssetPlaceholders(projectJSON, archive) {
  const added = [];
  for (const target of projectJSON.targets || []) {
    for (const asset of [...(target.costumes || []), ...(target.sounds || [])]) {
      const name = asset?.md5ext || (asset?.assetId && asset?.dataFormat ? `${asset.assetId}.${asset.dataFormat}` : null);
      if (typeof name === 'string' && name && !archive.file(name)) {
        archive.file(name, new Uint8Array(0));
        added.push(name);
      }
    }
  }
  return added;
}

/** Compile a project with the pinned real 02 compiler and return its compiled bundle. */
export function compileProject(projectJSON, archive = null, options = {}) {
  // Creating the VM and storage logs too ("[Signature Injector]", "Central dispatch replacing ..."), so the
  // whole call is inside the mute, not just the compile. The switch is process-wide while it is held, which
  // is fine here because the oracle runs one compilation at a time.
  return withVmLogsMuted(() => compileProjectUnmuted(projectJSON, archive, options));
}

async function compileProjectUnmuted(projectJSON, archive, {onCompileError} = {}) {
  const VirtualMachine = installedVirtualMachine();
  const vm = new VirtualMachine();
  const storage = new VirtualMachine.Storage();
  // Recompilation looks at blocks only. Asset bytes are supplied through the project archive; anything
  // else (a missing file, a remote default) is simply "not found", which the VM already degrades on
  // (`handleCostumeLoadError`). Throwing here instead would abort the whole compile on a project whose
  // media is incomplete, so resolve to null and never touch the network.
  const notFound = () => Promise.resolve(null);
  const denied = () => { throw new Error('External extension loading is disabled for recompilation'); };
  if (storage.scratchFetch) storage.scratchFetch.scratchFetch = notFound;
  vm.attachStorage(storage);
  storage.load = notFound;
  vm.extensionManager.loadExtensionURL = denied;
  vm.setCompilerOptions({enabled: true, warpTimer: false});
  const errors = [];
  vm.runtime.on('COMPILE_ERROR', (target, error) => {
    errors.push({target: target?.getName?.() ?? null, message: String(error?.message || error)});
    onCompileError?.(target, error);
  });
  try {
    // sb3.deserialize rewrites the object it is given into the VM's in-memory block format (inputs
    // become {name, block, shadow}, fields become {name, value, id}). Hand it a private copy so the
    // caller's project.json structure is never altered; otherwise a project that was only meant to be
    // checked would come back unserializable.
    // Why every costume and sound must resolve to *some* archive entry:
    //  - With an asset present and no renderer (always the case in Node) the VM logs "No rendering module"
    //    and returns the costume untouched. Quiet and safe; no decoder is involved.
    //  - With the asset missing, the VM falls back to loading its built-in default costume, which does need
    //    a browser image decoder (`runtime.v2BitmapAdapter`). That path ends in
    //    `Promise.reject('No V2 Bitmap adapter present.')` with nothing attached to catch it, so it escapes
    //    as an unhandledRejection and terminates the CLI. (Passing no archive at all hits the same path;
    //    reproduced with a one-costume project.)
    // Blocks compile identically whatever the asset bytes are, so a missing asset gets an empty
    // placeholder for the duration of the compile and the placeholder is removed afterwards.
    // With no archive at all, an empty one is created so the same guarantee holds.
    const workingArchive = archive ?? new JSZip();
    const placeholders = addAssetPlaceholders(projectJSON, workingArchive);
    try {
      const bundle = await vm.compileProjectFromJSON(JSON.parse(JSON.stringify(projectJSON)), workingArchive);
      return {bundle, errors};
    } finally {
      for (const name of placeholders) workingArchive.remove(name);
    }
  } finally {
    vm.quit();
  }
}

/**
 * Compare the shipped compiled bundle with a recompiled one, script by script.
 * Scripts are keyed by (target key, top block ID). Procedures are keyed by variant name.
 */
export function compareBundles(shipped, recompiled, {shippedSourceOf = entry => entry.factorySource} = {}) {
  const result = {scripts: new Map(), procedures: new Map()};
  for (const [targetKey, entry] of Object.entries(shipped.compiledTargets || {})) {
    const mine = recompiled.compiledTargets?.[targetKey];
    for (const kind of ['scripts', 'procedures']) {
      for (const [id, script] of Object.entries(entry[kind] || {})) {
        const candidate = mine?.[kind]?.[id];
        const outcome = {targetKey, id, status: 'missing'};
        if (candidate) {
          try {
            const left = comparableFactory(shippedSourceOf(script));
            const right = comparableFactory(candidate.factorySource);
            outcome.status = left === right ? 'match' : 'mismatch';
            outcome.shippedDigest = sha256(left);
            outcome.recompiledDigest = sha256(right);
          } catch (error) {
            outcome.status = 'incomparable';
            outcome.error = error.message;
          }
        }
        result[kind].set(`${targetKey}\u0000${id}`, outcome);
      }
    }
  }
  return result;
}