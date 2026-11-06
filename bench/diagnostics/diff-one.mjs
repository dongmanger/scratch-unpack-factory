// 取 strict 命中真值但 oracle 输出未命中的第一个脚本，打印两边在同一顶块 ID 下的完整签名
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const [aFile, bFile] = process.argv.slice(2);
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const A = (await readProjectFile(path.resolve(aFile))).project;
const B = (await readProjectFile(path.resolve(bFile))).project;
const key = s => `${s.isStage ? '#stage' : s.target}\u0000${s.signature}`;
const aSet = new Map(); for (const s of listScripts(A)) aSet.set(key(s), s);
const bSet = new Map(); for (const s of listScripts(B)) bSet.set(key(s), s);
const bById = new Map(); for (const s of listScripts(B)) bById.set(`${s.targetIndex}:${s.id}`, s);
let shown = 0;
for (const t of listScripts(truth)) {
  if (!aSet.has(key(t)) || bSet.has(key(t))) continue;
  const a = aSet.get(key(t));
  const b = bById.get(`${a.targetIndex}:${a.id}`);
  console.log('target', a.target, 'id', a.id.slice(0, 20), 'opcode', a.opcode);
  console.log(' A(strict):', a.signature.slice(0, 600));
  console.log(' B(oracle):', b ? b.signature.slice(0, 600) : '(no script with same id)');
  if (++shown >= 2) break;
}
