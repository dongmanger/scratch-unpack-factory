// 两份 strict 输出的差异归因:基线里有、新输出里没有的顶层栈,是不是"过程体副本"(与新输出里某个过程的体结构相同)?
// 用法: node bench/diagnostics/strict-delta.mjs <基线.sb3> <新.sb3>
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const [baseFile, newFile] = process.argv.slice(2);
const base = (await readProjectFile(path.resolve(baseFile))).project;
const next = (await readProjectFile(path.resolve(newFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const bs = listScripts(base), ns = listScripts(next);
const remaining = new Map();
for (const s of ns) remaining.set(key(s), (remaining.get(key(s)) || 0) + 1);
const vanished = [];
for (const s of bs) {
  const left = remaining.get(key(s)) || 0;
  if (left > 0) remaining.set(key(s), left - 1); else vanished.push(s);
}
const gained = [];
const baseRemaining = new Map();
for (const s of bs) baseRemaining.set(key(s), (baseRemaining.get(key(s)) || 0) + 1);
for (const s of ns) {
  const left = baseRemaining.get(key(s)) || 0;
  if (left > 0) baseRemaining.set(key(s), left - 1); else gained.push(s);
}
// Body signature of a procedure definition: the chain after the definition block.
const bodies = new Set(ns.filter(s => s.opcode === 'procedures_definition').map(s => `${s.target}\u0000${s.signature.slice(s.signature.indexOf(';') + 1)}`));
const bodiesBase = new Set(bs.filter(s => s.opcode === 'procedures_definition').map(s => `${s.target}\u0000${s.signature.slice(s.signature.indexOf(';') + 1)}`));
const classify = s => s.opcode === 'procedures_definition' ? 'procedure definition' : /^event_/.test(s.opcode) ? 'event script' : 'loose stack';
const byKind = {};
let copies = 0, vanishedBlocks = 0;
for (const s of vanished) {
  const kind = classify(s);
  byKind[kind] = (byKind[kind] || 0) + 1;
  vanishedBlocks += s.blockCount;
  if (kind === 'loose stack' && (bodies.has(`${s.target}\u0000${s.signature}`) || bodiesBase.has(`${s.target}\u0000${s.signature}`))) copies++;
}
console.log(`scripts only in baseline: ${vanished.length} (${vanishedBlocks} blocks)`, byKind, ` of the loose stacks, equal to a procedure body: ${copies}`);
console.log(`scripts only in new output: ${gained.length}`, gained.reduce((m, s) => { const k = classify(s); m[k] = (m[k] || 0) + 1; return m; }, {}));
