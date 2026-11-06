import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {restoreSb3} from '../src/restore.mjs';

const restore = f => restoreSb3({staticResult: {type: 'sb3', format: 'o2-html-precompile', data: f.bytes,
  compiledProject: JSON.stringify(f.bundle)}});

test('编译包漏角色、重复对应和残缺清单不能声明完整恢复', async () => {
  for (const mutate of [
    f => {delete f.bundle.compiledTargets[1];},
    f => {f.bundle.compiledTargets[1].targetIndex = 0;},
    f => {f.bundle.compiledTargets[0].scripts = [];},
    f => {delete f.bundle.compiledTargets[0].scripts.a.factorySource;}
  ]) {
    const f = await compiledFixture();
    mutate(f);
    const result = await restore(f);
    assert.equal(result.report.status, 'invalid');
    assert.equal(result.report.canClaimComplete, false);
    assert.equal(result.report.confidence.code.score, 0);
  }
});

test('无ID唯一广播名称回退的低分必须传递到脚本体和生成积木', async () => {
  const f = await compiledFixture();
  f.bundle.compiledTargets[1].hats[0].fieldsOfInputs.BROADCAST_OPTION = {value: 'STARTGAME'};
  const result = recoverCompiledCode(structuredClone(f.stripped), f.bundle);
  const script = result.scripts.find(s => s.scriptId === 'r');
  assert.equal(script.hat.confidence.score, 0.65);
  assert.equal(script.body.confidence.score, 0.65);
  assert.ok(result.blocks.filter(b => b.targetIndex === 1).every(b => b.confidence.score === 0.65));
});

test('stage变量ID与本地定义冲突时，不用同名变量偷换全局引用', async () => {
  const f = await compiledFixture();
  f.stripped.targets[1].variables.varId1 = ['不同本地变量', 0];
  const result = recoverCompiledCode(f.stripped, f.bundle);
  assert.ok(result.unresolved.some(x => /全局 ID.*本地定义冲突/.test(x.reason)));
  assert.equal(result.scripts.find(s => s.scriptId === 'r').body.confidence.score, 0);
});

test('负零不通过当前常数模板假称精确保真', async () => {
  for (const literal of ['-0']) {
    const f = await compiledFixture();
    f.bundle.compiledTargets[0].scripts.a.factorySource = f.bundle.compiledTargets[0].scripts.a.factorySource.replace('a0.value = "准备"', `a0.value = ${literal}`);
    const result = recoverCompiledCode(structuredClone(f.stripped), f.bundle);
    assert.equal(result.scripts[0].status, 'unresolved');
    assert.equal(result.scripts[0].body.confidence.score, 0);
  }
});
