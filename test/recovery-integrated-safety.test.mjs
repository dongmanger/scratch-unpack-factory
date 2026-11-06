import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {compileReal02,runReal02} from './real-02-compiler.mjs';

const source=(body,name='body',parameters='')=>`(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function ${name}(${parameters}){${body}};})`;
const base=async()=>{const fixture=await compiledFixture();fixture.bundle.compiledTargets[1].scripts={};fixture.bundle.compiledTargets[1].hats=[];return fixture;};

test('嵌套空字符串过程返回不丢弃，恢复后真实VM执行不进入后续赋值',async()=>{
 const fixture=await base();fixture.stripped.targets[0].variables.varId1[1]=0;
 fixture.bundle.compiledTargets[0].procedures.Zearly={factorySource:source('if(1===1){return "";}b0.value=99;return "";')};
 fixture.bundle.compiledTargets[0].scripts.a.factorySource=source('thread.procedures["Zearly"]();retire();return;');
 const project={...fixture.project,targets:structuredClone(fixture.stripped.targets)};const result=recoverCompiledCode(project,fixture.bundle);
 assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
 assert.ok(Object.values(project.targets[0].blocks).some(block=>block.opcode==='procedures_return'));
 const compiled=await compileReal02(project,fixture.assets);const state=await runReal02(project,fixture.assets,{bundle:compiled.bundle});
 assert.equal(state.targets[0].variables.varId1.value,0);
});

test('具名函数p00不能冒充实际参数p0，整过程保留未恢复原因',async()=>{
 const fixture=await base();fixture.bundle.compiledTargets[0].procedures['Zscope %b']={factorySource:source('if(p00){b0.value=1;}return "";','p00','p0')};
 fixture.bundle.compiledTargets[0].scripts.a.factorySource=source('thread.procedures["Zscope %b"](false);retire();return;');
 const result=recoverCompiledCode(structuredClone(fixture.stripped),fixture.bundle);
 assert.equal(result.procedures[0].status,'unresolved');assert.equal(result.scripts[0].status,'unresolved');
 assert.match(result.procedures[0].reason,/truthiness|表达式/);
});

test('被拒绝的W变体不能通过已恢复Z签名继续被调用',async()=>{
 const fixture=await base();const target=fixture.bundle.compiledTargets[0];
 target.procedures={Zleaf:{factorySource:source('b0.value=1;return "";')},Wleaf:{factorySource:source('b0.value=2;return "";')},Wouter:{factorySource:source('thread.procedures["Wleaf"]();return "";')}};
 target.scripts.a.factorySource=source('thread.procedures["Wouter"]();retire();return;');
 const result=recoverCompiledCode(structuredClone(fixture.stripped),fixture.bundle);
 assert.equal(result.procedures.find(p=>p.variant==='Zleaf').status,'reconstructed-unverified');
 assert.equal(result.procedures.find(p=>p.variant==='Wleaf').status,'unresolved');
 assert.equal(result.procedures.find(p=>p.variant==='Wouter').status,'unresolved');
 assert.equal(result.scripts[0].status,'unresolved');
});

test('非事件锚点碰撞不删除之前已恢复的真实事件帽子',async()=>{
 const fixture=await base();const target=fixture.bundle.compiledTargets[0];
 const hatId='rf_'+createHash('sha256').update('0:loose:inert-anchor').digest('hex').slice(0,20);
 target.scripts={[hatId]:{factorySource:source('b0.value=7;retire();return;'),executableHat:false},loose:{factorySource:source('b0.value=9;retire();return;'),executableHat:false}};
 target.hats=[{topBlockId:hatId,opcode:'event_whenflagclicked',fieldsOfInputs:{}}];
 const project={...fixture.project,targets:structuredClone(fixture.stripped.targets)};const result=recoverCompiledCode(project,fixture.bundle);
 assert.equal(project.targets[0].blocks[hatId].opcode,'event_whenflagclicked');assert.ok(project.targets[0].blocks[hatId].next);
 assert.equal(result.scripts[0].status,'reconstructed-unverified');assert.equal(result.scripts[1].status,'unresolved');
 const compiled=await compileReal02(project,fixture.assets);const state=await runReal02(project,fixture.assets,{bundle:compiled.bundle});
 assert.equal(state.targets[0].variables.varId1.value,7);
});
