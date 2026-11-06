// 已被预言机确认“行为等价”的项里，结构上与真值完全相同的比例，以及不同时的差异类型。
// 回答：召回上限被什么卡住——是没恢复，还是恢复了但与作者原图形态不同（编译器信息损失）。
import fs from 'node:fs';
import path from 'node:path';
import {readProjectFile, listScripts} from './score.mjs';

const dir = process.argv[2];
const base = process.argv[3];
const rep = JSON.parse(fs.readFileSync(path.join(dir, `${base}.fidelity-report.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const cand = (await readProjectFile(path.join(dir, sb3))).project;
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;

const verifiedScripts = rep.code.scripts.filter(s => s.recompilation?.status === 'match');
const verifiedProcs = rep.code.procedures.filter(p => p.recompilation?.status === 'match');
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const truthBag = new Map(); for (const s of listScripts(truth)) truthBag.set(key(s), (truthBag.get(key(s)) || 0) + 1);
const candByTop = new Map(); for (const s of listScripts(cand)) candByTop.set(`${s.targetIndex}:${s.id}`, s);
let scriptsExact = 0, scriptsOther = 0;
for (const v of verifiedScripts) {
  const s = candByTop.get(`${v.targetIndex}:${v.scriptId}`);
  if (!s) continue;
  if ((truthBag.get(key(s)) || 0) > 0) scriptsExact++; else scriptsOther++;
}
const procCand = listScripts(cand).filter(s => s.opcode === 'procedures_definition');
let procExact = 0;
for (const s of procCand) if ((truthBag.get(key(s)) || 0) > 0) procExact++;
console.log({
  scripts: {recompileVerified: verifiedScripts.length, structurallyIdenticalToAuthorsGraph: scriptsExact, equivalentButDifferentShape: scriptsOther},
  procedures: {recompileVerified: verifiedProcs.length, structurallyIdenticalToAuthorsGraph: procExact, equivalentButDifferentShape: verifiedProcs.length - procExact}
});
