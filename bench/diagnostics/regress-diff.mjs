// 找出：strict 命中真值、但新方案丢失/改变的脚本，并给出它们的状态
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const [aFile, bFile] = process.argv.slice(2);
const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = (await readProjectFile(truthPath)).project;
const A = (await readProjectFile(path.resolve(aFile))).project;
const B = (await readProjectFile(path.resolve(bFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const hit = project => {
  const bag = new Map();
  for (const s of listScripts(project)) bag.set(key(s), (bag.get(key(s)) || 0) + 1);
  const out = new Set();
  listScripts(truth).forEach((s, i) => { if ((bag.get(key(s)) || 0) > 0) { bag.set(key(s), bag.get(key(s)) - 1); out.add(i); } });
  return out;
};
const ha = hit(A), hb = hit(B);
const lost = [...ha].filter(i => !hb.has(i)), gained = [...hb].filter(i => !ha.has(i));
console.log({aHits: ha.size, bHits: hb.size, lost: lost.length, gained: gained.length});
const ts = listScripts(truth);
for (const i of lost.slice(0, 5)) console.log('LOST  ', ts[i].target, ts[i].opcode, ts[i].signature.slice(0, 110));
for (const i of gained.slice(0, 3)) console.log('GAINED', ts[i].target, ts[i].opcode, ts[i].signature.slice(0, 110));
