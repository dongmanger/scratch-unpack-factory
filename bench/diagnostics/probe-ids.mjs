// 探针：打包后顶层积木 ID 与真值 ID 的关系；以及用内容对齐脚本的可行性
import fs from 'node:fs';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {installedVirtualMachine} from '../../src/default-vm.mjs';

const un = await staticUnpack(new Uint8Array(fs.readFileSync(new URL('../../../compiled/o2/10128407-plain.html', import.meta.url))));
const compiled = JSON.parse(un.compiledProject);
const truth = JSON.parse(fs.readFileSync(new URL('../../../samples/10128407.sb3', import.meta.url), 'utf8'));
const zip = await JSZip.loadAsync(un.data);

const truthTops = new Map();
truth.targets.forEach((t, i) => {
  for (const [id, b] of Object.entries(t.blocks || {})) if (b.topLevel) truthTops.set(`${i}:${id}`, b.opcode);
});
const packedTops = [];
for (const [key, entry] of Object.entries(compiled.compiledTargets)) for (const id of Object.keys(entry.scripts)) packedTops.push(`${key}:${id}`);
console.log('truth top-level', truthTops.size, 'packed scripts', packedTops.length);
console.log('packed ids in truth', packedTops.filter(k => truthTops.has(k)).length);
console.log('sample packed', packedTops.slice(0, 3), 'sample truth', [...truthTops.keys()].slice(0, 3));

// 真值工程重编译 → 按 factorySource 内容对齐
const VM = installedVirtualMachine();
const vm = new VM();
const storage = new VM.Storage();
storage.load = () => { throw new Error('denied'); };
vm.attachStorage(storage);
vm.setCompilerOptions({enabled: true, warpTimer: false});
const bundle = await vm.compileProjectFromJSON(truth, zip);
const byContent = new Map();
for (const [key, entry] of Object.entries(bundle.compiledTargets)) for (const [id, s] of Object.entries(entry.scripts)) {
  const k = `${key}\0${s.factorySource.replace(/"[^"]{8,}"/g, '"S"')}`;
  (byContent.get(k) || byContent.set(k, []).get(k)).push(id);
}
let exact = 0, ambiguous = 0, none = 0;
for (const [key, entry] of Object.entries(compiled.compiledTargets)) for (const s of Object.values(entry.scripts)) {
  const k = `${key}\0${s.factorySource.replace(/"[^"]{8,}"/g, '"S"')}`;
  const m = byContent.get(k);
  if (!m) none++; else if (m.length === 1) exact++; else ambiguous++;
}
console.log({truthScripts: Object.values(bundle.compiledTargets).reduce((a, e) => a + Object.keys(e.scripts).length, 0), exact, ambiguous, none});
vm.quit();
