// 给完整 unpack 流水线按阶段计时（在进程内重放 restoreSb3 的主要阶段）
import fs from 'node:fs';
import path from 'node:path';
import {staticUnpack} from '../../src/static-unpack.mjs';
import {deobfuscateMany} from '../../src/deobfuscate-pool.mjs';
import {prettifyFactorySource} from '../../src/pretty-code.mjs';
import {recoverCompiledCode} from '../../src/recover-code.mjs';
import {validateSb3} from '../../src/sb3-validate.mjs';
import JSZip from '@turbowarp/jszip';

const stamp = (() => { let t = performance.now(); return label => { const n = performance.now(); console.log(`${label.padEnd(34)} ${((n - t) / 1000).toFixed(1)}s`); t = n; }; })();
const file = process.argv[2] || '../compiled/o2/10128407-strong.html';
const un = await staticUnpack(new Uint8Array(fs.readFileSync(path.resolve(file))));
stamp('staticUnpack');
const compiled = JSON.parse(un.compiledProject);
const decoded = JSON.parse(un.compiledProject);
stamp('JSON parse x2');
const jobs = [];
for (const t of Object.values(decoded.compiledTargets)) for (const k of ['scripts', 'procedures']) for (const s of Object.values(t[k])) jobs.push(s.factorySource);
const out = await deobfuscateMany(jobs);
stamp(`deobfuscateMany (${jobs.length}, parallel)`);
let i = 0;
for (const t of Object.values(decoded.compiledTargets)) for (const k of ['scripts', 'procedures']) for (const s of Object.values(t[k])) {
  const r = out[i++];
  if (!r.ok) continue;
  const p = prettifyFactorySource(r.value.code, {innerName: 'script'});
  s.factorySource = p.report.applied ? p.code : r.value.code;
  s.deobfuscation = r.value.report;
}
stamp('prettify all (main thread)');
const zip = await JSZip.loadAsync(un.data);
const project = JSON.parse(await zip.file('project.json').async('text'));
stamp('read project.zip');
recoverCompiledCode(structuredClone(project), decoded, {beautify: false});
stamp('recoverCompiledCode');
const body = JSON.stringify(decoded, null, 2);
stamp(`stringify decoded (${(body.length / 1e6).toFixed(0)}MB)`);
const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
stamp('generate zip');
await validateSb3(bytes);
stamp('validateSb3');
