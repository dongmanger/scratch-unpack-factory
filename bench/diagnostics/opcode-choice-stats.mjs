// “同一段 JS，多种积木写法”的选择，在作者真实工程里哪种更常见？用真值统计，作为解码默认偏好的依据。
import path from 'node:path';
import {readProjectFile} from '../score.mjs';

const truth = (await readProjectFile(process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3'))).project;
const count = new Map();
const bump = k => count.set(k, (count.get(k) || 0) + 1);
for (const t of truth.targets) for (const b of Object.values(t.blocks || {})) {
  if (!b || Array.isArray(b)) continue;
  bump(b.opcode);
  if (b.opcode === 'data_deleteoflist') {
    const idx = b.inputs?.INDEX;
    const v = Array.isArray(idx) ? idx[1] : null;
    bump(`data_deleteoflist INDEX=${Array.isArray(v) ? JSON.stringify(v[1]) : typeof v === 'string' ? '(reporter)' : '?'}`);
  }
  if (b.opcode === 'looks_gotofrontback') bump(`gotofrontback ${b.fields?.FRONT_BACK?.[0]}`);
  if (b.opcode === 'control_stop') bump(`control_stop ${b.fields?.STOP_OPTION?.[0]}`);
  if (b.opcode === 'operator_not') bump('operator_not');
}
const show = [
  ['data_deletealloflist', 'data_deleteoflist INDEX="all"', 'data_deleteoflist INDEX=(reporter)', 'data_deleteoflist INDEX="1"', 'data_deleteoflist INDEX="last"'],
  ['data_changevariableby', 'data_setvariableto'],
  ['control_stop this script', 'control_stop all', 'control_stop other scripts in sprite']
];
for (const group of show) console.log(group.map(k => `${k}=${count.get(k) || 0}`).join('   '));
console.log('\nall data_deleteoflist forms:', [...count].filter(([k]) => k.startsWith('data_deleteoflist INDEX')).map(([k, n]) => `${k}:${n}`).join('  '));
