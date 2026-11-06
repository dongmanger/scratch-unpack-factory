import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

// Execute only test-owned programs in fresh contexts with a timeout.
const execute = (code, globals = {}) =>
  vm.runInNewContext(`(()=>{${code}})()`, globals, {timeout: 200});

for (const [label, mutation] of [
  ['直接Object.assign', 'Object.assign(String,{fromCharCode:()=>"changed"});'],
  ['计算属性接口及源对象键', 'Object["assign"](String,{["fromCharCode"]:()=>"changed"});'],
  ['接口与目标的多级别名', 'const O=Object,P=O,S=String,T=S;P.assign(T,{fromCharCode:()=>"changed"});']
]) {
  test(`${label}前后均返回changed且成员受到保护`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('assign检查每个源对象及所有属性键，保留源顺序与覆盖语义', () => {
  const source = 'Object.assign(String,{marker:1,fromCharCode:()=>"first"},{other:2},{fromCharCode:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  for (const key of ['marker', 'other', 'fromCharCode']) {
    assert.ok(result.report.builtinEffects.blockedMembers.includes(`String.${key}`));
  }
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('assign getter读取不在解混淆器执行，副作用和最终调用保持一致', () => {
  const source = 'let reads=0;Object.assign(String,{get fromCharCode(){reads++;return ()=>"changed";}});return [String.fromCharCode(65),reads];';
  const result = deobfuscate(source);
  assert.deepEqual(JSON.parse(JSON.stringify(execute(source))), ['changed', 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(execute(result.code))), ['changed', 1]);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.equal(result.report.executesInput, false);
});

test('assign变量源、展开源和未知计算键保守保护可能目标整体', () => {
  for (const source of [
    'const data={fromCharCode:()=>"changed"};Object.assign(String,data);return String.fromCharCode(65);',
    'const data={fromCharCode:()=>"changed"};Object.assign(String,{...data});return String.fromCharCode(65);',
    'Object.assign(String,{[key]:()=>"changed"});return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
    assert.equal(execute(source, {key: 'fromCharCode'}), 'changed');
    assert.equal(execute(result.code, {key: 'fromCharCode'}), 'changed');
  }
});

test('assign多来源目标同时保护每个可能成员，分支行为一致', () => {
  const source = 'let S=String;if(useNumber)S=Number;Object.assign(S,{fromCharCode:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? 'A' : 'changed';
    assert.equal(execute(source, {useNumber}), expected);
    assert.equal(execute(result.code, {useNumber}), expected);
  }
});

test('assign null源不造成虚假成员修改或改变结果', () => {
  const source = 'Object.assign(String,null);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedBuiltins.includes('String'), false);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.equal(execute(source), 'A');
  assert.equal(execute(result.code), 'A');
});

test('本地Object遮蔽不按全局assign分析；局部普通对象不影响String', () => {
  for (const source of [
    'const Object={assign(){return 0;}};Object.assign(String,{fromCharCode:()=>"changed"});return String.fromCharCode(65);',
    'const S={};Object.assign(S,{fromCharCode:()=>"changed"});return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
    assert.equal(execute(source), 'A');
    assert.equal(execute(result.code), 'A');
  }
});
