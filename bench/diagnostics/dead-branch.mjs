// 解混淆产物里 `false;` 之类的残留：死分支在哪个 pass 被删？被删的内容在混淆输入中是否存在？
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hits = dump.filter(m => /\{false;\}|false;while|\{true;\}/.test(m.got));
console.log('cases with bare literal statement:', hits.length);
for (const m of hits.slice(0, 2)) {
  const i = m.got.search(/\{false;\}|false;while|\{true;\}/);
  console.log('\n', m.tk, m.kind, m.id.slice(0, 40));
  console.log(' GOT :', m.got.slice(Math.max(0, i - 120), i + 140));
  const j = m.want.indexOf('if(false)');
  console.log(' WANT:', m.want.slice(Math.max(0, j - 120), j + 220));
}
