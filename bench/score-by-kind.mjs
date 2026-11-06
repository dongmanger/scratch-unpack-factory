// 按顶层类型（过程定义 / 事件脚本）分别统计结构命中，并对未命中的已恢复项做近似匹配诊断
import path from 'node:path';
import {readProjectFile, listScripts} from './score.mjs';

const [candFile] = process.argv.slice(2);
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const cand = (await readProjectFile(path.resolve(candFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const kindOf = s => s.opcode === 'procedures_definition' ? 'procedure' : s.opcode.startsWith('event_') || s.opcode === 'control_start_as_clone' ? 'event' : 'other';
const tScripts = listScripts(truth), cScripts = listScripts(cand);
const bag = new Map(); for (const s of cScripts) bag.set(key(s), (bag.get(key(s)) || 0) + 1);
const stats = {};
for (const k of ['procedure', 'event', 'other']) stats[k] = {truth: 0, candidate: 0, hit: 0};
for (const s of cScripts) stats[kindOf(s)].candidate++;
const left = new Map(bag);
for (const s of tScripts) { const k = kindOf(s); stats[k].truth++; if ((left.get(key(s)) || 0) > 0) { left.set(key(s), left.get(key(s)) - 1); stats[k].hit++; } }
for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(10)} truth ${String(v.truth).padStart(4)}  recovered ${String(v.candidate).padStart(4)}  exact-structure hits ${String(v.hit).padStart(4)}  (hit/recovered ${(v.candidate ? v.hit / v.candidate * 100 : 0).toFixed(0)}%)`);
