import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import {JSZip} from './helpers.mjs';

const factory = body => `(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];const b1=stage.variables["globalList"];return function* body(){${body}retire();return;};})`;
const restore = async body => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory(body);
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  return {...fixture, project, result, blocks: project.targets[0].blocks};
};
const assertStructural = async fixture => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(fixture.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
  const validation = await validateSb3(await zip.generateAsync({type: 'uint8array'}));
  assert.equal(validation.ok, true, validation.errors.join('\n'));
};

test('嵌套条件与repeat恢复为连接完整的C形积木并保留变量作用域', async () => {
  const fixture = await restore('if(compareGreaterThan(b0.value,3)){for(var a0=5;a0>0;a0--){b0.value=(+b0.value||0)+2;yield;}}else{b0.value="结束";}');
  assert.equal(fixture.result.scripts[0].status, 'reconstructed-unverified', fixture.result.scripts[0].reason);
  const blocks = Object.values(fixture.blocks);
  assert.ok(blocks.some(block => block.opcode === 'control_if_else'));
  assert.ok(blocks.some(block => block.opcode === 'control_repeat'));
  assert.ok(blocks.some(block => block.opcode === 'operator_gt'));
  assert.ok(blocks.some(block => block.opcode === 'operator_add'));
  assert.ok(blocks.filter(block => block.opcode === 'data_setvariableto').every(block => block.fields.VARIABLE[1] === 'varId1'));
  await assertStructural(fixture);
});

test('repeat-until及列表内联修改恢复，monitor语句不变成假积木', async () => {
  const fixture = await restore('while(!listContains(b1,"完成")){b1.value.push("完成");b1._monitorUpToDate=false;yield;}b0.value=b1.value.length;');
  assert.equal(fixture.result.scripts[0].status, 'reconstructed-unverified', fixture.result.scripts[0].reason);
  assert.ok(Object.values(fixture.blocks).some(block => block.opcode === 'control_repeat_until'));
  assert.ok(Object.values(fixture.blocks).some(block => block.opcode === 'data_listcontainsitem'));
  assert.ok(Object.values(fixture.blocks).some(block => block.opcode === 'data_addtolist'));
  await assertStructural(fixture);
});

test('等待条件与运动外观原语恢复，显示后bubble同步必须成对', async () => {
  const fixture = await restore('while(!compareEqual(b0.value,7)){yield;}target.setXY(20,target.y);target.setDirection(target.direction+15);target.setSize(target.size+10);target.setVisible(true);runtime.ext_scratch3_looks._renderBubble(target);runtime.ext_scratch3_looks._say("开始",target);');
  assert.equal(fixture.result.scripts[0].status, 'reconstructed-unverified', fixture.result.scripts[0].reason);
  const opcodes = Object.values(fixture.blocks).map(block => block.opcode);
  for (const opcode of ['control_wait_until', 'motion_setx', 'motion_turnright', 'looks_changesizeby', 'looks_show', 'looks_say']) assert.ok(opcodes.includes(opcode), opcode);
  await assertStructural(fixture);
});

test('含未知嵌套语句时事务性拒绝整段，不能生成已知前缀', async () => {
  const fixture = await restore('b0.value="准备";if(compareEqual(b0.value,7)){target.unknownOperation();}');
  assert.equal(fixture.result.scripts[0].status, 'unresolved');
  assert.equal(fixture.result.scripts[0].body.confidence.score, 0);
  assert.deepEqual(Object.values(fixture.blocks).map(block => block.opcode), ['event_whenflagclicked']);
});

test('非法循环跳转和孤立yield不能被当作调度语句丢弃', async () => {
  for (const body of ['for(var a0=3;a0>0;a0--){break;yield;}', 'yield;b0.value="done";', 'if(true){yield;}']) {
    const fixture = await restore(body);
    assert.equal(fixture.result.scripts[0].status, 'unresolved', body);
    assert.equal(Object.keys(fixture.blocks).length, 1);
  }
});

test('额外事件帽子从元数据恢复，背景拼写来自原定义', async () => {
  for (const [opcode, fieldsOfInputs, targetIndex, expectedFields] of [
    ['event_whenkeypressed', {KEY_OPTION: {value: 'SPACE'}}, 0, {KEY_OPTION: ['space', null]}],
    ['event_whenbackdropswitchesto', {BACKDROP: {value: 'BACKDROP1'}}, 0, {BACKDROP: ['backdrop1', null]}],
    ['event_whenthisspriteclicked', {}, 1, {}],
    ['control_start_as_clone', {}, 1, {}]
  ]) {
    const fixture = await compiledFixture();
    const target = fixture.bundle.compiledTargets[targetIndex];
    target.hats[0].opcode = opcode;
    target.hats[0].fieldsOfInputs = fieldsOfInputs;
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle);
    assert.equal(result.scripts[targetIndex].status, 'reconstructed-unverified', result.scripts[targetIndex].reason);
    assert.deepEqual(project.targets[targetIndex].blocks[target.hats[0].topBlockId].fields, expectedFields);
  }
});
