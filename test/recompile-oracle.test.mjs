import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizeFactory, comparableFactory, factoryDigest} from '../src/recompile-oracle.mjs';

const same = (a, b, message) => assert.equal(comparableFactory(a), comparableFactory(b), message);
const differ = (a, b, message) => assert.notEqual(comparableFactory(a), comparableFactory(b), message);

// The oracle accepts a recovery only when the compiler's output equals the shipped factory under this
// canonical form. Equalities must therefore be real program equivalences, and the inequalities below
// are as important as the equalities: a canonicalizer that is too generous would accept wrong recoveries.

test('identifier names do not matter, but the binding structure does', () => {
  same('(function a(t){const x=t.target;return function(){x.size=1;};})', '(function q(z){const w=z.target;return function(){w.size=1;};})');
  // Two distinct variables must not be confused with one.
  differ('(function(){const a=1,b=2;return a+b;})', '(function(){const a=1,b=2;return a+a;})');
  differ('(function(t){return t.x;})', '(function(t){return t.y;})', 'property names are structure, not bindings');
});

test('canonical renaming never captures a free identifier', () => {
  // The canonical form renames bound identifiers to x0, x1, ... A rename that lands on a name the factory
  // reads as a free variable makes two different programs compare equal. Both directions matter: the
  // free name must stay distinguishable from a renamed binding, and two different free names must stay
  // different from each other.
  differ('(function f(a){return a + x0;})', '(function f(a){return a + f;})', 'free x0 must not collide with the renamed factory');
  differ('(function(){const q=1;return q + __c0;})', '(function(){const q=1;return q + x0;})', 'free __c0 must keep its name');
  differ('(function(){const q=1;return q + __c0;})', '(function(){const q=1;return q + __c1;})');
  // The same program with different binding names still has to compare equal, including when a free
  // identifier occupies the obvious slot for a renamed one.
  same('(function f(a){return a + x0;})', '(function g(b){return b + x0;})');
  same('(function(){const q=1;return q;})', '(function(){const z=1;return z;})');
  // A real factory shape keeps comparing equal against a renamed copy.
  same('(function factory(thread){const target=thread.target;return function* script(){retire();return;};});',
    '(function f(t){const a=t.target;return function* s(){retire();return;};});');
});

test('variable and list IDs inside strings are compared exactly', () => {  differ('(function(t){const v=t.variables["id-1"];})', '(function(t){const v=t.variables["id-2"];})');
  same('(function(t){const v=t.variables["id-1"];})', '(function(t){const v=t.variables[\'id-1\'];})', 'quote style is spelling');
});

test('literal-only arithmetic folds to the same value, other arithmetic does not', () => {
  same('(function(){return a[73-1];})', '(function(){return a[72];})');
  same('(function(){return 1000*3;})', '(function(){return 3000;})');
  same('(function(){return "ABC".toLowerCase();})', '(function(){return "abc";})');
  same('(function(){return "abc".length;})', '(function(){return 3;})');
  differ('(function(){return a[73-1];})', '(function(){return a[73];})');
  differ('(function(){return 2*3;})', '(function(){return 2+3;})');
  // Division/modulo by zero and other non-finite results are left alone rather than folded.
  differ('(function(){return 1/0;})', '(function(){return 1;})');
});

test('constant-condition branches resolve, non-constant ones are kept', () => {
  same('(function(){if(false){a();}b();})', '(function(){b();})');
  same('(function(){if(true){a();}else{b();}})', '(function(){a();})');
  same('(function(){if(1>2){a();}else{b();}})', '(function(){b();})');
  differ('(function(){if(x){a();}b();})', '(function(){b();})', 'a runtime condition must not be dropped');
  differ('(function(){if(x){a();}else{b();}})', '(function(){if(x){b();}else{a();}})', 'swapped arms differ');
});

test('a constant branch that declares a lexical binding is not unwrapped into the enclosing scope', () => {
  // `if (true) { let v = 1; }` followed by a use of an outer `v`: unwrapping would capture that outer name.
  differ('(function(){const v=2;if(true){let v=1;a(v);}b(v);})', '(function(){const v=2;let v2=1;a(v2);b(v);})');
  differ('(function(){if(true){const k=f();}use(k);})', '(function(){const k=f();use(k);})',
    'unwrapping would change which `k` the later use refers to');
  // A branch without declarations still resolves as before.
  same('(function(){if(true){a();}b();})', '(function(){a();b();})');
});

test('short-circuit identities need a literal left operand', () => {
  same('(function(){return true&&f();})', '(function(){return f();})');
  same('(function(){return false||f();})', '(function(){return f();})');
  same('(function(){return false&&f();})', '(function(){return false;})');
  differ('(function(){return x&&f();})', '(function(){return f();})', 'unknown left operand cannot be dropped');
  differ('(function(){return f()&&true;})', '(function(){return f();})', 'only the LEFT literal is a safe identity here');
});

test('braces and statement/expression shapes the obfuscator changes are normalized', () => {
  same('(function(){if(a)b();})', '(function(){if(a){b();}})');
  same('(function(){for(;;)b();})', '(function(){for(;;){b();}})');
  same('(function(){return o["name"];})', '(function(){return o.name;})');
  same('(function(){return {"k":1};})', '(function(){return {k:1};})');
  // Dead code after an unconditional return never runs; a hoisted function declaration does matter.
  same('(function(){a();return;b();})', '(function(){a();return;})');
  differ('(function(){a();return;function f(){}})', '(function(){a();return;})');
});

test('compat-layer block IDs are masked by call shape, regardless of callee name', () => {
  const call = (callee, id) => `(function(){yield* ${callee}({"X":1}, b1, true, false, "${id}", null);})`;
  same(call('executeInCompatibilityLayer', 'abc'), call('executeInCompatibilityLayer', 'zzz'));
  // An obfuscator alias is a binding inside the factory, so it is alpha-renamed; what it was bound to
  // (a free runtime helper) stays visible, so aliases of different helpers are still different.
  const aliased = (helper, id) => `(function(){const _0x1f=${helper};yield* _0x1f({"X":1}, b1, true, false, "${id}", null);})`;
  same(aliased('executeInCompatibilityLayer', 'abc'), aliased('executeInCompatibilityLayer', 'zzz'), 'an aliased callee has the same shape');
  differ(aliased('executeInCompatibilityLayer', 'abc'), aliased('otherHelper', 'abc'), 'aliases of different helpers must not be conflated');
  differ(call('executeInCompatibilityLayer', 'abc'), call('executeInCompatibilityLayer', 'abc').replace('"X":1', '"X":2'),
    'the block inputs themselves are still compared');
  // A string in the same position of a call with a different shape is data, not a block ID.
  differ('(function(){f({"X":1}, b1, true, false, "a", 1);})', '(function(){f({"X":1}, b1, true, false, "b", 1);})');
});

test('comparison is order sensitive for statements', () => {
  differ('(function(){a();b();})', '(function(){b();a();})');
  differ('(function(){a(1);a(2);})', '(function(){a(2);a(1);})');
});

test('digest is stable and distinguishes programs', () => {
  assert.equal(factoryDigest('(function(a){return a;})'), factoryDigest('(function(zz){return zz;})'));
  assert.notEqual(factoryDigest('(function(a){return a;})'), factoryDigest('(function(a){return a+1;})'));
  assert.match(factoryDigest('(function(){})'), /^[0-9a-f]{64}$/);
});

test('canonicalization does not mutate its input and rejects non-JavaScript', () => {
  const source = '(function(a){return a;})';
  canonicalizeFactory(source);
  assert.equal(source, '(function(a){return a;})');
  assert.throws(() => canonicalizeFactory('(function('), /./);
});
