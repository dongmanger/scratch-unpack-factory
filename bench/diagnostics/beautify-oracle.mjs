// beautify（not(not(x)) 折叠等）之后的积木图，重编译是否仍与原 factory 等价？
// 若成立，则可以在预言机裁决之后再美化，并对美化结果再验证一次。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {layoutRecoveredProject} from '../../src/recovery-layout.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';
import {structuralScore, readProjectFile} from '../score.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;

const evaluate = async (label, beautify) => {
  const project = structuredClone(stripped);
  const result = recoverCompiledCode(project, sidecar, {beautify, validatedForBeautify: beautify});
  if (beautify) layoutRecoveredProject(project);
  const {bundle} = await compileProject(project, zip);
  let match = 0, mismatch = 0, missing = 0;
  for (const s of result.scripts) {
    if (s.status !== 'reconstructed-unverified' || s.event?.kind === 'none') continue;
    const key = Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === s.targetIndex);
    const shipped = sidecar.compiledTargets[key].scripts[s.scriptId], rebuilt = bundle.compiledTargets[s.targetIndex]?.scripts?.[s.scriptId];
    if (!rebuilt) { missing++; continue; }
    comparableFactory(shipped.factorySource) === comparableFactory(rebuilt.factorySource) ? match++ : mismatch++;
  }
  const sc = structuralScore(truth, project);
  console.log(`${label.padEnd(18)} recompile match ${match}, mismatch ${mismatch}, missing ${missing}   truth script hits ${sc.matchedScripts}/${sc.truthScripts}`);
};
await evaluate('beautify=false', false);
await evaluate('beautify=true', true);
