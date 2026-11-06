import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {parse} from '@babel/parser';
import {analyzeBuiltinEffects} from '../src/builtin-effects.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

const inspect = source => analyzeBuiltinEffects(parse(source, {allowReturnOutsideFunction: true}));
const execute = (source, globals = {}) => vm.runInNewContext(`(()=>{${source}})()`, globals, {timeout: 200});

// A timeout in a separate process catches a synchronous fixed-point hang; node:test's
// own timeout cannot interrupt a blocked JS event loop.
test('多来源可变别名及时收敛，原代码和解混淆代码均返回1', () => {
  const source = 'const A=String;const B=Number;let S=A;S=B;return 1;';
  const engine = new URL('../src/deobfuscate.mjs', import.meta.url).href;
  const childCode = `
    import vm from 'node:vm';
    import {deobfuscate} from ${JSON.stringify(engine)};
    const source = ${JSON.stringify(source)};
    const started = performance.now();
    const result = deobfuscate(source);
    const execute = code => vm.runInNewContext('(()=>{' + code + '})()', {}, {timeout:200});
    console.log(JSON.stringify({elapsedMs:performance.now()-started, input:execute(source),
      output:execute(result.code), analysis:result.report.builtinEffects}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode],
    {encoding: 'utf8', timeout: 5000});
  assert.equal(child.error, undefined, `传播未及时返回：${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.input, 1);
  assert.equal(result.output, 1);
  assert.ok(result.elapsedMs < 4000);
  assert.deepEqual(result.analysis.aliases.find(a => a.name === 'S').possibleBuiltins, ['Number', 'String']);
  assert.ok(result.analysis.processedFacts <= result.analysis.finiteFactLimit);
});

test('多来源别名成员赋值保护每个可能对象而不只保留最后来源', () => {
  const source = 'const A=String;const B=Number;let S=A;S=B;S.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(execute(source), 'A');
  assert.equal(execute(result.code), 'A');
  assert.ok(result.report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(result.report.builtinEffects.blockedMembers.includes('Number.fromCharCode'));
  assert.ok(result.code.includes('String.fromCharCode(65)'));
});

test('分支重赋值的两条实际执行路径均保留语义且集合同时包含两来源', () => {
  const source = 'const A=String;const B=Number;let S=A;if(useNumber)S=B;S.fromCharCode=()=>"changed";return String.fromCharCode(65);';
  const result = deobfuscate(source);
  assert.equal(execute(source, {useNumber: false}), 'changed');
  assert.equal(execute(result.code, {useNumber: false}), 'changed');
  assert.equal(execute(source, {useNumber: true}), 'A');
  assert.equal(execute(result.code, {useNumber: true}), 'A');
  assert.deepEqual(result.report.builtinEffects.aliases.find(a => a.name === 'S').possibleBuiltins, ['Number', 'String']);
});

test('赋值图中的循环和多级传播只增加事实，所有可能来源传播到后继', () => {
  const source = 'let S=String,T=Number;S=T;T=S;let U=T;return 1;';
  const effects = inspect(source);
  for (const name of ['S', 'T', 'U']) {
    assert.deepEqual(effects.aliasSummary.find(a => a.name === name).possibleBuiltins, ['Number', 'String']);
  }
  assert.ok(effects.stats.processedFacts <= effects.stats.finiteFactLimit);
  const result = deobfuscate(source);
  assert.equal(execute(source), 1);
  assert.equal(execute(result.code), 1);
});

test('成员普通/复合赋值、delete和更新统一保护别名所有可能对象', () => {
  for (const operation of [
    'S.fromCharCode=()=>"changed"',
    'S["fromCharCode"] += ""',
    'delete S.fromCharCode',
    'S.fromCharCode++',
    '--S["fromCharCode"]'
  ]) {
    const effects = inspect(`let S=String;S=Number;${operation};return 1;`);
    assert.ok(effects.blockedBuiltinMembers.has('String.fromCharCode'), operation);
    assert.ok(effects.blockedBuiltinMembers.has('Number.fromCharCode'), operation);
  }
});

test('未知计算键保护所有可能对象；本地别名重绑定本身不修改全局对象', () => {
  const unknownKey = inspect('let S=String;S=Number;S[key]=1;return 1;');
  assert.ok(unknownKey.blockedBuiltins.has('String'));
  assert.ok(unknownKey.blockedBuiltins.has('Number'));
  const rebound = inspect('let S=String;S=Number;return 1;');
  assert.equal(rebound.blockedBuiltins.size, 0);
  assert.equal(rebound.blockedBuiltinMembers.size, 0);
});

test('同名遮蔽用binding identity区分，内层成员修改不串到外层别名', () => {
  const effects = inspect('const S=String;{const S=Number;S.marker=1;}return String.fromCharCode(65);');
  const sameNames = effects.aliasSummary.filter(a => a.name === 'S');
  assert.equal(sameNames.length, 2);
  assert.notEqual(sameNames[0].declarationStart, sameNames[1].declarationStart);
  assert.deepEqual(sameNames.map(a => a.possibleBuiltins), [['String'], ['Number']]);
  assert.ok(effects.blockedBuiltinMembers.has('Number.marker'));
  assert.equal(effects.blockedBuiltinMembers.has('String.marker'), false);
});
