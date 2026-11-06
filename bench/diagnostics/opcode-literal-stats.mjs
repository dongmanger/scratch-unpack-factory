// 真值工程里某个运算符带字面量时,字面量在左还是右、取什么值。用于在"同一段 JS 对应多种积木"时选作者更常用的写法。
// 用法: node bench/diagnostics/opcode-literal-stats.mjs [truth.sb3]
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const {project} = await readProjectFile(path.resolve(process.argv[2] || path.join('..', 'samples', '10128407.sb3')));
const literalOf = (blocks, input) => {
  if (!Array.isArray(input)) return undefined;
  const shadow = input[1];
  if (Array.isArray(shadow) && shadow.length >= 2 && typeof shadow[1] === 'string' && input[0] === 1) return shadow[1];
  return undefined;
};
const stats = {};
for (const target of project.targets) {
  const blocks = target.blocks || {};
  for (const block of Object.values(blocks)) {
    if (!block || !['operator_multiply', 'operator_divide'].includes(block.opcode)) continue;
    const left = literalOf(blocks, block.inputs?.NUM1), right = literalOf(blocks, block.inputs?.NUM2);
    for (const [side, value] of [['left', left], ['right', right]]) {
      if (value === undefined || value === '') continue;
      if (!['0.5', '2', '0.25', '4', '-1', '1'].includes(value)) continue;
      const key = `${block.opcode.replace('operator_', '')} by literal ${value} on the ${side}`;
      stats[key] = (stats[key] || 0) + 1;
    }
  }
}
for (const [key, n] of Object.entries(stats).sort()) console.log(String(n).padStart(4), key);
