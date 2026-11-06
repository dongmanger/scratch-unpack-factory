// 同时有 W 与 Z 变体的过程：两个变体的 factory 除了调度 (yield) 之外是否一致？
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {canonicalizeFactory} from '../../src/recompile-oracle.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-plain.html'))));
const compiled = JSON.parse(un.compiledProject);
for (const [key, entry] of Object.entries(compiled.compiledTargets)) {
  const byCode = new Map();
  for (const v of Object.keys(entry.procedures)) (byCode.get(v.slice(1)) || byCode.set(v.slice(1), {}).get(v.slice(1)))[v[0]] = entry.procedures[v].factorySource;
  for (const [code, vs] of byCode) {
    if (!(vs.W && vs.Z)) continue;
    const w = canonicalizeFactory(vs.W), z = canonicalizeFactory(vs.Z);
    console.log(`\n== target ${key} "${code}"  W:${w.length} chars  Z:${z.length} chars  identical=${w === z}`);
    // 打印两者第一个差异点附近
    let i = 0; while (i < w.length && w[i] === z[i]) i++;
    console.log(' W:', w.slice(Math.max(0, i - 60), i + 140));
    console.log(' Z:', z.slice(Math.max(0, i - 60), i + 140));
  }
}
