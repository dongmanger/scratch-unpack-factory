// 并行跑全部 factory，记录每个的墙钟耗时分布，识别长尾（输出 JSON 供后续比较）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscate} from '../../src/deobfuscate.mjs';

if (!isMainThread) {
  parentPort.on('message', ({i, src}) => {
    const t = performance.now();
    let ok = true;
    try { deobfuscate(src); } catch { ok = false; }
    parentPort.postMessage({i, ms: performance.now() - t, ok});
  });
} else {
  const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve(process.argv[2] || '../compiled/o2/10128407-strong.html'))));
  const compiled = JSON.parse(un.compiledProject);
  const all = [];
  for (const [tk, e] of Object.entries(compiled.compiledTargets)) for (const kind of ['scripts', 'procedures'])
    for (const [id, s] of Object.entries(e[kind])) all.push({tk, kind, id, bytes: s.factorySource.length, src: s.factorySource});
  const order = all.map((_, i) => i).sort((a, b) => all[b].bytes - all[a].bytes);
  const n = Math.min(os.availableParallelism() - 1, 11);
  const times = new Array(all.length);
  let cursor = 0, done = 0;
  const t0 = performance.now();
  await new Promise(resolve => {
    for (let w = 0; w < n; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), {resourceLimits: {maxOldGenerationSizeMb: 2048}});
      const feed = () => { if (cursor >= order.length) { worker.terminate(); return; } const i = order[cursor++]; worker.postMessage({i, src: all[i].src}); };
      worker.on('message', r => { times[r.i] = r.ms; if (++done === all.length) resolve(); feed(); });
      feed();
    }
  });
  const wall = (performance.now() - t0) / 1000;
  const total = times.reduce((a, b) => a + b, 0) / 1000;
  const sorted = times.map((ms, i) => ({ms, ...all[i], src: undefined})).sort((a, b) => b.ms - a.ms);
  console.log(`workers=${n} wall=${wall.toFixed(1)}s cpuSum=${total.toFixed(1)}s ideal=${(total / n).toFixed(1)}s efficiency=${(total / n / wall * 100).toFixed(0)}%`);
  console.log('top 10 (s / KB / id):', sorted.slice(0, 10).map(x => `${(x.ms / 1000).toFixed(1)}/${(x.bytes / 1000).toFixed(0)}/${x.kind[0]}:${x.id.slice(0, 18)}`).join('  '));
  const pct = q => (sorted[Math.floor((1 - q) * sorted.length)].ms / 1000).toFixed(2);
  console.log(`p50=${pct(0.5)}s p90=${pct(0.9)}s p99=${pct(0.99)}s max=${(sorted[0].ms / 1000).toFixed(1)}s; top1 share of cpu=${(sorted[0].ms / 1000 / total * 100).toFixed(0)}%, top10 share=${(sorted.slice(0, 10).reduce((a, x) => a + x.ms, 0) / 1000 / total * 100).toFixed(0)}%`);
  fs.writeFileSync(path.resolve('../work/factory-times.json'), JSON.stringify(sorted.map(x => ({tk: x.tk, kind: x.kind, id: x.id, bytes: x.bytes, ms: Math.round(x.ms)}))));
}
