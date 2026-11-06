// 统计 Strong 解混淆后仍残留的“代理对象函数”形状，决定 proxyObjects 要支持哪些
import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscateMany} from '../../src/deobfuscate-pool.mjs';

const traverse = traverseModule.default || traverseModule;
const generate = generatorModule.default || generatorModule;
const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve('../compiled/o2/10128407-strong.html'))));
const compiled = JSON.parse(un.compiledProject);
const sources = [];
for (const e of Object.values(compiled.compiledTargets)) for (const k of ['scripts', 'procedures']) for (const s of Object.values(e[k])) sources.push(s.factorySource);
const stride = Number(process.argv[2] || 5);
const sample = sources.filter((_, i) => i % stride === 0);
const out = await deobfuscateMany(sample);

// 把函数体规范成“形参名 -> P0,P1…”的形状字符串
const shapes = new Map();
let withProxy = 0;
out.forEach(r => {
  if (!r.ok) return;
  const ast = parse(r.value.code, {sourceType: 'script', allowReturnOutsideFunction: true});
  let found = false;
  traverse(ast, {
    ObjectExpression(p) {
      const props = p.node.properties;
      if (!props.length || !props.every(x => x.type === 'ObjectProperty' && !x.computed && (x.value.type === 'FunctionExpression' || x.value.type === 'StringLiteral' || x.value.type === 'NumericLiteral'))) return;
      if (!props.some(x => x.value.type === 'FunctionExpression')) return;
      found = true;
      for (const x of props) {
        if (x.value.type !== 'FunctionExpression') continue;
        const params = x.value.params.map(q => q.name);
        let code = generate(x.value.body).code.replace(/\s+/g, ' ');
        params.forEach((n, i) => { code = code.replace(new RegExp(`\\b${n}\\b`, 'g'), `P${i}`); });
        const key = `(${params.length}) ${code}`;
        shapes.set(key, (shapes.get(key) || 0) + 1);
      }
    }
  });
  if (found) withProxy++;
});
console.log(`sample ${sample.length}, still containing a proxy object after deobfuscation: ${withProxy}`);
for (const [k, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(n).padStart(4), k.slice(0, 150));
