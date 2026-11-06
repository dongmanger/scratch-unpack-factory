import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

const execute = (code, globals = {}) =>
  vm.runInNewContext(`(()=>{${code}})()`, globals, {timeout: 200});
const observe = (code, globals = {}) => {
  try { return {value: JSON.parse(JSON.stringify(execute(code, globals)))}; }
  catch (error) { return {error: error.name}; }
};

for (const [label, mutation] of [
  ['直接Reflect.deleteProperty', 'Reflect.deleteProperty(String,"fromCharCode");'],
  ['计算属性接口', 'Reflect["deleteProperty"](String,"fromCharCode");'],
  ['接口及目标多级别名', 'const R=Reflect,Q=R,S=String,T=S;Q.deleteProperty(T,"fromCharCode");'],
  ['可变赋值别名', 'let R,S;R=Reflect;S=String;R.deleteProperty(S,"fromCharCode");'],
  ['函数先出现、别名后声明', 'function remove(){R.deleteProperty(S,"fromCharCode");}const R=Reflect,S=String;remove();'],
  ['循环别名', 'let S=String,T=S;S=T;const R=Reflect;R.deleteProperty(T,"fromCharCode");']
]) {
  test(`${label}原代码和解混淆代码均抛出TypeError`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.deepEqual(observe(source), {error: 'TypeError'});
    assert.deepEqual(observe(result.code), {error: 'TypeError'});
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('Reflect.deleteProperty未知键保护整个可能目标', () => {
  const source = 'const R=Reflect,S=String;R.deleteProperty(S,key);return String["fromCharCode"](65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source, {key: 'fromCharCode'}), {error: 'TypeError'});
  assert.deepEqual(observe(result.code, {key: 'fromCharCode'}), {error: 'TypeError'});
  assert.deepEqual(observe(source, {key: 'absent'}), {value: 'A'});
  assert.deepEqual(observe(result.code, {key: 'absent'}), {value: 'A'});
});

test('Reflect.deleteProperty多来源目标的每个可能成员均受保护', () => {
  const source = 'let S=String;if(useNumber)S=Number;Reflect.deleteProperty(S,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? {value: 'A'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useNumber}), expected);
    assert.deepEqual(observe(result.code, {useNumber}), expected);
  }
});

test('Reflect.deleteProperty多来源接口仍保护Reflect的可能删除', () => {
  const source = 'let R=Reflect;if(useObject)R=Object;R.deleteProperty(String,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  for (const useObject of [false, true]) {
    assert.deepEqual(observe(source, {useObject}), {error: 'TypeError'});
    assert.deepEqual(observe(result.code, {useObject}), {error: 'TypeError'});
  }
});

test('Reflect.deleteProperty成功布尔结果和成员消失保持不变', () => {
  const source = 'const success=Reflect.deleteProperty(String,"fromCharCode");return [success,typeof String.fromCharCode];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [true, 'undefined']});
  assert.deepEqual(observe(result.code), {value: [true, 'undefined']});
});

test('Reflect.deleteProperty冻结目标删除失败，false和原方法语义保持', () => {
  const source = 'Object.freeze(String);const success=Reflect.deleteProperty(String,"fromCharCode");return [success,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [false, 'A']});
  assert.deepEqual(observe(result.code), {value: [false, 'A']});
});

test('Reflect.deleteProperty不可配置成员删除失败，严格模式仍返回false', () => {
  const source = '"use strict";Object.defineProperty(String,"fromCharCode",{configurable:false});const success=Reflect.deleteProperty(String,"fromCharCode");return [success,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [false, 'A']});
  assert.deepEqual(observe(result.code), {value: [false, 'A']});
});

test('Reflect.deleteProperty非法目标的TypeError保持不变', () => {
  const source = 'Reflect.deleteProperty(null,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('Reflect.deleteProperty无receiver，额外参数仍求值但不误当删除目标', () => {
  const source = 'let n=0;const success=Reflect.deleteProperty({},"fromCharCode",(n++,String));return [success,n,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.deepEqual(observe(source), {value: [true, 1, 'A']});
  assert.deepEqual(observe(result.code), {value: [true, 1, 'A']});
});

test('本地Reflect遮蔽及普通局部对象不误认为内置成员删除', () => {
  for (const source of [
    'const Reflect={deleteProperty(){return false;}};Reflect.deleteProperty(String,"fromCharCode");return String.fromCharCode(65);',
    'const S={fromCharCode:1};Reflect.deleteProperty(S,"fromCharCode");return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
    assert.deepEqual(observe(source), {value: 'A'});
    assert.deepEqual(observe(result.code), {value: 'A'});
  }
});

test('Reflect.deleteProperty数字键只保护对应成员并保持布尔结果', () => {
  const source = 'String[65]="value";const success=Reflect.deleteProperty(String,65);return [success,typeof String[65],String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.65'));
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.deepEqual(observe(source), {value: [true, 'undefined', 'A']});
  assert.deepEqual(observe(result.code), {value: [true, 'undefined', 'A']});
});
