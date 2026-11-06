// 8 个真实 02 packager 产物（none/light/balanced/strong × html/zip）：
// 新流水线必须仍全部恢复、预言机全部 match，且行为差分（verify）与可信源工程一致。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const dir = path.resolve('fixtures', 'real-02-v1');
const trusted = path.join(dir, 'trusted-recursive.sb3');
const outRoot = path.resolve('..', 'work', 'fixtures-oracle');
fs.rmSync(outRoot, {recursive: true, force: true});
const names = fs.readdirSync(dir).filter(f => /^recursive-.*\.(html|zip)$/.test(f)).sort();
let failures = 0;
for (const name of names) {
  const out = path.join(outRoot, name);
  const un = spawnSync(process.execPath, ['bin/factory.mjs', 'unpack', path.join(dir, name), '-o', out, '--allow-partial', '--overwrite'], {encoding: 'utf8'});
  const reportFile = fs.existsSync(out) && fs.readdirSync(out).find(f => f.endsWith('.fidelity-report.json'));
  if (!reportFile) { console.log(name.padEnd(26), 'NO REPORT', (un.stderr || '').split('\n')[0]); failures++; continue; }
  const rep = JSON.parse(fs.readFileSync(path.join(out, reportFile), 'utf8'));
  const sb3 = fs.readdirSync(out).find(f => f.endsWith('.sb3'));
  const rc = rep.code.recompilation;
  const v = spawnSync(process.execPath, ['bin/factory.mjs', 'verify', trusted, path.join(out, sb3), '--allow-execute'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let verdict = 'n/a';
  try { verdict = JSON.parse(v.stdout).status; } catch { /* leave n/a */ }
  const ok = rep.code.unresolved.length === 0 && rc?.recompiledAndMatching === rc?.recoveredItems && rc?.recoveredItems > 0 && verdict === 'matched';
  if (!ok) failures++;
  console.log(`${name.padEnd(26)} unresolved=${rep.code.unresolved.length} recompiled=${rc?.recompiledAndMatching}/${rc?.recoveredItems} codeScore=${rep.confidence.code.score} behaviorVerify=${verdict} ${ok ? 'OK' : 'FAIL'}`);
}
console.log(failures ? `${failures} FAILED` : 'ALL 8 FIXTURES OK');
process.exitCode = failures ? 1 : 0;
