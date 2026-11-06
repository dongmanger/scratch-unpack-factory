// 追查：某类被丢失的脚本在 strict / relaxed / relaxed+allow 下分别是什么状态
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

const run = options => {
  const project = structuredClone(stripped);
  const result = recoverCompiledCode(project, sidecar, {beautify: false, ...options});
  const map = new Map(result.scripts.map(s => [`${s.targetIndex}:${s.scriptId}`, s]));
  return {project, result, map};
};
const strict = run({});
const relaxed = run({relaxed: true});
const allowNone = run({relaxed: true, relaxedAllow: new Set()});

let strictOk = 0, lostInRelaxed = 0, lostInAllowNone = 0, changed = 0;
const examples = [];
for (const [key, s] of strict.map) {
  const ok = r => r && (r.status === 'reconstructed-unverified' || r.status === 'procedure-body-copy');
  if (!ok(s)) continue;
  strictOk++;
  const r = relaxed.map.get(key), n = allowNone.map.get(key);
  if (!ok(r)) { lostInRelaxed++; if (examples.length < 3) examples.push({key, why: r?.reason, in: 'relaxed'}); }
  else if (r.assumptions?.length) { changed++; if (examples.length < 6) examples.push({key, assumptions: r.assumptions, in: 'relaxed-changed'}); }
  if (!ok(n)) { lostInAllowNone++; if (examples.length < 6) examples.push({key, why: n?.reason, in: 'allowNone'}); }
}
console.log({strictOk, lostInRelaxed, strictOkButNowHasAssumptions: changed, lostInAllowNone});
for (const e of examples) console.log(JSON.stringify(e).slice(0, 260));
