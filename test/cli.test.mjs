import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {makeMinimalSb3, buildO2Html, buildTwHtmlV4, JSZip} from './helpers.mjs';
import {compiledFixture} from './compiled-fixtures.mjs';
import {compileReal02} from './real-02-compiler.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const cli = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const run = (input, out, ...args) => spawnSync(process.execPath, [cli, 'unpack', input, '-o', out, ...args], {encoding: 'utf8'});
const runVerify = (original, recovered, ...args) => spawnSync(process.execPath,
  [cli, 'verify', original, recovered, ...args], {encoding: 'utf8'});
const zipProject = async (project, assets) => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(assets)) zip.file(name, bytes);
  return zip.generateAsync({type: 'uint8array'});
};

async function context(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-cli-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return {dir, input: path.join(dir, 'artifact.html'), out: path.join(dir, 'out')};
}
async function report(out) {return JSON.parse(await fsp.readFile(path.join(out, 'artifact.fidelity-report.json'), 'utf8'));}

test('普通产物CLI保存变量、积木和报告，默认不启动浏览器', async t => {
  const c = await context(t);
  const original = await makeMinimalSb3();
  await fsp.writeFile(c.input, buildTwHtmlV4(original.bytes));
  const result = run(c.input, c.out);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal((await report(c.out)).status, 'preserved');
  const zip = await JSZip.loadAsync(await fsp.readFile(path.join(c.out, 'artifact.sb3')));
  assert.deepEqual(JSON.parse(await zip.file('project.json').async('text')), original.project);
  assert.ok((await fsp.readFile(path.join(c.out, 'artifact.fidelity-report.md'), 'utf8')).includes('变量'));
});

test('明文模板重构写.reconstructed.sb3并退出3，不能伪装完整', async t => {
  const c = await context(t);
  const fixture = await compiledFixture();
  await fsp.writeFile(c.input, fixture.html);
  const result = run(c.input, c.out);
  assert.equal(result.status, 3, result.stderr + result.stdout);
  const r = await report(c.out);
  assert.equal(r.status, 'reconstructed-unverified');
  assert.equal(r.canClaimComplete, false);
  assert.equal(r.confidence.code.score, 0.85);
  await fsp.access(path.join(c.out, 'artifact.reconstructed.sb3'));
  await assert.rejects(fsp.access(path.join(c.out, 'artifact.sb3')));
  await fsp.access(path.join(c.out, 'artifact.compiled-project.json'));
});

test('混淆结构产物写.partial.sb3，--allow-partial仅改变退出码', async t => {
  const c = await context(t);
  const fixture = await compiledFixture({obfuscated: true});
  await fsp.writeFile(c.input, fixture.html);
  const result = run(c.input, c.out, '--allow-partial');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const r = await report(c.out);
  assert.equal(r.status, 'partial');
  assert.equal(r.canClaimComplete, false);
  assert.equal(r.confidence.code.score, 0);
  await fsp.access(path.join(c.out, 'artifact.partial.sb3'));
});

test('变量引用无效只输出失败报告，不输出可打开的sb3假成功', async t => {
  const c = await context(t);
  const fixture = await makeMinimalSb3();
  fixture.project.targets[0].blocks.b.fields.VARIABLE = ['wrong', 'missing-id'];
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(fixture.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
  await fsp.writeFile(c.input, buildTwHtmlV4(await zip.generateAsync({type: 'uint8array'})));
  const result = run(c.input, c.out);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  const r = await report(c.out);
  assert.equal(r.status, 'invalid');
  assert.ok(r.validation.errors.some(x => x.includes('missing-id')));
  await assert.rejects(fsp.access(path.join(c.out, 'artifact.sb3')));
});

test('默认不覆盖已有输出，显式overwrite才允许；非法选项拒绝', async t => {
  const c = await context(t);
  const fixture = await makeMinimalSb3();
  await fsp.writeFile(c.input, buildTwHtmlV4(fixture.bytes));
  assert.equal(run(c.input, c.out).status, 0);
  const initial = await fsp.readFile(path.join(c.out, 'artifact.sb3'));
  assert.equal(run(c.input, c.out).status, 1);
  assert.deepEqual(await fsp.readFile(path.join(c.out, 'artifact.sb3')), initial);
  assert.equal(run(c.input, c.out, '--overwrite').status, 0);
  assert.equal(run(c.input, c.out, '--mode', 'typo').status, 1);
  assert.equal(run(c.input, c.out, '--timeout', 'NaN').status, 1);
});

test('verify CLI requires explicit execution consent and reports a matched artifact pair', async t => {
  const c = await context(t);
  const fixture = await makeMinimalSb3();
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const recoveredProject = {targets: structuredClone(compiled.bundle.targets), extensions: [], monitors: []};
  const recovery = recoverCompiledCode(recoveredProject, compiled.bundle);
  assert.deepEqual(recovery.unresolved, []);
  const recoveredData = await zipProject(recoveredProject, fixture.assets);
  const original = path.join(c.dir, 'original.html');
  const recovered = path.join(c.dir, 'recovered.sb3');
  await fsp.writeFile(original, buildO2Html(compiled.bytes, {
    precompile: true, compiledProject: JSON.stringify(compiled.bundle)
  }));
  await fsp.writeFile(recovered, recoveredData);

  const refused = runVerify(original, recovered);
  assert.equal(refused.status, 4, refused.stderr + refused.stdout);
  const refusedReport = JSON.parse(refused.stdout);
  assert.equal(refusedReport.status, 'refused');
  assert.equal(refusedReport.execution.started, false);

  const matched = runVerify(original, recovered, '--allow-execute', '--timeout-ms', '30000', '--max-steps', '10000');
  assert.equal(matched.status, 0, matched.stderr + matched.stdout);
  const report = JSON.parse(matched.stdout);
  assert.equal(report.status, 'matched');
  assert.equal(report.matched, true);
  assert.equal(report.behavior.snapshotsEqual, true);
  assert.equal(report.behavior.broadcastsEqual, true);
  assert.equal(report.execution.securitySandbox, false);
  assert.equal(report.execution.terminationVerified, true);
});

test('verify拒绝非整数或超上限的timeout-ms/max-steps参数，不启动执行', async t => {
  const c = await context(t);
  const original = path.join(c.dir, 'original.html');
  const recovered = path.join(c.dir, 'recovered.sb3');
  await fsp.writeFile(original, '<html></html>');
  await fsp.writeFile(recovered, '<html></html>');
  for (const args of [['--timeout-ms', '0'], ['--timeout-ms', '600001'], ['--timeout-ms', '1.5'], ['--timeout-ms', 'NaN'],
    ['--max-steps', '0'], ['--max-steps', '1000001'], ['--max-steps', '1e400']]) {
    const r = runVerify(original, recovered, '--allow-execute', ...args);
    assert.equal(r.status, 1, `${args} 应被拒绝：${r.stderr}`);
    assert.match(r.stderr, /必须/);
  }
});
