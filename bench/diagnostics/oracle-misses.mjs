// 找出真值重编译后与 plain 产物对不上的 factory，打印首个差异点
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-plain.html'))));
const shipped = JSON.parse(un.compiledProject);
const archive = await JSZip.loadAsync(un.data);
const truth = JSON.parse(fs.readFileSync(path.resolve('../samples/10128407.sb3'), 'utf8'));
const {bundle} = await compileProject(truth, archive);

const entries = b => {
  const out = [];
  for (const [tk, e] of Object.entries(b.compiledTargets)) for (const kind of ['scripts', 'procedures'])
    for (const [id, s] of Object.entries(e[kind])) { let c; try { c = comparableFactory(s.factorySource); } catch { c = null; } out.push({tk, kind, id, c, raw: s.factorySource}); }
  return out;
};
const A = entries(shipped), B = entries(bundle);
const setB = new Map();
for (const x of B) (setB.get(`${x.tk}\0${x.c}`) || setB.set(`${x.tk}\0${x.c}`, []).get(`${x.tk}\0${x.c}`)).push(x);
const unmatched = A.filter(x => !setB.has(`${x.tk}\0${x.c}`));
const setA = new Set(A.map(x => `${x.tk}\0${x.c}`));
const unmatchedB = B.filter(x => !setA.has(`${x.tk}\0${x.c}`));
console.log('unmatched shipped', unmatched.length, 'unmatched recompiled', unmatchedB.length);
// 对每个未匹配的 shipped，找同 target、长度最接近的 recompiled 并打印首个差异
for (const a of unmatched.slice(0, 6)) {
  const pool = unmatchedB.filter(b => b.tk === a.tk && b.kind === a.kind);
  let best = null, bd = Infinity;
  for (const b of pool) { const d = Math.abs((b.c || '').length - (a.c || '').length); if (d < bd) { bd = d; best = b; } }
  console.log('\n---', a.tk, a.kind, a.id.slice(0, 40), 'len', a.c?.length, 'cand', best?.c?.length);
  if (a.c && best?.c) {
    let i = 0; while (i < a.c.length && a.c[i] === best.c[i]) i++;
    console.log(' shipped :', a.c.slice(Math.max(0, i - 70), i + 90));
    console.log(' recomp  :', best.c.slice(Math.max(0, i - 70), i + 90));
  } else console.log(' (no counterpart / canonicalize failed)');
}
