// 取一个“新增、行为等价、但结构与作者原图不同”的过程，把恢复版与真值版逐块并排展开
import path from 'node:path';
import {readProjectFile, listScripts} from '../score.mjs';

const [oldFile, newFile] = process.argv.slice(2);
const which = Number(process.argv[4] || 0);
const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const A = (await readProjectFile(path.resolve(oldFile))).project;
const B = (await readProjectFile(path.resolve(newFile))).project;
const code = (project, s) => { const t = project.targets[s.targetIndex]; return t.blocks[t.blocks[s.id].inputs?.custom_block?.[1]]?.mutation?.proccode; };
const id = (project, s) => `${s.targetIndex}:${code(project, s)}`;
const had = new Set(listScripts(A).filter(s => s.opcode === 'procedures_definition').map(s => id(A, s)));
const fresh = listScripts(B).filter(s => s.opcode === 'procedures_definition' && !had.has(id(B, s)));
console.log('had',had.size,'fresh',fresh.length,'B defs',listScripts(B).filter(s=>s.opcode==='procedures_definition').length,'A defs',listScripts(A).filter(s=>s.opcode==='procedures_definition').length);
const mine = fresh[which];
if (!mine) { console.log('no such item'); process.exit(0); }
const theirs = listScripts(truth).find(s => s.targetIndex === mine.targetIndex && code(truth, s) === code(B, mine));
console.log('proccode:', code(B, mine), '| target', B.targets[mine.targetIndex].name);
const tokens = sig => sig.split(/(?<=[;{}(),|=])/).map(x => x.trim()).filter(Boolean);
const a = tokens(theirs.signature), b = tokens(mine.signature);
let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
console.log('first difference at token', i, 'of', a.length, '(truth) /', b.length, '(recovered)');
console.log(' TRUTH    …', a.slice(Math.max(0, i - 6), i + 14).join(' '));
console.log(' RECOVERED…', b.slice(Math.max(0, i - 6), i + 14).join(' '));
