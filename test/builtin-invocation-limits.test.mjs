import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {deobfuscate} from '../src/deobfuscate.mjs';

const observe = (source, globals = {}) => {
  const context = vm.createContext(globals, {codeGeneration: {strings: false, wasm: false}});
  try {
    const value = new vm.Script(`JSON.stringify((()=>{${source}})())`).runInContext(context, {timeout: 300});
    return {value: JSON.parse(value)};
  } catch (error) { return {error: error.name}; }
};

test('深层bind链解析达到上限时报告partial并保护内置，不错误折叠', () => {
  const source = 'const f0=Reflect.deleteProperty;' +
    Array.from({length: 50}, (_, i) => `const f${i + 1}=f${i}.bind(null);`).join('') +
    'f50(String,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.builtinEffects.invocationResolutionLimited, true);
  assert.ok(result.report.residuals.some(r => r.type === 'builtin-invocation-resolution-limit'));
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
  assert.equal(result.report.executesInput, false);
});

// A subprocess timeout can interrupt a synchronous analyzer loop.
test('循环bind赋值的事实集合收敛，参数不确定时仍保持TypeError', () => {
  const source = 'let remove=Reflect.deleteProperty,erase=remove;remove=erase.bind(null);erase=remove.bind(null);erase(String,"fromCharCode");return String.fromCharCode(65);';
  const engine = new URL('../src/deobfuscate.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {deobfuscate} from ${JSON.stringify(engine)};
    console.log(JSON.stringify(deobfuscate(${JSON.stringify(source)})));
  `], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.report.builtinEffects.methodProcessedFacts <= result.report.builtinEffects.finiteMethodFactLimit);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('条件表达式选择删除或写入的绑定函数，两条路径均保留', () => {
  const source = 'const change=useSet?Reflect.set.bind(null,String,"fromCharCode",()=>"changed"):Reflect.deleteProperty.bind(null,String,"fromCharCode");change();return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.deepEqual(result.report.builtinEffects.methodAliases.find(a => a.name === 'change').possibleMethods,
    ['Reflect.deleteProperty', 'Reflect.set']);
  for (const useSet of [false, true]) {
    const expected = useSet ? {value: 'changed'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useSet}), expected);
    assert.deepEqual(observe(result.code, {useSet}), expected);
  }
});

test('逻辑表达式中的方法来源不丢失，保留短路语义', () => {
  const source = 'const remove=enabled&&Reflect.deleteProperty;remove(String,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  for (const enabled of [false, true]) {
    assert.deepEqual(observe(source, {enabled}), {error: 'TypeError'});
    assert.deepEqual(observe(result.code, {enabled}), {error: 'TypeError'});
  }
});

test('逗号表达式提取方法保留先前参数副作用', () => {
  const source = 'let n=0;const remove=(n++,Reflect.deleteProperty);const deleted=remove(String,"fromCharCode");return [n,deleted,typeof String.fromCharCode];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [1, true, 'undefined']});
  assert.deepEqual(observe(result.code), {value: [1, true, 'undefined']});
});

test('动态计算的方法键保护接口的可能副作用方法', () => {
  const source = 'const change=Reflect[method];change(String,"fromCharCode",()=>"changed");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  for (const method of ['deleteProperty', 'set']) {
    const expected = method === 'set' ? {value: 'changed'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {method}), expected);
    assert.deepEqual(observe(result.code, {method}), expected);
  }
});

test('逗号表达式中的实际内置目标受保护', () => {
  const source = 'let n=0;Reflect.deleteProperty.call(null,(n++,String),"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('条件目标的每个可能内置受保护，并保留两条实际路径', () => {
  const source = 'const remove=Reflect.deleteProperty.bind(null,useNumber?Number:String,"fromCharCode");remove();return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? {value: 'A'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useNumber}), expected);
    assert.deepEqual(observe(result.code, {useNumber}), expected);
  }
});

test('函数返回的未知目标保守保护，原代码与输出均保持删除后异常', () => {
  const source = 'function target(){return String;}const remove=Reflect.deleteProperty.bind(null,target(),"fromCharCode");remove();return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('apply数组逃逸到本地同名接口后修改，不能按初始化元素折叠', () => {
  const source = 'const args=[String,"absent"];const local={apply(_this,items){items[1]="fromCharCode";}};local.apply(null,args);Reflect.deleteProperty.apply(null,args);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('apply数组在多次读取间改变，不能重复使用初始化形状', () => {
  const source = 'const args=[String,"absent"];Reflect.deleteProperty.apply(null,args);args[1]="fromCharCode";Reflect.deleteProperty.apply(null,args);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('apply字面量数组展开保留目标及属性键位置', () => {
  const source = 'Reflect.deleteProperty.apply(null,[...[String],"fromCharCode"]);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(result.code), {error: 'TypeError'});
});

test('apply参数数组的getter不在解混淆时执行，运行时副作用保持', () => {
  const source = 'let n=0;const args={get 0(){n++;return String;},1:"fromCharCode",length:2};const remove=Reflect.deleteProperty;const deleted=remove.apply(null,args);return [n,deleted,typeof String.fromCharCode];';
  const result = deobfuscate(source);
  assert.equal(result.report.executesInput, false);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.deepEqual(observe(source), {value: [1, true, 'undefined']});
  assert.deepEqual(observe(result.code), {value: [1, true, 'undefined']});
});
