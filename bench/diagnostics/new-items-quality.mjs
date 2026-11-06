// 两份输出之间“新增的”脚本/过程：它们与作者原图的结构一致性如何？（区分覆盖扩大的质量）
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const [oldFile, newFile] = process.argv.slice(2);
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const A = (await readProjectFile(path.resolve(oldFile))).project;
const B = (await readProjectFile(path.resolve(newFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const truthBag = new Map(); for (const s of listScripts(truth)) truthBag.set(key(s), (truthBag.get(key(s)) || 0) + 1);
const procCode = (project, ti, id) => { const t = project.targets[ti]; const d = t.blocks[id]; return t.blocks[d.inputs?.custom_block?.[1]]?.mutation?.proccode; };
const idOf = (project, s) => s.opcode === 'procedures_definition' ? `P:${s.targetIndex}:${procCode(project, s.targetIndex, s.id)}` : `S:${s.targetIndex}:${s.id}`;
const a = new Set(listScripts(A).map(s => idOf(A, s)));
const fresh = listScripts(B).filter(s => !a.has(idOf(B, s)));
const stat = {procedure: {n: 0, exact: 0}, event: {n: 0, exact: 0}, other: {n: 0, exact: 0}};
for (const s of fresh) {
  const k = s.opcode === 'procedures_definition' ? 'procedure' : s.opcode.startsWith('event_') || s.opcode === 'control_start_as_clone' ? 'event' : 'other';
  stat[k].n++;
  if ((truthBag.get(key(s)) || 0) > 0) stat[k].exact++;
}
console.log('newly recovered items (present in new, absent in old):', fresh.length);
for (const [k, v] of Object.entries(stat)) console.log(`  ${k.padEnd(10)} new=${String(v.n).padStart(3)}  structurally identical to the author's graph=${String(v.exact).padStart(3)}  (${v.n ? (v.exact / v.n * 100).toFixed(0) : '-'}%)`);
