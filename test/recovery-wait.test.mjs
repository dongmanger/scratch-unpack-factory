import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {compileReal02, runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const source = body => `(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function* body(){${body}b0.value="done";retire();return;};})`;
const group = 'thread.timer=timer();var a0=Math.max(0,1000*0);runtime.requestRedraw();yield;while(thread.timer.timeElapsed()<a0){yield;}thread.timer=null;';

test('等待完整计时组恢复为一块，不误识别成repeat-until', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = source(group);
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
  assert.ok(Object.values(project.targets[0].blocks).some(block => block.opcode === 'control_wait'));
});

test('等待计时组任意缺失副作用或调度拒绝整段', async () => {
  for (const broken of [group.replace('runtime.requestRedraw();', ''), group.replace('thread.timer=null;', ''), group.replace('yield;', 'target.unknown();')]) {
    const fixture = await compiledFixture();
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = source(broken);
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle);
    assert.equal(result.scripts[0].status, 'unresolved');
    assert.equal(Object.keys(project.targets[0].blocks).length, 1);
  }
});

test('真实02等待0秒含至少一次yield，恢复重编译后变量最终状态一致', async () => {
  const fixture = await compiledFixture();
  fixture.project.targets[1].blocks = {};
  const target = fixture.project.targets[0];
  target.blocks.a.next = 'wait';
  target.blocks.wait = {opcode: 'control_wait', parent: 'a', next: 'b', fields: {}, inputs: {DURATION: [1, [4, '0']]}, topLevel: false, shadow: false};
  target.blocks.b.parent = 'wait';
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const bundle = structuredClone(compiled.bundle);
  for (const item of Object.values(bundle.compiledTargets)) for (const script of Object.values(item.scripts)) script.factorySource = deobfuscate(script.factorySource).code;
  const project = {...fixture.project, targets: structuredClone(bundle.targets)};
  const result = recoverCompiledCode(project, bundle);
  assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
  const recompiled = await compileReal02(project, fixture.assets);
  const before = await runReal02(fixture.project, fixture.assets, {bundle: compiled.bundle, steps: 100});
  const after = await runReal02(project, fixture.assets, {bundle: recompiled.bundle, steps: 100});
  assert.deepEqual(after.targets, before.targets);
  assert.ok(Object.values(project.targets[0].blocks).some(block => block.opcode === 'control_wait'));
});
