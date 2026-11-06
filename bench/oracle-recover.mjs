// 用重编译预言机做 relaxed 恢复，并用真值评分。
// 用法: node bench/oracle-recover.mjs <unpack输出目录> <基名> [--out sb3路径]
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../src/relaxed-recovery.mjs';
import {structuralScore, readProjectFile} from './score.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

const t0 = performance.now();
const {project, result, oracle} = await recoverWithOracle(stripped, sidecar, {archive: zip,
  onRound: r => console.log(`  round ${r.round}: relaxed ${r.relaxedItems}, accepted ${r.accepted}, mismatched ${r.mismatched}, uncompiled ${r.uncompiled}`)});
const okScripts = result.scripts.filter(s => s.status === 'reconstructed-unverified' || s.status === 'procedure-body-copy').length;
const okProcs = result.procedures.filter(p => p.status === 'reconstructed-unverified').length;
console.log(`oracle recovery ${((performance.now() - t0) / 1000).toFixed(0)}s: scripts ${okScripts}/${result.scripts.length}, procedures ${okProcs}/${result.procedures.length}, ` +
  `verified-by-recompilation ${oracle.verified}, strict-only ${oracle.strictOnly}, unverified-after-final ${oracle.unverifiedAfterFinal}, converged=${oracle.converged}`);

const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = (await readProjectFile(truthPath)).project;
const s = structuralScore(truth, project);
const f = x => (x * 100).toFixed(1) + '%';
console.log(`vs truth: script recall ${f(s.scriptRecall)} (${s.matchedScripts}/${s.truthScripts}), script precision ${f(s.scriptPrecision)} (${s.matchedScripts}/${s.candidateScripts}), ` +
  `block recall ${f(s.blockRecall)}, block precision ${f(s.blockPrecision)}, inflation ${s.inflation.toFixed(2)}x`);
if (process.argv.includes('--out')) {
  const out = new JSZip();
  out.file('project.json', JSON.stringify(project));
  for (const [name, file] of Object.entries(zip.files)) if (!file.dir && name !== 'project.json') out.file(name, await file.async('uint8array'));
  fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1], await out.generateAsync({type: 'uint8array', compression: 'DEFLATE'}));
}
