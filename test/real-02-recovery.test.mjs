import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMinimalSb3} from './helpers.mjs';
import {compileReal02, runReal02} from './real-02-compiler.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import JSZip from '@turbowarp/jszip';
import {recursiveRealFixture} from './real-02-recursive.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

test('真实02嵌套循环/条件/列表/广播恢复后重编译，预编译执行状态一致', async () => {
  const fixture = await recursiveRealFixture();
  const original = await compileReal02(fixture.project, fixture.assets);
  const decoded = structuredClone(original.bundle);
  for (const target of Object.values(decoded.compiledTargets)) {
    for (const script of Object.values(target.scripts)) script.factorySource = deobfuscate(script.factorySource).code;
  }
  const project = {...fixture.project, targets: structuredClone(decoded.targets)};
  const recovery = recoverCompiledCode(project, decoded);
  assert.equal(recovery.unresolved.length, 0, JSON.stringify(recovery.unresolved));
  const regenerated = await compileReal02(project, fixture.assets);
  const before = await runReal02(fixture.project, fixture.assets, {bundle: original.bundle, steps: 100});
  const after = await runReal02(project, fixture.assets, {bundle: regenerated.bundle, steps: 100});
  assert.deepEqual(after.targets, before.targets);
  assert.equal(before.targets[0].variables.varId1.value, '成功');
  assert.deepEqual(before.targets[0].variables.items.value, [3, 5, 7]);
  assert.equal(before.targets[1].variables.localScore.value, '成功');
  assert.equal(after.remainingThreads, 0);
  const opcodes = Object.values(project.targets[0].blocks).map(block => block.opcode);
  for (const opcode of ['control_repeat', 'control_if_else', 'operator_gt', 'operator_add', 'data_addtolist', 'event_broadcast']) assert.ok(opcodes.includes(opcode), opcode);
});

const compileFixture = async () => {
  const fixture = await makeMinimalSb3();
  const compiled = await compileReal02(fixture.project, fixture.assets);
  return {fixture, compiled};
};

test('真实02 VM编译导出、预编译重载和执行状态可复现', async () => {
  const {fixture, compiled} = await compileFixture();
  assert.equal(compiled.provenance.kind, 'actual-02engine-vm-compiler');
  assert.equal(compiled.bundle.format, '02engine-compiled-project');
  assert.equal(Object.keys(compiled.bundle.compiledTargets[0].scripts).length, 1);
  assert.equal(Object.keys(compiled.bundle.compiledTargets[1].scripts).length, 1);
  for (const target of Object.values(compiled.bundle.compiledTargets)) {
    assert.deepEqual(target.hats.map(hat => hat.opcode), ['event_whenflagclicked']);
    for (const script of Object.values(target.scripts)) assert.match(script.factorySource, /function/);
  }
  const state = await runReal02(fixture.project, fixture.assets, {bundle: compiled.bundle, steps: 10});
  assert.ok(state.compiled.every(Boolean));
  assert.equal(state.targets.find(target => target.isStage).variables.varId1.value, 'factory-ok');
  assert.equal(state.targets.find(target => !target.isStage).x, 10);
});

test('真实02编译bundle进入静态恢复，变量引用和运动积木结构有效', async () => {
  const {fixture, compiled} = await compileFixture();
  const project = structuredClone(compiled.bundle.targets);
  const wrapper = {targets: project};
  const result = recoverCompiledCode(wrapper, compiled.bundle);
  assert.equal(result.unresolved.length, 0, JSON.stringify(result.unresolved));
  assert.equal(result.scripts.length, 2);
  assert.ok(result.scripts.every(script => script.status === 'reconstructed-unverified'));
  const stageBlocks = Object.values(wrapper.targets[0].blocks);
  const spriteBlocks = Object.values(wrapper.targets[1].blocks);
  assert.ok(stageBlocks.some(block => block.opcode === 'data_setvariableto'));
  assert.ok(spriteBlocks.some(block => block.opcode === 'motion_movesteps'));
  assert.equal(stageBlocks.find(block => block.opcode === 'data_setvariableto').fields.VARIABLE[1], 'varId1');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(wrapper));
  for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
  const validation = await validateSb3(await zip.generateAsync({type: 'uint8array'}));
  assert.equal(validation.ok, true, validation.errors.join('\n'));
});
