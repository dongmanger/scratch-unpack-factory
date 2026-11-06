// 配对后,哪些脚本贡献了某个 opcode 的盈余(候选比真值多)。用法: node bench/diagnostics/opcode-surplus.mjs <候选.sb3> <opcode> [--n 8]
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const [candidateFile, opcode] = args;
const truth = (await readProjectFile(path.resolve(opt('--truth', path.join('..', 'samples', '10128407.sb3'))))).project;
const candidate = (await readProjectFile(path.resolve(candidateFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const t = listScripts(truth), c = listScripts(candidate);
const remaining = new Map();
for (const s of t) remaining.set(key(s), [...(remaining.get(key(s)) || []), s]);
const unmatched = [];
for (const s of c) { const b = remaining.get(key(s)); if (b?.length) b.pop(); else unmatched.push(s); }
const unmatchedTruth = [...remaining.values()].flat();
const opsOf = signature => [...signature.matchAll(/([a-z][a-z0-9]*_[a-z0-9_]+)/g)].map(m => m[1]);
const bag = list => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const sim = (a, b) => { const A = bag(a), B = bag(b); let i = 0, u = 0; for (const k of new Set([...A.keys(), ...B.keys()])) { i += Math.min(A.get(k) || 0, B.get(k) || 0); u += Math.max(A.get(k) || 0, B.get(k) || 0); } return u ? i / u : 1; };
const used = new Set();
const rows = [];
for (const cs of unmatched) {
  let best = null, bestScore = -1;
  for (const ts of unmatchedTruth) {
    if (used.has(ts.id) || ts.target !== cs.target || ts.opcode !== cs.opcode) continue;
    const score = sim(opsOf(cs.signature), opsOf(ts.signature));
    if (score > bestScore) { best = ts; bestScore = score; }
  }
  if (!best || bestScore < 0.5) continue;
  used.add(best.id);
  const delta = (bag(opsOf(cs.signature)).get(opcode) || 0) - (bag(opsOf(best.signature)).get(opcode) || 0);
  if (delta) rows.push({target: cs.target, top: cs.id, delta, score: bestScore, cand: cs.blockCount, truth: best.blockCount});
}
rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log(`${opcode}: ${rows.length} pairs differ; total delta ${rows.reduce((s, r) => s + r.delta, 0)}`);
for (const r of rows.slice(0, Number(opt('--n', 8)))) console.log(`${String(r.delta > 0 ? '+' + r.delta : r.delta).padStart(5)}  [${r.target}] sim=${r.score.toFixed(2)} blocks cand=${r.cand} truth=${r.truth} top=${r.top}`);
