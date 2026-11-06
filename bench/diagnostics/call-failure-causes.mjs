// 把“过程调用缺少唯一非warp定义或参数数量不符”拆成子原因：
//   missing-signature   : 被调过程根本没有登记签名（签名里没有该 proccode）
//   callee-unrecovered  : 签名存在，但被调过程体没被成功解码（不在 decodedProcedures 里）
//   prefix-mismatch     : 调用的变体前缀(W/Z)与按 signature.warp||isWarp 推出的不符
//   arity-mismatch      : 参数个数不符
//   variant-absent      : 签名里没有这个具体变体
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {collectProcedureSignatures} from '../../src/recovery-procedures.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

const project = structuredClone(stripped);
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: true});
const recoveredProc = new Set(result.procedures.filter(p => p.status === 'reconstructed-unverified').map(p => `${p.targetIndex}:${p.variant.slice(1)}`));
const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);

const causes = new Map();
const note = (c, ex) => { const e = causes.get(c) || {n: 0, ex}; e.n++; causes.set(c, e); };
for (const u of result.unresolved) {
  if (!/过程调用缺少唯一非warp定义/.test(u.reason)) continue;
  const entry = sidecar.compiledTargets[keyOf(u.targetIndex)];
  const src = u.kind === 'script' ? entry.scripts[u.scriptId]?.factorySource : entry.procedures[u.variant]?.factorySource;
  const signatures = collectProcedureSignatures(entry, u.targetIndex);
  const callee = [...(src || '').matchAll(/procedures\["([WZ])([^"]+)"\]\(/g)].map(m => ({prefix: m[1], code: m[2]}));
  let cause = 'no-call-found-in-source';
  for (const c of callee) {
    const sig = signatures.get(c.code);
    if (!sig) { cause = 'missing-signature'; break; }
    if (!sig.variants.some(v => v.variant === c.prefix + c.code)) { cause = 'variant-absent'; break; }
    if (!recoveredProc.has(`${u.targetIndex}:${c.code}`)) { cause = 'callee-unrecovered'; break; }
  }
  note(`${u.kind}:${cause}`, `${u.kind} ${u.scriptId || u.variant}`);
}
const lines = [`failures with this reason: ${[...causes.values()].reduce((a, e) => a + e.n, 0)}`];
for (const [c, e] of [...causes].sort((a, b) => b[1].n - a[1].n)) lines.push(`${String(e.n).padStart(5)} ${c}   e.g. ${e.ex}`);
fs.writeFileSync(path.resolve('..', 'work', 'call-causes.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
