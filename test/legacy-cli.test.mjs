import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {actualVMRoot} from './real-02-compiler.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';

const cli = fileURLToPath(new URL('../bin/factory.mjs', import.meta.url));
const require = createRequire(path.join(actualVMRoot(), 'package.json'));

test('默认CLI使用随包真实VM转换SB1，无需研究目录适配参数', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-default-legacy-cli-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const parserRoot = path.dirname(require.resolve('scratch-parser/package.json'));
  const input = path.join(parserRoot, 'test/fixtures/data/_empty.sb');
  const out = path.join(dir, 'out');
  const child = spawnSync(process.execPath, [cli, 'unpack', input, '-o', out], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 3, child.stderr + child.stdout);
  const report = JSON.parse(await fsp.readFile(path.join(out, '_empty.fidelity-report.json'), 'utf8'));
  assert.equal(report.status, 'reconstructed-unverified');
  assert.equal(report.legacyConversion.scriptsExecuted, false);
  assert.equal((await validateSb3(await fsp.readFile(path.join(out, '_empty.reconstructed.sb3')))).ok, true);
});

test('CLI通过显式可信VM转换真实SB1，输出不冒称原图保留', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-legacy-cli-'));
  t.after(() => fsp.rm(dir, {recursive:true,force:true}));
  const parserRoot = path.dirname(require.resolve('scratch-parser/package.json'));
  const input = path.join(parserRoot, 'test/fixtures/data/_empty.sb');
  const adapter = path.join(dir,'adapter.cjs');
  const storage = fileURLToPath(new URL('../../research/02engine/packager/node_modules/@turbowarp/scratch-storage/dist/node/scratch-storage.js',import.meta.url));
  await fsp.writeFile(adapter, `const VM=require(${JSON.stringify(path.join(actualVMRoot(),'src/index.js'))});const Storage=require(${JSON.stringify(storage)});module.exports=class extends VM{static Storage=Storage;};`);
  const out = path.join(dir,'out');
  const child = spawnSync(process.execPath,[cli,'unpack',input,'--vm-module',adapter,'-o',out],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,3,child.stderr+child.stdout);
  const report = JSON.parse(await fsp.readFile(path.join(out,'_empty.fidelity-report.json'),'utf8'));
  assert.equal(report.status,'reconstructed-unverified');
  assert.equal(report.canClaimComplete,false);
  assert.equal(report.legacyConversion.scriptsExecuted,false);
  assert.equal(report.legacyConversion.sourceType,'sb');
  assert.equal(report.confidence.originalBlockStructure.score,0);
  const bytes=await fsp.readFile(path.join(out,'_empty.reconstructed.sb3'));
  assert.equal((await validateSb3(bytes)).ok,true);
});
