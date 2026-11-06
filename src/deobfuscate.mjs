import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
import {StaticEvaluator, literalNode} from './static-evaluator.mjs';
import {analyzeBuiltinEffects} from './builtin-effects.mjs';

const traverse = traverseModule.default || traverseModule;
const generate = generatorModule.default || generatorModule;
const parser = source => parse(source, {sourceType: 'unambiguous', errorRecovery: false, allowReturnOutsideFunction: true});
const walk = (node, fn) => {
  if (!node) return;
  fn(node);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, fn));
    else if (value) walk(value, fn);
  }
};
/**
 * Print an AST without losing how `||` / `&&` chains are nested.
 *
 * Babel treats `||` and `&&` as associative and prints `a || (b || c)` as `a || b || c`. The two behave the
 * same, but the text reads back as `(a || b) || c`. The nesting is information: the compiler writes the
 * author's nesting (in the sample project `or` blocks are nested to the right 21 times against 6 to the left)
 * and recovery turns it back into blocks, so a printer that flattens it makes every right-nested condition
 * come back mirrored. The right operand is parenthesized for the duration of the print only; the tree that
 * the passes work on is restored afterwards, so no pass ever sees a ParenthesizedExpression.
 */
const printer = ast => {
  const nested = [];
  walk(ast, node => {
    if (node.type === 'LogicalExpression' && node.right?.type === 'LogicalExpression' && node.right.operator === node.operator) nested.push([node, node.right]);
  });
  for (const [parent, child] of nested) parent.right = t.parenthesizedExpression(child);
  try {
    return generate(ast, {comments: false, compact: false, jsescOption: {minimal: false}}).code;
  } finally {
    for (const [parent, child] of nested) parent.right = child;
  }
};
const hasIdentifier = (node, name) => {
  let found = false;
  walk(node, child => {if (t.isIdentifier(child, {name})) found = true;});
  return found;
};
const propertyName = node => t.isMemberExpression(node) ? (node.computed && t.isStringLiteral(node.property) ? node.property.value : !node.computed ? node.property.name : null) : null;
const primitiveArguments = value => value === undefined || value === null || ['number', 'string', 'boolean'].includes(typeof value);

const foldedAlphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
function obfuscatorBase64(text) {
  let binary = '', percent = '', bc = 0, bs = 0;
  for (const character of text) {
    const code = foldedAlphabet.indexOf(character);
    if (code < 0) continue;
    bs = bc % 4 ? bs * 64 + code : code;
    if (bc++ % 4) binary += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  for (let i = 0; i < binary.length; i++) percent += '%' + ('00' + binary.charCodeAt(i).toString(16)).slice(-2);
  return decodeURIComponent(percent);
}
function rc4(text, key) {
  if (typeof key !== 'string' || !key.length) throw new Error('RC4 key missing');
  const s = Array.from({length: 256}, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {j = (j + s[i] + key.charCodeAt(i % key.length)) % 256; [s[i], s[j]] = [s[j], s[i]];}
  let i = 0; j = 0; let output = '';
  for (let n = 0; n < text.length; n++) {
    i = (i + 1) % 256; j = (j + s[i]) % 256; [s[i], s[j]] = [s[j], s[i]];
    output += String.fromCharCode(text.charCodeAt(n) ^ s[(s[i] + s[j]) % 256]);
  }
  return output;
}

function bindingFor(path) {
  if (path.isFunctionDeclaration()) return path.parentPath.scope.getBinding(path.node.id.name);
  if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) return path.scope.getBinding(path.node.id.name);
  return null;
}
// The bootstrap executes before business code. Prove that boundary structurally,
// rather than relaxing the whole-program protections used for ordinary folding.
function generatedRotor(path, decoders) {
  const fn = path.get('callee');
  if (!fn.isFunctionExpression() || fn.node.async || fn.node.generator || fn.node.params.length !== 2 ||
      !fn.node.params.every(p => t.isIdentifier(p)) || fn.node.params[0].name === fn.node.params[1].name) return null;
  const body = fn.get('body').get('body');
  const loop = body.at(-1);
  const declarations = body.slice(0, -1).filter(p => p.isVariableDeclaration());
  const wrappers = body.slice(0, -1).filter(p => p.isFunctionDeclaration());
  if (declarations.length !== 1 || declarations.length + wrappers.length !== body.length - 1 ||
      declarations[0].node.declarations.length !== 1 || !loop?.isWhileStatement()) return null;
  const array = declarations[0].get('declarations')[0];
  const init = array.get('init');
  if (!array.get('id').isIdentifier() || !init.isCallExpression() || init.node.arguments.length ||
      !init.get('callee').isIdentifier({name: fn.node.params[0].name}) ||
      init.scope.getBinding(init.node.callee.name)?.identifier !== fn.node.params[0]) return null;
  const arithmetic = (p, names = new Set(), calls = false) => {
    if (p.isNumericLiteral() || p.isStringLiteral()) return true;
    if (p.isIdentifier()) return names.has(p.node.name);
    if (p.isUnaryExpression() && ['+', '-'].includes(p.node.operator)) return arithmetic(p.get('argument'), names, calls);
    if (p.isBinaryExpression() && ['+', '-', '*', '/', '%'].includes(p.node.operator)) {
      return arithmetic(p.get('left'), names, calls) && arithmetic(p.get('right'), names, calls);
    }
    if (!calls || !p.isCallExpression() || !p.get('callee').isIdentifier() || p.node.arguments.some(t.isSpreadElement)) return false;
    const binding = p.scope.getBinding(p.node.callee.name);
    if (!binding && p.node.callee.name === 'parseInt') {
      return p.node.arguments.length === 1 && arithmetic(p.get('arguments')[0], names, true);
    }
    if (!decoders.some(d => d.binding.identifier === binding?.identifier) &&
        !wrappers.some(w => bindingFor(w)?.identifier === binding?.identifier)) return false;
    return p.get('arguments').every(arg => arithmetic(arg, names));
  };
  if (!arithmetic(path.get('arguments')[1]) || !bindingFor(array)?.constant ||
      !fn.node.params.every(param => fn.scope.getBinding(param.name)?.constant)) return null;
  for (const wrapper of wrappers) {
    const statements = wrapper.get('body').get('body');
    if (wrapper.node.async || wrapper.node.generator || !wrapper.node.params.every(p => t.isIdentifier(p)) ||
        statements.length !== 1 || !statements[0].isReturnStatement()) return null;
    const value = statements[0].get('argument');
    if (!value.isCallExpression() || !value.get('callee').isIdentifier() ||
        !decoders.some(d => d.binding.identifier === value.scope.getBinding(value.node.callee.name)?.identifier) ||
        !value.get('arguments').every(p => arithmetic(p, new Set(wrapper.node.params.map(n => n.name))))) return null;
  }
  const test = loop.node.test;
  if (!(t.isBooleanLiteral(test, {value: true}) || (t.isUnaryExpression(test, {operator: '!'}) &&
      t.isUnaryExpression(test.argument, {operator: '!'}) && t.isArrayExpression(test.argument.argument) &&
      !test.argument.argument.elements.length))) return null;
  if (!loop.get('body').isBlockStatement() || loop.node.body.body.length !== 1) return null;
  const attempt = loop.get('body').get('body')[0];
  if (!attempt.isTryStatement() || attempt.node.finalizer || !attempt.node.handler ||
      attempt.node.block.body.length !== 2 || attempt.node.handler.body.body.length !== 1) return null;
  const [checksumStatement, comparison] = attempt.get('block').get('body');
  if (!checksumStatement.isVariableDeclaration() || checksumStatement.node.declarations.length !== 1 || !comparison.isIfStatement()) return null;
  const checksumBinding = checksumStatement.get('declarations')[0];
  const checksum = checksumBinding.get('init');
  const compare = comparison.get('test');
  if (!checksumBinding.get('id').isIdentifier() || !arithmetic(checksum, new Set(), true) ||
      !compare.isBinaryExpression({operator: '==='}) || !compare.get('left').isIdentifier({name: checksumBinding.node.id.name}) ||
      compare.scope.getBinding(compare.node.left.name)?.identifier !== checksumBinding.node.id ||
      !compare.get('right').isIdentifier({name: fn.node.params[1].name}) ||
      compare.scope.getBinding(compare.node.right.name)?.identifier !== fn.node.params[1] ||
      !comparison.get('consequent').isBreakStatement() || comparison.node.consequent.label) return null;
  const rotation = p => {
    if (!p.isExpressionStatement()) return false;
    const push = p.get('expression');
    if (!push.isCallExpression() || push.node.arguments.length !== 1 || propertyName(push.node.callee) !== 'push') return false;
    const shift = push.get('arguments')[0];
    if (!shift.isCallExpression() || shift.node.arguments.length || propertyName(shift.node.callee) !== 'shift') return false;
    return [push.get('callee').get('object'), shift.get('callee').get('object')].every(object =>
      object.isIdentifier({name: array.node.id.name}) && object.scope.getBinding(object.node.name)?.identifier === array.node.id);
  };
  if (!rotation(comparison.get('alternate')) || !rotation(attempt.get('handler').get('body').get('body')[0])) return null;
  return {path, checksum};
}

function bootstrapPrefix(ast, rotor, descriptors, provedRotors) {
  let expression = rotor.path;
  const earlier = [];
  while (expression.parentPath?.isSequenceExpression()) {
    earlier.unshift(...expression.parentPath.get('expressions').slice(0, expression.key));
    expression = expression.parentPath;
  }
  const statement = expression.parentPath;
  if (!statement?.isExpressionStatement() || !statement.parentPath.isProgram()) return null;
  const generatedDeclarations = new Set([...descriptors.providers, ...descriptors.decoders].map(d => d.path.node));
  const literalOnly = node => {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
    if (t.isUnaryExpression(node) && ['!', '+', '-', '~', 'void'].includes(node.operator)) return literalOnly(node.argument);
    if (t.isBinaryExpression(node)) return literalOnly(node.left) && literalOnly(node.right);
    if (t.isArrayExpression(node)) return node.elements.every(n => !n || literalOnly(n));
    if (t.isObjectExpression(node)) return node.properties.every(p => t.isObjectProperty(p) && !p.computed && !p.method &&
      (p.key.name ?? p.key.value) !== '__proto__' && literalOnly(p.value));
    return false;
  };
  const safeExpression = node => t.isSequenceExpression(node) ? node.expressions.every(safeExpression) : provedRotors.has(node);
  const prefix = [];
  for (const prior of statement.parentPath.get('body').slice(0, statement.key)) {
    if (prior.isFunctionDeclaration()) {
      if (!generatedDeclarations.has(prior.node)) return null;
    } else if (prior.isVariableDeclaration()) {
      if (!prior.node.declarations.every(d => t.isIdentifier(d.id) && d.init && literalOnly(d.init))) return null;
    } else if (!prior.isExpressionStatement() || !safeExpression(prior.node.expression)) return null;
    prefix.push(prior.node);
  }
  if (!earlier.every(p => safeExpression(p.node))) return null;
  prefix.push(...earlier.map(p => t.expressionStatement(p.node)), t.expressionStatement(rotor.path.node));
  // Hoisted declarations may occur after the rotor. Include every reachable
  // binding, including shadows; a later lexical initializer is not a prefix fact.
  const included = new Set(prefix);
  const pending = [...prefix, rotor.path.node];
  while (pending.length) {
    const node = pending.pop();
    let invalid = false;
    const path = node === rotor.path.node ? rotor.path : statement.parentPath.get('body').find(p => p.node === node);
    const inspect = p => {
      if (!p.isReferencedIdentifier()) return;
      const binding = p.scope.getBinding(p.node.name);
      if (!binding || !binding.scope.path.isProgram()) return;
      if (!binding.path.isFunctionDeclaration() || !generatedDeclarations.has(binding.path.node)) {invalid = true; return;}
      if (included.has(binding.path.node)) return;
      included.add(binding.path.node); prefix.push(binding.path.node); pending.push(binding.path.node);
    };
    if (path) {inspect(path); path.traverse({ReferencedIdentifier: inspect});}
    else {
      // Earlier sequence operands are already proved rotors and their reachable
      // declarations were included when resolving them; inspect their real paths.
      for (const p of earlier) if (node.expression === p.node) p.traverse({ReferencedIdentifier: inspect});
    }
    if (invalid) return null;
  }
  // Generate and parse: Babel scope caches for the full AST cannot contaminate
  // this separate traversal with later assignments or initializers.
  return parser(printer(t.file(t.program(prefix.map(node => t.cloneNode(node, true))))));
}

function discoverDecoders(ast, evaluator, report) {
  const providers = [];
  const decoders = [];
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.params.length || !path.node.id) return;
      const arrays = [];
      path.traverse({ArrayExpression(p) {
        if (p.getFunctionParent() === path && p.node.elements.length && p.node.elements.every(x => t.isStringLiteral(x))) arrays.push(p);
      }});
      if (arrays.length !== 1) return;
      const statements = path.node.body.body;
      const arrayPath = arrays[0];
      const declaration = arrayPath.parentPath;
      if (!declaration.isVariableDeclarator() || !t.isIdentifier(declaration.node.id) ||
          !t.isVariableDeclaration(statements[0]) || statements[0].declarations.length !== 1 ||
          statements[0].declarations[0] !== declaration.node || statements.length !== 3) return;
      const assignment = statements[1];
      const returned = statements[2];
      if (!t.isExpressionStatement(assignment) || !t.isAssignmentExpression(assignment.expression, {operator: '='}) ||
          !t.isIdentifier(assignment.expression.left, {name: path.node.id.name}) ||
          !t.isFunctionExpression(assignment.expression.right) || assignment.expression.right.params.length ||
          assignment.expression.right.body.body.length !== 1 || !t.isReturnStatement(assignment.expression.right.body.body[0]) ||
          !t.isIdentifier(assignment.expression.right.body.body[0].argument, {name: declaration.node.id.name}) ||
          !t.isReturnStatement(returned) || !t.isCallExpression(returned.argument) || returned.argument.arguments.length ||
          !t.isIdentifier(returned.argument.callee, {name: path.node.id.name})) return;
      const binding = bindingFor(path);
      if (!binding) return;
      const array = arrays[0].node.elements.map(x => x.value);
      const object = {kind: 'provider', array, path, binding, rotated: false};
      providers.push(object);
      evaluator.specialBindings.set(binding.identifier, object);
    }
  });
  traverse(ast, {
    FunctionDeclaration(path) {
      if (!path.node.id || !path.node.params.length) return;
      const binding = bindingFor(path);
      if (!binding) return;
      let provider;
      path.traverse({CallExpression(p) {
        if (!t.isIdentifier(p.node.callee) || p.node.arguments.length) return;
        const b = p.scope.getBinding(p.node.callee.name);
        provider ||= providers.find(x => x.binding.identifier === b?.identifier);
      }});
      if (!provider) return;
      let fnPath = path;
      path.traverse({AssignmentExpression(p) {
        if (t.isIdentifier(p.node.left, {name: path.node.id.name}) && t.isFunctionExpression(p.node.right)) fnPath = p.get('right');
      }});
      const param = fnPath.node.params[0];
      if (!t.isIdentifier(param)) return;
      let offset;
      fnPath.traverse({AssignmentExpression(p) {
        if (!t.isIdentifier(p.node.left, {name: param.name}) || !t.isBinaryExpression(p.node.right, {operator: '-'}) ||
            !t.isIdentifier(p.node.right.left, {name: param.name})) return;
        try {const value = evaluator.evaluate(p.get('right').get('right')); if (typeof value === 'number') offset = value;} catch {}
      }});
      if (!Number.isFinite(offset)) return;
      const outerBody = path.node.body.body;
      const outerReturn = outerBody.at(-1);
      if (fnPath === path) {
        // Older actual 02 packager output uses a direct table reader, without
        // the newer decoder's self-replacement. Require its generated spine.
        const [adjust, table, item] = outerBody;
        if (path.node.params.length !== 2 || !path.node.params.every(p => t.isIdentifier(p)) ||
            !t.isExpressionStatement(adjust) || !t.isAssignmentExpression(adjust.expression, {operator: '='}) ||
            !t.isIdentifier(adjust.expression.left, {name: param.name}) ||
            !t.isBinaryExpression(adjust.expression.right, {operator: '-'}) ||
            !t.isIdentifier(adjust.expression.right.left, {name: param.name}) ||
            !t.isVariableDeclaration(table) || table.declarations.length !== 1 ||
            !t.isIdentifier(table.declarations[0].id) || !t.isCallExpression(table.declarations[0].init) ||
            table.declarations[0].init.arguments.length || !t.isIdentifier(table.declarations[0].init.callee) ||
            path.scope.getBinding(table.declarations[0].init.callee.name)?.identifier !== provider.binding.identifier ||
            !t.isVariableDeclaration(item) || item.declarations.length !== 1 || !t.isIdentifier(item.declarations[0].id) ||
            !t.isMemberExpression(item.declarations[0].init, {computed: true}) ||
            !t.isIdentifier(item.declarations[0].init.object, {name: table.declarations[0].id.name}) ||
            !t.isIdentifier(item.declarations[0].init.property, {name: param.name}) || !t.isReturnStatement(outerReturn)) return;
        const returnedItem = node => t.isIdentifier(node, {name: item.declarations[0].id.name});
        if (outerBody.length === 4) {
          if (!returnedItem(outerReturn.argument)) return;
        } else {
          const initialized = outerBody[3];
          const cache = outerBody[4];
          if (![6, 7].includes(outerBody.length) || !t.isIfStatement(initialized) || initialized.alternate ||
              !t.isBinaryExpression(initialized.test, {operator: '==='}) ||
              !t.isMemberExpression(initialized.test.left) ||
              !t.isIdentifier(initialized.test.left.object, {name: path.node.id.name}) ||
              !t.isIdentifier(initialized.test.right, {name: 'undefined'}) ||
              !t.isBlockStatement(initialized.consequent) || !t.isVariableDeclaration(cache) || cache.declarations.length !== 3) return;
          if (outerBody.length === 6) {
            if (!t.isSequenceExpression(outerReturn.argument) || outerReturn.argument.expressions.length !== 2 ||
                !t.isConditionalExpression(outerReturn.argument.expressions[0]) || !returnedItem(outerReturn.argument.expressions[1])) return;
          } else if (!t.isIfStatement(outerBody[5]) || !returnedItem(outerReturn.argument)) return;
        }
      } else {
        if (outerBody.length !== 2 || !t.isVariableDeclaration(outerBody[0]) || outerBody[0].declarations.length !== 1 ||
            !t.isReturnStatement(outerReturn) || !t.isSequenceExpression(outerReturn.argument) || outerReturn.argument.expressions.length !== 2) return;
        const [replace, invoke] = outerReturn.argument.expressions;
        if (!t.isAssignmentExpression(replace, {operator: '='}) || !t.isIdentifier(replace.left, {name: path.node.id.name}) ||
            replace.right !== fnPath.node || !t.isCallExpression(invoke) || !t.isIdentifier(invoke.callee, {name: path.node.id.name})) return;
      }
      let unsafeGlobalCall = false;
      path.traverse({
        ReferencedIdentifier(p) {
          if (p.scope.getBinding(p.node.name)) return;
          if (!['undefined', 'String', 'decodeURIComponent', 'RegExp', 'Boolean', 'Math', 'arguments'].includes(p.node.name)) unsafeGlobalCall = true;
        },
        CallExpression(p) {
          if (!t.isMemberExpression(p.node.callee)) return;
          const root = p.node.callee.object;
          if (t.isIdentifier(root) && !p.scope.getBinding(root.name)) {
            const key = propertyName(p.node.callee);
            if ((root.name === 'String' && key !== 'fromCharCode') || (root.name === 'Math' && !['round', 'random'].includes(key))) unsafeGlobalCall = true;
          }
        }
      });
      if (unsafeGlobalCall) return;
      const text = generate(path.node).code;
      const encoded = text.includes(foldedAlphabet);
      const xor = /charCodeAt/.test(text) && (() => {let found = false; walk(path.node, n => {if (t.isBinaryExpression(n, {operator: '^'})) found = true;}); return found;})();
      const encoding = xor ? 'rc4' : encoded ? 'base64' : 'plain';
      const descriptor = {kind: 'decoder', path, binding, provider, offset, encoding,
        decode(args) {
          if (!Number.isInteger(args[0])) throw new Error('String-array index not integer');
          const item = provider.array[args[0] - offset];
          if (typeof item !== 'string') throw new Error('String-array index out of bounds');
          if (encoding === 'plain') return item;
          const decoded = obfuscatorBase64(item);
          return encoding === 'rc4' ? rc4(decoded, args[1]) : decoded;
        }};
      decoders.push(descriptor);
      evaluator.specialBindings.set(binding.identifier, descriptor);
      report.transforms.push({pass: 'decoder-discovery', encoding, name: path.node.id.name, entries: provider.array.length});
    }
  });
  // Execute only the arithmetic comparison of a recognized rotate bootstrap; no arbitrary JS body runs.
  const rotors = [];
  const candidates = [];
  traverse(ast, {
    CallExpression(path) {
      if (!t.isFunctionExpression(path.node.callee) || path.node.arguments.length !== 2 || !t.isIdentifier(path.node.arguments[0])) return;
      const b = path.scope.getBinding(path.node.arguments[0].name);
      const provider = providers.find(x => x.binding.identifier === b?.identifier);
      if (!provider || path.node.callee.params.length !== 2) return;
      let rotates = false;
      path.get('callee').traverse({CallExpression(p) {
        if (propertyName(p.node.callee) === 'push' && p.node.arguments.some(a => t.isCallExpression(a) && propertyName(a.callee) === 'shift')) rotates = true;
      }});
      if (rotates) {provider.rotationUnresolved = true; candidates.push({path, provider});}
    }
  });
  const provedRotors = new Set();
  for (const candidate of candidates) {
    const rotor = generatedRotor(candidate.path, decoders);
    const prefix = rotor && bootstrapPrefix(ast, rotor, {providers, decoders}, provedRotors);
    if (!prefix) {
      report.warnings.push(`字符串轮转执行前缀未证明：${candidate.provider.binding.identifier.name}`);
      continue;
    }
    const prefixEvaluator = new StaticEvaluator({maxSteps: evaluator.maxSteps, maxString: evaluator.maxString});
    prefixEvaluator.steps = evaluator.steps;
    detectBlockedBuiltins(prefix, prefixEvaluator);
    // Rebind recognized descriptors to identifiers owned by the independent AST.
    // The table itself is shared so successful rotation fixes the original decoder.
    const prefixDecoders = [];
    let clonedRotor;
    traverse(prefix, {FunctionDeclaration(path) {
      if (!path.parentPath.isProgram()) return;
      const descriptor = [...providers, ...decoders].find(d => d.path.parentPath.isProgram() && d.binding.identifier.name === path.node.id.name);
      if (!descriptor) return;
      const copy = {...descriptor, path, binding: bindingFor(path)};
      prefixEvaluator.specialBindings.set(copy.binding.identifier, copy);
      if (copy.kind === 'decoder') prefixDecoders.push(copy);
    }});
    traverse(prefix, {CallExpression(path) {
      if (!path.parentPath.isExpressionStatement() || !path.parentPath.parentPath.isProgram()) return;
      const parsed = generatedRotor(path, prefixDecoders);
      if (parsed) clonedRotor = parsed;
    }});
    const saved = [...candidate.provider.array];
    let matched = false;
    try {
      if (!clonedRotor) continue;
      const target = prefixEvaluator.evaluate(clonedRotor.path.get('arguments')[1]);
      if (typeof target !== 'number') continue;
      for (let i = 0; i < candidate.provider.array.length && prefixEvaluator.steps <= prefixEvaluator.maxSteps; i++) {
        try {
          if (prefixEvaluator.evaluate(clonedRotor.checksum) === target) {matched = true; break;}
        } catch {}
        candidate.provider.array.push(candidate.provider.array.shift());
      }
    } catch {
      // The probe only decides whether this rotation can be proved. An evaluator limit or an unsupported
      // node means "not proved", which is the same outcome as a checksum mismatch: the array is restored
      // in `finally` below and the candidate is reported as unresolved rather than guessed.
    } finally {
      evaluator.steps = prefixEvaluator.steps;
      if (!matched) candidate.provider.array.splice(0, candidate.provider.array.length, ...saved);
    }
    if (!matched) {
      report.warnings.push(`字符串轮转校验无法解析：${candidate.provider.binding.identifier.name}`);
      continue;
    }
    candidate.provider.rotated = true;
    candidate.provider.rotationUnresolved = false;
    rotors.push(candidate.path);
    provedRotors.add(candidate.path.node);
    report.transforms.push({pass: 'string-array-rotation', provider: candidate.provider.binding.identifier.name,
      proof: 'generated-top-level-bootstrap-prefix'});
  }
  for (const provider of providers) {
    provider.rotationUnresolved = candidates.some(candidate => candidate.provider === provider && !provedRotors.has(candidate.path.node));
    if (!provider.rotationUnresolved) continue;
    evaluator.specialBindings.delete(provider.binding.identifier);
    for (const decoder of decoders.filter(item => item.provider === provider)) evaluator.specialBindings.delete(decoder.binding.identifier);
  }
  return {providers, decoders, rotors};
}

const inside = (path, ancestor) => path === ancestor || !!path.findParent(p => p === ancestor);
function detectBlockedBuiltins(ast, evaluator) {
  const effects = analyzeBuiltinEffects(ast);
  evaluator.builtinAliases = effects.aliases;
  evaluator.blockedBuiltins = effects.blockedBuiltins;
  evaluator.blockedBuiltinMembers = effects.blockedBuiltinMembers;
  return effects;
}
function refreshBuiltinEffects(ast, evaluator, report) {
  const effects = analyzeBuiltinEffects(ast);
  for (const name of effects.blockedBuiltins) evaluator.blockedBuiltins.add(name);
  for (const name of effects.blockedBuiltinMembers) evaluator.blockedBuiltinMembers.add(name);
  for (const [binding, names] of effects.aliases) {
    if (!evaluator.builtinAliases.has(binding)) evaluator.builtinAliases.set(binding, new Set());
    for (const name of names) evaluator.builtinAliases.get(binding).add(name);
  }
  const summary = report.builtinEffects;
  const mergeAliases = (key, field, additions) => {
    for (const addition of additions) {
      const prior = summary[key].find(item => item.name === addition.name && item.declarationStart === addition.declarationStart);
      if (prior) prior[field] = [...new Set([...prior[field], ...addition[field]])].sort();
      else summary[key].push({...addition, [field]: [...addition[field]]});
    }
  };
  mergeAliases('aliases', 'possibleBuiltins', effects.aliasSummary);
  mergeAliases('methodAliases', 'possibleMethods', effects.methodAliasSummary);
  for (const [key, value] of Object.entries(effects.stats)) {
    summary[key] = typeof value === 'boolean' ? summary[key] || value : Math.max(summary[key] ?? 0, value);
  }
  summary.blockedBuiltins = [...evaluator.blockedBuiltins].sort();
  summary.blockedMembers = [...evaluator.blockedBuiltinMembers].sort();
}

// Materialize decoder calls and literal key arithmetic across the whole AST
// before any business builtin call can be folded. The next effect scan then
// sees method aliases that were hidden by encoded keys or proxy expansion.
function replaceStatic(ast, evaluator, descriptors, report, keysOnly = false) {
  let count = 0;
  const infrastructureNodes = new Set([...descriptors.providers.map(x => x.path.node), ...descriptors.decoders.map(x => x.path.node), ...descriptors.rotors.map(x => x.node)]);
  const reachesDecoder = (binding, active = new Set()) => {
    if (!binding || active.has(binding.identifier)) return false;
    if (descriptors.decoders.some(d => d.binding.identifier === binding.identifier)) return true;
    const next = new Set(active).add(binding.identifier);
    if (binding.constant && binding.path.isVariableDeclarator() && binding.path.get('init').isIdentifier()) {
      return reachesDecoder(binding.path.scope.getBinding(binding.path.node.init.name), next);
    }
    if (!binding.path.isFunctionDeclaration() || binding.path.node.body.body.length !== 1 ||
        !t.isReturnStatement(binding.path.node.body.body[0])) return false;
    const returned = binding.path.get('body').get('body')[0].get('argument');
    return returned.isCallExpression() && returned.get('callee').isIdentifier() &&
      reachesDecoder(returned.scope.getBinding(returned.node.callee.name), next);
  };
  traverse(ast, {
    Expression: {exit(path) {
      if (infrastructureNodes.has(path.node) || path.findParent(p => infrastructureNodes.has(p.node))) return;
      if (path.isLiteral() || path.isFunction() || path.isObjectExpression() || path.isArrayExpression() || path.isAssignmentExpression() ||
          path.isUpdateExpression() || path.isSequenceExpression() || path.isIdentifier()) return;
      if (keysOnly) {
        let safe = true;
        const inspect = p => {
          if (p.isMemberExpression() || p.isNewExpression() || p.isTaggedTemplateExpression() ||
              p.isAssignmentExpression() || p.isUpdateExpression() || p.isSequenceExpression()) safe = false;
          if (p.isCallExpression() && (!p.get('callee').isIdentifier() ||
              !reachesDecoder(p.scope.getBinding(p.node.callee.name)))) safe = false;
          if (p.isIdentifier() && p.isReferencedIdentifier() &&
              !(p.parentPath.isCallExpression() && p.key === 'callee')) safe = false;
        };
        inspect(path);
        path.traverse({enter: inspect});
        if (!safe) return;
      }
      const parent = path.parentPath;
      if ((parent.isAssignmentExpression() && path.key === 'left') || parent.isUpdateExpression() ||
          parent.isUnaryExpression({operator: 'delete'}) || parent.isForInStatement() || parent.isForOfStatement()) return;
      let result;
      try {result = evaluator.evaluate(path);} catch {return;}
      if (!primitiveArguments(result)) return;
      const literal = literalNode(result);
      if (!literal) return;
      // Logical folds must not erase unevaluated live side effects; evaluator only accepts safe operands.
      path.replaceWith(literal);
      count++;
    }}
  });
  if (count) report.transforms.push({pass: 'bounded-static-evaluation', count});
  return count;
}

function proxyObjects(ast, report) {
  // Inlining one call rewrites the AST under Babel's cached scope, so `binding.referencePaths` is
  // stale for the rest of that traversal and the "every reference is a plain member read" check
  // fails for the remaining keys. Without this loop only one key per outer round was inlined, and a
  // 16-key proxy object outlived the 12-round budget. Re-crawl and sweep again until nothing changes.
  let total = 0;
  for (let sweep = 0; sweep < 64; sweep++) {
    traverse(ast, {Program(path) {path.scope.crawl();}});
    const inlined = proxyObjectsSweep(ast, report);
    total += inlined;
    if (!inlined) break;
  }
  return total;
}

function proxyObjectsSweep(ast, report) {
  let count = 0;
  traverse(ast, {
    MemberExpression: {exit(path) {
      if (!path.node || path.removed || !path.container) return;
      const node = path.node;
      if (!t.isIdentifier(node.object)) return;
      const binding = path.scope.getBinding(node.object.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator() || !binding.path.get('init').isObjectExpression()) return;
      if (!binding.referencePaths.every(ref => ref.parentPath.isMemberExpression() && ref.key === 'object' &&
          !ref.parentPath.parentPath.isAssignmentExpression({left: ref.parentPath.node}) && !ref.parentPath.parentPath.isUpdateExpression())) return;
      const key = propertyName(node);
      if (!key) return;
      const properties = binding.path.get('init').get('properties');
      if (!properties.every(p => p.isObjectProperty() && !p.node.computed && !p.node.method)) return;
      const keys = properties.map(p => String(p.node.key.name ?? p.node.key.value));
      if (new Set(keys).size !== keys.length) return;
      const property = properties.find(p => (p.node.key.name ?? p.node.key.value) === key);
      if (!property) return;
      const value = property.node.value;
      if (t.isLiteral(value)) {path.replaceWith(t.cloneNode(value)); count++; return;}
      if (!(t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) || value.async || value.generator) return;
      const callPath = path.parentPath;
      if (!callPath.isCallExpression() || callPath.node.callee !== node || value.params.some(p => !t.isIdentifier(p)) ||
          value.params.length !== callPath.node.arguments.length || callPath.node.arguments.some(a => t.isSpreadElement(a))) return;
      const body = t.isBlockStatement(value.body) ? value.body.body.length === 1 && t.isReturnStatement(value.body.body[0]) ? value.body.body[0].argument : null : value.body;
      if (!body) return;
      const params = value.params.map(p => p.name);
      // `return P0 <op> P1` where <op> is any binary or logical operator. Inlining substitutes the
      // call's argument expressions for the parameters, which preserves left-to-right evaluation order
      // and evaluates each argument exactly once, including for the short-circuiting `||`/`&&`/`??`:
      // `proxy.f(a, b)` and `a || b` both evaluate `a` first and `b` only when needed.
      let safe = (t.isBinaryExpression(body) || t.isLogicalExpression(body)) && t.isIdentifier(body.left) && t.isIdentifier(body.right) &&
        params.length === 2 && body.left.name === params[0] && body.right.name === params[1] && params[0] !== params[1];
      if (t.isCallExpression(body) && t.isIdentifier(body.callee, {name: params[0]}) && params.length === body.arguments.length + 1 &&
          body.arguments.every((a, i) => t.isIdentifier(a, {name: params[i + 1]})) && t.isIdentifier(callPath.node.arguments[0])) safe = true;
      if (!safe) return;
      const replacements = new Map(params.map((p, i) => [p, callPath.node.arguments[i]]));
      const rewrite = n => {
        if (t.isIdentifier(n) && replacements.has(n.name)) return t.cloneNode(replacements.get(n.name), true);
        const copy = t.cloneNode(n, false);
        for (const key of t.VISITOR_KEYS[n.type] || []) {
          if (Array.isArray(n[key])) copy[key] = n[key].map(rewrite);
          else if (n[key]) copy[key] = rewrite(n[key]);
        }
        return copy;
      };
      if (!callPath.node || callPath.removed || !callPath.container) return;
      callPath.replaceWith(rewrite(body)); count++;
    }}
  });
  if (count) report.transforms.push({pass: 'object-proxy-inlining', count});
  return count;
}

function normalizeProperties(ast, report) {
  let count = 0;
  traverse(ast, {
    MemberExpression(path) {
      if (path.node.computed && t.isStringLiteral(path.node.property) && t.isValidIdentifier(path.node.property.value)) {
        path.node.property = t.identifier(path.node.property.value); path.node.computed = false; count++;
      }
    }
  });
  if (count) report.transforms.push({pass: 'property-normalization', count});
  return count;
}

function unwrapAndSimplify(ast, report) {
  let count = 0;
  traverse(ast, {
    ExpressionStatement(path) {
      if (t.isSequenceExpression(path.node.expression)) {
        path.replaceWithMultiple(path.node.expression.expressions.map(n => t.expressionStatement(n))); count++;
      }
    },
    VariableDeclaration(path) {
      if (path.node.declarations.length > 1 && (path.parentPath.isProgram() || path.parentPath.isBlockStatement())) {
        path.replaceWithMultiple(path.node.declarations.map(n => t.variableDeclaration(path.node.kind, [n]))); count++;
      }
    },
    CallExpression: {exit(path) {
      const fn = path.node.callee;
      if (!(t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) || fn.async || fn.generator || fn.params.length || path.node.arguments.length) return;
      const statements = t.isBlockStatement(fn.body) ? fn.body.body : [t.returnStatement(fn.body)];
      const declarations = statements.slice(0, -1);
      const last = statements.at(-1);
      if (!t.isReturnStatement(last) || !last.argument) return;
      const fnPath = path.get('callee');
      let unsafeScope = false;
      const returnedPath = t.isBlockStatement(fn.body) ? fnPath.get('body').get('body').at(-1).get('argument') : fnPath.get('body');
      returnedPath.traverse({
        ThisExpression() {unsafeScope = true;},
        Super() {unsafeScope = true;},
        MetaProperty() {unsafeScope = true;},
        ReferencedIdentifier(p) {
          if (p.node.name === 'arguments') unsafeScope = true;
          const binding = p.scope.getBinding(p.node.name);
          if (binding && binding.scope === fnPath.scope) unsafeScope = true;
        }
      });
      if (t.isIdentifier(last.argument, {name: 'arguments'}) || t.isThisExpression(last.argument) ||
          (t.isIdentifier(last.argument) && fnPath.scope.getBinding(last.argument.name)?.scope === fnPath.scope && !declarations.length)) unsafeScope = true;
      if (unsafeScope && !declarations.length) return;
      if (!declarations.length) {path.replaceWith(last.argument); count++; return;}
      if (!declarations.every(n => t.isVariableDeclaration(n) && n.kind === 'const' && n.declarations.length === 1)) return;
      if (!t.isIdentifier(last.argument)) return;
      const selected = declarations.find(n => t.isIdentifier(n.declarations[0].id, {name: last.argument.name}));
      if (declarations.length === 1 && selected && t.isFunctionExpression(selected.declarations[0].init)) {
        const initPath = fnPath.get('body').get('body')[0].get('declarations')[0].get('init');
        let capturesWrapper = false;
        initPath.traverse({ReferencedIdentifier(p) {
          const binding = p.scope.getBinding(p.node.name);
          if (binding && binding.scope === fnPath.scope) capturesWrapper = true;
        }});
        if (capturesWrapper) return;
        path.replaceWith(selected.declarations[0].init); count++;
      }
    }}
  });
  if (count) report.transforms.push({pass: 'structural-unwrapping', count});
  return count;
}

/**
 * Undo javascript-obfuscator's `simplify` option (and the block flattening it leaves behind).
 *
 * `simplify` rewrites statements into expressions:
 *   if (c) a;            ->  c && a;
 *   if (!c) a;           ->  !c && a;            (or  c || a)
 *   if (c) a; else b;    ->  c ? a : b;
 *   a; b; c;             ->  a, b, c;
 * It also drops braces (`if (c) stmt;`, `for (...) stmt;`) and leaves bare `{ ... }` blocks.
 *
 * Every rewrite below is applied only to an *expression statement*, where the value of the
 * expression is discarded. In that position `a && b;` and `if (a) { b; }` evaluate the same
 * operands in the same order and run `b` under the same condition, so the rewrite preserves
 * behaviour exactly; nothing here depends on the types of the operands. `return a && b;` is never
 * touched because there the value is used.
 */
function restoreStructure(ast, report) {
  let count = 0;

  // `a && b;` -> if (a) { b }, `a || b;` -> if (!a) { b }, `c ? a : b;` -> if (c) { a } else { b },
  // `a, b;` -> a; b;. Returns the replacement statements, or null when the expression is a plain call/assign.
  const statementsFor = expression => {
    if (t.isSequenceExpression(expression)) {
      return expression.expressions.flatMap(part => statementsFor(part) || [t.expressionStatement(part)]);
    }
    if (t.isLogicalExpression(expression) && ['&&', '||'].includes(expression.operator)) {
      const test = expression.operator === '&&' ? expression.left : negate(expression.left);
      const body = statementsFor(expression.right) || [t.expressionStatement(expression.right)];
      return [t.ifStatement(test, t.blockStatement(body))];
    }
    if (t.isConditionalExpression(expression)) {
      const consequent = statementsFor(expression.consequent) || [t.expressionStatement(expression.consequent)];
      const alternate = statementsFor(expression.alternate) || [t.expressionStatement(expression.alternate)];
      return [t.ifStatement(expression.test, t.blockStatement(consequent), t.blockStatement(alternate))];
    }
    return null;
  };
  // `!x` for the condition of a rewritten `a || b`. A double negation is dropped: `if (!!x)` and
  // `if (x)` branch identically because both only use the truthiness of `x`.
  const negate = node => t.isUnaryExpression(node, {operator: '!'}) ? node.argument : t.unaryExpression('!', node);
  const asBlock = node => t.isBlockStatement(node) ? node : t.blockStatement([node]);
  const hasLexicalDeclaration = block => block.body.some(s => t.isClassDeclaration(s) || t.isFunctionDeclaration(s) ||
    (t.isVariableDeclaration(s) && s.kind !== 'var'));

  traverse(ast, {
    ExpressionStatement: {exit(path) {
      // A statement that is just a literal (`false;`, `0;`, `"x";`) has no effect. Static evaluation leaves
      // these behind when it folds an obfuscated `if (false) { ... }`, i.e. `false && (...)`, down to its
      // value; the compiler never emits them, so the recovery would otherwise refuse the whole script.
      // Directives such as "use strict" are not expression statements in Babel's AST, so they are unaffected.
      if (t.isLiteral(path.node.expression) && !t.isTemplateLiteral(path.node.expression) &&
          (path.parentPath.isBlockStatement() || path.parentPath.isProgram())) {
        path.remove();
        count++;
        return;
      }
      const replacement = statementsFor(path.node.expression);
      if (!replacement) return;
      path.replaceWithMultiple(replacement);
      count++;
    }},
    // `return a, b;` evaluates `a` for its effects and returns `b`: the same as `a; return b;`.
    // Only the leading operands are hoisted, so evaluation order and the returned value are unchanged.
    ReturnStatement: {exit(path) {
      const argument = path.node.argument;
      if (!t.isSequenceExpression(argument) || !(path.parentPath.isBlockStatement() || path.parentPath.isProgram())) return;
      const parts = argument.expressions;
      const leading = parts.slice(0, -1).flatMap(part => statementsFor(part) || [t.expressionStatement(part)]);
      path.replaceWithMultiple([...leading, t.returnStatement(parts.at(-1))]);
      count++;
    }},
    // Braces are needed for the rewrite above to be well formed, and they are what the compiler emits.
    IfStatement: {exit(path) {
      const {consequent, alternate} = path.node;
      if (!t.isBlockStatement(consequent)) { path.node.consequent = asBlock(consequent); count++; }
      if (alternate && !t.isBlockStatement(alternate) && !t.isIfStatement(alternate)) { path.node.alternate = asBlock(alternate); count++; }
      // `else { if (...) {...} }` is the compiler's else-if chain written out; leave `else if` alone.
    }},
    'ForStatement|WhileStatement|DoWhileStatement|ForInStatement|ForOfStatement': {exit(path) {
      if (!t.isBlockStatement(path.node.body)) { path.node.body = asBlock(path.node.body); count++; }
    }},
    // A bare `{ ... }` statement adds no meaning. Unwrap it into the parent unless it holds a lexical
    // declaration, whose scope the braces define.
    BlockStatement: {exit(path) {
      if (!path.parentPath.isBlockStatement() && !path.parentPath.isProgram()) return;
      if (hasLexicalDeclaration(path.node)) return;
      path.replaceWithMultiple(path.node.body);
      count++;
    }}
  });
  if (count) report.transforms.push({pass: 'simplify-structure-restoration', count});
  return count;
}

function flattenDispatch(ast, evaluator, report) {
  let count = 0;
  traverse(ast, {
    WhileStatement(path) {
      let truth;
      try {truth = evaluator.evaluate(path.get('test'));} catch {return;}
      if (!truth || !t.isBlockStatement(path.node.body) || path.node.body.body.length !== 2) return;
      const [switchNode, breakNode] = path.node.body.body;
      if (!t.isSwitchStatement(switchNode) || !t.isBreakStatement(breakNode) || breakNode.label || !t.isMemberExpression(switchNode.discriminant) ||
          !switchNode.discriminant.computed || !t.isIdentifier(switchNode.discriminant.object) ||
          !t.isUpdateExpression(switchNode.discriminant.property, {operator: '++', prefix: false}) || !t.isIdentifier(switchNode.discriminant.property.argument)) return;
      const switchPath = path.get('body').get('body')[0];
      const binding = path.scope.getBinding(switchNode.discriminant.object.name);
      const indexBinding = path.scope.getBinding(switchNode.discriminant.property.argument.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator() || !indexBinding?.path.isVariableDeclarator()) return;
      let order, start;
      try {order = evaluator.evaluate(binding.path.get('init')); start = evaluator.evaluate(indexBinding.path.get('init'));} catch {return;}
      if (!Array.isArray(order) || !order.every(primitiveArguments) || !Number.isInteger(start) || start < 0 || order.length > 10000) return;
      if (!indexBinding.referencePaths.every(ref => inside(ref, path)) || !indexBinding.constantViolations.every(ref => inside(ref, path)) ||
          !binding.referencePaths.every(ref => inside(ref, path))) return;
      const cases = new Map();
      for (const c of switchNode.cases) {
        if (!c.test || !t.isLiteral(c.test) || cases.has(String(c.test.value))) return;
        cases.set(String(c.test.value), c.consequent);
      }
      const output = [];
      const selected = new Set();
      let terminal = false;
      for (const key of order.slice(start)) {
        const branch = cases.get(String(key));
        if (!branch || selected.has(String(key)) || branch.some(n => hasIdentifier(n, binding.identifier.name) || hasIdentifier(n, indexBinding.identifier.name))) return;
        selected.add(String(key));
        const last = branch.at(-1);
        let internalJump = false;
        for (const statement of branch.slice(0, -1)) walk(statement, node => {
          if (t.isBreakStatement(node) || t.isContinueStatement(node)) internalJump = true;
        });
        if (internalJump) return;
        if (t.isContinueStatement(last) && !last.label) output.push(...branch.slice(0, -1));
        else if (t.isReturnStatement(last) || t.isThrowStatement(last)) {output.push(...branch); terminal = true; break;}
        else return;
      }
      if (!output.length) return;
      // Block scope avoids changing lexical visibility of case-local bindings.
      path.replaceWith(t.blockStatement(output.map(n => t.cloneNode(n, true))));
      binding.path.remove();
      if (indexBinding.path.node) indexBinding.path.remove();
      report.transforms.push({pass: 'constant-switch-dispatcher-unflattening', steps: selected.size, terminal});
      count++;
    }
  });
  return count;
}

function cleanupInfrastructure(ast, descriptors, report) {
  const candidates = new Set([...descriptors.providers.map(p => p.path.node), ...descriptors.decoders.map(d => d.path.node)]);
  const rotorNodes = new Set(descriptors.rotors.map(p => p.node));
  // Extend to one-return decoder aliases/wrappers with no references outside the dependency component.
  let changed = true;
  while (changed) {
    changed = false;
    traverse(ast, {
      FunctionDeclaration(path) {
        if (candidates.has(path.node) || path.node.body.body.length !== 1 || !t.isReturnStatement(path.node.body.body[0])) return;
        let touches = false;
        path.traverse({Identifier(p) {
          const binding = p.scope.getBinding(p.node.name);
          if (binding && candidates.has(binding.path.node)) touches = true;
        }});
        if (touches) {candidates.add(path.node); changed = true;}
      },
      VariableDeclarator(path) {
        if (candidates.has(path.node) || !t.isIdentifier(path.node.init)) return;
        const binding = path.scope.getBinding(path.node.init.name);
        if (binding && candidates.has(binding.path.node)) {candidates.add(path.node); changed = true;}
      }
    });
  }
  const remove = [];
  const hasExternal = path => {
    const binding = bindingFor(path);
    return !binding || [...binding.referencePaths, ...binding.constantViolations].some(ref =>
      !ref.findParent(p => candidates.has(p.node) || rotorNodes.has(p.node)) && !candidates.has(ref.node));
  };
  traverse(ast, {
    FunctionDeclaration(path) {if (candidates.has(path.node) && !hasExternal(path)) remove.push(path);},
    VariableDeclarator(path) {if (candidates.has(path.node) && !hasExternal(path)) remove.push(path);}
  });
  // If a component remains referenced by live code, retain its bootstrap: no destructive partial removal.
  if (remove.length !== candidates.size) return 0;
  traverse(ast, {CallExpression(path) {
    if (!rotorNodes.has(path.node)) return;
    if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
    else if (path.parentPath.isSequenceExpression()) path.remove();
  }});
  for (const path of remove) if (!path.removed) path.remove();
  if (remove.length) report.transforms.push({pass: 'unused-decoder-component-removal', count: remove.length});
  return remove.length;
}

function stripSelfDefending(ast, report) {
  let count = 0;
  const wrappers = [];
  traverse(ast, {VariableDeclarator(path) {
    if (!t.isIdentifier(path.node.id) || !t.isCallExpression(path.node.init) || path.node.init.arguments.length !== 2 ||
        !t.isThisExpression(path.node.init.arguments[0]) || !t.isFunctionExpression(path.node.init.arguments[1])) return;
    const callback = path.node.init.arguments[1];
    if (callback.params.length || callback.body.body.length !== 1 || !t.isReturnStatement(callback.body.body[0])) return;
    const expression = callback.body.body[0].argument;
    const name = path.node.id.name;
    const pattern = '(((.+)+)+)+$';
    let searches = 0, toStrings = 0, constructor = 0, foreign = false;
    walk(expression, node => {
      if (t.isIdentifier(node) && node.name !== name && !['toString', 'search', 'constructor'].includes(node.name)) foreign = true;
      if (t.isCallExpression(node)) {
        const key = propertyName(node.callee);
        if (key === 'search' && node.arguments.length === 1 && t.isStringLiteral(node.arguments[0], {value: pattern})) searches++;
        else if (key === 'toString' && !node.arguments.length) toStrings++;
        else if (key === 'constructor' && node.arguments.length === 1 && t.isIdentifier(node.arguments[0], {name})) constructor++;
        else foreign = true;
      }
    });
    if (foreign || searches !== 2 || toStrings !== 2 || constructor !== 1) return;
    const binding = path.scope.getBinding(name);
    if (!binding || !binding.constant || !binding.referencePaths.every(ref => inside(ref, path) ||
        (ref.parentPath.isCallExpression() && ref.key === 'callee' && !ref.parentPath.node.arguments.length &&
         ref.parentPath.parentPath.isExpressionStatement()))) return;
    const wrapper = t.isIdentifier(path.node.init.callee) ? path.scope.getBinding(path.node.init.callee.name)?.path : null;
    for (const ref of binding.referencePaths) if (!inside(ref, path)) ref.parentPath.parentPath.remove();
    path.remove();
    if (wrapper) wrappers.push(wrapper);
    count++;
  }});
  traverse(ast, {Program(path) {path.scope.crawl();}});
  for (const wrapper of wrappers) {
    if (!wrapper.node || !wrapper.isVariableDeclarator()) continue;
    const binding = bindingFor(wrapper);
    const init = wrapper.node.init;
    if (!binding?.referenced && t.isCallExpression(init) && !init.arguments.length && t.isFunctionExpression(init.callee) &&
        !init.callee.params.length && generate(init.callee).code.includes('.apply(')) {
      wrapper.remove(); count++;
    }
  }
  if (count) report.transforms.push({pass: 'recognized-self-defending-prologue-removal', count,
    equivalenceScope: 'application-results-without-source-string-introspection'});
  return count;
}

function deadBindings(ast, report) {
  let count = 0;
  traverse(ast, {
    Program(path) {path.scope.crawl();},
    Function(path) {path.scope.crawl();},
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const binding = path.scope.getBinding(path.node.id.name);
      if (!binding || binding.referenced || !binding.constant || path.parentPath.parentPath.isProgram()) return;
      if (path.get('init').isPure()) {path.remove(); count++;}
    },
    FunctionDeclaration(path) {
      const binding = path.parentPath.scope.getBinding(path.node.id.name);
      if (binding && !binding.referenced && binding.constant && !path.parentPath.isProgram()) {path.remove(); count++;}
    }
  });
  if (count) report.transforms.push({pass: 'unreferenced-pure-binding-removal', count});
  return count;
}

function canonicalFactory(ast, report) {
  traverse(ast, {FunctionExpression(path) {
    if (path.node.params.length !== 1 || !t.isIdentifier(path.node.params[0])) return;
    const body = path.node.body.body;
    const first = body.find(n => t.isVariableDeclaration(n) && n.declarations.length === 1 && t.isMemberExpression(n.declarations[0].init));
    if (!first) return;
    const parameter = path.node.params[0].name;
    const init = first.declarations[0].init;
    if (!t.isIdentifier(init.object, {name: parameter}) || propertyName(init) !== 'target') return;
    if (parameter !== 'thread' && !path.scope.hasOwnBinding('thread')) path.scope.rename(parameter, 'thread');
    const rename = (oldName, newName) => {if (oldName !== newName && !path.scope.hasOwnBinding(newName)) path.scope.rename(oldName, newName);};
    const targetName = first.declarations[0].id.name;
    rename(targetName, 'target');
    for (const statement of body) {
      if (!t.isVariableDeclaration(statement) || statement.declarations.length !== 1) continue;
      const d = statement.declarations[0];
      if (t.isIdentifier(d.id) && t.isMemberExpression(d.init) && t.isIdentifier(d.init.object, {name: 'target'}) && propertyName(d.init) === 'runtime') rename(d.id.name, 'runtime');
    }
    for (const statement of body) {
      if (!t.isVariableDeclaration(statement) || statement.declarations.length !== 1) continue;
      const d = statement.declarations[0];
      if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && t.isMemberExpression(d.init.callee) &&
          t.isIdentifier(d.init.callee.object, {name: 'runtime'}) && propertyName(d.init.callee) === 'getTargetForStage') rename(d.id.name, 'stage');
    }
    // The 02 compiler names a procedure's parameters positionally: `p0`, `p1`, ... (jsgen.js, the
    // returned script function). The obfuscator renamed them to `_0x…`. Restoring the positional names is
    // a pure alpha-renaming, and it is what lets procedure signatures be read off the factory again.
    const returned = body.at(-1);
    if (t.isReturnStatement(returned) && (t.isFunctionExpression(returned.argument) || t.isArrowFunctionExpression(returned.argument))) {
      const inner = path.get('body').get('body').at(-1).get('argument');
      const params = inner.node.params;
      if (params.every(p => t.isIdentifier(p)) && !params.every((p, i) => p.name === `p${i}`)) {
        // Rename through temporaries first, so `p1 -> p0` and `p0 -> p1` style collisions cannot clobber each other.
        const taken = name => inner.scope.hasBinding(name) || path.scope.hasBinding(name);
        const targets = params.map((_, i) => `p${i}`);
        if (!targets.some((name, i) => params[i].name !== name && taken(name))) {
          params.map(p => p.name).forEach((oldName, i) => { if (oldName !== targets[i]) inner.scope.rename(oldName, targets[i]); });
        }
      }
    }
  }});
}

function residuals(ast, descriptors) {
  const list = [];
  const knownNodes = new Map([...descriptors.providers.map(x => [x.path.node, 'string-array-provider']),
    ...descriptors.decoders.map(x => [x.path.node, 'string-array-decoder']),
    ...descriptors.rotors.map(x => [x.node, 'string-array-rotation-bootstrap'])]);
  traverse(ast, {
    enter(path) {
      if (knownNodes.has(path.node)) list.push({type: knownNodes.get(path.node), line: path.node.loc?.start.line});
    },
    NewExpression(path) {
      if (t.isIdentifier(path.node.callee, {name: 'Function'}) && !path.scope.getBinding('Function')) list.push({type: 'dynamic-function-constructor', line: path.node.loc?.start.line});
    },
    CallExpression(path) {
      if (t.isIdentifier(path.node.callee, {name: 'eval'}) && !path.scope.getBinding('eval')) list.push({type: 'dynamic-eval', line: path.node.loc?.start.line});
      if (t.isIdentifier(path.node.callee, {name: 'Function'}) && !path.scope.getBinding('Function')) list.push({type: 'dynamic-function-constructor', line: path.node.loc?.start.line});
    },
    Function(path) {
      if (generate(path.node).code.includes(foldedAlphabet)) list.push({type: 'string-array-decoder-bootstrap', line: path.node.loc?.start.line});
    },
    WhileStatement(path) {
      if (path.node.body?.body?.some(n => t.isSwitchStatement(n))) list.push({type: 'switch-dispatcher', line: path.node.loc?.start.line});
    }
  });
  return list;
}

export function deobfuscate(source, {maxRounds = 12, maxSteps = 300000, maxSourceBytes = 4_000_000} = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxSourceBytes) throw new Error('JavaScript input absent or over size limit');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new Error('maxRounds out of range');
  const report = {schemaVersion: 1, status: 'unchanged', transforms: [], warnings: [], residuals: [],
    executesInput: false, proof: 'bounded-static-ast-transformations', behaviorEquivalenceVerified: false};
  let ast = parser(source);
  // Literal-only eval unwrapping. No eval is called, even on hostile input.
  for (let i = 0; i < 4; i++) {
    if (ast.program.body.length !== 1 || !t.isExpressionStatement(ast.program.body[0])) break;
    const expression = ast.program.body[0].expression;
    if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee, {name: 'eval'}) || expression.arguments.length !== 1 || !t.isStringLiteral(expression.arguments[0])) break;
    const inner = expression.arguments[0].value;
    if (Buffer.byteLength(inner) > maxSourceBytes) throw new Error('eval literal over size limit');
    ast = parser(inner);
    report.transforms.push({pass: 'literal-eval-unwrapping'});
  }
  const evaluator = new StaticEvaluator({maxSteps});
  const builtinEffects = detectBlockedBuiltins(ast, evaluator);
  report.builtinEffects = {
    aliasModel: 'scope-binding-may-set',
    ...builtinEffects.stats,
    aliases: builtinEffects.aliasSummary,
    methodAliases: builtinEffects.methodAliasSummary,
    blockedBuiltins: [...builtinEffects.blockedBuiltins].sort(),
    blockedMembers: [...builtinEffects.blockedBuiltinMembers].sort()
  };
  const descriptors = discoverDecoders(ast, evaluator, report);
  if (descriptors.providers.some(provider => provider.rotationUnresolved)) {
    // Unresolved table order also prevents removing source-text self checks safely.
    report.transforms = [];
    report.residuals = residuals(ast, descriptors);
    report.residuals.push({type: 'string-array-rotation-unresolved'});
    report.warnings.push('字符串表顺序未证明，保留输入源码及自检文本');
    report.status = 'partial';
    report.staticEvaluationSteps = evaluator.steps;
    return {code: source, report};
  }
  for (let round = 0; round < maxRounds; round++) {
    const before = printer(ast);
    replaceStatic(ast, evaluator, descriptors, report, true);
    proxyObjects(ast, report);
    normalizeProperties(ast, report);
    refreshBuiltinEffects(ast, evaluator, report);
    replaceStatic(ast, evaluator, descriptors, report);
    unwrapAndSimplify(ast, report);
    restoreStructure(ast, report);
    flattenDispatch(ast, evaluator, report);
    stripSelfDefending(ast, report);
    cleanupInfrastructure(ast, descriptors, report);
    deadBindings(ast, report);
    if (printer(ast) === before) break;
  }
  canonicalFactory(ast, report);
  report.residuals = residuals(ast, descriptors);
  if (report.builtinEffects.invocationResolutionLimited || report.builtinEffects.argumentResolutionLimited) {
    report.warnings.push('内置间接调用解析达到上限；保守保护内置对象，未执行输入');
    report.residuals.push({type: 'builtin-invocation-resolution-limit'});
  }
  if (evaluator.steps > evaluator.maxSteps) {
    report.warnings.push('静态求值预算耗尽；未尝试执行未知代码');
    report.residuals.push({type: 'static-evaluation-budget-exhausted'});
  }
  report.status = report.residuals.length ? 'partial' : report.transforms.length ? 'transformed' : 'unchanged';
  report.staticEvaluationSteps = evaluator.steps;
  return {code: printer(ast), report};
}
