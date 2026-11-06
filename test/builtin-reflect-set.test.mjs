import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

// Execute only test-owned programs in a fresh, time-limited context.
const execute = (code, globals = {}) =>
  vm.runInNewContext(`(()=>{${code}})()`, globals, {timeout: 200});

for (const [label, mutation] of [
  ['直接Reflect.set', 'Reflect.set(String,"fromCharCode",()=>"changed");'],
  ['计算属性接口', 'Reflect["set"](String,"fromCharCode",()=>"changed");'],
  ['接口与目标多级别名', 'const R=Reflect,Q=R,S=String,T=S;Q.set(T,"fromCharCode",()=>"changed");'],
  ['通过赋值建立别名', 'let R,S;R=Reflect;S=String;R.set(S,"fromCharCode",()=>"changed");']
]) {
  test(`${label}修改内置成员前后均返回changed`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('Reflect.set多个可能目标均受保护，两条分支语义保持', () => {
  const source = 'let S=String;if(useNumber)S=Number;Reflect.set(S,"fromCharCode",()=>"changed");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? 'A' : 'changed';
    assert.equal(execute(source, {useNumber}), expected);
    assert.equal(execute(result.code, {useNumber}), expected);
  }
});

test('Reflect.set动态键保守保护整个可能目标', () => {
  const source = 'Reflect.set(String,key,()=>"changed");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.equal(execute(source, {key: 'fromCharCode'}), 'changed');
  assert.equal(execute(result.code, {key: 'fromCharCode'}), 'changed');
});

test('Reflect.set显式内置receiver接收写入，原代码与输出均返回changed', () => {
  const source = 'Reflect.set({},"fromCharCode",()=>"changed",String);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('Reflect.set不同内置target和receiver都保守保护，保持receiver语义', () => {
  const source = 'Reflect.set(String,"fromCharCode",()=>"changed",Number);return [String.fromCharCode(65),Number.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  assert.deepEqual(JSON.parse(JSON.stringify(execute(source))), ['A', 'changed']);
  assert.deepEqual(JSON.parse(JSON.stringify(execute(result.code))), ['A', 'changed']);
});

test('Reflect.set保留写入布尔结果，不用分析结果替代调用返回值', () => {
  const source = 'const success=Reflect.set(String,"fromCharCode",()=>"changed");return [success,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(JSON.parse(JSON.stringify(execute(source))), [true, 'changed']);
  assert.deepEqual(JSON.parse(JSON.stringify(execute(result.code))), [true, 'changed']);
});

test('本地Reflect遮蔽及普通局部target不会误认内置成员变更', () => {
  for (const source of [
    'const Reflect={set(){return false;}};Reflect.set(String,"fromCharCode",()=>"changed");return String.fromCharCode(65);',
    'const S={};Reflect.set(S,"fromCharCode",()=>"changed");return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
    assert.equal(execute(source), 'A');
    assert.equal(execute(result.code), 'A');
  }
});
