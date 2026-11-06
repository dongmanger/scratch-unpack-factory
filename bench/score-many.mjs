// 批量评分：node bench/score-many.mjs label=path [label=path ...]
import path from 'node:path';
import {readProjectFile, structuralScore, broadcastReport} from './score.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';

const truthPath = process.env.TRUTH || path.resolve('..', 'samples', '10128407.sb3');
const truth = (await readProjectFile(truthPath)).project;
const f = x => (x * 100).toFixed(1).padStart(5) + '%';
const rows = [];
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=');
  const label = arg.slice(0, eq), file = arg.slice(eq + 1);
  const {project, bytes} = await readProjectFile(path.resolve(file));
  const s = structuralScore(truth, project);
  const b = broadcastReport(truth, project);
  const v = bytes[0] === 0x50 ? await validateSb3(new Uint8Array(bytes)) : null;
  rows.push({label, s, b, v});
}
console.log('| 方案 | 脚本召回 | 脚本精确 | 块召回 | 块精确 | 块膨胀 | 广播(多出/缺失) | 结构校验 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const {label, s, b, v} of rows) {
  console.log(`| ${label} | ${f(s.scriptRecall)} (${s.matchedScripts}/${s.truthScripts}) | ${f(s.scriptPrecision)} (${s.matchedScripts}/${s.candidateScripts}) | ` +
    `${f(s.blockRecall)} | ${f(s.blockPrecision)} | ${s.inflation.toFixed(2)}x | ${b.candidate}(+${b.extra}/-${b.missing}) | ` +
    `${v ? (v.ok ? 'PASS' : `FAIL ${v.errors.length}err`) : '-'} |`);
}
