// 按阶段给流水线计时：静态提取 / 逐工厂解混淆 / 逐工厂美化 / 模板恢复 / 校验
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscate} from '../../src/deobfuscate.mjs';
import {prettifyFactorySource} from '../../src/pretty-code.mjs';

const file = process.argv[2] || '../compiled/o2/10128407-strong.html';
const limit = Number(process.argv[3] || 0);
const lap = (() => { let t = performance.now(); return () => { const n = performance.now(); const d = n - t; t = n; return d; }; })();
const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve(file))));
console.log(`staticUnpack            ${(lap() / 1000).toFixed(1)}s`);
const compiled = JSON.parse(un.compiledProject);
console.log(`parse compiled JSON     ${(lap() / 1000).toFixed(1)}s`);

const all = [];
for (const [tk, e] of Object.entries(compiled.compiledTargets)) for (const kind of ['scripts', 'procedures'])
  for (const [id, s] of Object.entries(e[kind])) all.push({tk, kind, id, src: s.factorySource});
const sample = limit ? all.slice(0, limit) : all;
console.log(`factories ${all.length}, timing ${sample.length}; total source ${(sample.reduce((a, x) => a + x.src.length, 0) / 1e6).toFixed(1)}MB`);

let deobf = 0, pretty = 0, sizeWeighted = [];
for (const x of sample) {
  const t0 = performance.now();
  const d = deobfuscate(x.src);
  const t1 = performance.now();
  prettifyFactorySource(d.code, {innerName: 'script'});
  const t2 = performance.now();
  deobf += t1 - t0; pretty += t2 - t1;
  sizeWeighted.push({id: x.id.slice(0, 30), kind: x.kind, bytes: x.src.length, deobfMs: t1 - t0, prettyMs: t2 - t1});
}
console.log(`deobfuscate (serial)    ${(deobf / 1000).toFixed(1)}s   avg ${(deobf / sample.length).toFixed(0)}ms`);
console.log(`prettify    (serial)    ${(pretty / 1000).toFixed(1)}s   avg ${(pretty / sample.length).toFixed(0)}ms`);
sizeWeighted.sort((a, b) => b.deobfMs - a.deobfMs);
console.log('slowest 5:', sizeWeighted.slice(0, 5).map(x => `${x.deobfMs.toFixed(0)}ms/${(x.bytes / 1000).toFixed(0)}KB ${x.kind}`).join(' | '));
const corr = (() => {
  // 耗时与体积是否近似线性
  const n = sizeWeighted.length; const xs = sizeWeighted.map(s => s.bytes), ys = sizeWeighted.map(s => s.deobfMs);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
})();
console.log(`corr(bytes, deobfMs)    ${corr.toFixed(2)}`);
