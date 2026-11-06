// 预言机自检：真值工程（已知正确答案）重编译后，其 factory 摘要应能与 plain 产物逐脚本对上。
// 若误判率高，预言机不能作为采纳依据。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from '../src/static-unpack.mjs';
import {compileProject, factoryDigest} from '../src/recompile-oracle.mjs';

const artifact = process.argv[2] || '../compiled/o2/10128407-plain.html';
const truthFile = process.argv[3] || '../samples/10128407.sb3';
const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve(artifact))));
const shipped = JSON.parse(un.compiledProject);
const archive = await JSZip.loadAsync(un.data);
const truth = JSON.parse(fs.readFileSync(path.resolve(truthFile), 'utf8'));

let t = Date.now();
const {bundle, errors} = await compileProject(truth, archive);
console.log(`重编译真值 ${((Date.now() - t) / 1000).toFixed(1)}s, compileErrors=${errors.length}`);

const digestsOf = entries => {
  const out = new Map();
  for (const [tk, e] of Object.entries(entries)) for (const kind of ['scripts', 'procedures']) {
    for (const [id, s] of Object.entries(e[kind])) {
      let d;
      try { d = factoryDigest(s.factorySource); } catch { d = 'ERR:' + id; }
      const key = `${tk}\u0000${d}`;
      (out.get(key) || out.set(key, []).get(key)).push({kind, id});
    }
  }
  return out;
};
t = Date.now();
const mine = digestsOf(bundle.compiledTargets);
const theirs = digestsOf(shipped.compiledTargets);
console.log(`规范化 ${((Date.now() - t) / 1000).toFixed(1)}s; 真值重编译摘要 ${mine.size}, 产物摘要 ${theirs.size}`);
let matched = 0, onlyShipped = 0;
for (const [k, list] of theirs) (mine.has(k) ? (matched += list.length) : (onlyShipped += list.length));
let onlyMine = 0;
for (const [k, list] of mine) if (!theirs.has(k)) onlyMine += list.length;
const total = [...theirs.values()].reduce((a, l) => a + l.length, 0);
console.log({shippedFactories: total, matched, onlyShipped, onlyRecompiled: onlyMine, matchRate: (matched / total * 100).toFixed(1) + '%'});
