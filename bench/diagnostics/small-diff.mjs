// 第二个工程（437419376）：重编译 factory 与产物 factory 的并排比较
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';
import {compileProject, canonicalizeFactory} from '../../src/recompile-oracle.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const {project, result} = await recoverWithOracle(stripped, sidecar, {archive: zip});
const { bundle } = await compileProject(project, zip);
for (const s of result.scripts) {
  const key = Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === s.targetIndex);
  const shipped = sidecar.compiledTargets[key].scripts[s.scriptId]?.factorySource;
  const rebuilt = bundle.compiledTargets[s.targetIndex]?.scripts?.[s.scriptId]?.factorySource;
  console.log('---', s.targetIndex, s.scriptId, s.status, 'recompilation:', JSON.stringify(s.recompilation));
  console.log('SHIPPED :', shipped && canonicalizeFactory(shipped).slice(0, 700));
  console.log('REBUILT :', rebuilt && canonicalizeFactory(rebuilt).slice(0, 700));
}
