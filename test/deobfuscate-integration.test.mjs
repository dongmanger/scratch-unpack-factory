import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import {compiledFixture} from './compiled-fixtures.mjs';
import {buildO2Html, JSZip} from './helpers.mjs';
import {OFFICIAL_02_PRESETS} from './obfuscation-corpus.mjs';
import {restoreSb3} from '../src/restore.mjs';

function scramble(source, level) {
  const code = JavaScriptObfuscator.obfuscate(`(()=>{const __o2_factory_out__=${source};return __o2_factory_out__;})()`,
    {...OFFICIAL_02_PRESETS[level], stringArrayEncoding: [...OFFICIAL_02_PRESETS[level].stringArrayEncoding],
      stringArrayIndexesType: [...OFFICIAL_02_PRESETS[level].stringArrayIndexesType], seed: 24831}).getObfuscatedCode();
  return `eval(${JSON.stringify(code)})`;
}

for (const level of ['light', 'balanced', 'strong']) {
  test(`real ${level} factory混淆 → 解混淆 → 恢复积木，变量名广播ID不变`, async () => {
    const fixture = await compiledFixture();
    for (const target of Object.values(fixture.bundle.compiledTargets)) {
      for (const script of Object.values(target.scripts)) script.factorySource = scramble(script.factorySource, level);
    }
    const restored = await restoreSb3({staticResult: {type: 'sb3', format: 'o2-html-precompile', data: fixture.bytes,
      compiledProject: JSON.stringify(fixture.bundle)}, format: 'o2-html-precompile'});
    assert.equal(restored.report.status, 'reconstructed-unverified', JSON.stringify(restored.report.code.unresolved));
    assert.equal(restored.report.code.counts.templateReconstructedScripts, 2);
    assert.equal(restored.report.confidence.code.score, 0.85);
    assert.equal(restored.report.deobfuscation.transformedFactories, 2);
    assert.ok(restored.report.deobfuscation.factories.every(f => f.residuals.length === 0 && f.executesInput === false));
    assert.ok(!restored.decodedCompiledProject.includes('eval('));
    const zip = await JSZip.loadAsync(restored.data);
    const project = JSON.parse(await zip.file('project.json').async('text'));
    for (const [i, target] of project.targets.entries()) {
      for (const key of ['variables', 'lists', 'broadcasts']) assert.deepEqual(target[key], fixture.stripped.targets[i][key]);
    }
    assert.deepEqual(project.targets[1].blocks.r.fields.BROADCAST_OPTION, ['StartGame', 'bStart']);
    assert.ok(Object.values(project.targets[1].blocks).some(b => b.opcode === 'event_broadcastandwait'));
    for (const [name, bytes] of Object.entries(fixture.assets)) assert.deepEqual(await zip.file(name).async('uint8array'), bytes);
  });
}

test('CLI直接解混淆JS和SB3流水线输出两份编译包及转换证据', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deobfuscation-cli-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = scramble(fixture.bundle.compiledTargets[0].scripts.a.factorySource, 'strong');
  const jsPath = path.join(dir, 'factory.js');
  await fs.writeFile(jsPath, fixture.bundle.compiledTargets[0].scripts.a.factorySource);
  const cli = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
  const out = path.join(dir, 'out');
  const run = spawnSync(process.execPath, [cli, 'deobfuscate', jsPath, '-o', out], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok((await fs.readFile(path.join(out, 'factory.deobfuscated.js'), 'utf8')).includes('StartGame'));
  const report = JSON.parse(await fs.readFile(path.join(out, 'factory.deobfuscation-report.json'), 'utf8'));
  assert.equal(report.executesInput, false);
  assert.equal(report.residuals.length, 0);
  const html = path.join(dir, 'project.html');
  await fs.writeFile(html, buildO2Html(fixture.bytes, {precompile: true, compiledProject: JSON.stringify(fixture.bundle)}));
  const unpack = spawnSync(process.execPath, [cli, 'unpack', html, '-o', out, '--allow-partial'], {encoding: 'utf8'});
  assert.equal(unpack.status, 0, unpack.stdout + unpack.stderr);
  await fs.access(path.join(out, 'project.reconstructed.sb3'));
  await fs.access(path.join(out, 'project.compiled-project.json'));
  await fs.access(path.join(out, 'project.deobfuscated-compiled-project.json'));
});
