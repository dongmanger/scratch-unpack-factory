import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {compileReal02,runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

test('sprite named _stage_ cannot be rebound to the reserved sensing_of stage token', async () => {
 const fixture = await compiledFixture();
 fixture.stripped.targets[0].variables.stageX = ['x position', 99];
 fixture.stripped.targets[1].name = '_stage_';
 fixture.stripped.targets[1].x = 41;
 const script = fixture.bundle.compiledTargets[0].scripts.a;
 script.factorySource = `(function factory(thread) {
  const target = thread.target;
  const runtime = target.runtime;
  const stage = runtime.getTargetForStage();
  const b0 = stage.variables["varId1"];
  const b1 = runtime.getSpriteTargetByName("_stage_");
  return function* body() {
   b0.value = b1 ? b1.x : 0;
   retire(); return;
  };
 })`;
 const project = structuredClone(fixture.stripped);
 const result = recoverCompiledCode(project, fixture.bundle, {beautify: false});
 assert.equal(result.scripts[0].status, 'unresolved');
 assert.equal(result.scripts[0].body.confidence.score, 0);
 assert.match(result.scripts[0].reason, /_stage_.*冲突/);
 assert.deepEqual(Object.values(project.targets[0].blocks).map(block => block.opcode), ['event_whenflagclicked']);
});

for(const property of ['x position','direction','size','costume #','costume name','分数']){
 test(`真实02 sensing_of ${property}静态目标恢复，重编译运行结果一致`,async()=>{
  const f=await compiledFixture();f.project.targets[1].blocks={};
  const stage=f.project.targets[0];stage.blocks={
   a:{opcode:'event_whenflagclicked',next:'set',parent:null,inputs:{},fields:{},topLevel:true,shadow:false,x:0,y:0},
   set:{opcode:'data_setvariableto',parent:'a',next:null,fields:{VARIABLE:['分数','varId1']},inputs:{VALUE:[2,'of']},topLevel:false,shadow:false},
   of:{opcode:'sensing_of',parent:'set',next:null,fields:{PROPERTY:[property,null]},inputs:{OBJECT:[1,'menu']},topLevel:false,shadow:false},
   menu:{opcode:'sensing_of_object_menu',parent:'of',next:null,fields:{OBJECT:['Sprite1',null]},inputs:{},topLevel:false,shadow:true}
  };
  const original=await compileReal02(f.project,f.assets);const bundle=structuredClone(original.bundle);
  for(const target of Object.values(bundle.compiledTargets))for(const script of Object.values(target.scripts))script.factorySource=deobfuscate(script.factorySource).code;
  const project={...f.project,targets:structuredClone(bundle.targets)};const result=recoverCompiledCode(project,bundle);
  assert.equal(result.unresolved.length,0,JSON.stringify(result.unresolved));
  assert.ok(Object.values(project.targets[0].blocks).some(block=>block.opcode==='sensing_of'));
  const recompiled=await compileReal02(project,f.assets);
  const before=await runReal02(f.project,f.assets,{bundle:original.bundle});const after=await runReal02(project,f.assets,{bundle:recompiled.bundle});
  assert.deepEqual(after.targets,before.targets);
 });
}
