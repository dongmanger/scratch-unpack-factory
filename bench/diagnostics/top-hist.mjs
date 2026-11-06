import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';
for (const f of process.argv.slice(2)) {
  const p = (await readProjectFile(path.resolve(f))).project;
  const h = new Map();
  for (const s of listScripts(p)) h.set(s.opcode, (h.get(s.opcode) || 0) + 1);
  console.log(path.basename(f), [...h].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.replace('event_when', 'ev:').replace('procedures_', 'pr:')}=${n}`).join(' '));
}
