import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

// Only test-owned programs execute, with fresh builtins for each observation.
const observe = (code, globals = {}, setup = '') => {
  const context = vm.createContext({...globals}, {codeGeneration: {strings: false, wasm: false}});
  try {
    if (setup) new vm.Script(setup).runInContext(context, {timeout: 200});
    const value = new vm.Script(`JSON.stringify((()=>{${code}})())`).runInContext(context, {timeout: 200});
    return {value: JSON.parse(value)};
  } catch (error) { return {error: error.name}; }
};

const checkBehavior = (source, cases) => {
  const result = deobfuscate(source);
  for (const {expected, globals = {}, setup = ''} of cases) {
    assert.deepEqual(observe(source, globals, setup), expected, 'original test program');
    assert.deepEqual(observe(result.code, globals, setup), expected, 'deobfuscated test program');
  }
  assert.equal(result.report.executesInput, false);
  return result;
};

const assertMemberBlocked = (result, member = 'String.fromCharCode') => {
  assert.ok(result.report.builtinEffects.blockedMembers.includes(member), `${member} must be protected`);
};
const assertStringUnblocked = result => {
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.equal(result.report.builtinEffects.blockedBuiltins.includes('String'), false);
};
const deleted = [{expected: {error: 'TypeError'}}];

for (const [label, mutation] of [
  ['destructuring declaration', 'const {deleteProperty:remove}=Reflect;remove(String,"fromCharCode");'],
  ['destructuring assignment', 'let remove;({deleteProperty:remove}=Reflect);remove(String,"fromCharCode");'],
  ['computed literal destructuring key', 'const {["deleteProperty"]:remove}=Reflect;remove(String,"fromCharCode");'],
  ['destructuring through interface and target aliases', 'const R=Reflect,Q=R,S=String,T=S;const {deleteProperty:remove}=Q;remove(T,"fromCharCode");']
]) {
  test(`Reflect.deleteProperty ${label} preserves the later TypeError`, () => {
    const result = checkBehavior(`${mutation}return String.fromCharCode(65);`, deleted);
    assertMemberBlocked(result);
    assert.ok(result.report.builtinEffects.methodAliases.some(alias =>
      alias.name === 'remove' && alias.possibleMethods.includes('Reflect.deleteProperty')));
  });
}

test('destructuring from a mutable interface preserves builtin and local branches', () => {
  const source = 'let R=Reflect;if(useLocal)R={deleteProperty(){return false;}};const {deleteProperty:remove}=R;remove(String,"fromCharCode");return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {useLocal: false}, expected: {error: 'TypeError'}},
    {globals: {useLocal: true}, expected: {value: 'A'}}
  ]);
  assertMemberBlocked(result);
});

test('Reflect.deleteProperty.call uses the first argument after thisArg as target', () => {
  const source = 'Reflect.deleteProperty.call(null,String,"fromCharCode");return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('a destructured method invoked through call preserves deletion', () => {
  const source = 'const {deleteProperty:remove}=Reflect;remove.call(Reflect,String,"fromCharCode");return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('Reflect.deleteProperty.apply expands a literal argument array', () => {
  const source = 'Reflect.deleteProperty.apply(null,[String,"fromCharCode"]);return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('method apply through a const argument array alias protects deletion', () => {
  const source = 'const remove=Reflect.deleteProperty;const args=[String,"fromCharCode"],inputs=args;remove.apply(null,inputs);return String.fromCharCode(65);';
  const result = checkBehavior(source, deleted);
  const effects = result.report.builtinEffects;
  assert.ok(effects.blockedMembers.includes('String.fromCharCode') || effects.blockedBuiltins.includes('String'),
    'the member or its whole builtin must be protected');
});

test('apply with a reassigned argument array preserves both supplied-key branches', () => {
  const source = 'let args=[String,"absent"];if(doDelete)args=[String,key];Reflect.deleteProperty.apply(null,args);return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {doDelete: true, key: 'fromCharCode'}, expected: {error: 'TypeError'}},
    {globals: {doDelete: false, key: 'fromCharCode'}, expected: {value: 'A'}}
  ]);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
});

test('apply does not trust const array elements after mutation through an alias', () => {
  const source = 'const args=[String,"absent"],inputs=args;inputs[1]=key;Reflect.deleteProperty.apply(null,args);return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {key: 'fromCharCode'}, expected: {error: 'TypeError'}},
    {globals: {key: 'absent'}, expected: {value: 'A'}}
  ]);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
});

test('apply with an unknown global argument array protects possible builtin targets', () => {
  const source = 'const remove=Reflect.deleteProperty;remove.apply(null,args);return String.fromCharCode(65);';
  // Build args inside each context so its target is that context's own builtin.
  const setup = 'globalThis.args=[useNumber?Number:String,key];';
  const result = checkBehavior(source, [
    {globals: {useNumber: false, key: 'fromCharCode'}, setup, expected: {error: 'TypeError'}},
    {globals: {useNumber: true, key: 'fromCharCode'}, setup, expected: {value: 'A'}},
    {globals: {useNumber: false, key: 'absent'}, setup, expected: {value: 'A'}}
  ]);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('Number'));
});

test('bind with only thisArg tracks the later invocation arguments', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null);remove(String,"fromCharCode");return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('bind with a partial target tracks the key supplied at invocation', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String);remove("fromCharCode");return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('bind with both target and literal key preserves a zero-argument deletion', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String,"fromCharCode");remove();return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('bind captures an unknown key and protects the whole possible target', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String,key);remove();return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {key: 'fromCharCode'}, expected: {error: 'TypeError'}},
    {globals: {key: 'absent'}, expected: {value: 'A'}}
  ]);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
});

test('chained bind appends arguments and retains the original bound thisArg', () => {
  const source = 'const base=Reflect.deleteProperty.bind(null),target=base.bind(Reflect,String),remove=target.bind({},"fromCharCode");remove();return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('a bound method invoked through call keeps its captured target', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String);remove.call(Number,"fromCharCode");return String.fromCharCode(65);';
  const result = checkBehavior(source, deleted);
  assertMemberBlocked(result);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'), false);
});

test('a bound method invoked through apply prepends its captured arguments', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String);const args=["fromCharCode"];remove.apply(null,args);return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('a mutable method alias invoked through call preserves delete and set branches', () => {
  const source = 'let change=Reflect.deleteProperty;if(useSet)change=Reflect.set;change.call(null,String,"fromCharCode",()=>"changed");return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {useSet: false}, expected: {error: 'TypeError'}},
    {globals: {useSet: true}, expected: {value: 'changed'}}
  ]);
  assertMemberBlocked(result);
  assert.deepEqual(result.report.builtinEffects.methodAliases.find(alias => alias.name === 'change').possibleMethods,
    ['Reflect.deleteProperty', 'Reflect.set']);
});

test('a mutable bound alias retains both captured builtin targets', () => {
  const source = 'let remove=Reflect.deleteProperty.bind(null,String);if(useNumber)remove=Reflect.deleteProperty.bind(null,Number);const run=remove;run("fromCharCode");return String.fromCharCode(65);';
  const result = checkBehavior(source, [
    {globals: {useNumber: false}, expected: {error: 'TypeError'}},
    {globals: {useNumber: true}, expected: {value: 'A'}}
  ]);
  assertMemberBlocked(result);
  assertMemberBlocked(result, 'Number.fromCharCode');
});

test('a bound target is resolved in its creation scope despite call-site shadowing', () => {
  const source = 'const target=String;const remove=Reflect.deleteProperty.bind(null,target);function run(){const target={};return remove("fromCharCode");}run();return String.fromCharCode(65);';
  assertMemberBlocked(checkBehavior(source, deleted));
});

test('apply preserves successful deletion and its true return value', () => {
  const source = 'const remove=Reflect.deleteProperty;const success=remove.apply(null,[String,"fromCharCode"]);return [success,typeof String.fromCharCode];';
  const result = checkBehavior(source, [{expected: {value: [true, 'undefined']}}]);
  assertMemberBlocked(result);
});

test('call preserves a failed deletion from a frozen target', () => {
  const source = 'Object.freeze(String);const success=Reflect.deleteProperty.call(null,String,"fromCharCode");return [success,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [false, 'A']}}]);
  assertMemberBlocked(result);
});

test('bind preserves false for a non-configurable member in strict mode', () => {
  const source = '"use strict";Object.defineProperty(String,"fromCharCode",{configurable:false});const remove=Reflect.deleteProperty.bind(null,String,"fromCharCode");return [remove(),String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [false, 'A']}}]);
  assertMemberBlocked(result);
});

test('deleteProperty.call evaluates thisArg and extra parameters without a receiver write', () => {
  const source = 'const order=[];const success=Reflect.deleteProperty.call((order.push("this"),String),(order.push("target"),{}),(order.push("key"),"fromCharCode"),(order.push("extra"),String));return [success,order,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, ['this', 'target', 'key', 'extra'], 'A']}}]);
  assertStringUnblocked(result);
});

test('deleteProperty.apply evaluates extra array elements without a receiver write', () => {
  const source = 'let n=0;const success=Reflect.deleteProperty.apply(null,[{},"fromCharCode",(n++,String)]);return [success,n,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, 1, 'A']}}]);
  assertStringUnblocked(result);
});

test('bind evaluates captured extras once and invocation extras in order', () => {
  const source = 'const order=[];const remove=Reflect.deleteProperty.bind((order.push("this"),null),{},"fromCharCode",(order.push("bound"),String));order.push("between");const success=remove((order.push("call"),Number));return [success,order,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, ['this', 'bound', 'between', 'call'], 'A']}}]);
  assertStringUnblocked(result);
  assert.equal(result.report.builtinEffects.blockedBuiltins.includes('Number'), false);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'), false);
});

test('Reflect.set.call protects the explicit receiver rather than thisArg', () => {
  const source = 'const success=Reflect.set.call(Number,{},"fromCharCode",()=>"changed",String);return [success,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, 'changed']}}]);
  assertMemberBlocked(result);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'), false);
});

test('Reflect.set.apply protects its explicit receiver from a const argument array', () => {
  const source = 'const {set:change}=Reflect;const args=[{},"fromCharCode",()=>"changed",String];const success=change.apply(null,args);return [success,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, 'changed']}}]);
  assertMemberBlocked(result);
});

test('Reflect.set.bind combines captured target and key with the supplied receiver', () => {
  const source = 'const change=Reflect.set.bind(null,{},"fromCharCode");const success=change(()=>"changed",String);return [success,String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [true, 'changed']}}]);
  assertMemberBlocked(result);
});

test('creating an uninvoked deletion binding does not mutate or block String.fromCharCode', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,String,"fromCharCode");return String.fromCharCode(65);';
  const result = checkBehavior(source, [{expected: {value: 'A'}}]);
  assertStringUnblocked(result);
});

test('a shadowed local Reflect destructured and bound method causes no builtin protection', () => {
  const source = 'const Reflect={deleteProperty(){return false;}};const {deleteProperty:remove}=Reflect;const bound=remove.bind(null,String,"fromCharCode");return [bound(),String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [false, 'A']}}]);
  assertStringUnblocked(result);
  assert.equal(result.report.builtinEffects.methodAliases.some(alias => alias.name === 'remove'), false);
});

test('an unrelated local function using call apply and bind causes no builtin protection', () => {
  const source = 'function remove(target,key){return false;}const a=remove.call(null,String,"fromCharCode"),b=remove.apply(null,[String,"fromCharCode"]),bound=remove.bind(null,String,"fromCharCode");return [a,b,bound(),String.fromCharCode(65)];';
  const result = checkBehavior(source, [{expected: {value: [false, false, false, 'A']}}]);
  assertStringUnblocked(result);
});
