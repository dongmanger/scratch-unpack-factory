import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {compileReal02, runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';

const factory = body => `(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function* body(){${body}retire();return;};})`;

for (const [name, body, expected] of [
  ['for-each', 'var a0=0;while(a0<3){a0++;b0.value=a0;yield;}', 'control_for_each'],
  ['while', 'while(compareLessThan(b0.value,4)){b0.value=(+b0.value||0)+1;yield;}', 'control_while'],
  ['删除克隆', 'if(!target.isOriginal){runtime.disposeTarget(target);runtime.stopForTarget(target);retire();return;}', 'control_delete_this_clone'],
  ['停止其他脚本', 'runtime.stopForTarget(target,thread);', 'control_stop'],
  ['counter', 'runtime.ext_scratch3_control._counter=0;runtime.ext_scratch3_control._counter++;b0.value=runtime.ext_scratch3_control._counter;', 'control_get_counter']
]) {
  test(`${name}严格原生组恢复并由真实VM重新编译`, async () => {
    const fixture = await compiledFixture();
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory(body);
    fixture.bundle.compiledTargets[1].scripts = {};fixture.bundle.compiledTargets[1].hats=[];
    const project = {...fixture.project, targets: structuredClone(fixture.stripped.targets)};
    const result = recoverCompiledCode(project,fixture.bundle);
    assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
    assert.ok(Object.values(project.targets[0].blocks).some(block=>block.opcode===expected));
    const compiled=await compileReal02(project,fixture.assets);
    assert.ok(compiled.bundle.compiledTargets[0].scripts.a.factorySource);
  });
}

test('真实02 while迭代恢复后重编译，最终变量值保持',async()=>{
 const fixture=await compiledFixture();fixture.project.targets[1].blocks={};
 const target=fixture.project.targets[0];target.variables.varId1[1]=0;
 target.blocks={a:{opcode:'event_whenflagclicked',parent:null,next:'loop',fields:{},inputs:{},topLevel:true,shadow:false,x:0,y:0},
 loop:{opcode:'control_while',parent:'a',next:null,fields:{},inputs:{CONDITION:[2,'cmp'],SUBSTACK:[2,'set']},topLevel:false,shadow:false},
 cmp:{opcode:'operator_lt',parent:'loop',next:null,fields:{},inputs:{OPERAND1:[3,[12,'分数','varId1'],[10,'']],OPERAND2:[1,[10,'4']]},topLevel:false,shadow:false},
 set:{opcode:'data_changevariableby',parent:'loop',next:null,fields:{VARIABLE:['分数','varId1']},inputs:{VALUE:[1,[4,'1']]},topLevel:false,shadow:false}};
 const original=await compileReal02(fixture.project,fixture.assets);const bundle=structuredClone(original.bundle);
 for(const item of Object.values(bundle.compiledTargets))for(const script of Object.values(item.scripts))script.factorySource=deobfuscate(script.factorySource).code;
 const project={...fixture.project,targets:structuredClone(bundle.targets)};const result=recoverCompiledCode(project,bundle);
 assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
 const generated=await compileReal02(project,fixture.assets);
 const before=await runReal02(fixture.project,fixture.assets,{bundle:original.bundle});const after=await runReal02(project,fixture.assets,{bundle:generated.bundle});
 assert.deepEqual(after.targets,before.targets);assert.equal(after.targets[0].variables.varId1.value,4);
});
