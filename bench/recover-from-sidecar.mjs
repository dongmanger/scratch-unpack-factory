// 用已有的 *.deobfuscated-compiled-project.json 直接跑 recoverCompiledCode，跳过 100 秒的解混淆。
// 用法: node bench/recover-from-sidecar.mjs <unpack输出目录> <基名> [--relaxed] [--out file.json]
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const [dir, base] = process.argv.slice(2);
const relaxed = process.argv.includes('--relaxed');
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
// 起点必须是容器里“剥离了积木”的原始工程，而不是已被恢复的输出
const project = JSON.parse(await zip.file('project.json').async('text'));
for (const t of project.targets) { t.blocks = {}; t.comments = {}; }

const t0 = performance.now();
const result = recoverCompiledCode(project, sidecar, {beautify: false, relaxed});
const ok = result.scripts.filter(s => s.status === 'reconstructed-unverified' || s.status === 'procedure-body-copy').length;
const okProc = result.procedures.filter(p => p.status === 'reconstructed-unverified').length;
const withAssume = [...result.scripts, ...result.procedures].filter(r => r.assumptions?.length).length;
console.log(`${relaxed ? 'RELAXED' : 'strict '}  scripts ${ok}/${result.scripts.length}  procedures ${okProc}/${result.procedures.length}  ` +
  `unresolved ${result.unresolved.length}  withAssumptions ${withAssume}  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
if (process.argv.includes('--out')) fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1], JSON.stringify({project, result}));
