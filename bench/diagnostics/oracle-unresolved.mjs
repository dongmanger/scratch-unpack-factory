// 预言机恢复之后，仍未恢复的项的原因分布（按 reason 聚类）
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';

const [dir, base] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const {result} = await recoverWithOracle(stripped, sidecar, {archive: zip});
const norm = s => String(s || '').replace(/[0-9a-f]{8,}/g, '#').replace(/"[^"]{0,60}"/g, 'S').replace(/\d+/g, 'N').slice(0, 100);
const h = new Map();
for (const u of result.unresolved) { const k = `${u.kind} | ${norm(u.reason)}`; h.set(k, (h.get(k) || 0) + 1); }
const lines = [`unresolved ${result.unresolved.length}`];
for (const [k, n] of [...h].sort((a, b) => b[1] - a[1]).slice(0, 26)) lines.push(`${String(n).padStart(4)} ${k}`);
fs.writeFileSync(process.env.OUT || path.resolve('..', 'work', 'oracle-unresolved.txt'), lines.join('\n'), 'utf8');
console.log('wrote', lines.length, 'lines');
