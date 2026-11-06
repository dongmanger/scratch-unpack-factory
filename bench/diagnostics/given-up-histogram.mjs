// 完整 oracle 跑完后,各项放弃偏好的数量分布,以及放弃了哪几种。用法: node bench/diagnostics/given-up-histogram.mjs <unpack输出目录> <基名>
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

const {result, oracle} = await recoverWithOracle(stripped, sidecar, {archive: zip,
  onRound: r => console.log(`  round ${r.round}: relaxed ${r.relaxedItems}, accepted ${r.accepted}, demoted ${r.demotedToFaithful}, mismatched ${r.mismatched}`)});
const items = [...result.procedures, ...result.scripts].filter(r => r.recompilation && r.status === 'reconstructed-unverified');
const bySize = {}, byCombo = {}, outcome = {};
for (const r of items) {
  const given = r.recompilation.preferencesGivenUp || [];
  bySize[given.length] = (bySize[given.length] || 0) + 1;
  if (given.length) byCombo[given.join('+')] = (byCombo[given.join('+')] || 0) + 1;
  const kept = r.recompilation.preferencesKept || [];
  const key = `${r.recompilation.status}${given.length ? ' (gave up ' + given.length + ')' : ''}`;
  outcome[key] = (outcome[key] || 0) + 1;
}
console.log('items:', items.length, ' oracle:', JSON.stringify({verified: oracle.verified, strictOnly: oracle.strictOnly, pruned: oracle.prunedInFinalPass, rounds: oracle.rounds.length, gaveUp: oracle.preferencesGivenUp}));
console.log('number of preferences given up per item:', bySize);
console.log('combinations given up:', Object.fromEntries(Object.entries(byCombo).sort((a, b) => b[1] - a[1]).slice(0, 12)));
console.log('verdict by number given up:', outcome);
