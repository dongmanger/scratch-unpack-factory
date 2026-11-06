import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {deobfuscate} from '../src/deobfuscate.mjs';

// Execute only programs constructed in this test, each in a fresh bounded context.
const execute = (code, globals = {}) =>
  vm.runInNewContext(`(()=>{${code}})()`, globals, {timeout: 200});

for (const [label, mutation] of [
  ['直接接口及标识符属性键', 'Object.defineProperties(String,{fromCharCode:{value:()=>"changed"}});'],
  ['字符串属性键', 'Object.defineProperties(String,{"fromCharCode":{value:()=>"changed"}});'],
  ['计算属性键及接口', 'Object["defineProperties"](String,{["fromCharCode"]:{value:()=>"changed"}});'],
  ['接口与目标的多级别名', 'const O=Object,P=O,S=String,T=S;P.defineProperties(T,{fromCharCode:{value:()=>"changed"}});'],
  ['descriptor getter', 'Object.defineProperties(String,{fromCharCode:{get:()=>()=>"changed"}});']
]) {
  test(`defineProperties ${label}保持changed语义`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('defineProperties解析所有描述符属性键，不只检查第一个', () => {
  const source = 'Object.defineProperties(String,{first:{value:1},fromCharCode:{value:()=>"changed"},last:{value:2}});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  for (const key of ['first', 'fromCharCode', 'last']) {
    assert.ok(result.report.builtinEffects.blockedMembers.includes(`String.${key}`));
  }
  assert.equal(execute(source), 'changed');
  assert.equal(execute(result.code), 'changed');
});

test('未知计算属性键保守保护整个目标，运行时仍保持changed', () => {
  const source = 'Object.defineProperties(String,{[key]:{value:()=>"changed"}});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.equal(execute(source, {key: 'fromCharCode'}), 'changed');
  assert.equal(execute(result.code, {key: 'fromCharCode'}), 'changed');
});

test('描述符展开项及变量容器保守保护目标，不猜测隐藏键', () => {
  for (const source of [
    'const descriptors={fromCharCode:{value:()=>"changed"}};Object.defineProperties(String,{...descriptors});return String.fromCharCode(65);',
    'const descriptors={fromCharCode:{value:()=>"changed"}};Object.defineProperties(String,descriptors);return String.fromCharCode(65);'
  ]) {
    const result = deobfuscate(source);
    assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
  }
});

test('多个可能目标的每个描述符成员均受保护，两条分支语义一致', () => {
  const source = 'let S=String;if(useNumber)S=Number;Object.defineProperties(S,{fromCharCode:{value:()=>"changed"},marker:{value:1}});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  for (const object of ['String', 'Number']) for (const member of ['fromCharCode', 'marker']) {
    assert.ok(result.report.builtinEffects.blockedMembers.includes(`${object}.${member}`));
  }
  for (const useNumber of [false, true]) {
    const expected = useNumber ? 'A' : 'changed';
    assert.equal(execute(source, {useNumber}), expected);
    assert.equal(execute(result.code, {useNumber}), expected);
  }
});

test('本地Object遮蔽不会把defineProperties误判为全局接口', () => {
  const source = 'const Object={defineProperties(){return 0;}};Object.defineProperties(String,{fromCharCode:{value:()=>"changed"}});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.equal(execute(source), 'A');
  assert.equal(execute(result.code), 'A');
});
