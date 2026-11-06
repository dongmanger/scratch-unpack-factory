import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const observe = code => {
  const context = vm.createContext({}, {codeGeneration: {strings: false, wasm: false}});
  try { return {value: new vm.Script(`(()=>{${code}})()`).runInContext(context, {timeout: 200})}; }
  catch (error) { return {error: error.name}; }
};
const run = async (t, source) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-invocation-cli-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const input = path.join(dir, 'source.js');
  const out = path.join(dir, 'out');
  await fsp.writeFile(input, source);
  const child = spawnSync(process.execPath, [cli, 'deobfuscate', input, '-o', out], {encoding: 'utf8', timeout: 5000});
  assert.equal(child.error, undefined, child.error?.message);
  const code = await fsp.readFile(path.join(out, 'source.deobfuscated.js'), 'utf8');
  const report = JSON.parse(await fsp.readFile(path.join(out, 'source.deobfuscation-report.json'), 'utf8'));
  return {child, code, report};
};

test('CLI输出解构和bind调用的可检查保护报告并保持TypeError', async t => {
  const source = 'const {deleteProperty:remove}=Reflect;const run=remove.bind(null,String,"fromCharCode");run();return String.fromCharCode(65);';
  const {child, code, report} = await run(t, source);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(code), {error: 'TypeError'});
  assert.ok(report.builtinEffects.blockedMembers.includes('String.fromCharCode'));
  assert.ok(report.builtinEffects.methodAliases.some(a => a.name === 'run' && a.possibleMethods.includes('Reflect.deleteProperty')));
  assert.equal(report.executesInput, false);
});

test('CLI对解析上限写partial报告并退出3，保留删除后的异常', async t => {
  const source = 'const f0=Reflect.deleteProperty;' +
    Array.from({length: 50}, (_, i) => `const f${i + 1}=f${i}.bind(null);`).join('') +
    'f50(String,"fromCharCode");return String.fromCharCode(65);';
  const {child, code, report} = await run(t, source);
  assert.equal(child.status, 3, child.stderr + child.stdout);
  assert.equal(report.status, 'partial');
  assert.ok(report.residuals.some(r => r.type === 'builtin-invocation-resolution-limit'));
  assert.equal(report.executesInput, false);
  assert.deepEqual(observe(source), {error: 'TypeError'});
  assert.deepEqual(observe(code), {error: 'TypeError'});
});
