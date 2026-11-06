import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '@babel/parser';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {canonicalizeFactory} from '../src/recompile-oracle.mjs';

// javascript-obfuscator's `simplify` option and proxy-object transform produce the shapes below.
// Each test pins one inverse transform AND the semantics it must preserve (evaluation order, short-circuit).

const run = source => deobfuscate(source).code;
const canon = source => canonicalizeFactory(source);
const equivalent = (obfuscated, plain, message) => assert.equal(canon(run(obfuscated)), canon(plain), message);

test('expression-statement && / || / ?: are restored to if statements', () => {
  equivalent('(function(){a&&b();})', '(function(){if(a){b();}})');
  equivalent('(function(){a||b();})', '(function(){if(!a){b();}})');
  equivalent('(function(){a?b():c();})', '(function(){if(a){b();}else{c();}})');
  equivalent('(function(){a&&(b(),c());})', '(function(){if(a){b();c();}})', 'a sequence on the right becomes statements of the body');
});

test('nested short-circuit statements keep their evaluation structure', () => {
  equivalent('(function(){a&&b&&c();})', '(function(){if(a&&b){c();}})');
  equivalent('(function(){a?(b&&c()):d();})', '(function(){if(a){if(b){c();}}else{d();}})');
});

test('a value-producing && / || is never rewritten', () => {
  const kept = run('(function(){return a&&b();})');
  assert.match(kept, /return a && b\(\)/, 'return uses the value, so it must stay an expression');
  const assigned = run('(function(){x=a||b();})');
  assert.match(assigned, /x = a \|\| b\(\)/);
});

test('return with a sequence expression hoists only the leading operands', () => {
  equivalent('(function(){return a(),b(),"v";})', '(function(){a();b();return "v";})');
  // The value that is returned is the LAST operand; reordering would change it.
  assert.notEqual(canon(run('(function(){return a(),"v";})')), canon('(function(){return "v";})'), 'the leading call must still happen');
});

test('a double negation in a condition stays as written (it is not a no-op in a value position)', () => {
  const out = run('(function(){return !!a;})');
  assert.match(out, /!!a/);
});

test('proxy object functions with logical, binary and call bodies are inlined to a fixed point', () => {
  const source = `(function(){
    const p={k1:function(a,b){return a||b;},k2:function(a,b){return a+b;},k3:function(f,x){return f(x);},k4:function(a,b){return a*b;}};
    return p.k4(p.k2(x,1),p.k1(y,0))+p.k3(g,z);
  })`;
  const out = run(source);
  assert.doesNotMatch(out, /\bp\.k\d/, 'every proxy member must be gone');
  assert.equal(canon(out), canon('(function(){return (x+1)*(y||0)+g(z);})'));
});

test('proxy inlining keeps argument evaluation order and count', () => {
  const out = run('(function(){const p={k:function(a,b){return a+b;}};return p.k(f(),g());})');
  assert.equal(canon(out), canon('(function(){return f()+g();})'));
});

test('an object that escapes is left alone', () => {
  const out = run('(function(){const p={k:function(a,b){return a+b;}};use(p);return p.k(1,2);})');
  assert.match(out, /use\(p\)/);
  assert.match(out, /p\.k|\bk\b/, 'the proxy must survive when it can be observed elsewhere');
});

test('procedure parameters are restored to the compiler positional names p0..pn', () => {
  const source = '(function(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();return function*(_0x1a,_0x2b,_0x3c){return _0x1a+_0x2b+_0x3c;};})';
  const out = run(source);
  assert.match(out, /function\*?\s*\w*\(p0, p1, p2\)/);
  assert.match(out, /p0 \+ p1 \+ p2/);
});

test('parameter renaming does not collide with an existing binding named p0', () => {
  const source = '(function(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const p0=stage.variables["id"];return function*(_0x1a){return p0.value+_0x1a;};})';
  const out = run(source);
  // p0 is already a binding in scope, so the parameter must keep a non-colliding name; both stay distinguishable.
  assert.match(out, /p0\.value/);
  assert.doesNotMatch(out, /function\*?\s*\w*\(p0\)/);
});

test('statements that are only a literal are removed, directives and anything with an effect are not', () => {
  // Static evaluation folds `if (false) {...}` / `false && (...)` down to a bare `false;`; the compiler never writes one.
  equivalent('(function(){false;0;"x";null;foo();})', '(function(){foo();})');
  equivalent('(function(){if(a){false;b();}else{1;}})', '(function(){if(a){b();}else{}})');
  const withDirective = run('(function(){"use strict";false;foo();})');
  assert.match(withDirective, /"use strict"/, 'a directive is not an expression statement');
  assert.match(withDirective, /foo\(\)/);
  assert.doesNotMatch(withDirective, /false/);
  // An identifier, a call, an assignment and a template literal can all have an effect or throw.
  const kept = run('(function(){a;b();c=1;`t${d()}`;})');
  for (const part of ['a;', 'b()', 'c = 1', 'd()']) assert.ok(kept.includes(part), `${part} must survive: ${kept}`);
  // Only statements in a block or program body are touched: an `if` consequent keeps its (unbraced) statement.
  assert.doesNotThrow(() => run('(function(){if(a)0;foo();})'));
});

test('a chain of || or && keeps the nesting it was written with', () => {
  // Babel treats || and && as associative and prints a || (b || c) as a || b || c. The two evaluate alike, but the
  // text then reads back as (a || b) || c, and the nesting is what the compiler wrote and recovery turns into blocks.
  const rightNested = run('(function(){return a||(b||c);})');
  assert.match(rightNested, /a \|\| \(b \|\| c\)/);
  assert.match(run('(function(){return a&&(b&&c);})'), /a && \(b && c\)/);
  assert.match(run('(function(){return a??(b??c);})'), /a \?\? \(b \?\? c\)/);
  // Left nesting is what the plain printer already writes, so it carries no parentheses.
  const leftNested = run('(function(){return (a||b)||c;})');
  assert.match(leftNested, /a \|\| b \|\| c/);
  assert.doesNotMatch(leftNested, /\(a \|\| b\)/);
  // Other mixes need no help: && binds tighter than ||, and a different operator is parenthesized as needed.
  assert.match(run('(function(){return a||(b&&c);})'), /a \|\| b && c/);
  assert.match(run('(function(){return a&&(b||c);})'), /a && \(b \|\| c\)/);
  // What matters is the tree the text parses back to: the output of each reads back with its own nesting.
  const nesting = code => {
    const logical = parse(code, {sourceType: 'script'}).program.body[0].expression.body.body[0].argument;
    return logical.left.type === 'LogicalExpression' ? 'left' : logical.right.type === 'LogicalExpression' ? 'right' : 'none';
  };
  assert.equal(nesting(rightNested), 'right');
  assert.equal(nesting(leftNested), 'left');
});

test('printing parentheses are never left in the tree the passes work on', () => {
  // The parentheses exist only while printing; a later round must see a plain LogicalExpression again, so a
  // second pass over already deobfuscated output has to reach the same text.
  const once = run('(function(){if(a||(b||(c||d))){x();}})');
  assert.equal(run(once), once);
  assert.match(once, /a \|\| \(b \|\| \(c \|\| d\)\)/);
  // The structure pass runs after the printer has been used on the same tree in the round before. It still has to
  // see the inner && as a logical expression to turn `a && (b && c())` into nested ifs.
  equivalent('(function(){a&&(b&&c());})', '(function(){if(a){if(b){c();}}})');
  equivalent('(function(){a||(b||c());})', '(function(){if(!a){if(!b){c();}}})');
});
