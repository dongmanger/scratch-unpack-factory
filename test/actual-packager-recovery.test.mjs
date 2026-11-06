import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {compileReal02,runReal02} from './real-02-compiler.mjs';
import {recursiveRealFixture} from './real-02-recursive.mjs';

const root=new URL('../fixtures/real-02-v1/',import.meta.url);
const manifest=JSON.parse(await fsp.readFile(new URL('manifest.json',root),'utf8'));
const sha256=data=>createHash('sha256').update(data).digest('hex');

for(const artifact of manifest.artifacts){
 test(`真实02packager ${artifact.level}/${artifact.target}提取恢复重编译，行为与源项目一致`,async()=>{
  const bytes=await fsp.readFile(new URL(artifact.path,root));
  assert.equal(sha256(bytes),artifact.sha256);
  const original=await recursiveRealFixture();
  const extraction=await staticUnpack(bytes);
  const restored=await restoreSb3({staticResult:extraction,inputSha256:sha256(bytes)});
  assert.equal(restored.validation.ok,true,restored.validation.errors.join('\n'));
  assert.equal(restored.report.status,'reconstructed-unverified');
  assert.deepEqual(restored.report.code.unresolved,[]);
  assert.ok(restored.report.deobfuscation.factories.every(record=>record.residuals.length===0),JSON.stringify(restored.report.deobfuscation));
  const expected=await compileReal02(original.project,original.assets);
  const regenerated=await compileReal02(restored.project,original.assets);
  const before=await runReal02(original.project,original.assets,{bundle:expected.bundle});
  const after=await runReal02(restored.project,original.assets,{bundle:regenerated.bundle});
  assert.deepEqual(after.targets,before.targets);
  assert.equal(after.targets[0].variables.varId1.value,'成功');
  assert.deepEqual(after.targets[0].variables.items.value,[3,5,7]);
  assert.equal(after.remainingThreads,0);
 });
}
