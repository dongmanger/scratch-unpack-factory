// 作者的积木嵌套方向统计:同一运算符的链 (a or b or c) 在真值工程里是左嵌套还是右嵌套。
// 用于判断在产物只保留 JS 结合律下"等价"信息时,应当偏好哪一种嵌套。
// 用法: node bench/diagnostics/nesting-stats.mjs [truth.sb3]
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const truthFile = process.argv[2] || path.join('..', 'samples', '10128407.sb3');
const {project} = await readProjectFile(path.resolve(truthFile));
const inputBlock = (blocks, input) => {
  if (!Array.isArray(input)) return null;
  const ref = input[1];
  return typeof ref === 'string' && blocks[ref] && !blocks[ref].shadow ? blocks[ref] : null;
};

for (const opcode of ['operator_or', 'operator_and', 'operator_join', 'operator_add', 'operator_multiply']) {
  let leftNested = 0, rightNested = 0, both = 0, chains = 0, longest = 0;
  for (const target of project.targets) {
    const blocks = target.blocks || {};
    for (const block of Object.values(blocks)) {
      if (!block || block.opcode !== opcode) continue;
      const names = opcode === 'operator_join' ? ['STRING1', 'STRING2'] : opcode === 'operator_add' || opcode === 'operator_multiply' ? ['NUM1', 'NUM2'] : ['OPERAND1', 'OPERAND2'];
      const l = inputBlock(blocks, block.inputs?.[names[0]]);
      const r = inputBlock(blocks, block.inputs?.[names[1]]);
      const ls = l?.opcode === opcode, rs = r?.opcode === opcode;
      if (ls && rs) both++; else if (ls) leftNested++; else if (rs) rightNested++;
    }
  }
  chains = leftNested + rightNested + both;
  console.log(`${opcode.padEnd(18)} nested in left operand: ${String(leftNested).padStart(4)}   in right operand: ${String(rightNested).padStart(4)}   both: ${String(both).padStart(3)}   (${chains} nestings)`);
}
