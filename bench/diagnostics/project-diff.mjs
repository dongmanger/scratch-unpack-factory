// 两个 sb3 的 project.json 差异：按 target 比较 blocks 的 ID 集合与逐块内容，归纳差在哪
import fs from 'node:fs';
import JSZip from '@turbowarp/jszip';

const load = async f => JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(f))).file('project.json').async('text'));
const [A, B] = await Promise.all([load(process.argv[2]), load(process.argv[3])]);
let onlyA = 0, onlyB = 0, changed = 0, same = 0;
const examples = [];
for (let i = 0; i < Math.max(A.targets.length, B.targets.length); i++) {
  const a = A.targets[i]?.blocks || {}, b = B.targets[i]?.blocks || {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(id in a)) { onlyB++; if (examples.length < 4) examples.push(['onlyB', i, id, b[id]?.opcode]); }
    else if (!(id in b)) { onlyA++; if (examples.length < 4) examples.push(['onlyA', i, id, a[id]?.opcode]); }
    else if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) { changed++; if (examples.length < 6) examples.push(['changed', i, id, a[id].opcode, JSON.stringify(a[id].inputs).slice(0, 100), JSON.stringify(b[id].inputs).slice(0, 100)]); }
    else same++;
  }
}
const nonBlock = JSON.stringify({...A, targets: A.targets.map(t => ({...t, blocks: 0, comments: 0}))}) === JSON.stringify({...B, targets: B.targets.map(t => ({...t, blocks: 0, comments: 0}))});
console.log({same, changed, onlyInBaseline: onlyA, onlyInNew: onlyB, everythingExceptBlocksAndCommentsIdentical: nonBlock});
for (const e of examples) console.log(JSON.stringify(e));
const commentDiff = A.targets.reduce((n, t, i) => n + (JSON.stringify(t.comments) !== JSON.stringify(B.targets[i]?.comments) ? 1 : 0), 0);
console.log('targets whose comments differ:', commentDiff);
