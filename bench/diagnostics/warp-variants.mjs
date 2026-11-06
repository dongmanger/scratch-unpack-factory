// 每个 proccode 在产物里有哪些变体（仅 W / 仅 Z / W+Z），对照真值里该过程自己声明的 warp。
// 用来验证规则：变体=W 当且仅当(调用者在 warp 中) 或 (被调过程自己声明了 warp)。
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-plain.html'))));
const compiled = JSON.parse(un.compiledProject);
const truth = JSON.parse(fs.readFileSync(path.resolve('../samples/10128407.sb3'), 'utf8'));

const declaredWarp = (targetIndex, proccode) => {
  for (const b of Object.values(truth.targets[targetIndex].blocks)) {
    if (b.opcode === 'procedures_prototype' && b.mutation?.proccode === proccode) {
      const w = b.mutation.warp;
      return typeof w === 'string' ? JSON.parse(w) : !!w;
    }
  }
  return null;
};

const table = new Map();
let total = 0;
for (const [key, entry] of Object.entries(compiled.compiledTargets)) {
  const ti = entry.targetIndex ?? Number(key);
  const byCode = new Map();
  for (const v of Object.keys(entry.procedures)) {
    const code = v.slice(1);
    (byCode.get(code) || byCode.set(code, new Set()).get(code)).add(v[0]);
  }
  for (const [code, set] of byCode) {
    total++;
    const shape = [...set].sort().join('+');
    const declared = declaredWarp(ti, code);
    const k = `variants=${shape.padEnd(3)} declaredWarp=${declared}`;
    table.set(k, (table.get(k) || 0) + 1);
  }
}
console.log('procedures (distinct proccode per target):', total);
for (const [k, n] of [...table].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), k);
