// “脚本体含尚未支持或仍混淆的操作”：是哪条语句不被识别？按语句形态聚类。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {parse} from 'acorn';
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

// 取语句的“形状”：调用的完整路径或语句类型，数字与字符串归一
const shape = (node, src) => {
  const text = src.slice(node.start, node.end).replace(/\s+/g, ' ');
  return text.replace(/"[^"]*"/g, '"…"').replace(/\b[a-z]\d+\b/g, 'v').replace(/\d+(\.\d+)?/g, 'N').slice(0, 90);
};
const hist = new Map();
for (const u of result.unresolved) {
  if (!/脚本体含尚未支持/.test(u.reason)) continue;
  const entry = sidecar.compiledTargets[keyOf(u.targetIndex)];
  const src = u.kind === 'script' ? entry.scripts[u.scriptId]?.factorySource : entry.procedures[u.variant]?.factorySource;
  if (!src) continue;
  const ast = parse(src, {ecmaVersion: 'latest'});
  const fn = ast.body[0].expression.body.body.at(-1).argument;      // the returned script function
  // 统计函数体里每个顶层/嵌套的 ExpressionStatement 形状里不在常见集合中的
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'ExpressionStatement') {
      const s = shape(n, src);
      const known = /^(?:v\.value = |v\.value\.(?:push|pop|shift|unshift)|yield|retire|return|thread\.procedures|target\.set|listReplace|listInsert|listDelete|runtime\.(?:ext_scratch3_motion|stop|requestRedraw|ioDevices\.clock)|startHats|yield\* )/.test(s);
      if (!known) hist.set(s, (hist.get(s) || 0) + 1);
    }
    for (const k of Object.keys(n)) if (!['start', 'end', 'loc'].includes(k)) walk(n[k]);
  };
  walk(fn.body);
}
const lines = [`distinct unfamiliar statement shapes: ${hist.size}`];
for (const [s, n] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 18)) lines.push(`${String(n).padStart(4)}  ${s}`);
fs.writeFileSync(path.resolve('..', 'work', 'unsupported-ops.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
