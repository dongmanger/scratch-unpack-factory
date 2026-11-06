import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {compileReal02,runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import JSZip from '@turbowarp/jszip';

const source = '(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const v0=stage.variables["varId1"];const op=runtime.getOpcodeFunction("motion_goto");return function* body(){yield* executeInCompatibilityLayer({TO:v0.value},op,false,false,"goto",null);retire();return;};})';

test('动态兼容菜单保留变量连接，缺失shadow默认值明确标为合成',async()=>{
 const fixture=await compiledFixture();fixture.bundle.compiledTargets[0].scripts.a.factorySource=source;
 const project={...fixture.project,targets:structuredClone(fixture.stripped.targets)};
 const result=recoverCompiledCode(project,fixture.bundle);
 assert.equal(result.scripts[0].status,'reconstructed-unverified',result.scripts[0].reason);
 assert.deepEqual(result.scripts[0].body.syntheticMenuDefaults,[{inputName:'TO',opcode:'motion_goto_menu',field:'TO',value:'_random_',reason:'original-inactive-menu-shadow-not-exported'}]);
 const block=Object.values(project.targets[0].blocks).find(block=>block.opcode==='motion_goto');
 assert.equal(block.inputs.TO[0],3);assert.deepEqual(block.inputs.TO[1],[12,'分数','varId1']);
 const zip=new JSZip();zip.file('project.json',JSON.stringify(project));for(const[name,bytes]of Object.entries(fixture.assets))zip.file(name,bytes);
 const validation=await validateSb3(await zip.generateAsync({type:'uint8array'}));assert.equal(validation.ok,true,validation.errors.join('\n'));
});

test('声音兼容指令与reporter经真实VM编译恢复再编译，volume状态一致',async()=>{
 const fixture=await compiledFixture();fixture.project.targets[1].blocks={};const target=fixture.project.targets[0];
 target.blocks={a:{opcode:'event_whenflagclicked',parent:null,next:'volume',inputs:{},fields:{},topLevel:true,shadow:false,x:0,y:0},
 volume:{opcode:'sound_setvolumeto',parent:'a',next:'effect',inputs:{VOLUME:[1,[4,'42']]},fields:{},topLevel:false,shadow:false},
 effect:{opcode:'sound_seteffectto',parent:'volume',next:'set',inputs:{VALUE:[1,[4,'7']]},fields:{EFFECT:['PITCH',null]},topLevel:false,shadow:false},
 set:{opcode:'data_setvariableto',parent:'effect',next:null,inputs:{VALUE:[2,'read']},fields:{VARIABLE:['分数','varId1']},topLevel:false,shadow:false},
 read:{opcode:'sound_volume',parent:'set',next:null,inputs:{},fields:{},topLevel:false,shadow:false}};
 const original=await compileReal02(fixture.project,fixture.assets);const bundle=structuredClone(original.bundle);
 for(const data of Object.values(bundle.compiledTargets))for(const script of Object.values(data.scripts))script.factorySource=deobfuscate(script.factorySource).code;
 const project={...fixture.project,targets:structuredClone(bundle.targets)};const result=recoverCompiledCode(project,bundle);
 assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
 const recompiled=await compileReal02(project,fixture.assets);
 const before=await runReal02(fixture.project,fixture.assets,{bundle:original.bundle});const after=await runReal02(project,fixture.assets,{bundle:recompiled.bundle});
 assert.deepEqual(after.targets,before.targets);assert.equal(after.targets[0].variables.varId1.value,42);
});
