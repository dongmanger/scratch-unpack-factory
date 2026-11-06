// 第一轮里被重编译预言机拒绝(mismatch)的项:显示"产物规范化文本"与"重编译规范化文本"的首个分歧处,并按分歧形态归类。
// 找出解码器的系统性错误。用法: node bench/diagnostics/oracle-mismatches.mjs <unpack输出目录> <基名> [--examples N] [--kind scripts|procedures]
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';

const args = process.argv.slice(2);
const [dir, base] = args;
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const examples = Number(opt('--examples', 10));
const onlyKind = opt('--kind', null);
const clone = value => JSON.parse(JSON.stringify(value));

const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

// Round 1 exactly as the oracle runs it: everything relaxed, nothing filtered, no unwrapping.
const project = clone(stripped);
// Every item starts with every preferred spelling, as in relaxed-recovery.mjs.
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: true, relaxedAllow: null, unwrapCoercions: true});
// Which items already carry a preferred spelling (so a mismatch could be the preference's fault).
const preferred = r => (r.beautify?.coercionsUnwrapped ?? 0) > 0 || (r.preferences?.length ?? 0) > 0;
const subjects = [];
for (const p of result.procedures) if (p.status === 'reconstructed-unverified') subjects.push({kind: 'procedures', targetIndex: p.targetIndex, id: p.variant, record: p});
for (const s of result.scripts) if (s.status === 'reconstructed-unverified' && s.event?.kind !== 'none') subjects.push({kind: 'scripts', targetIndex: s.targetIndex, id: s.scriptId, record: s});

// Probe calls so procedures are emitted (same idea as relaxed-recovery.mjs withProbeCalls).
const probed = clone(project);
const byTarget = new Map();
for (const s of subjects.filter(x => x.kind === 'procedures')) (byTarget.get(s.targetIndex) || byTarget.set(s.targetIndex, []).get(s.targetIndex)).push(s);
for (const [ti, procs] of byTarget) {
  const target = probed.targets[ti];
  const prototypes = Object.values(target.blocks).filter(b => b.opcode === 'procedures_prototype' && b.mutation);
  const hat = `probe_hat_${ti}`;
  target.blocks[hat] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
  let prev = hat;
  procs.forEach((s, order) => {
    const proto = prototypes.find(b => b.mutation.proccode === s.id.slice(1));
    if (!proto) return;
    const ids = JSON.parse(proto.mutation.argumentids || '[]');
    const defaults = JSON.parse(proto.mutation.argumentdefaults || '[]');
    const id = `probe_call_${ti}_${order}`;
    target.blocks[id] = {opcode: 'procedures_call', next: null, parent: prev, shadow: false, topLevel: false, fields: {},
      inputs: Object.fromEntries(ids.filter((_, i) => defaults[i] !== 'false').map(a => [a, [1, [4, '0']]])),
      mutation: {tagName: 'mutation', children: [], proccode: proto.mutation.proccode, argumentids: proto.mutation.argumentids, warp: proto.mutation.warp}};
    target.blocks[prev].next = id;
    prev = id;
  });
}
const {bundle} = await compileProject(probed, zip);
const keyOf = ti => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === ti);

const verdicts = {match: 0, mismatch: 0, missing: 0, error: 0};
const mismatches = [];
for (const s of subjects) {
  if (onlyKind && s.kind !== onlyKind) continue;
  const shipped = sidecar.compiledTargets[keyOf(s.targetIndex)]?.[s.kind]?.[s.id];
  const rebuilt = bundle.compiledTargets[s.targetIndex]?.[s.kind]?.[s.id];
  if (!shipped || !rebuilt) { verdicts.missing++; continue; }
  try {
    const a = comparableFactory(shipped.factorySource), b = comparableFactory(rebuilt.factorySource);
    if (a === b) verdicts.match++; else { verdicts.mismatch++; mismatches.push({s, a, b}); }
  } catch { verdicts.error++; }
}
console.log('round-1 verdicts:', verdicts, ' (items with assumptions among mismatches:', mismatches.filter(m => m.s.record.assumptions?.length).length +
  '; with a preferred spelling:', mismatches.filter(m => preferred(m.s.record)).length + ')');

// First divergence. The canonical text is one long line, so show a window around the first differing character
// instead of the whole line.
const WINDOW = 70;
const firstDiff = (a, b) => {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const window = text => text.slice(Math.max(0, i - 40), i + WINDOW);
  return {a: window(a), b: window(b)};
};
const norm = text => text.replace(/\b(x|b|p)\d+\b/g, '$1#').replace(/"[^"]{0,40}"/g, 'S').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 110);
const groups = new Map();
for (const m of mismatches) {
  const d = firstDiff(m.a, m.b);
  m.d = d;
  const key = `${norm(d.a)}\n   =>  ${norm(d.b)}`;
  groups.set(key, [...(groups.get(key) || []), m]);
}
console.log('\nmismatch groups (shipped line => recompiled line at first divergence):');
for (const [key, list] of [...groups].sort((x, y) => y[1].length - x[1].length).slice(0, examples)) {
  console.log(`\n${String(list.length).padStart(3)} items  ${list[0].s.kind} e.g. [${sidecar.compiledTargets[keyOf(list[0].s.targetIndex)].name}] ${String(list[0].s.id).slice(0, 40)}\n   ${key}`);
  console.log(`   raw shipped : ${list[0].d.a.slice(0, 200)}\n   raw rebuilt : ${list[0].d.b.slice(0, 200)}`);
}
