// 两个候选在真值脚本上的命中集合是否互补
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = (await readProjectFile(truthPath)).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const hits = async file => {
  const {project} = await readProjectFile(path.resolve(file));
  const bag = new Map();
  for (const s of listScripts(project)) bag.set(key(s), (bag.get(key(s)) || 0) + 1);
  const out = new Set();
  const left = new Map(bag);
  listScripts(truth).forEach((s, i) => {
    if ((left.get(key(s)) || 0) > 0) { left.set(key(s), left.get(key(s)) - 1); out.add(i); }
  });
  return out;
};
const [a, b] = process.argv.slice(2);
const A = await hits(a), B = await hits(b);
const both = [...A].filter(i => B.has(i)).length;
const onlyA = A.size - both, onlyB = B.size - both;
console.log({A: A.size, B: B.size, both, onlyA, onlyB, union: A.size + onlyB, total: listScripts(truth).length});
