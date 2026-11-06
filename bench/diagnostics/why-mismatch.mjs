// 被预言机否决（mismatch）的放宽候选：给出规范化后第一个不同点，归类“预言机太严”还是“候选真的不对”
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

// 给每个过程加探针调用（复用 relaxed-recovery 的逻辑思路：直接内联最小实现）
const probed = structuredClone(project);
const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);
for (const t of probed.targets.keys()) {
  const target = probed.targets[t];
  const protos = Object.values(target.blocks).filter(b => b.opcode === 'procedures_prototype' && b.mutation);
  if (!protos.length) continue;
  const hat = `probe_hat_${t}`;
  target.blocks[hat] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
  let prev = hat;
  protos.forEach((p, i) => {
    const ids = JSON.parse(p.mutation.argumentids || '[]'), defs = JSON.parse(p.mutation.argumentdefaults || '[]');
    const id = `probe_call_${t}_${i}`;
    target.blocks[id] = {opcode: 'procedures_call', next: null, parent: prev, inputs: Object.fromEntries(ids.filter((_, k) => defs[k] !== 'false').map(a => [a, [1, [4, '0']]])), fields: {}, shadow: false, topLevel: false,
      mutation: {tagName: 'mutation', children: [], proccode: p.mutation.proccode, argumentids: p.mutation.argumentids, warp: p.mutation.warp}};
    target.blocks[prev].next = id; prev = id;
  });
}
const {bundle} = await compileProject(probed, zip);
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
const buckets = new Map(); const detail = [];
const check = (rec, kind, id, tIdx) => {
  const rebuilt = bundle.compiledTargets[tIdx]?.[kind]?.[id];
  const shipped = sidecar.compiledTargets[keyOf(tIdx)]?.[kind]?.[id];
  if (!rebuilt || !shipped) return;
  const a = comparableFactory(shipped.factorySource), b = comparableFactory(rebuilt.factorySource);
  if (a === b) return;
  const i = firstDiff(a, b);
  const fp = `shipped[${a.slice(Math.max(0, i - 15), i + 45).replace(/x\d+/g, 'X').replace(/\d+/g, 'N')}]  rebuilt[${b.slice(Math.max(0, i - 15), i + 45).replace(/x\d+/g, 'X').replace(/\d+/g, 'N')}]`;
  const key = (rec.assumptions?.[0] || '').slice(0, 24) + ' || ' + fp;
  (buckets.get(key) || buckets.set(key, []).get(key)).push(id);
};
for (const p of result.procedures) if (p.status === 'reconstructed-unverified' && p.assumptions?.length) check(p, 'procedures', p.variant, p.targetIndex);
for (const s of result.scripts) if (s.status === 'reconstructed-unverified' && s.assumptions?.length && s.event?.kind !== 'none') check(s, 'scripts', s.scriptId, s.targetIndex);
const lines = [`mismatch clusters: ${buckets.size}, items ${[...buckets.values()].reduce((a, l) => a + l.length, 0)}`];
for (const [k, l] of [...buckets].sort((a, b) => b[1].length - a[1].length).slice(0, 14)) lines.push(`${String(l.length).padStart(3)}x ${k.slice(0, 330)}`);
fs.writeFileSync(path.resolve('..', 'work', 'mismatch.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
