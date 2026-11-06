// 沿“调用了未恢复过程”的依赖链追到叶子，统计真正的根因（而不是级联症状）
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const {result} = await recoverWithOracle(stripped, sidecar, {archive: zip});

const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);
const failed = new Map();      // "p:target:variant" -> reason
for (const u of result.unresolved) if (u.kind === 'procedure') failed.set(`p:${u.targetIndex}:${u.variant}`, u.reason);
const callsOf = (targetIndex, variant) => {
  const src = sidecar.compiledTargets[keyOf(targetIndex)].procedures[variant].factorySource;
  return [...src.matchAll(/procedures\["([WZ][^"]+)"\]/g)].map(m => m[1]);
};
const isCascade = reason => /过程调用缺少唯一非warp定义/.test(reason);
const rootOf = (key, seen = new Set()) => {
  if (seen.has(key)) return {reason: '(调用环)', chain: 1};
  seen.add(key);
  const reason = failed.get(key);
  if (!reason) return null;
  if (!isCascade(reason)) return {reason, chain: 1};
  const [, ti, variant] = key.split(/:(\d+):/).length === 3 ? key.match(/^p:(\d+):(.*)$/) && ['', ...key.match(/^p:(\d+):(.*)$/).slice(1)] : [];
  for (const callee of callsOf(Number(ti), variant)) {
    const sibling = [...failed.keys()].find(k => k.startsWith(`p:${ti}:`) && k.slice(`p:${ti}:`.length).slice(1) === callee.slice(1));
    if (sibling) { const r = rootOf(sibling, new Set(seen)); if (r && !isCascade(r.reason)) return {...r, chain: r.chain + 1}; }
  }
  return {reason: '(级联：被调过程在别处失败/缺定义)', chain: 1};
};
const norm = s => String(s || '').replace(/[0-9a-f]{8,}/g, '#').replace(/"[^"]{0,60}"/g, 'S').replace(/\d+/g, 'N').slice(0, 90);
const h = new Map();
for (const key of failed.keys()) { const r = rootOf(key); const k = norm(r?.reason); h.set(k, (h.get(k) || 0) + 1); }
const lines = [`failed procedures ${failed.size}`];
for (const [k, n] of [...h].sort((a, b) => b[1] - a[1]).slice(0, 18)) lines.push(`${String(n).padStart(4)} ${k}`);
fs.writeFileSync(path.resolve('..', 'work', 'root-causes.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
