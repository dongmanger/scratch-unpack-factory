import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import {analyzeBuiltinEffects} from '../src/builtin-effects.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

// Only execute these test-owned programs, never external project input.
const execute = (source, globals = {}) =>
  vm.runInNewContext(`(()=>{${source}})()`, globals, {timeout: 200});

for (const [name, mutation] of [
  ['直接Object.defineProperty', 'Object.defineProperty(String,"fromCharCode",{value:()=>"changed"});'],
  ['计算属性defineProperty', 'Object["defineProperty"](String,"fromCharCode",{value:()=>"changed"});'],
  ['Object及目标的多级别名', 'const O=Object;const P=O;const S=String;const T=S;P.defineProperty(T,"fromCharCode",{value:()=>"changed"});'],
  ['descriptor getter', 'Object.defineProperty(String,"fromCharCode",{get:()=>()=>"changed"});']
]) {
  test(`${name}修改成员时原程序和解混淆程序均返回changed`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.equal(execute(source), 'changed');
    assert.equal(execute(result.code), 'changed');
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.ok(result.code.includes('String.fromCharCode(65)'));
    assert.equal(result.report.executesInput, false);
  });
}

test('defineProperty作用于多来源可变别名时保护所有可能的内置成员', () => {
  const source = 'let S=String;if(useNumber)S=Number;Object.defineProperty(S,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? 'A' : 'changed';
    assert.equal(execute(source, {useNumber}), expected);
    assert.equal(execute(result.code, {useNumber}), expected);
  }
});

test('defineProperty未知属性键保护可能目标的整对象，不猜测修改成员', () => {
  const source = 'Object.defineProperty(String,key,{value:()=>"changed"});return String.fromCharCode(65);';
  const effects = analyzeBuiltinEffects(parse(source, {allowReturnOutsideFunction: true}));
  assert.ok(effects.blockedBuiltins.has('String'));
  const result = deobfuscate(source);
  assert.equal(execute(source, {key: 'fromCharCode'}), 'changed');
  assert.equal(execute(result.code, {key: 'fromCharCode'}), 'changed');
});

test('本地Object遮蔽不误认成全局descriptor接口', () => {
  const source = 'const Object={defineProperty(target,key,descriptor){return 0;}};Object.defineProperty(String,"fromCharCode",{value:()=>"changed"});return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(execute(source), 'A');
  assert.equal(execute(result.code), 'A');
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
});
