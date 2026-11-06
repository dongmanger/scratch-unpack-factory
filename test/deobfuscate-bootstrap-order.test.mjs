import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import JavaScriptObfuscator from 'javascript-obfuscator';
import {OFFICIAL_02_PRESETS} from './obfuscation-corpus.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

// Execute only test-owned fixtures in a fresh, timed realm. The deobfuscator
// itself must never execute the input, including the hostile prefixes below.
const observe = source => {
  const context = vm.createContext({}, {codeGeneration: {strings: false, wasm: false}});
  try {return {value: new vm.Script(source).runInContext(context, {timeout: 1000})};}
  catch (error) {return {error: error.name};}
};
const scramble = (source, level) => {
  const preset = OFFICIAL_02_PRESETS[level];
  return JavaScriptObfuscator.obfuscate(source, {...preset,
    stringArrayEncoding: [...preset.stringArrayEncoding],
    stringArrayIndexesType: [...preset.stringArrayIndexesType], seed: 12345}).getObfuscatedCode();
};
const assertDecoded = result => {
  assert.equal(result.report.executesInput, false);
  assert.equal(result.report.behaviorEquivalenceVerified, false);
  assert.equal(result.report.status, 'transformed', JSON.stringify(result.report));
  assert.deepEqual(result.report.residuals, []);
  assert.ok(result.report.transforms.some(pass => pass.pass === 'string-array-rotation' &&
    pass.proof === 'generated-top-level-bootstrap-prefix'));
  assert.ok(result.report.transforms.some(pass => pass.pass === 'unused-decoder-component-removal'));
  assert.ok(!/parseInt|while\s*\(|eval\s*\(|abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(result.code), result.code);
};

for (const level of Object.keys(OFFICIAL_02_PRESETS)) {
  for (const [kind, mutation] of [
    ['bound deletion', 'const remove=Reflect.deleteProperty.bind(null,String,"fromCharCode");remove();'],
    ['direct deletion', 'Reflect.deleteProperty(String,"fromCharCode");'],
    ['direct write', 'String.fromCharCode=65;']
  ]) {
    test(`real ${level} seed12345 bootstrap before later ${kind}`, () => {
      const original = `(function(){${mutation}return String.fromCharCode(65);})()`;
      const source = scramble(original, level);
      for (const shell of [source, `eval(${JSON.stringify(source)})`]) {
        const result = deobfuscate(shell);
        const expected = {error: 'TypeError'};
        assert.deepEqual(observe(original), expected);
        assert.deepEqual(observe(source), expected);
        assert.deepEqual(observe(result.code), expected);
        assertDecoded(result);
        assert.ok(result.code.includes('String.fromCharCode'), result.code);
        assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String') ||
          result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
        if (kind === 'bound deletion') {
          assert.ok(result.code.includes('Reflect.deleteProperty.bind'), result.code);
          assert.ok(result.report.builtinEffects.methodAliases.some(alias =>
            alias.possibleMethods.includes('Reflect.deleteProperty')));
        }
      }
    });
  }
}

// The simple generated plain-table form makes negative proof-boundary fixtures
// independent of a particular obfuscator identifier seed or source formatting.
const provider = 'function table(){const a=["2","1","deleteProperty","fromCharCode"];table=function(){return a;};return table();}';
const decoder = 'function decode(i,k){const a=table();return decode=function(j,k){j=j-0x10;let s=a[j];return s;},decode(i,k);}';
const rotor = '(function(p,n){const a=p();while(!![]){try{const sum=parseInt(decode(0x10));if(sum===n)break;else a["push"](a["shift"]());}catch(e){a["push"](a["shift"]());}}}(table,2))';
const business = '(function(){const remove=Reflect[decode(0x12)].bind(null,String,decode(0x13));remove();return String.fromCharCode(65);})()';
const generated = `${provider}${decoder}${rotor},${business};`;
const assertRetained = source => {
  const result = deobfuscate(source);
  assert.equal(result.code, source);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.executesInput, false);
  assert.deepEqual(result.report.transforms, []);
  assert.ok(result.report.residuals.some(item => item.type === 'string-array-rotation-unresolved'));
  return result;
};

test('hoisted generated declarations and literal-only preceding declarations are safe prefix facts', () => {
  for (const source of [generated,
    `const literals={name:"safe",numbers:[1,-2,3+4]};${generated}`,
    `${rotor},${business};${provider}${decoder}`]) {
    const result = deobfuscate(source);
    assertDecoded(result);
    assert.deepEqual(observe(source), {error: 'TypeError'});
    assert.deepEqual(observe(result.code), {error: 'TypeError'});
  }
});

for (const [label, prefix] of [
  ['direct builtin write', 'parseInt=()=>2;'],
  ['member write', 'String.fromCharCode=()=>"changed";'],
  ['unrelated global write', 'globalThis.bootstrapMarker=1;'],
  ['unknown earlier call', 'unknownBootstrap();'],
  ['earlier call through declaration', 'function mutate(){parseInt=()=>2;}mutate();'],
  ['object getter read', 'const o={get key(){parseInt=()=>2;return 1;}};o.key;'],
  ['object getter declaration', 'const o={get key(){return 1;}};'],
  ['object spread', 'const o={...unknown};'],
  ['computed object key', 'const o={[unknown]:1};'],
  ['ordinary object method', 'const o={method(){return 1;}};'],
  ['unrelated prior function declaration', 'function unrelated(){return 1;}'],
  ['nonliteral declaration', 'const previous=unknown;']
]) {
  test(`unproved preceding ${label} retains exact input`, () => {
    assertRetained(`${prefix}${generated}`);
  });
}

test('earlier call/write inside the rotor sequence is part of the execution prefix', () => {
  for (const earlier of ['unknownBootstrap()', 'parseInt=()=>2', 'globalThis.marker=1']) {
    assertRetained(`${provider}${decoder}(${earlier},${rotor},${business});`);
  }
});

test('nested rotor and injected rotor side effects are outside the generated proof boundary', () => {
  assertRetained(`(function(){${generated}})();`);
  assertRetained(generated.replace('const a=p();while', 'const a=p();unknownBootstrap();while'));
  assertRetained(generated.replace('const sum=parseInt(decode(0x10));', 'const sum=parseInt(decode(0x10));unknownBootstrap();'));
  assertRetained(generated.replace('else a["push"]', 'else other["push"]'));
  assertRetained(generated.replace('}(table,2))', '}(table,unknownTarget()))'));
  assertRetained(generated.replace('}(table,2))', '}(table,(unknownTarget(),2)))'));
});

test('hoisted builtin shadows and declarations initialized after the rotor cannot become host defaults', () => {
  assertRetained(`${generated}function parseInt(){globalThis.shadowWasCalled=true;return 2;}`);
  assertRetained(`${generated}const parseInt=()=>2;`);
  assertRetained(`${generated}var parseInt;`);
});

test('unsafe earlier calls and getters are not executed by bootstrap analysis', () => {
  delete globalThis.__bootstrap_must_not_execute;
  try {
    assertRetained(`(()=>{globalThis.__bootstrap_must_not_execute=true;throw new Error("executed");})();${generated}`);
    assertRetained(`const o={get x(){globalThis.__bootstrap_must_not_execute=true;return 1;}};o.x;${generated}`);
    assert.equal(globalThis.__bootstrap_must_not_execute, undefined);
  } finally {delete globalThis.__bootstrap_must_not_execute;}
});

test('unresolved order preserves source text and low budgets do not acquire a new checksum allowance', () => {
  assertRetained(generated.replace('}(table,2))', '}(table,999))'));
  const result = deobfuscate(generated, {maxSteps: 5});
  assert.equal(result.code, generated);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.staticEvaluationSteps, 6, JSON.stringify(result.report));
});

test('older actual packager direct table readers rotate and decode without arbitrary return execution', () => {
  const source = `${provider}function direct(i,k){i=i-1;const values=table();let item=values[i];return item;}(function(p,n){const values=p();while(!![]){try{const sum=parseInt(direct(1));if(sum===n)break;else values.push(values.shift());}catch(e){values.push(values.shift());}}}(table,2)),(function(){const remove=Reflect[direct(3)].bind(null,String,direct(4));remove();return String.fromCharCode(65);})()`;
  const result = deobfuscate(source);
  assertDecoded(result);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
  assert.ok(result.report.transforms.some(pass => pass.pass === 'decoder-discovery' && pass.encoding === 'plain'));
  assert.ok(result.report.transforms.some(pass => pass.pass === 'string-array-rotation'));
  assert.ok(result.code.includes('Reflect.deleteProperty.bind'), result.code);
  assert.ok(!result.code.includes('function direct'), result.code);
});

test('direct decoder lookalikes with extra calls or non-item returns remain unresolved', () => {
  for (const bad of [
    'function direct(i,k){i=i-1;const values=table();let item=values[i];unknownBootstrap();return item;}',
    'function direct(i,k){i=i-1;const values=table();let item=values[i];return item.toString();}',
    'function direct(i,k){i=i-1;const values=table();let item=values[i];return values[i];}'
  ]) {
    const source = `${provider}${bad}${rotor},(function(){const remove=Reflect[direct(2)].bind(null,String,direct(3));remove();return String.fromCharCode(65);})()`;
    const result = deobfuscate(source);
    assert.equal(result.code, source, bad);
    assert.equal(result.report.status, 'partial', bad);
    assert.ok(result.report.residuals.some(item => item.type === 'string-array-rotation-unresolved'), bad);
    assert.equal(result.report.executesInput, false);
  }
});

test('actual 02 packager recursive fixtures decode every HTML/ZIP factory for recovery', async () => {
  for (const level of ['none', 'light', 'balanced', 'strong']) for (const format of ['html', 'zip']) {
    const id = `recursive-${level}-${format}`;
    const bundle = JSON.parse(await fs.readFile(new URL(`../fixtures/real-02-v1/compiled/${id}.json`, import.meta.url), 'utf8'));
    const decoded = structuredClone(bundle);
    for (const target of Object.values(decoded.compiledTargets)) for (const script of Object.values(target.scripts)) {
      const result = deobfuscate(script.factorySource);
      assert.equal(result.report.status, 'transformed', `${id}: ${JSON.stringify(result.report)}`);
      assert.deepEqual(result.report.residuals, [], id);
      assert.equal(result.report.executesInput, false, id);
      script.factorySource = result.code;
    }
    const project = structuredClone(decoded.targets);
    const recovery = recoverCompiledCode({targets: project}, decoded);
    assert.equal(recovery.scripts.length, 2, `${id}: ${JSON.stringify(recovery)}`);
    assert.equal(recovery.unresolved.length, level === 'none' ? 0 : recovery.unresolved.length,
      `${id}: factory decoding succeeded; recovery detail=${JSON.stringify(recovery.unresolved)}`);
  }
});

test('decoded method aliases refresh protections before a previously literal business builtin call', () => {
  // Object's decoded mutation API was not a method-alias seed in the original
  // expression. A literal fromCharCode call must wait for that key to be exposed.
  const source = `${provider}${decoder}${rotor};(function(){const change=Object[decode(0x12)];change(String,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);})()`
    .replace('"deleteProperty"', '"defineProperty"');
  const result = deobfuscate(source);
  assertDecoded(result);
  assert.deepEqual(observe(source), {value: 'changed'});
  assert.deepEqual(observe(result.code), {value: 'changed'});
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.methodAliases.some(alias => alias.name === 'change' &&
    alias.possibleMethods.includes('Object.defineProperty')));
});

test('proxy-expanded computed method aliases refresh effects while original scope reports remain protected', () => {
  const source = 'const R=Reflect;const keys={method:"deleteProperty",member:"fromCharCode"};const remove=R[keys.method];remove(String,keys.member);(function(){const remove=Object.defineProperty;remove(Number,"extra",{value:1});})();String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'), 'original broad protection must survive refresh');
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  const aliases = result.report.builtinEffects.methodAliases.filter(alias => alias.name === 'remove');
  assert.equal(aliases.length, 2, 'same name in two scopes stays separate by declarationStart');
  assert.equal(new Set(aliases.map(alias => alias.declarationStart)).size, 2);
  assert.ok(aliases.some(alias => alias.possibleMethods.includes('Reflect.deleteProperty')));
  assert.ok(aliases.some(alias => alias.possibleMethods.includes('Object.defineProperty')));
});
