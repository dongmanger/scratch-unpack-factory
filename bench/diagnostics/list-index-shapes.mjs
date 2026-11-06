// 看 plain 产物里 data_itemoflist / 动态列表索引实际生成的 JS 形状，并与真值积木的索引输入对照
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-plain.html'))));
const c = JSON.parse(un.compiledProject);
const shapes = new Map();
const add = (k, ex) => { const e = shapes.get(k) || {n: 0, ex}; e.n++; shapes.set(k, e); };
for (const t of Object.values(c.compiledTargets)) for (const kind of ['scripts', 'procedures']) for (const s of Object.values(t[kind])) {
  const src = s.factorySource;
  for (const m of src.matchAll(/(\w+)\.value\[([^\]]{1,80})\] \?\? ""/g)) {
    const idx = m[2].replace(/\b[a-z]\d+\b/g, 'v').replace(/\d+(\.\d+)?/g, 'N');
    add('value[' + idx + '] ?? ""', m[0]);
  }
  for (const m of src.matchAll(/listGet\(\w+\.value, ([^)]{1,60})\)/g)) {
    add('listGet(.., ' + m[1].replace(/\b[a-z]\d+\b/g, 'v').replace(/\d+(\.\d+)?/g, 'N') + ')', m[0]);
  }
  for (const m of src.matchAll(/(?:listDelete|listInsert|listReplace)\(\w+, ([^,)]{1,60})/g)) {
    add(m[0].split('(')[0] + '(.., ' + m[1].replace(/\b[a-z]\d+\b/g, 'v').replace(/\d+(\.\d+)?/g, 'N') + ')', m[0]);
  }
}
for (const [k, v] of [...shapes].sort((a, b) => b[1].n - a[1].n).slice(0, 22)) console.log(String(v.n).padStart(5), k);
