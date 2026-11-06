// 看“调用写法未被我的探测匹配”的 factory 里，过程调用到底怎么写
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const project = structuredClone(stripped);
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: true});
const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);

const forms = new Map();
let shown = 0;
for (const u of result.unresolved) {
  if (!/过程调用缺少唯一非warp定义/.test(u.reason)) continue;
  const entry = sidecar.compiledTargets[keyOf(u.targetIndex)];
  const src = u.kind === 'script' ? entry.scripts[u.scriptId]?.factorySource : entry.procedures[u.variant]?.factorySource;
  if (!src || /procedures\["[WZ]/.test(src)) continue;
  // 抓所有 procedures 相关的写法
  const hits = [...src.matchAll(/[\w.]*procedures[^\n;]{0,70}/g)].map(m => m[0].replace(/"[^"]{3,}"/g, '"…"').replace(/\d+/g, 'N'));
  for (const h of hits) forms.set(h, (forms.get(h) || 0) + 1);
  if (shown++ < 1) console.log('example', u.kind, u.scriptId || u.variant, '\n', src.slice(0, 600));
}
console.log('call forms (procedures-related) in factories whose calls my probe missed:');
for (const [f, n] of [...forms].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(n).padStart(4), f);
