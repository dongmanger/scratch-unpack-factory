// if / if-else 的几种等价写法在作者工程里的实际分布。
//   A: 条件是 not X 的 if                         -> JS: if (!X) { B }
//   B: if-else,then 分支为空、else 分支非空        -> JS: if (!X) { B }  (若编译器如此折叠)
//   C: if-else,else 分支为空、then 分支非空        -> JS: if (X) { B }
//   D: 条件不是 not 的普通 if
// 用法: node bench/diagnostics/if-else-stats.mjs [truth.sb3]
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const {project} = await readProjectFile(path.resolve(process.argv[2] || path.join('..', 'samples', '10128407.sb3')));
const count = {A_if_not: 0, B_ifelse_empty_then: 0, C_ifelse_empty_else: 0, D_plain_if: 0, ifelse_both: 0, ifelse_neither: 0};
const isBlockRef = (blocks, input) => Array.isArray(input) && typeof input[1] === 'string' && !!blocks[input[1]];
for (const target of project.targets) {
  const blocks = target.blocks || {};
  for (const block of Object.values(blocks)) {
    if (!block || typeof block !== 'object') continue;
    const sub1 = isBlockRef(blocks, block.inputs?.SUBSTACK), sub2 = isBlockRef(blocks, block.inputs?.SUBSTACK2);
    if (block.opcode === 'control_if') {
      const cond = block.inputs?.CONDITION;
      const condBlock = isBlockRef(blocks, cond) ? blocks[cond[1]] : null;
      if (condBlock?.opcode === 'operator_not') count.A_if_not++; else count.D_plain_if++;
    } else if (block.opcode === 'control_if_else') {
      if (!sub1 && sub2) count.B_ifelse_empty_then++;
      else if (sub1 && !sub2) count.C_ifelse_empty_else++;
      else if (sub1 && sub2) count.ifelse_both++;
      else count.ifelse_neither++;
    }
  }
}
console.log(count);
