// 恢复出但与真值结构签名不一致的脚本:与同角色里最相近的未匹配真值脚本配对,汇总 opcode 差异。
// 目的:找出"重编译等价却不同于作者原图"的系统性拼写差异,以便按作者统计选更常见的写法。
// 用法: node bench/diagnostics/mismatch-causes.mjs <候选.sb3> [--truth ../samples/10128407.sb3] [--examples N]
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const candidateFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const truth = (await readProjectFile(path.resolve(opt('--truth', path.join('..', 'samples', '10128407.sb3'))))).project;
const candidate = (await readProjectFile(path.resolve(candidateFile))).project;
const examplesWanted = Number(opt('--examples', 8));

const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const truthScripts = listScripts(truth), candScripts = listScripts(candidate);
const remaining = new Map();
for (const s of truthScripts) remaining.set(key(s), [...(remaining.get(key(s)) || []), s]);
const unmatchedCand = [];
for (const s of candScripts) {
  const bucket = remaining.get(key(s));
  if (bucket?.length) bucket.pop(); else unmatchedCand.push(s);
}
const unmatchedTruth = [...remaining.values()].flat();

const opcodesOf = signature => [...signature.matchAll(/([a-z][a-z0-9]*_[a-z0-9_]+)(?:<[^>]*>)?/g)].map(m => m[1]);
const bag = list => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const similarity = (a, b) => {
  const A = bag(a), B = bag(b);
  let inter = 0, union = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) { inter += Math.min(A.get(k) || 0, B.get(k) || 0); union += Math.max(A.get(k) || 0, B.get(k) || 0); }
  return union ? inter / union : 1;
};

const byTarget = new Map();
for (const s of unmatchedTruth) byTarget.set(s.target + (s.isStage ? '#' : ''), [...(byTarget.get(s.target + (s.isStage ? '#' : '')) || []), s]);
const deltas = new Map();
const pairs = [];
let unpaired = 0;
const used = new Set();
for (const c of unmatchedCand) {
  const pool = (byTarget.get(c.target + (c.isStage ? '#' : '')) || []).filter(t => !used.has(t.id) && t.opcode === c.opcode);
  const cOps = opcodesOf(c.signature);
  let best = null, bestScore = -1;
  for (const t of pool) {
    const score = similarity(cOps, opcodesOf(t.signature));
    if (score > bestScore) { best = t; bestScore = score; }
  }
  if (!best || bestScore < 0.5) { unpaired++; continue; }
  used.add(best.id);
  pairs.push({c, t: best, score: bestScore});
  const cb = bag(cOps), tb = bag(opcodesOf(best.signature));
  for (const k of new Set([...cb.keys(), ...tb.keys()])) {
    const d = (cb.get(k) || 0) - (tb.get(k) || 0);
    if (d) deltas.set(k, (deltas.get(k) || 0) + d);
  }
}
console.log(`recovered scripts: ${candScripts.length}; unmatched (not structurally equal to truth): ${unmatchedCand.length}; paired with a similar truth script: ${pairs.length}; unpaired: ${unpaired}`);
const scoreBuckets = {'>=0.95': 0, '0.8-0.95': 0, '0.6-0.8': 0, '<0.6': 0};
for (const p of pairs) scoreBuckets[p.score >= 0.95 ? '>=0.95' : p.score >= 0.8 ? '0.8-0.95' : p.score >= 0.6 ? '0.6-0.8' : '<0.6']++;
console.log('similarity of pairs:', scoreBuckets);
const sorted = [...deltas].filter(([, n]) => n).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
console.log('\nopcode count: candidate minus truth (summed over pairs)');
for (const [k, n] of sorted.slice(0, 30)) console.log(String(n > 0 ? '+' + n : n).padStart(6), k);

// 差异最小的例子(最可能是单一拼写差异)
const tokens = signature => signature.split(/([;{},()|=])/).filter(Boolean);
pairs.sort((a, b) => b.score - a.score);
let shown = 0;
console.log('\nclosest pairs (first point where the signatures diverge):');
for (const {c, t, score} of pairs) {
  if (shown >= examplesWanted) break;
  const a = tokens(c.signature), b = tokens(t.signature);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (list) => list.slice(Math.max(0, i - 6), i + 10).join('');
  console.log(`\n[${c.target}] sim=${score.toFixed(2)} blocks cand=${c.blockCount} truth=${t.blockCount}\n  cand : ${ctx(a)}\n  truth: ${ctx(b)}`);
  shown++;
}
