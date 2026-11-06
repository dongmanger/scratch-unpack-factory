// 对“代理对象整体放弃内联”的样本，逐轮看 proxyObjects 的行为
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscate} from '../../src/deobfuscate.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-strong.html'))));
const c = JSON.parse(un.compiledProject);
const src = c.compiledTargets['2'].scripts['aTX'].factorySource;
const d = deobfuscate(src);
console.log('status', d.report.status, 'residuals', JSON.stringify(d.report.residuals));
console.log('passes:', d.report.transforms.map(t => t.pass + (t.count ? `(${t.count})` : '')).join(' > '));
const left = [...d.code.matchAll(/(\w+)\.(\w{5})\(/g)].filter(m => /^_?0x/.test(m[1]) || m[1].length > 4).slice(0, 6).map(m => m[0]);
console.log('proxy-like calls left:', left);
const i = d.code.indexOf('AmMGL');
console.log(d.code.slice(Math.max(0, i - 400), i + 200));
