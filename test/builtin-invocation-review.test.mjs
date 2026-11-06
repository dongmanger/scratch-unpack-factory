import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import JavaScriptObfuscator from 'javascript-obfuscator';
import {OFFICIAL_02_PRESETS} from './obfuscation-corpus.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

const observe = (code, globals = {}, expression = false) => {
  const context = vm.createContext({...globals}, {codeGeneration: {strings: false, wasm: false}});
  try {
    const value = new vm.Script(expression ? code : `(()=>{${code}})()`).runInContext(context, {timeout: 1000});
    return {value};
  } catch (error) { return {error: error.name}; }
};

for (const [label, source] of [
  ['逗号表达式解构来源', 'const {deleteProperty:remove}=(0,Reflect);remove(String,"fromCharCode");return String.fromCharCode(65);'],
  ['条件表达式解构来源', 'const {deleteProperty:remove}=true?Reflect:{};remove(String,"fromCharCode");return String.fromCharCode(65);'],
  ['call的thisArg前展开', 'Reflect.deleteProperty.call(...[null,String,"fromCharCode"]);return String.fromCharCode(65);'],
  ['bind的thisArg前展开', 'const remove=Reflect.deleteProperty.bind(...[null,String,"fromCharCode"]);remove();return String.fromCharCode(65);'],
  ['apply的thisArg前展开', 'Reflect.deleteProperty.apply(...[null,[String,"fromCharCode"]],[Number,"fromCharCode"]);return String.fromCharCode(65);'],
  ['可变目标条件赋值', 'let target=Number;target=true?String:Number;Reflect.deleteProperty.call(null,target,"fromCharCode");return String.fromCharCode(65);'],
  ['可变目标未知调用赋值', 'let target=Number;function select(){return String;}target=select();Reflect.deleteProperty.call(null,target,"fromCharCode");return String.fromCharCode(65);'],
  ['数组展开的自定义iterator', 'Array.prototype[Symbol.iterator]=function*(){yield String;yield "fromCharCode";};Reflect.deleteProperty.apply(null,[...[{},"absent"]]);return String.fromCharCode(65);']
]) {
  test(`${label}原代码与解混淆代码均抛出TypeError`, () => {
    const result = deobfuscate(source);
    assert.deepEqual(observe(source), {error: 'TypeError'});
    assert.deepEqual(observe(result.code), {error: 'TypeError'});
    assert.equal(result.report.executesInput, false);
  });
}

test('Reflect.set显式receiver经条件赋值仍保护String，两条分支结果保持', () => {
  const source = 'let receiver=Number;receiver=useString?String:Number;Reflect.set.call(null,{},"fromCharCode",()=>"changed",receiver);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  for (const useString of [false, true]) {
    const expected = {value: useString ? 'changed' : 'A'};
    assert.deepEqual(observe(source, {useString}), expected);
    assert.deepEqual(observe(result.code, {useString}), expected);
  }
});

for (const [level, preset] of Object.entries(OFFICIAL_02_PRESETS)) {
  test(`真实${level}混淆的编码方法及bind前后均保持TypeError`, () => {
    const original = '(function(){const remove=Reflect.deleteProperty.bind(null,String,"fromCharCode");remove();return String.fromCharCode(65);})()';
    const source = JavaScriptObfuscator.obfuscate(original, {...preset, seed: 12345}).getObfuscatedCode();
    const result = deobfuscate(source);
    assert.deepEqual(observe(original, {}, true), {error: 'TypeError'});
    assert.deepEqual(observe(source, {}, true), {error: 'TypeError'});
    assert.deepEqual(observe(result.code, {}, true), {error: 'TypeError'});
    assert.equal(result.report.executesInput, false);
    assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
    assert.equal(result.report.status, 'transformed');
    assert.notEqual(result.code, source);
    assert.deepEqual(result.report.residuals, []);
    assert.match(result.code, /Reflect\.deleteProperty\.bind/);
  });
}
