// 沿“调用了未恢复过程”的依赖链追到叶子，统计真正的根因。兼容两种调用写法：
//   thread.procedures["Zname"](…)   和   thread.procedures.Zname(…)
// 输出同时给出“如果某一类根因被消除，最多能连带解放多少项”（影响面），用来排优先级。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';

const [dir, base] = process.argv.slice(2);
const relaxedMode = !process.argv.includes('--strict');
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const project = structuredClone(stripped);
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: relaxedMode});

const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);
const isCascade = r => /过程调用缺少唯一非warp定义/.test(r);
const failedProc = new Map(), failedScript = new Map();
for (const u of result.unresolved) {
  if (u.kind === 'procedure') failedProc.set(`${u.targetIndex}:${u.variant.slice(1)}`, u);
  else if (u.kind === 'script') failedScript.set(`${u.targetIndex}:${u.scriptId}`, u);
}
const calleesOf = (targetIndex, source) => [...source.matchAll(/procedures(?:\["([WZ][^"]+)"\]|\.([WZ][A-Za-z0-9_$]*))\s*\(/g)].map(m => (m[1] || m[2]).slice(1));
const sourceOf = u => {
  const entry = sidecar.compiledTargets[keyOf(u.targetIndex)];
  return u.kind === 'script' ? entry.scripts[u.scriptId]?.factorySource : entry.procedures[u.variant]?.factorySource;
};
// 叶子根因：自己不是级联、或者所有被调都已恢复
const rootOf = (u, seen = new Set()) => {
  if (!isCascade(u.reason)) return [{reason: u.reason, via: u}];
  const id = u.kind === 'script' ? `s${u.targetIndex}:${u.scriptId}` : `p${u.targetIndex}:${u.variant}`;
  if (seen.has(id)) return [];
  seen.add(id);
  const roots = [];
  for (const code of new Set(calleesOf(u.targetIndex, sourceOf(u) || ''))) {
    const callee = failedProc.get(`${u.targetIndex}:${code}`);
    if (callee) roots.push(...rootOf(callee, seen));
  }
  return roots;
};
const norm = s => String(s || '').replace(/[0-9a-f]{8,}/g, '#').replace(/"[^"]{0,60}"/g, 'S').replace(/\d+/g, 'N').slice(0, 84);
const direct = new Map(), blocked = new Map();
for (const u of [...failedProc.values(), ...failedScript.values()]) {
  const roots = rootOf(u);
  const keys = new Set(roots.map(r => norm(r.reason)));
  if (!isCascade(u.reason)) direct.set(norm(u.reason), (direct.get(norm(u.reason)) || 0) + 1);
  for (const k of keys) blocked.set(k, (blocked.get(k) || 0) + 1);   // 这一类根因“触及”的项数
}
const lines = [`mode=${relaxedMode ? 'relaxed' : 'strict'}  failed procedures=${failedProc.size} scripts=${failedScript.size}`, '', 'ROOT-CAUSE (leaf) reasons: items they directly block  |  items they touch through the call chain'];
for (const [k, n] of [...direct].sort((a, b) => b[1] - a[1]).slice(0, 16)) lines.push(`${String(n).padStart(4)} direct | ${String(blocked.get(k) || n).padStart(4)} touched  ${k}`);
fs.writeFileSync(path.resolve('..', 'work', 'leaf-causes.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
