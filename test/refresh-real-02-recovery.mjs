import fsp from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {compileReal02,runReal02} from './real-02-compiler.mjs';
import {recursiveRealFixture} from './real-02-recursive.mjs';

const inputRoot=new URL('../fixtures/real-02-v1/',import.meta.url);
const outputRoot=new URL('../fixtures/real-02-v1-reverified/',import.meta.url);
const manifest=JSON.parse(await fsp.readFile(new URL('manifest.json',inputRoot),'utf8'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
await fsp.mkdir(outputRoot,{recursive:true});
const source=await recursiveRealFixture();
const expected=await compileReal02(source.project,source.assets);
const before=await runReal02(source.project,source.assets,{bundle:expected.bundle});
const results=[];
for(const artifact of manifest.artifacts){
 const bytes=await fsp.readFile(new URL(artifact.path,inputRoot));assert.equal(sha256(bytes),artifact.sha256);
 const restored=await restoreSb3({staticResult:await staticUnpack(bytes),inputSha256:artifact.sha256});
 assert.equal(restored.report.code.unresolved.length,0);
 const generated=await compileReal02(restored.project,source.assets);
 const after=await runReal02(restored.project,source.assets,{bundle:generated.bundle});
 assert.deepEqual(after.targets,before.targets);
 const stem=`${artifact.level}-${artifact.target}`;
 await fsp.writeFile(new URL(`${stem}.reconstructed.sb3`,outputRoot),restored.data);
 await fsp.writeFile(new URL(`${stem}.fidelity.json`,outputRoot),JSON.stringify(restored.report,null,2));
 await fsp.writeFile(new URL(`${stem}.decoded.json`,outputRoot),restored.decodedCompiledProject);
 results.push({sourceArtifact:artifact.path,sourceArtifactSha256:artifact.sha256,packagerRevision:manifest.provenance.packagerRevision,
  vmRevision:manifest.provenance.vmRevision,output:`${stem}.reconstructed.sb3`,outputSha256:sha256(restored.data),
  status:restored.report.status,unresolved:restored.report.code.unresolved,deobfuscationResiduals:restored.report.deobfuscation.factories.flatMap(item=>item.residuals),
  actualVMRecompiled:true,finalStateMatchesTrustedSource:true,finalState:after.targets,remainingThreads:after.remainingThreads});
 console.log(`${artifact.path}: two scripts recovered, recompile/runtime state match`);
}
await fsp.writeFile(new URL('evidence.json',outputRoot),JSON.stringify({kind:'actual-02-packager-static-recovery-real-vm-differential',
 inputManifest:'../real-02-v1/manifest.json',compilerProvenance:expected.provenance,artifacts:results,
 limitations:['Fixture-only behavior evidence, not universal equivalence','Original internal block IDs/layout/comments not uniquely recoverable','No audio or renderer adapters in VM differential']},null,2));
