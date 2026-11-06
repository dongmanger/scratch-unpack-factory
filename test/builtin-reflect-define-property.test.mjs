import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

const execute = (code, globals = {}) =>
  vm.runInNewContext(`(()=>{${code}})()`, globals, {timeout: 200});
const json = value => JSON.parse(JSON.stringify(value));

for (const [label, mutation] of [
  ['直接Reflect.defineProperty', 'Reflect.defineProperty(String,"fromCharCode",{value:()=>"changed"});'],
  ['计算属性接口', 'Reflect["defineProperty"](String,"fromCharCode",{value:()=>"changed"});'],
  ['接口及目标多级别名', 'const R=Reflect,Q=R,S=String,T=S;Q.defineProperty(T,"fromCharCode",{value:()=>"changed"});'],
  ['可变赋值别名', 'let R,S;R=Reflect;S=String;R.defineProperty(S,"fromCharCode",{value:()=>"changed"});'],
  ['getter描述符', 'Reflect.defineProperty(String,"fromCharCode",{get:()=>()=>"changed"});']
]) {
  test(`${label}原代码和解混淆代码均返回changed`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('Reflect.defineProperty未知键保护整个可能目标', () => {
  const source = 'Reflect.defineProperty(String,key,{value:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.equal(execute(source, {key: 'fromCharCode'}), 'changed');
  assert.equal(execute(result.code, {key: 'fromCharCode'}), 'changed');
});

test('Reflect.defineProperty多来源目标的每个可能成员均受保护', () => {
  const source = 'let S=String;if(useNumber)S=Number;Reflect.defineProperty(S,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? 'A' : 'changed';
    assert.equal(execute(source, {useNumber}), expected);
    assert.equal(execute(result.code, {useNumber}), expected);
  }
});

test('Reflect.defineProperty成功布尔结果与成员调用都保持', () => {
  const source = 'const success=Reflect.defineProperty(String,"fromCharCode",{value:()=>"changed"});return [success,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(json(execute(source)), [true, 'changed']);
  assert.deepEqual(json(execute(result.code)), [true, 'changed']);
});

test('Reflect.defineProperty失败不假定写入成功，false和原方法语义保持', () => {
  const source = 'Object.freeze(String);const success=Reflect.defineProperty(String,"fromCharCode",{value:()=>"changed"});return [success,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(json(execute(source)), [false, 'A']);
  assert.deepEqual(json(execute(result.code)), [false, 'A']);
});

test('Reflect.defineProperty非法描述符的TypeError保持不变', () => {
  const source = 'Reflect.defineProperty(String,"fromCharCode",null);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  const observe = code => {
    try { return {value: execute(code)}; }
    catch (error) { return {error: error.name}; }
  };
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('Reflect.defineProperty无receiver，额外参数不误当成员写入目标', () => {
  const source = 'Reflect.defineProperty({},"fromCharCode",{value:()=>"changed"},String);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.equal(execute(source), 'A');
  assert.equal(execute(result.code), 'A');
});

test('本地Reflect遮蔽及普通局部对象不误认为内置成员修改', () => {
  for (const source of [
    'const Reflect={defineProperty(){return false;}};Reflect.defineProperty(String,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);',
    'const S={};Reflect.defineProperty(S,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
    assert.equal(execute(source), 'A');
    assert.equal(execute(result.code), 'A');
  }
});
