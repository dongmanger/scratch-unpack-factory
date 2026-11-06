import fs from 'node:fs';
import path from 'node:path';
import {readProjectFile} from '../score.mjs';
const [file, targetName, topId] = process.argv.slice(2);
const p = (await readProjectFile(path.resolve(file))).project;
const t = p.targets.find(x => x.name === targetName);
const seen = new Set();
const show = (id, depth = 0) => {
  if (seen.has(id) || depth > 4) return;
  seen.add(id);
  const b = t.blocks[id];
  if (!b || Array.isArray(b)) { console.log(' '.repeat(depth * 2) + id, JSON.stringify(b)); return; }
  console.log(' '.repeat(depth * 2) + `${id.slice(0, 14)} ${b.opcode} shadow=${b.shadow} inputs=${JSON.stringify(b.inputs).slice(0, 160)} fields=${JSON.stringify(b.fields).slice(0, 80)}`);
  for (const v of Object.values(b.inputs || {})) if (typeof v[1] === 'string') show(v[1], depth + 1);
  if (typeof b.next === 'string') show(b.next, depth);
};
show(topId);
