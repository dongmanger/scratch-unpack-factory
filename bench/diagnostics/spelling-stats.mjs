// 作者在"同一段 JS 对应多种积木"的几类场景下实际用的写法。用于决定偏好,并由重编译预言机逐项核验。
// 用法: node bench/diagnostics/spelling-stats.mjs [truth.sb3]
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const {project} = await readProjectFile(path.resolve(process.argv[2] || path.join('..', 'samples', '10128407.sb3')));
const count = {};
const bump = key => { count[key] = (count[key] || 0) + 1; };
const isObj = v => v !== null && typeof v === 'object';
const inputBlock = (blocks, input) => {
  if (!Array.isArray(input)) return null;
  const ref = input[1];
  return typeof ref === 'string' && blocks[ref] && !blocks[ref].shadow ? blocks[ref] : null;
};
const hasInput = (block, name) => block.inputs && Object.hasOwn(block.inputs, name) && inputBlock({}, block.inputs[name]) === null && Array.isArray(block.inputs[name]);

for (const target of project.targets) {
  const blocks = target.blocks || {};
  // Which blocks are inside a procedure definition (walk from each definition hat).
  const inProcedure = new Set();
  for (const [id, block] of Object.entries(blocks)) {
    if (!isObj(block) || block.opcode !== 'procedures_definition') continue;
    const stack = [block.next];
    while (stack.length) {
      const current = stack.pop();
      if (!current || inProcedure.has(current) || !blocks[current]) continue;
      inProcedure.add(current);
      const b = blocks[current];
      stack.push(b.next);
      for (const input of Object.values(b.inputs || {})) if (Array.isArray(input) && typeof input[1] === 'string') stack.push(input[1]);
    }
  }
  for (const [id, block] of Object.entries(blocks)) {
    if (!isObj(block)) continue;
    if (block.opcode === 'control_stop') {
      const option = block.fields?.STOP_OPTION?.[0];
      bump(`control_stop(${option}) ${inProcedure.has(id) ? 'inside a procedure' : 'outside procedures'}`);
    }
    if (block.opcode === 'procedures_return') bump('procedures_return');
    if (block.opcode === 'operator_not') {
      const operand = block.inputs?.OPERAND;
      const hasBlock = !!inputBlock(blocks, operand);
      bump(`operator_not with ${hasBlock ? 'a block' : 'an EMPTY operand'}`);
    }
    if (block.opcode === 'operator_equals') {
      const a = block.inputs?.OPERAND1, b = block.inputs?.OPERAND2;
      if (!inputBlock(blocks, a) && !inputBlock(blocks, b)) bump('operator_equals of two literals/empty (a boolean constant)');
    }
    if (block.opcode === 'control_if_else') {
      const sub2 = block.inputs?.SUBSTACK2;
      if (!Array.isArray(sub2) || !sub2[1]) bump('control_if_else with an EMPTY else branch');
      else bump('control_if_else with an else branch');
    }
    if (block.opcode === 'procedures_call') {
      // boolean arguments left empty vs given a block
      const ids = (() => { try { return JSON.parse(block.mutation?.argumentids || '[]'); } catch { return []; } })();
      const proccode = block.mutation?.proccode || '';
      const kinds = [...proccode.matchAll(/(?<!\\)%([snb])/g)].map(m => m[1]);
      ids.forEach((argId, i) => {
        if (kinds[i] !== 'b') return;
        const input = block.inputs?.[argId];
        if (!input) bump('procedure boolean argument: slot left empty (no input)');
        else if (inputBlock(blocks, input)) bump(`procedure boolean argument: ${inputBlock(blocks, input).opcode}`);
        else bump('procedure boolean argument: slot with only a shadow');
      });
    }
  }
}
for (const [key, n] of Object.entries(count).sort((a, b) => a[0].localeCompare(b[0]))) console.log(String(n).padStart(5), key);
