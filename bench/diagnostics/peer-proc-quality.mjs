// peer 的过程体质量上限：与真值过程体（按 角色+proccode 对齐）比 opcode 序列相似度。
// 若多数 <95%，peer 过程候选即使送去预言机也大概率被否决，不值得做昂贵的 ID 嫁接。
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refs = input => Array.isArray(input) ? (typeof input[1] === 'string' ? [input[1]] : []) :
  isObject(input) ? ['block', 'shadow'].map(k => input[k]).filter(v => typeof v === 'string') : [];
const flatten = (blocks, id) => {
  const out = [];
  const visit = (bid, d) => {
    const b = blocks[bid];
    if (!isObject(b) || d > 400) return;
    if (!b.shadow && b.opcode !== 'procedures_definition' && b.opcode !== 'procedures_prototype') out.push(b.opcode);
    for (const n of Object.keys(b.inputs || {}).sort()) for (const r of refs(b.inputs[n])) if (blocks[r] && !blocks[r].shadow) visit(r, d + 1);
    if (typeof b.next === 'string') visit(b.next, d);
  };
  visit(id, 0);
  return out;
};
const procs = project => {
  const out = new Map();
  project.targets.forEach(t => {
    for (const [id, b] of Object.entries(t.blocks || {})) {
      if (b.opcode !== 'procedures_definition' || !b.topLevel) continue;
      const proto = t.blocks[b.inputs?.custom_block?.[1]] || Object.values(t.blocks).find(x => x.opcode === 'procedures_prototype' && x.parent === id);
      if (proto?.mutation?.proccode) out.set(`${t.name}\0${proto.mutation.proccode}`, flatten(t.blocks, id));
    }
  });
  return out;
};
const lcs = (a, b) => { let prev = new Array(b.length + 1).fill(0); for (let i = 1; i <= a.length; i++) { const cur = new Array(b.length + 1).fill(0); for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); prev = cur; } return prev[b.length]; };
const truth = procs((await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project);
const peer = procs((await readProjectFile(path.resolve(process.argv[2]))).project);
const buckets = {exact: 0, '>=95%': 0, '80-95%': 0, '<80%': 0, absent: 0};
for (const [k, t] of truth) {
  const p = peer.get(k);
  if (!p) { buckets.absent++; continue; }
  const sim = t.length ? lcs(t, p) / Math.max(t.length, p.length) : 1;
  if (sim === 1) buckets.exact++; else if (sim >= 0.95) buckets['>=95%']++; else if (sim >= 0.8) buckets['80-95%']++; else buckets['<80%']++;
}
console.log('truth procedures', truth.size, 'peer procedures', peer.size, buckets);
