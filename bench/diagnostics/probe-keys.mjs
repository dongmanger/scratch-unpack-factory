// 探针：plain 与 strong 产物的脚本键是否一致；解混淆后与 plain 是否 α-等价
import fs from 'node:fs';
import {parse} from '@babel/parser';
import generate from '@babel/generator';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscate} from '../../src/deobfuscate.mjs';

const load = async rel => {
  const un = await staticUnpack(new Uint8Array(fs.readFileSync(new URL(rel, import.meta.url))));
  return JSON.parse(un.compiledProject);
};
const plain = await load('../../compiled/o2/10128407-plain.html');
const strong = await load('../../compiled/o2/10128407-strong.html');

let scriptsBoth = 0, scriptsOnlyPlain = 0, scriptsOnlyStrong = 0, procBoth = 0, procOnlyP = 0, procOnlyS = 0;
for (const key of Object.keys(plain.compiledTargets)) {
  const p = plain.compiledTargets[key], s = strong.compiledTargets[key];
  for (const id of Object.keys(p.scripts)) s.scripts[id] ? scriptsBoth++ : scriptsOnlyPlain++;
  for (const id of Object.keys(s.scripts)) p.scripts[id] || scriptsOnlyStrong++;
  for (const id of Object.keys(p.procedures)) s.procedures[id] ? procBoth++ : procOnlyP++;
  for (const id of Object.keys(s.procedures)) p.procedures[id] || procOnlyS++;
}
console.log({scriptsBoth, scriptsOnlyPlain, scriptsOnlyStrong, procBoth, procOnlyP, procOnlyS});

// α-规范化：按首次出现顺序重命名全部标识符绑定；去掉注释
const canon = code => {
  const ast = parse(code, {sourceType: 'script', allowReturnOutsideFunction: true});
  const names = new Map();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') {
      if (!names.has(node.name)) names.set(node.name, 'x' + names.size);
      node.name = names.get(node.name);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      walk(v);
    }
  };
  walk(ast.program);
  return generate.default(ast, {comments: false, compact: true}).code;
};

const limit = Number(process.argv[2] || 60);
let compared = 0, equal = 0, parseFail = 0;
const examples = [];
outer:
for (const key of Object.keys(plain.compiledTargets)) {
  for (const kind of ['procedures', 'scripts']) {
    for (const [id, ps] of Object.entries(plain.compiledTargets[key][kind])) {
      const ss = strong.compiledTargets[key]?.[kind]?.[id];
      if (!ss) continue;
      if (compared >= limit) break outer;
      compared++;
      try {
        const a = canon(deobfuscate(ps.factorySource).code);
        const b = canon(deobfuscate(ss.factorySource).code);
        if (a === b) equal++;
        else if (examples.length < 2) examples.push({key, kind, id, a: a.slice(0, 300), b: b.slice(0, 300)});
      } catch (e) { parseFail++; }
    }
  }
}
console.log({compared, equal, parseFail});
for (const e of examples) console.log(JSON.stringify(e, null, 1));
