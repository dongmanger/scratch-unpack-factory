// 对 dump 里残留代理对象的样本，列出“代理键 -> 被引用的方式”，找出为何整对象被放弃内联
import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const re = /^\(\(\)=>\{const x0=\{/;
const list = dump.filter(m => re.test(m.got.slice(0, 40)));
console.log('cases with proxy shell:', list.length);
for (const m of list.slice(0, 5)) {
  const code = m.got;
  const header = code.match(/^\(\(\)=>\{const x0=\{(.*?)\};const x9=/s);
  const keys = header ? [...header[1].matchAll(/(\w+):(function[^}]*\}|"[^"]*")/g)].map(x => x[1]) : [];
  console.log('\n', m.tk, m.kind, m.id.slice(0, 40), 'proxy keys:', keys.length);
  for (const key of keys) {
    const uses = [...code.slice(code.indexOf('};const x9=')).matchAll(new RegExp(`x0\\.${key}([^\\w])`, 'g'))];
    const sample = [];
    for (const u of uses.slice(0, 2)) sample.push(code.slice(Math.max(0, u.index + code.indexOf('};const x9=') - 25), u.index + code.indexOf('};const x9=') + 40));
    if (uses.length) console.log(`  ${key}: ${uses.length} use(s), e.g. ${JSON.stringify(sample[0])}`);
    else console.log(`  ${key}: UNUSED`);
  }
}
