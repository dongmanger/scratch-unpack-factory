// 找出解混淆最慢的 factory，并在其中做函数级剖析（--cpu-prof 在 8GB 堆下失败，改用手工分段计时）
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscate} from '../../src/deobfuscate.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-strong.html'))));
const compiled = JSON.parse(un.compiledProject);
const all = [];
for (const [tk, e] of Object.entries(compiled.compiledTargets)) for (const kind of ['scripts', 'procedures'])
  for (const [id, s] of Object.entries(e[kind])) all.push({tk, kind, id, src: s.factorySource});
all.sort((a, b) => b.src.length - a.src.length);
console.log('largest 12 sources (KB):', all.slice(0, 12).map(x => (x.src.length / 1000).toFixed(0)).join(', '));
console.log('size distribution KB p50/p90/p99/max:', [0.5, 0.9, 0.99, 1].map(q => (all[Math.min(all.length - 1, Math.floor((1 - q) * all.length))].src.length / 1000).toFixed(1)).join(' / '));
const which = Number(process.argv[2] || 0);
const x = all[which];
const t = performance.now();
const d = deobfuscate(x.src);
console.log(`#${which} ${x.kind} ${(x.src.length / 1000).toFixed(0)}KB -> ${((performance.now() - t) / 1000).toFixed(1)}s, status=${d.status}`);
const passes = (d.report.transforms || []).map(p => p.pass);
const counts = passes.reduce((m, p) => m.set(p, (m.get(p) || 0) + 1), new Map());
console.log('pass counts:', Object.fromEntries(counts));
