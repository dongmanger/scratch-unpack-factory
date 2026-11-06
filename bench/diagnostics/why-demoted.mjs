// 被降级（unwrap 形态不匹配、faithful 形态匹配）的项：unwrap 形态重编译后到底在哪里与 shipped 不同？
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {compileProject, comparableFactory} from '../../src/recompile-oracle.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);

const attempt = async options => {
  const project = structuredClone(stripped);
  const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed: true, ...options});
  // 过程加探针
  const probed = structuredClone(project);
  for (const [ti, target] of probed.targets.entries()) {
    const protos = Object.values(target.blocks).filter(b => b.opcode === 'procedures_prototype' && b.mutation);
    if (!protos.length) continue;
    const hat = `probe_hat_${ti}`;
    target.blocks[hat] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
    let prev = hat;
    protos.forEach((p, i) => {
      const ids = JSON.parse(p.mutation.argumentids || '[]'), defs = JSON.parse(p.mutation.argumentdefaults || '[]');
      const id = `probe_call_${ti}_${i}`;
      target.blocks[id] = {opcode: 'procedures_call', next: null, parent: prev, inputs: Object.fromEntries(ids.filter((_, k) => defs[k] !== 'false').map(a => [a, [1, [4, '0']]])), fields: {}, shadow: false, topLevel: false,
        mutation: {tagName: 'mutation', children: [], proccode: p.mutation.proccode, argumentids: p.mutation.argumentids, warp: p.mutation.warp}};
      target.blocks[prev].next = id; prev = id;
    });
  }
  const { bundle } = await compileProject(probed, zip);
  const verdicts = new Map();
  for (const p of result.procedures) if (p.status === 'reconstructed-unverified') {
    const rebuilt = bundle.compiledTargets[p.targetIndex]?.procedures?.[p.variant];
    const shipped = sidecar.compiledTargets[keyOf(p.targetIndex)].procedures[p.variant];
    verdicts.set(`${p.targetIndex}:${p.variant}`, rebuilt ? {ok: comparableFactory(shipped.factorySource) === comparableFactory(rebuilt.factorySource),
      shipped: comparableFactory(shipped.factorySource), rebuilt: comparableFactory(rebuilt.factorySource), unwrapped: p.beautify?.coercionsUnwrapped ?? 0} : {ok: false, missing: true});
  }
  return verdicts;
};
const faithful = await attempt({});
const unwrapped = await attempt({unwrapCoercions: true});
let demotedExamples = 0, onlyFaithful = 0, onlyUnwrapped = 0, both = 0;
const clusters = new Map();
for (const [k, f] of faithful) {
  const u = unwrapped.get(k);
  if (!u) continue;
  if (f.ok && u.ok) both++;
  else if (f.ok && !u.ok) {
    onlyFaithful++;
    let i = 0; while (i < u.shipped.length && u.shipped[i] === u.rebuilt?.[i]) i++;
    const fp = `shipped[${u.shipped.slice(Math.max(0, i - 25), i + 40).replace(/x\d+/g, 'X').replace(/\d+/g, 'N')}] rebuilt[${(u.rebuilt || '').slice(Math.max(0, i - 25), i + 40).replace(/x\d+/g, 'X').replace(/\d+/g, 'N')}]`;
    (clusters.get(fp) || clusters.set(fp, []).get(fp)).push(k);
  } else if (!f.ok && u.ok) onlyUnwrapped++;
}
const lines = [`procedures judged: both-ok=${both} only-faithful-ok=${onlyFaithful} only-unwrapped-ok=${onlyUnwrapped}`, ''];
for (const [fp, ks] of [...clusters].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) lines.push(`${String(ks.length).padStart(3)}x ${fp.slice(0, 300)}`);
fs.writeFileSync(path.resolve('..', 'work', 'demoted.txt'), lines.join('\n'), 'utf8');
console.log('wrote');
