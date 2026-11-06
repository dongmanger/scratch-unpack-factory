// 放宽候选里 verdict=missing（重编译产物中没有对应脚本/过程）的原因
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

const project = structuredClone(stripped);
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: true});
const {bundle, errors} = await compileProject(project, zip);
console.log('compile errors:', errors.length, errors.slice(0, 2));

const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);
const kinds = {procedure: {missing: 0, match: 0, mismatch: 0}, script: {missing: 0, match: 0, mismatch: 0}};
const samples = {missing: [], mismatch: []};
for (const p of result.procedures) {
  if (p.status !== 'reconstructed-unverified' || !p.assumptions?.length) continue;
  const rebuilt = bundle.compiledTargets[p.targetIndex]?.procedures?.[p.variant];
  const shipped = sidecar.compiledTargets[keyOf(p.targetIndex)].procedures[p.variant];
  if (!rebuilt) { kinds.procedure.missing++; if (samples.missing.length < 4) samples.missing.push({kind: 'procedure', variant: p.variant, targetIndex: p.targetIndex, have: Object.keys(bundle.compiledTargets[p.targetIndex]?.procedures || {}).filter(v => v.slice(1) === p.variant.slice(1))}); continue; }
  const same = comparableFactory(shipped.factorySource) === comparableFactory(rebuilt.factorySource);
  kinds.procedure[same ? 'match' : 'mismatch']++;
  if (!same && samples.mismatch.length < 2) samples.mismatch.push({variant: p.variant, assumptions: p.assumptions, shipped: comparableFactory(shipped.factorySource).slice(0, 400), rebuilt: comparableFactory(rebuilt.factorySource).slice(0, 400)});
}
for (const s of result.scripts) {
  if (s.status !== 'reconstructed-unverified' || !s.assumptions?.length || s.event?.kind === 'none') continue;
  const rebuilt = bundle.compiledTargets[s.targetIndex]?.scripts?.[s.scriptId];
  const shipped = sidecar.compiledTargets[keyOf(s.targetIndex)].scripts[s.scriptId];
  if (!rebuilt) { kinds.script.missing++; continue; }
  comparableFactory(shipped.factorySource) === comparableFactory(rebuilt.factorySource) ? kinds.script.match++ : kinds.script.mismatch++;
}
console.log(JSON.stringify(kinds));
for (const m of samples.missing) console.log('MISSING', JSON.stringify(m).slice(0, 300));
for (const m of samples.mismatch) { console.log('MISMATCH', m.variant, m.assumptions); console.log(' shipped:', m.shipped); console.log(' rebuilt:', m.rebuilt); }
