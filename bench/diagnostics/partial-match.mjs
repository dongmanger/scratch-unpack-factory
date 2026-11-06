// 部分匹配诊断：对每个真值脚本，在候选同角色脚本里找最相似者（opcode 序列的 LCS 相似度），
// 统计相似度分布，区分“完全对 / 差一点 / 完全没有”。
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refs = input => Array.isArray(input) ? (typeof input[1] === 'string' ? [input[1]] : []) :
  isObject(input) ? ['block', 'shadow'].map(k => input[k]).filter(v => typeof v === 'string') : [];

// 前序展开：opcode 序列（含嵌套输入与子栈）
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
const lcs = (a, b) => {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
};
const scripts = project => {
  const out = [];
  (project.targets || []).forEach((t, i) => {
    for (const [id, b] of Object.entries(t.blocks || {})) if (isObject(b) && b.topLevel) out.push({ti: i, name: t.name, stage: !!t.isStage, ops: flatten(t.blocks, id)});
  });
  return out;
};

const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = scripts((await readProjectFile(truthPath)).project);
const cand = scripts((await readProjectFile(path.resolve(process.argv[2]))).project);
const byTarget = new Map();
for (const c of cand) (byTarget.get(c.stage ? '#stage' : c.name) || byTarget.set(c.stage ? '#stage' : c.name, []).get(c.stage ? '#stage' : c.name)).push(c);

const buckets = {exact: 0, '>=90%': 0, '70-90%': 0, '40-70%': 0, '<40%': 0, none: 0};
let totalOps = 0, matchedOps = 0;
for (const t of truth) {
  totalOps += t.ops.length;
  const pool = byTarget.get(t.stage ? '#stage' : t.name) || [];
  let best = 0;
  for (const c of pool) {
    if (Math.abs(c.ops.length - t.ops.length) > t.ops.length) continue;
    const sim = lcs(t.ops, c.ops);
    if (sim > best) best = sim;
  }
  matchedOps += best;
  const ratio = t.ops.length ? best / Math.max(t.ops.length, 1) : 0;
  if (!pool.length || best === 0) buckets.none++;
  else if (best === t.ops.length && pool.some(c => c.ops.length === t.ops.length && lcs(t.ops, c.ops) === t.ops.length)) buckets.exact++;
  else if (ratio >= 0.9) buckets['>=90%']++;
  else if (ratio >= 0.7) buckets['70-90%']++;
  else if (ratio >= 0.4) buckets['40-70%']++;
  else buckets['<40%']++;
}
console.log(path.basename(process.argv[2]), '真值脚本', truth.length, '候选脚本', cand.length);
console.log(buckets);
console.log('opcode 序列 LCS 覆盖率', (matchedOps / totalOps * 100).toFixed(1) + '%');
