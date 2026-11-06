// 把恢复结果与真值中"最相近但不相等"的脚本配对,各打印成缩进伪代码(含字面量与字段),并给出第一处行级差异。
// 用法: node bench/diagnostics/pair-view.mjs <候选.sb3> [--sidecar <*.deobfuscated-compiled-project.json>] [--n 6] [--skip 0] [--min 0.9] [--target Name]
import fs from 'node:fs';
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const candidateFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const truth = (await readProjectFile(path.resolve(opt('--truth', path.join('..', 'samples', '10128407.sb3'))))).project;
const candidate = (await readProjectFile(path.resolve(candidateFile))).project;
const wanted = Number(opt('--n', 6)), skip = Number(opt('--skip', 0)), minSim = Number(opt('--min', 0.9)), onlyTarget = opt('--target', null);
const sidecar = opt('--sidecar', null) ? JSON.parse(fs.readFileSync(path.resolve(opt('--sidecar')), 'utf8')) : null;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refOf = input => Array.isArray(input) && typeof input[1] === 'string' ? input[1] : null;
// SB3 stores a variable or list reporter inline as [12|13, name, id] instead of as a block reference.
const inlineReporter = input => {
  const inline = Array.isArray(input) ? (input[0] === 3 || input[0] === 2 ? input[1] : null) : null;
  return Array.isArray(inline) && (inline[0] === 12 || inline[0] === 13) ? `(${inline[0] === 12 ? 'var' : 'list'} ${inline[1]})` : null;
};
const shadowLiteral = input => {
  if (!Array.isArray(input)) return undefined;
  const shadow = input[0] === 3 ? input[2] : input[1];
  // Numbers and numeric strings are the same literal for our purposes; only the digits matter.
  if (Array.isArray(shadow) && shadow.length >= 2 && !Array.isArray(shadow[1])) return JSON.stringify(String(shadow[1]));
  return undefined;
};

/** One line per block; reporters are inlined as (opcode field:value input=...). */
function render(blocks, topId) {
  const reporter = (id, depth = 0) => {
    const b = blocks[id];
    if (!isObj(b) || depth > 40) return '?';
    // The names of procedure parameters are synthetic on the recovered side, so they are not compared.
    const fields = /^argument_reporter/.test(b.opcode) ? ['arg'] : Object.entries(b.fields || {}).map(([k, v]) => `${k}:${JSON.stringify(v?.[0])}`);
    const inputs = Object.entries(b.inputs || {}).map(([k, v]) => {
      const ref = refOf(v);
      if (ref && blocks[ref] && !blocks[ref].shadow) return `${k}=${reporter(ref, depth + 1)}`;
      const inline = inlineReporter(v);
      if (inline) return `${k}=${inline}`;
      const lit = shadowLiteral(v);
      return lit === undefined ? null : `${k}=${lit}`;
    }).filter(Boolean);
    const head = b.opcode.replace(/^(operator|data|control|procedures|looks|motion|sensing|event)_/, '$1.');
    return `(${[head + (b.mutation?.proccode ? `<${b.mutation.proccode}>` : ''), ...fields, ...inputs].join(' ')})`;
  };
  const lines = [];
  const stack = (first, indent) => {
    for (let id = first, guard = 0; id && blocks[id] && guard < 4000; id = blocks[id].next, guard++) {
      const b = blocks[id];
      const subs = Object.entries(b.inputs || {}).filter(([k, v]) => /^SUBSTACK/.test(k));
      const plain = { ...b, inputs: Object.fromEntries(Object.entries(b.inputs || {}).filter(([k]) => !/^SUBSTACK/.test(k))) };
      const copy = { ...blocks, [id]: plain };
      lines.push(`${'  '.repeat(indent)}${reporter.call(null, id) && (() => { const saved = blocks[id]; blocks[id] = plain; const text = reporter(id); blocks[id] = saved; return text; })()}`);
      for (const [name, input] of subs) { lines.push(`${'  '.repeat(indent + 1)}${name}:`); stack(refOf(input), indent + 2); }
    }
  };
  stack(topId, 0);
  return lines;
}

const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const tScripts = listScripts(truth), cScripts = listScripts(candidate);
const remaining = new Map();
for (const s of tScripts) remaining.set(key(s), [...(remaining.get(key(s)) || []), s]);
const unmatched = [];
for (const s of cScripts) { const bucket = remaining.get(key(s)); if (bucket?.length) bucket.pop(); else unmatched.push(s); }
const unmatchedTruth = [...remaining.values()].flat();
const ops = signature => [...signature.matchAll(/([a-z][a-z0-9]*_[a-z0-9_]+)/g)].map(m => m[1]);
const bag = list => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const sim = (a, b) => { const A = bag(a), B = bag(b); let i = 0, u = 0; for (const k of new Set([...A.keys(), ...B.keys()])) { i += Math.min(A.get(k) || 0, B.get(k) || 0); u += Math.max(A.get(k) || 0, B.get(k) || 0); } return u ? i / u : 1; };

const used = new Set();
const pairs = [];
for (const c of unmatched) {
  if (onlyTarget && c.target !== onlyTarget) continue;
  let best = null, bestScore = -1;
  for (const t of unmatchedTruth) {
    if (used.has(t.id) || t.target !== c.target || t.opcode !== c.opcode) continue;
    const score = sim(ops(c.signature), ops(t.signature));
    if (score > bestScore) { best = t; bestScore = score; }
  }
  if (best && bestScore >= minSim) { used.add(best.id); pairs.push({c, t: best, score: bestScore}); }
}
pairs.sort((a, b) => b.score - a.score || a.c.blockCount - b.c.blockCount);
console.log(`${pairs.length} pairs with similarity >= ${minSim}; showing ${Math.min(wanted, pairs.length - skip)} from ${skip}`);
for (const {c, t, score} of pairs.slice(skip, skip + wanted)) {
  const cl = render(candidate.targets[c.targetIndex].blocks, c.id), tl = render(truth.targets[t.targetIndex].blocks, t.id);
  console.log(`\n===== [${c.target}] sim=${score.toFixed(3)} blocks cand=${c.blockCount} truth=${t.blockCount}  cand-top=${c.id}`);
  let shown = 0, i = 0, j = 0;
  // Simple line diff by walking both and printing lines that differ (aligned by index; enough for local spelling differences).
  const max = Math.max(cl.length, tl.length);
  const clip = text => text === undefined ? '(none)' : text.length > 260 ? text.slice(0, 260) + ' …' : text;
  for (let k = 0; k < max && shown < Number(opt('--lines', 3)); k++) {
    if (cl[k] !== tl[k]) {
      console.log(`  line ${k}\n    cand : ${clip(cl[k])}\n    truth: ${clip(tl[k])}`);
      shown++;
    }
  }
  if (!shown) console.log('  (no aligned line differs; ordering/length differences only)');
  if (sidecar) {
    for (const entry of Object.values(sidecar.compiledTargets)) {
      if (entry.name !== c.target) continue;
      const hit = entry.scripts?.[c.id];
      if (hit && args.includes('--js')) console.log(`  shipped JS (${hit.factorySource.length} chars): ${hit.factorySource.slice(hit.factorySource.indexOf('return function')).slice(0, 500).replace(/\s+/g, ' ')}`);
    }
  }
}
