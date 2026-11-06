// 解混淆“规范形还原度”基准。
//
// Strong 与 plain 产物的 factory 一一对应（脚本键、过程变体键完全相同），而 plain 就是编译器的原始输出。
// 因此：deobfuscate(strong) 与 plain 做 α-规范化比较，相等 == 解混淆已还原到编译器规范形。
//
// 用法: node bench/deobf-exact.mjs [--stride N] [--offset K] [--max N] [--show N] [--cache file]
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../src/static-unpack.mjs';
import {deobfuscateMany} from '../src/deobfuscate-pool.mjs';
import {canonicalizeFactory} from '../src/recompile-oracle.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const stride = Number(opt('--stride', 1)), offset = Number(opt('--offset', 0)), max = Number(opt('--max', 1e9)), show = Number(opt('--show', 6));
const strongFile = opt('--strong', '../compiled/o2/10128407-strong.html');
const plainFile = opt('--plain', '../compiled/o2/10128407-plain.html');

const load = async rel => JSON.parse((await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve(rel))))).compiledProject);
const [strong, plain] = await Promise.all([load(strongFile), load(plainFile)]);

const items = [];
for (const [tk, e] of Object.entries(strong.compiledTargets)) for (const kind of ['scripts', 'procedures'])
  for (const [id, s] of Object.entries(e[kind])) {
    const p = plain.compiledTargets[tk]?.[kind]?.[id];
    if (p) items.push({tk, kind, id, strong: s.factorySource, plain: p.factorySource});
  }
const picked = items.filter((_, i) => i % stride === offset % stride).slice(0, max);

const t0 = performance.now();
const results = await deobfuscateMany(picked.map(x => x.strong));
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const canon = code => { try { return canonicalizeFactory(code); } catch (e) { return `PARSE-ERROR:${e.message}`; } };
let exact = 0, failed = 0;
const misses = [];
picked.forEach((x, i) => {
  const r = results[i];
  if (!r.ok) { failed++; misses.push({...x, why: 'deobfuscate threw: ' + r.error.message, got: '', want: canon(x.plain)}); return; }
  const got = canon(r.value.code), want = canon(x.plain);
  if (got === want) exact++;
  else misses.push({...x, got, want, why: 'differs', status: r.value.report?.status});
});

// 差异指纹：第一个不同位置附近的片段，归一化数字/标识符后聚类
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const fingerprint = m => {
  const i = firstDiff(m.got, m.want);
  const g = m.got.slice(Math.max(0, i - 10), i + 40).replace(/x\d+/g, 'X').replace(/\d+/g, 'N');
  const w = m.want.slice(Math.max(0, i - 10), i + 40).replace(/x\d+/g, 'X').replace(/\d+/g, 'N');
  return `got[${g}]  want[${w}]`;
};
const clusters = new Map();
for (const m of misses) { const k = fingerprint(m); (clusters.get(k) || clusters.set(k, []).get(k)).push(m); }

console.log(`factories ${picked.length} (stride ${stride}, offset ${offset}), deobfuscate ${secs}s`);
console.log(`EXACT canonical match: ${exact}/${picked.length} = ${(exact / picked.length * 100).toFixed(1)}%   (threw: ${failed})`);
const sorted = [...clusters].sort((a, b) => b[1].length - a[1].length);
console.log(`distinct first-diff fingerprints: ${sorted.length}`);
for (const [k, list] of sorted.slice(0, show)) console.log(`\n${String(list.length).padStart(4)}x ${k.slice(0, 260)}`);
if (opt('--dump')) fs.writeFileSync(opt('--dump'), JSON.stringify(misses.map(m => ({tk: m.tk, kind: m.kind, id: m.id, why: m.why, got: m.got, want: m.want})), null, 1));
