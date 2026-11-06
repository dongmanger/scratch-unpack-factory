import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {deobfuscate} from '../src/deobfuscate.mjs';

const observe = (code, globals = {}) => {
  const context = vm.createContext(globals, {codeGeneration: {strings: false, wasm: false}});
  try {
    const value = new vm.Script(`JSON.stringify((()=>{${code}})())`).runInContext(context, {timeout: 200});
    return {value: JSON.parse(value)};
  } catch (error) { return {error: error.name}; }
};

for (const [label, mutation] of [
  ['直接方法别名', 'const remove=Reflect.deleteProperty;remove(String,"fromCharCode");'],
  ['计算属性方法别名', 'const remove=Reflect["deleteProperty"];remove(String,"fromCharCode");'],
  ['接口与目标多级别名', 'const R=Reflect,Q=R,S=String,T=S;const remove=Q.deleteProperty;remove(T,"fromCharCode");'],
  ['通过赋值建立方法别名', 'let remove;remove=Reflect.deleteProperty;remove(String,"fromCharCode");'],
  ['多级方法别名', 'const remove=Reflect.deleteProperty;const erase=remove;let run;run=erase;run(String,"fromCharCode");'],
  ['函数先出现、方法别名后声明', 'function change(){remove(String,"fromCharCode");}const remove=Reflect.deleteProperty;change();'],
  ['循环方法别名', 'let remove=Reflect.deleteProperty,erase=remove;remove=erase;erase(String,"fromCharCode");'],
  ['接口通过赋值建立', 'let R;R=Reflect;const remove=R.deleteProperty;remove(String,"fromCharCode");']
]) {
  test(`Reflect.deleteProperty${label}前后均抛出TypeError`, () => {
    const source = `${mutation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.deepEqual(observe(source), {error: 'TypeError'});
    assert.deepEqual(observe(result.code), {error: 'TypeError'});
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
    assert.equal(result.report.executesInput, false);
  });
}

test('方法别名未知键保护所有可能目标，两条执行路径均保持', () => {
  const source = 'const remove=Reflect.deleteProperty;let S=String;if(useNumber)S=Number;remove(S,key);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('String'));
  assert.ok(result.report.builtinEffects.blockedBuiltins.includes('Number'));
  for (const useNumber of [false, true]) {
    const expected = useNumber ? {value: 'A'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useNumber, key: 'fromCharCode'}), expected);
    assert.deepEqual(observe(result.code, {useNumber, key: 'fromCharCode'}), expected);
  }
});

test('方法提取自多来源接口时不遗漏Reflect来源', () => {
  const source = 'let R=Reflect;if(useLocal)R={deleteProperty(){return false;}};const remove=R.deleteProperty;remove(String,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  for (const useLocal of [false, true]) {
    const expected = useLocal ? {value: 'A'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useLocal}), expected);
    assert.deepEqual(observe(result.code, {useLocal}), expected);
  }
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
});

test('多来源方法别名保留删除与写入两种结果', () => {
  const source = 'let change=Reflect.deleteProperty;if(useSet)change=Reflect.set;change(String,"fromCharCode",()=>"changed");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.deepEqual(result.report.builtinEffects.methodAliases.find(a => a.name === 'change').possibleMethods,
    ['Reflect.deleteProperty', 'Reflect.set']);
  for (const useSet of [false, true]) {
    const expected = useSet ? {value: 'changed'} : {error: 'TypeError'};
    assert.deepEqual(observe(source, {useSet}), expected);
    assert.deepEqual(observe(result.code, {useSet}), expected);
  }
});

test('方法别名删除成功的true与成员消失保持不变', () => {
  const source = 'const remove=Reflect.deleteProperty;return [remove(String,"fromCharCode"),typeof String.fromCharCode];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [true, 'undefined']});
  assert.deepEqual(observe(result.code), {value: [true, 'undefined']});
});

test('方法别名删除冻结目标保留false与原方法调用', () => {
  const source = 'const remove=Reflect.deleteProperty;Object.freeze(String);return [remove(String,"fromCharCode"),String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: [false, 'A']});
  assert.deepEqual(observe(result.code), {value: [false, 'A']});
});

test('方法别名删除没有receiver，额外参数仍求值', () => {
  const source = 'const remove=Reflect.deleteProperty;let n=0;const success=remove({},"fromCharCode",(n++,String));return [success,n,String.fromCharCode(65)];';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.deepEqual(observe(source), {value: [true, 1, 'A']});
  assert.deepEqual(observe(result.code), {value: [true, 1, 'A']});
});

test('方法别名同名绑定遮蔽不串到外层删除函数', () => {
  const source = 'const remove=Reflect.deleteProperty;function run(){const remove=()=>false;remove(String,"fromCharCode");}run();return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.deepEqual(observe(source), {value: 'A'});
  assert.deepEqual(observe(result.code), {value: 'A'});
});

test('本地Reflect的同名方法不识别成内置方法别名', () => {
  const source = 'const Reflect={deleteProperty(){return false;}};const remove=Reflect.deleteProperty;remove(String,"fromCharCode");return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'), false);
  assert.deepEqual(observe(source), {value: 'A'});
  assert.deepEqual(observe(result.code), {value: 'A'});
});

for (const [method, invocation] of [
  ['Reflect.set', 'change(String,"fromCharCode",()=>"changed");'],
  ['Reflect.defineProperty', 'change(String,"fromCharCode",{value:()=>"changed"});'],
  ['Object.defineProperty', 'change(String,"fromCharCode",{value:()=>"changed"});'],
  ['Object.defineProperties', 'change(String,{fromCharCode:{value:()=>"changed"}});'],
  ['Object.assign', 'change(String,{fromCharCode:()=>"changed"});']
]) {
  test(`${method}方法别名复用副作用分析并保持changed`, () => {
    const source = `const change=${method};${invocation}return String.fromCharCode(65);`;
    const result = deobfuscate(source);
    assert.deepEqual(observe(source), {value: 'changed'});
    assert.deepEqual(observe(result.code), {value: 'changed'});
    assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  });
}

test('Reflect.set方法别名仍保护显式receiver', () => {
  const source = 'const change=Reflect.set;change({},"fromCharCode",()=>"changed",String);return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.deepEqual(observe(source), {value: 'changed'});
  assert.deepEqual(observe(result.code), {value: 'changed'});
});

// An independent process can interrupt a synchronous propagation loop.
test('方法多来源与循环传播在硬超时内收敛并记录有限事实集合', () => {
  const source = 'let first=Reflect.deleteProperty,second=Reflect.set;first=second;second=first;const third=second;return 1;';
  const engine = new URL('../src/deobfuscate.mjs', import.meta.url).href;
  const childCode = `
    import {deobfuscate} from ${JSON.stringify(engine)};
    const result=deobfuscate(${JSON.stringify(source)});
    console.log(JSON.stringify(result.report.builtinEffects));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode],
    {encoding: 'utf8', timeout: 5000});
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const effects = JSON.parse(child.stdout);
  for (const name of ['first', 'second', 'third']) {
    assert.deepEqual(effects.methodAliases.find(a => a.name === name).possibleMethods,
      ['Reflect.deleteProperty', 'Reflect.set']);
  }
  assert.ok(effects.methodProcessedFacts <= effects.finiteMethodFactLimit);
  const result = deobfuscate(source);
  assert.deepEqual(observe(source), {value: 1});
  assert.deepEqual(observe(result.code), {value: 1});
});
