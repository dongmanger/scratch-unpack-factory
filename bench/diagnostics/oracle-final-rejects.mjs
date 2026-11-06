// 跑完整的重编译预言机,找出"第一轮可解码、最终没被接受"的项,并显示它们最后一次被拒时与产物的首个分歧处。
// 与 oracle-mismatches.mjs(只看第一轮)不同:这里的被拒项是真正丢掉的,不会被后续回退挽回。
// 用法: node bench/diagnostics/oracle-final-rejects.mjs <unpack输出目录> <基名> [--examples N]
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';

const args = process.argv.slice(2);
const [dir, base] = args;
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const examples = Number(opt('--examples', 12));

const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

const bundles = [];
const {result, oracle} = await recoverWithOracle(stripped, sidecar, {archive: zip,
  compile: async (project, archive) => { const r = await compileProject(project, archive); bundles.push(r.bundle); return r; }});
console.log(`oracle: ${bundles.length} compilations, ${oracle.rounds.length} rounds, verified ${oracle.verified}, strict-only ${oracle.strictOnly}`);

const accepted = new Set();
for (const p of result.procedures) if (p.status === 'reconstructed-unverified') accepted.add(`p:${p.targetIndex}:${p.variant}`);
for (const s of result.scripts) if (s.status === 'reconstructed-unverified') accepted.add(`s:${s.targetIndex}:${s.scriptId}`);

const keyOf = ti => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === ti);
const rejects = new Map();
bundles.forEach((bundle, call) => {
  for (const [ti, entry] of Object.entries(bundle.compiledTargets)) {
    const shippedTarget = sidecar.compiledTargets[keyOf(Number(ti))];
    if (!shippedTarget) continue;
    for (const kind of ['procedures', 'scripts']) {
      for (const [id, rebuilt] of Object.entries(entry[kind] || {})) {
        const shipped = shippedTarget[kind]?.[id];
        if (!shipped) continue;
        const key = `${kind === 'procedures' ? 'p' : 's'}:${ti}:${id}`;
        if (accepted.has(key)) continue;
        let a, b;
        try { a = comparableFactory(shipped.factorySource); b = comparableFactory(rebuilt.factorySource); } catch { continue; }
        if (a === b) rejects.delete(key); else rejects.set(key, {kind, ti: Number(ti), id, a, b, call, target: shippedTarget.name});
      }
    }
  }
});
// Definition-hat "scripts" of procedures have no event; they are not separate recoveries.
const real = [...rejects.values()].filter(r => !(r.kind === 'scripts' && /^(rf_|def)/.test(String(r.id))));
console.log(`candidates that were rebuilt at least once but are not in the final result: ${real.length} (procedures ${real.filter(r => r.kind === 'procedures').length}, scripts ${real.filter(r => r.kind === 'scripts').length})`);

const WINDOW = 80;
const firstDiff = (a, b) => {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const win = text => text.slice(Math.max(0, i - 50), i + WINDOW);
  return {a: win(a), b: win(b)};
};
const norm = text => text.replace(/\b(x|b|p)\d+\b/g, '$1#').replace(/"[^"]{0,40}"/g, 'S').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 120);
const groups = new Map();
for (const r of real) {
  r.d = firstDiff(r.a, r.b);
  const key = `${norm(r.d.a)}\n    =>  ${norm(r.d.b)}`;
  groups.set(key, [...(groups.get(key) || []), r]);
}
for (const [key, list] of [...groups].sort((x, y) => y[1].length - x[1].length).slice(0, examples)) {
  console.log(`\n${String(list.length).padStart(3)} items  e.g. [${list[0].target}] ${list[0].kind} ${String(list[0].id).slice(0, 36)}\n    ${key}`);
  console.log(`    raw shipped : ${list[0].d.a}\n    raw rebuilt : ${list[0].d.b}`);
}
