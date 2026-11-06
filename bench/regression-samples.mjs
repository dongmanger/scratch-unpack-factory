// 对仓库里全部真实产物样本跑完整 unpack，汇总状态/退出码/恢复数。用于确认 TurboWarp 解包保持不变。
// 用法: node bench/regression-samples.mjs [--recovery oracle|strict]
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const recovery = process.argv.includes('--recovery') ? process.argv[process.argv.indexOf('--recovery') + 1] : 'oracle';
const root = path.resolve('..', 'compiled');
const outRoot = path.resolve('..', 'work', `reg-${recovery}`);
fs.rmSync(outRoot, {recursive: true, force: true});
const samples = [];
for (const family of ['tw', 'o2']) {
  for (const f of fs.readdirSync(path.join(root, family))) {
    if (/\.(html|zip|exe|asar)$/i.test(f)) samples.push({family, file: path.join(root, family, f), name: f});
  }
}
const skip = new Set((process.env.SKIP || '').split(',').filter(Boolean));
console.log(`recovery=${recovery}, ${samples.length} samples`);
const rows = [];
for (const s of samples) {
  if (skip.has(s.name)) continue;
  const out = path.join(outRoot, s.family, s.name);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', 'bin/factory.mjs', 'unpack', s.file, '-o', out, '--allow-partial', '--overwrite', '--recovery', recovery],
    {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const reportFile = fs.existsSync(out) ? fs.readdirSync(out).find(f => f.endsWith('.fidelity-report.json')) : null;
  let info = {};
  if (reportFile) {
    const rep = JSON.parse(fs.readFileSync(path.join(out, reportFile), 'utf8'));
    const c = rep.code?.counts || {};
    info = {status: rep.status, scripts: `${(rep.code?.scripts || []).filter(x => ['reconstructed-unverified', 'procedure-body-copy', 'preserved'].includes(x.status)).length}/${(rep.code?.scripts || []).length}`,
      procs: `${(rep.code?.procedures || []).filter(x => x.status === 'reconstructed-unverified').length}/${(rep.code?.procedures || []).length}`,
      mode: rep.code?.recompilation?.mode || '-', match: rep.code?.recompilation ? `${rep.code.recompilation.recompiledAndMatching}/${rep.code.recompilation.recoveredItems}` : '-',
      validation: rep.validation?.ok ? 'PASS' : 'FAIL', codeScore: rep.confidence?.code?.score};
  }
  rows.push({sample: `${s.family}/${s.name}`, exit: r.status, secs: ((Date.now() - t0) / 1000).toFixed(0), ...info, err: r.status && r.status !== 0 ? (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 110) : ''});
  console.log(JSON.stringify(rows.at(-1)));
}
fs.writeFileSync(path.resolve('..', 'work', `reg-${recovery}.json`), JSON.stringify(rows, null, 1));
