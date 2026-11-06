// "other"(顶层既不是事件帽子也不是过程定义)类脚本:候选里没对上的是哪些,真值里对应的又是什么。
// 用法: node bench/diagnostics/other-scripts.mjs <候选.sb3> [--n 12]
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const truth = (await readProjectFile(path.resolve(opt('--truth', path.join('..', 'samples', '10128407.sb3'))))).project;
const candidate = (await readProjectFile(path.resolve(args[0]))).project;
const isOther = s => !/^event_|^procedures_definition$/.test(s.opcode);
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const tAll = listScripts(truth), cAll = listScripts(candidate);
const tOther = tAll.filter(isOther), cOther = cAll.filter(isOther);
const remaining = new Map();
for (const s of tAll) remaining.set(key(s), [...(remaining.get(key(s)) || []), s]);
const unmatched = [];
for (const s of cAll) { const b = remaining.get(key(s)); if (b?.length) b.pop(); else if (isOther(s)) unmatched.push(s); }
const byOpcode = list => list.reduce((m, s) => m.set(s.opcode, (m.get(s.opcode) || 0) + 1), new Map());
console.log(`truth 'other': ${tOther.length}   candidate 'other': ${cOther.length}   candidate 'other' not matching truth: ${unmatched.length}`);
console.log('truth other top opcodes    :', Object.fromEntries([...byOpcode(tOther)].sort((a, b) => b[1] - a[1]).slice(0, 8)));
console.log('candidate other top opcodes:', Object.fromEntries([...byOpcode(cOther)].sort((a, b) => b[1] - a[1]).slice(0, 8)));
console.log('unmatched candidate top opcodes:', Object.fromEntries([...byOpcode(unmatched)].sort((a, b) => b[1] - a[1]).slice(0, 8)));
const sizes = unmatched.map(s => s.blockCount).sort((a, b) => a - b);
console.log('unmatched block counts: min', sizes[0], 'median', sizes[Math.floor(sizes.length / 2)], 'max', sizes.at(-1));
for (const s of unmatched.slice(0, Number(opt('--n', 8)))) console.log(`  [${s.target}] ${s.opcode} blocks=${s.blockCount}  ${s.signature.slice(0, 150)}`);
// Are the unmatched candidates copies of procedure bodies? Compare against the truth's procedure bodies (definition's next chain).
const bodySignature = (project, s) => {
  const blocks = project.targets[s.targetIndex].blocks;
  const next = blocks[s.id]?.next;
  return next ? s.signature.slice(s.signature.indexOf(';') + 1) : '';
};
const procedureBodies = new Set(tAll.filter(s => s.opcode === 'procedures_definition').map(s => `${s.target}\u0000${bodySignature(truth, s)}`));
const copies = unmatched.filter(s => procedureBodies.has(`${s.target}\u0000${s.signature}`)).length;
console.log(`unmatched candidates whose structure equals a truth procedure BODY: ${copies}`);
