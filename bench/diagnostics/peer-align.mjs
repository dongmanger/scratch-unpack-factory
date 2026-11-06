// peer 输出能与 factory 的 script/procedure 键对齐多少？未被 oracle-factory 恢复的项里，peer 有候选的有多少？
import fs from 'node:fs';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';
import {readSb3Project, inspectCandidateGraph} from '../../src/hybrid.mjs';

const [dir, base, peerFile] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${base}.deobfuscated-compiled-project.json`), 'utf8'));
const sb3 = fs.readdirSync(dir).find(f => f.startsWith(base) && f.endsWith('.sb3'));
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, sb3)));
const stripped = JSON.parse(await zip.file('project.json').async('text'));
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }
const {result} = await recoverWithOracle(stripped, sidecar, {archive: zip});
const peer = await readSb3Project(new Uint8Array(fs.readFileSync(path.resolve(peerFile))));

const keyOf = i => Object.keys(sidecar.compiledTargets).find(k => (sidecar.compiledTargets[k].targetIndex ?? Number(k)) === i);
const unresolvedScripts = result.unresolved.filter(u => u.kind === 'script');
const unresolvedProcs = result.unresolved.filter(u => u.kind === 'procedure');
let scriptAligned = 0, scriptClean = 0, procAligned = 0;
const peerProcCodes = idx => new Set(Object.values(peer.targets[idx]?.blocks || {}).filter(b => b.opcode === 'procedures_prototype').map(b => b.mutation?.proccode));
for (const u of unresolvedScripts) {
  const pt = peer.targets[u.targetIndex];
  if (pt?.blocks?.[u.scriptId]) {
    scriptAligned++;
    const hat = sidecar.compiledTargets[keyOf(u.targetIndex)].hats.find(h => h.topBlockId === u.scriptId);
    if (hat && inspectCandidateGraph(pt.blocks, u.scriptId, hat.opcode).ok) scriptClean++;
  }
}
for (const u of unresolvedProcs) if (peerProcCodes(u.targetIndex).has(u.variant.slice(1))) procAligned++;
console.log({unresolvedScripts: unresolvedScripts.length, peerHasScriptById: scriptAligned, peerScriptStructurallyClean: scriptClean,
  unresolvedProcedures: unresolvedProcs.length, peerHasProcedure: procAligned});
