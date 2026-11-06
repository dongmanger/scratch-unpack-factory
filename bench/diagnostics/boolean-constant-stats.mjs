// 作者用什么积木表示布尔常量 true / false。把"没有积木输入的比较"和"空的 not"按取值与出现的位置(条件槽 / 过程实参 / 运算符操作数)分类。
// 用法: node bench/diagnostics/boolean-constant-stats.mjs [truth.sb3]
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const {project} = await readProjectFile(path.resolve(process.argv[2] || path.join('..', 'samples', '10128407.sb3')));
const count = {};
const bump = key => { count[key] = (count[key] || 0) + 1; };
const literalOf = input => Array.isArray(input) && input[0] === 1 && Array.isArray(input[1]) ? String(input[1][1]) : (Array.isArray(input) && input[0] === 3 && Array.isArray(input[2]) ? `shadow:${input[2][1]}` : undefined);
const isBlockRef = (blocks, input) => Array.isArray(input) && typeof input[1] === 'string' && blocks[input[1]] && !blocks[input[1]].shadow;

for (const target of project.targets) {
  const blocks = target.blocks || {};
  // parent -> which input of the parent holds this block
  const slotOf = new Map();
  for (const [pid, parent] of Object.entries(blocks)) {
    if (!parent || typeof parent !== 'object') continue;
    for (const [name, input] of Object.entries(parent.inputs || {})) {
      if (Array.isArray(input) && typeof input[1] === 'string' && blocks[input[1]]) slotOf.set(input[1], {parent, name});
    }
  }
  for (const [id, block] of Object.entries(blocks)) {
    if (!block || typeof block !== 'object') continue;
    const where = (() => {
      const slot = slotOf.get(id);
      if (!slot) return 'top level';
      const op = slot.parent.opcode;
      if (op === 'procedures_call') return 'procedure argument';
      if (/^control_(if|if_else|repeat_until|wait_until)$/.test(op)) return 'condition slot';
      if (/^operator_(and|or|not)$/.test(op)) return 'logic operand';
      return `slot of ${op}`;
    })();
    if (block.opcode === 'operator_not' && !isBlockRef(blocks, block.inputs?.OPERAND)) bump(`not <empty>  (true)   in ${where}`);
    if (block.opcode === 'operator_equals' && !isBlockRef(blocks, block.inputs?.OPERAND1) && !isBlockRef(blocks, block.inputs?.OPERAND2)) {
      const a = literalOf(block.inputs?.OPERAND1), b = literalOf(block.inputs?.OPERAND2);
      const same = String(a).toLowerCase() === String(b).toLowerCase();
      bump(`<${a === '' ? '(empty)' : a} = ${b === '' ? '(empty)' : b}> ${same ? '(true)' : '(false)'}  in ${where}`);
    }
  }
}
for (const [key, n] of Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(n).padStart(5), key);
