// 打印 dump 中第 N 个未命中项的 got / want（规范化后），用于定位具体缺口
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pattern = process.argv[3] ? new RegExp(process.argv[3]) : null;
const which = Number(process.argv[4] || 0);
const list = pattern ? dump.filter(m => pattern.test(m.got.slice(0, 200))) : dump;
console.log(`${list.length} matching of ${dump.length}`);
const m = list[which];
if (!m) process.exit(0);
console.log(m.tk, m.kind, m.id);
console.log('GOT  (', m.got.length, ')\n', m.got.slice(0, 1400));
console.log('WANT (', m.want.length, ')\n', m.want.slice(0, 900));
