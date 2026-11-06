// 找 peer 输出里“≥90% 相似但不完全相等”的脚本，打印真值 vs peer 的 opcode 序列差异，归纳系统性偏差
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refs = input => Array.isArray(input) ? (typeof input[1] === 'string' ? [input[1]] : []) :
  isObject(input) ? ['block', 'shadow'].map(k => input[k]).filter(v => typeof v === 'string') : [];
function flatten(blocks, topId) {
  const out = [];
  const visit = (id, depth) => {
    const b = blocks[id];
    if (!isObject(b) || depth > 400) return;
    if (!b.shadow) out.push(b.opcode);
    for (const name of Object.keys(b.inputs || {}).sort()) for (const r of refs(b.inputs[name])) if (blocks[r] && !blocks[r].shadow) visit(r, depth + 1);
    if (typeof b.next === 'string') visit(b.next, depth + 1);
  };
  visit(topId, 0);
  return out;
}
// 简单 diff：返回 truth 里缺失 / candidate 里多出的 opcode 多重集合
const bag = a => a.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const scripts = project => {
  const out = [];
  (project.targets || []).forEach((t, i) => {
    for (const [id, b] of Object.entries(t.blocks || {})) if (isObject(b) && b.topLevel) out.push({name: t.name, stage: !!t.isStage, id, ops: flatten(t.blocks, id)});
  });
  return out;
};
const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = scripts((await readProjectFile(truthPath)).project);
const cand = scripts((await readProjectFile(path.resolve(process.argv[2]))).project);
const missing = new Map(), extra = new Map();
let compared = 0;
for (const t of truth) {
  const pool = cand.filter(c => (c.stage ? '#stage' : c.name) === (t.stage ? '#stage' : t.name));
  let best = null, bestScore = -1;
  const tb = bag(t.ops);
  for (const c of pool) {
    const cb = bag(c.ops);
    let inter = 0;
    for (const [k, n] of tb) inter += Math.min(n, cb.get(k) || 0);
    const score = inter / Math.max(t.ops.length, c.ops.length, 1);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore >= 1 || bestScore < 0.7) continue;
  compared++;
  const cb = bag(best.ops);
  for (const [k, n] of tb) { const d = n - (cb.get(k) || 0); if (d > 0) missing.set(k, (missing.get(k) || 0) + d); }
  for (const [k, n] of cb) { const d = n - (tb.get(k) || 0); if (d > 0) extra.set(k, (extra.get(k) || 0) + d); }
}
const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${String(n).padStart(4)} ${k}`);
console.log('compared near-miss scripts:', compared);
console.log('--- 真值有、peer 缺失 (peer 漏掉/改写) ---'); console.log(top(missing).join('\n'));
console.log('--- peer 有、真值没有 (peer 多造) ---'); console.log(top(extra).join('\n'));
