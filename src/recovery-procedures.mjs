import {createHash} from 'node:crypto';
import {parse} from 'acorn';

const idFor = (targetIndex, code, key) => `rfp_${createHash('sha256').update(`${targetIndex}:${code}:${key}`).digest('hex').slice(0, 20)}`;

export function collectProcedureSignatures(compiledTarget, targetIndex) {
  const signatures = new Map();
  for (const [variant, entry] of Object.entries(compiledTarget.procedures || {})) {
    if (!/^[WZ]/.test(variant)) continue;
    const code = variant.slice(1);
    const types = [...code.matchAll(/(?<!\\)%([snb])/g)].map(match => match[1]);
    let ast;
    try { ast = parse(entry.factorySource, {ecmaVersion: 'latest'}); } catch { continue; }
    // The inner function's parameters carry the procedure's arguments. Their *names* are whatever the
    // compiler (and, under strong obfuscation, the obfuscator) wrote — `p0`, `_0x3e36b5`, anything. Only the
    // arity and the position of each argument matter, so the shape check is "all plain identifiers, one per
    // type". Requiring the names to be `p0..pn` rejected 206 of the 289 procedures in the sample project,
    // which in turn made every caller fail with "no unique non-warp definition".
    //
    // Two factory envelopes exist. The current compiler emits `(function factory(thread){ ... return
    // function* name(...){...}; })`; an older one wrapped the same thing in an IIFE and returned the inner
    // function through a local, `(() => { ... const t1 = function* name(){...}; return t1; })()`. Reading only
    // the first shape loses 63 more procedures. `innerFunction` finds the returned generator either way.
    const returned = innerFunction(ast);
    if (!returned || returned.params.length !== types.length ||
        returned.params.some(parameter => parameter.type !== 'Identifier')) continue;
    if (!signatures.has(code)) signatures.set(code, {
      code, types, names: types.map((_, i) => `参数${i + 1}`), ids: types.map((_, i) => idFor(targetIndex, code, `arg/${i}`)), variants: []
    });
    signatures.get(code).variants.push({variant, entry, yields: returned.generator, warp: variant[0] === 'W'});
  }
  for (const signature of signatures.values()) signature.warp = signature.variants.every(variant => variant.warp);
  return signatures;
}

/**
 * The generator/function a factory returns, whether it is returned directly or through a local variable
 * assigned inside the factory body. Returns null when the source has neither shape.
 */
function innerFunction(ast) {
  const isFunction = node => node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
  const expression = ast.body[0]?.expression;
  // `(function factory(thread){...})` — the envelope the current compiler writes.
  // `(() => {...})()` — the older IIFE envelope; the body lives on the callee.
  const factory = expression?.type === 'CallExpression' && isFunction(expression.callee) ? expression.callee : expression;
  const body = factory?.body?.body;
  if (!Array.isArray(body)) return null;
  const direct = body.at(-1)?.argument;
  if (isFunction(direct)) return direct;
  // `return t1;` where `t1` is a function declared earlier in the same factory body.
  if (direct?.type === 'Identifier') {
    for (const statement of body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) {
        if (declaration.id?.type === 'Identifier' && declaration.id.name === direct.name && isFunction(declaration.init)) {
          return declaration.init;
        }
      }
    }
  }
  return null;
}

// `thread.procedures["Wname"](` and the unquoted `thread.procedures.Wname(` form the obfuscator may leave behind.
const PROCEDURE_CALL = /procedures(?:\["([WZ](?:[^"\\]|\\.)*)"\]|\.([WZ][A-Za-z0-9_$]*))\s*\(/g;
const unescapeName = raw => { try { return JSON.parse(`"${raw}"`); } catch { return raw; } };

/**
 * The procedure variants of one target, ordered so that a procedure comes after the procedures it calls.
 *
 * A recovered call is only valid when the definition it names exists in the output, so a caller can only be
 * decoded after its callees. The compiled bundle lists variants in whatever order the compiler reached them,
 * which is not a dependency order: in the sample project 190 of 411 call edges point forward. This ordering is
 * a hint that lets the first decoding pass succeed; correctness never rests on it, because the decoder still
 * checks every call against the definitions that actually exist. A wrong hint costs a retry, not a wrong
 * result. Cycles (recursion) are cut at the point where they are first found, and independent procedures keep
 * their original relative order.
 *
 * @param {Record<string, {factorySource?: string}>} procedures
 * @returns {string[]} variant names, callees first
 */
export function orderProcedureVariants(procedures) {
  const names = Object.keys(procedures || {});
  const known = new Set(names);
  const calleesOf = name => {
    const source = procedures[name]?.factorySource;
    if (typeof source !== 'string') return [];
    const found = new Set();
    for (const match of source.matchAll(PROCEDURE_CALL)) {
      const callee = match[1] !== undefined ? unescapeName(match[1]) : match[2];
      if (known.has(callee)) found.add(callee);
    }
    return [...found];
  };
  const ordered = [];
  const entered = new Set();
  // Explicit stack: a long call chain must not be able to overflow the JavaScript stack.
  for (const root of names) {
    if (entered.has(root)) continue;
    entered.add(root);
    const stack = [{name: root, callees: calleesOf(root), next: 0}];
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.next < frame.callees.length) {
        const callee = frame.callees[frame.next++];
        if (!entered.has(callee)) { entered.add(callee); stack.push({name: callee, callees: calleesOf(callee), next: 0}); }
      } else {
        ordered.push(frame.name);
        stack.pop();
      }
    }
  }
  return ordered;
}

export const procedureMutation = signature => ({tagName: 'mutation', children: [], proccode: signature.code,
  argumentids: JSON.stringify(signature.ids), argumentnames: JSON.stringify(signature.names),
  argumentdefaults: JSON.stringify(signature.types.map(type => type === 'b' ? 'false' : '')), warp: String(!!signature.warp)});

export function addProcedureDefinition({target, targetIndex, signature}) {
  const definitionId = idFor(targetIndex, signature.code, 'definition');
  const prototypeId = idFor(targetIndex, signature.code, 'prototype');
  const argumentIds = signature.types.map((_, i) => idFor(targetIndex, signature.code, `reporter/${i}`));
  const ids = [definitionId, prototypeId, ...argumentIds];
  if (ids.some(id => Object.hasOwn(target.blocks, id))) throw new Error('过程合成积木ID冲突');
  const inputs = Object.fromEntries(signature.ids.map((id, index) => [id, [1, argumentIds[index]]]));
  const definition = {opcode: 'procedures_definition', next: null, parent: null, inputs: {custom_block: [1, prototypeId]}, fields: {},
    topLevel: true, shadow: false, x: 600, y: 80 + Object.keys(target.blocks).length * 2};
  const prototype = {opcode: 'procedures_prototype', next: null, parent: definitionId, inputs, fields: {}, topLevel: false, shadow: true,
    mutation: procedureMutation(signature)};
  const staged = {[definitionId]: definition, [prototypeId]: prototype};
  signature.types.forEach((type, index) => {
    staged[argumentIds[index]] = {opcode: type === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number',
      next: null, parent: prototypeId, fields: {VALUE: [signature.names[index], null]}, inputs: {}, topLevel: false, shadow: true};
  });
  Object.assign(target.blocks, staged);
  return {definitionId, prototypeId, ids};
}
