// 探针：真值工程 → 随包真实 02 编译器 → 与 plain 产物的 factorySource 逐串比较
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {installedVirtualMachine} from '../../src/default-vm.mjs';

const t0 = Date.now();
const lap = label => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

const artifact = process.argv[2] || '../../compiled/o2/10128407-plain.html';
const truthPath = process.argv[3] || '../../samples/10128407.sb3';
const un = await staticUnpack(new Uint8Array(fs.readFileSync(new URL(artifact, import.meta.url))));
lap(`staticUnpack ${un.format} compiled=${!!un.compiledProject}`);
const compiled = JSON.parse(un.compiledProject);
const zip = await JSZip.loadAsync(un.data);
const truth = JSON.parse(fs.readFileSync(new URL(truthPath, import.meta.url), 'utf8'));
lap(`truth targets=${truth.targets.length}`);

const VM = installedVirtualMachine();
const vm = new VM();
const storage = new VM.Storage();
const denied = () => { throw new Error('storage denied'); };
if (storage.scratchFetch) storage.scratchFetch.scratchFetch = denied;
vm.attachStorage(storage);
storage.load = denied;
vm.setCompilerOptions({enabled: true, warpTimer: false});
let compileErrors = 0;
vm.runtime.on('COMPILE_ERROR', (_t, e) => { compileErrors++; if (compileErrors < 4) console.log('COMPILE_ERROR', String(e?.message || e).slice(0, 200)); });

const bundle = await vm.compileProjectFromJSON(truth, zip);
lap(`compileProjectFromJSON done, compileErrors=${compileErrors}`);

let same = 0, diff = 0, missing = 0, extra = 0;
const diffs = [];
for (const [key, entry] of Object.entries(compiled.compiledTargets)) {
  const mine = bundle.compiledTargets[key];
  for (const kind of ['scripts', 'procedures']) {
    for (const [id, script] of Object.entries(entry[kind])) {
      const m = mine?.[kind]?.[id];
      if (!m) { missing++; continue; }
      if (m.factorySource === script.factorySource) same++;
      else { diff++; if (diffs.length < 3) diffs.push({key, kind, id}); }
    }
    for (const id of Object.keys(mine?.[kind] || {})) if (!entry[kind][id]) extra++;
  }
}
console.log({same, diff, missing, extra});
if (diffs.length) {
  const d = diffs[0];
  const a = compiled.compiledTargets[d.key][d.kind][d.id].factorySource;
  const b = bundle.compiledTargets[d.key][d.kind][d.id].factorySource;
  console.log('first diff', d, a.length, b.length);
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  console.log('A:', JSON.stringify(a.slice(Math.max(0, i - 80), i + 120)));
  console.log('B:', JSON.stringify(b.slice(Math.max(0, i - 80), i + 120)));
}
vm.quit();
lap('end');
