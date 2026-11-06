// 同一个过程（按 proccode 对齐）在真值与恢复结果中的签名差异
import path from 'node:path';
import {readProjectFile, scriptSignature} from '../score.mjs';

const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const cand = (await readProjectFile(path.resolve(process.argv[2]))).project;
const procs = project => {
  const out = new Map();
  project.targets.forEach((t, ti) => {
    for (const [id, b] of Object.entries(t.blocks || {})) {
      if (b.opcode !== 'procedures_definition' || !b.topLevel) continue;
      const proto = t.blocks[b.inputs?.custom_block?.[1]];
      const code = proto?.mutation?.proccode;
      if (code) out.set(`${t.name}\0${code}`, {sig: scriptSignature(t.blocks, id), warp: proto.mutation.warp});
    }
  });
  return out;
};
const T = procs(truth), C = procs(cand);
let same = 0, diff = 0, only = 0;
const samples = [];
for (const [k, c] of C) {
  const t = T.get(k);
  if (!t) { only++; continue; }
  if (t.sig === c.sig) same++;
  else { diff++; if (samples.length < 3) samples.push({k: k.replace('\0', ' / '), warpTruth: t.warp, warpCand: c.warp, truth: t.sig.slice(0, 420), cand: c.sig.slice(0, 420)}); }
}
console.log({candidateProcs: C.size, alsoInTruth: C.size - only, identicalSig: same, differentSig: diff, notInTruth: only});
for (const s of samples) { console.log('\n', s.k, 'warp truth/cand', s.warpTruth, s.warpCand); console.log(' T:', s.truth); console.log(' C:', s.cand); }
