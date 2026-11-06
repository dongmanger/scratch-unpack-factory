import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire, isBuiltin} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {makeMinimalSb3, JSZip} from './helpers.mjs';

const factory = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(factory, 'vendor');
const packager = path.resolve(factory, '../research/02engine/packager');
const requireTool = createRequire(path.join(packager, 'package.json'));
const execFileAsync = promisify(execFile);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const bundlePath = path.join(vendor, '02-vm.cjs');

async function sb2Fixture() {
  const {project, assets} = await makeMinimalSb3();
  const [stage, sprite] = project.targets;
  const source = {
    objName: 'Stage',
    variables: [{name: '分数', value: 7, isPersistent: false}],
    lists: [{listName: '项目列表', contents: ['开始', '结束', 3], isPersistent: false,
      x: 12, y: 20, width: 100, height: 100, visible: false}],
    scripts: [[32, 64, [['whenGreenFlag'], ['setVar:to:', '分数', '转换后才运行'],
      ['append:toList:', '新增', '项目列表']]]],
    costumes: [{costumeName: '背景 中文', baseLayerID: 0, baseLayerMD5: stage.costumes[0].md5ext,
      bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180}],
    sounds: [], currentCostumeIndex: 0, tempoBPM: 60, videoAlpha: 0.5,
    penLayerMD5: sprite.costumes[0].md5ext, penLayerID: 2,
    children: [{
      objName: '角色 名字', variables: [{name: '分数', value: 11, isPersistent: false}], lists: [],
      scripts: [[48, 96, [['whenGreenFlag'], ['forward:', 10], ['setVar:to:', '分数', 99]]]],
      costumes: [{costumeName: '造型 中文', baseLayerID: 1, baseLayerMD5: sprite.costumes[0].md5ext,
        bitmapResolution: 2, rotationCenterX: 0, rotationCenterY: 0}],
      sounds: [], currentCostumeIndex: 0, scratchX: 23, scratchY: -17, scale: 0.75,
      direction: 90, rotationStyle: 'normal', isDraggable: false, visible: true, indexInLibrary: 1
    }], info: {videoOn: false}
  };
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(source));
  archive.file('0.svg', assets[stage.costumes[0].md5ext]);
  archive.file('1.png', assets[sprite.costumes[0].md5ext]);
  archive.file('2.png', assets[sprite.costumes[0].md5ext]);
  return {bytes: await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE'}), assets};
}

async function buildTestResources(workspace) {
  // Bundle the unchanged real conversion/validator sources for the detached child.
  // This is test tooling only, not a second shipped runtime or a substitute converter.
  const entry = path.join(workspace, 'test-resources-entry.cjs');
  await fs.writeFile(entry,
    `exports.convertLegacy = require(${JSON.stringify(path.join(factory, 'src/legacy-convert.mjs'))}).convertLegacy;\n` +
    `exports.validateSb3 = require(${JSON.stringify(path.join(factory, 'src/sb3-validate.mjs'))}).validateSb3;\n` +
    `exports.JSZip = require(${JSON.stringify(requireTool.resolve('@turbowarp/jszip'))});\n`);
  const webpack = requireTool('webpack');
  const compiler = webpack({
    context: workspace, mode: 'production', target: 'node', devtool: false, entry,
    output: {path: workspace, filename: 'test-resources.cjs', libraryTarget: 'commonjs2', hashFunction: 'sha256'},
    externals: [(context, request, callback) => isBuiltin(request) ? callback(null, `commonjs ${request}`) : callback()],
    resolve: {modules: [path.join(factory, 'node_modules'), path.join(packager, 'node_modules')], mainFields: ['main']},
    module: {rules: [{test: /\.(mjs|js)$/, type: 'javascript/auto', include: path.join(factory, 'src'), loader: requireTool.resolve('babel-loader'),
      options: {babelrc: false, configFile: false,
        presets: [[requireTool.resolve('@babel/preset-env'), {targets: {node: '12'}, modules: false}]]}}]},
    optimization: {minimize: false}, performance: {hints: false}
  });
  const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
  assert.equal(stats.hasErrors(), false, stats.toString({all: false, errors: true}));
  for (const module of stats.compilation.modules) {
    if (module.external) assert.ok(isBuiltin(module.request), `test resource external ${module.request}`);
  }
  await fs.unlink(entry);
}

const childSource = String.raw`
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {createHash} = require('node:crypto');
const root = process.cwd();
// Prime Node's lazy built-in fetch implementation; it installs its own undici dispatcher Symbol.
new globalThis.Headers();
const initialGlobals = new Map(Reflect.ownKeys(globalThis).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const environmentHash = () => createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex');
const initialEnvironmentHash = environmentHash();
const moduleLoads = new Set();
const originalLoad = Module._load;
// Observation only: no VM/runtime overrides. Refuse package or out-of-directory loads.
Module._load = function (request, parent, isMain) {
  if (!Module.isBuiltin(request)) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    assert.ok(resolved.startsWith(root + path.sep), 'detached child reached outside resources: ' + resolved);
    assert.ok(!/[\\/]node_modules[\\/]|[\\/]research[\\/]/i.test(resolved), resolved);
    moduleLoads.add(path.relative(root, resolved));
  }
  return originalLoad.call(this, request, parent, isMain);
};
const VirtualMachine = require('./02-vm.cjs');
const {convertLegacy, validateSb3, JSZip} = require('./test-resources.cjs');
assert.equal(typeof VirtualMachine, 'function');
assert.equal(typeof VirtualMachine.Storage, 'function');
assert.equal(Object.hasOwn(VirtualMachine, 'Storage'), true);
assert.equal(Object.hasOwn(VirtualMachine, 'staticStorage'), false);
assert.equal(Object.getPrototypeOf(VirtualMachine).name, 'VirtualMachine');
assert.deepEqual(Object.getOwnPropertyNames(VirtualMachine.prototype), ['constructor']);
const byName = dictionary => Object.fromEntries(Object.values(dictionary).map(value => [value[0], value[1]]));
const hash = bytes => createHash('md5').update(bytes).digest('hex');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const steps = machine => {
  for (let i = 0; i < 100 && machine.runtime.threads.length; i++) machine.runtime._step();
  assert.equal(machine.runtime.threads.filter(thread => !thread.updateMonitor).length, 0);
};
(async () => {
  const bytes = fs.readFileSync('./minimal.sb3');
  const validation = await validateSb3(bytes);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(validation.warnings, []);
  const machine = new VirtualMachine();
  let compiled;
  try {
    const storage = new VirtualMachine.Storage();
    machine.attachStorage(storage);
    assert.equal(machine.runtime.storage, storage);
    assert.equal(machine.runtime.renderer, undefined);
    assert.equal(machine.runtime.audioEngine, undefined);
    assert.equal(!!machine.runtime.isPackaged, false);
    for (const kind of ['ImageVector', 'ImageBitmap', 'Sound']) {
      const asset = storage.get(storage.defaultAssetId[kind]);
      assert.ok(asset.data instanceof Uint8Array);
      assert.equal(hash(asset.data), asset.assetId, 'bundled builtin asset ' + kind);
    }
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    await machine.loadProject(arrayBuffer(bytes));
    assert.deepEqual(machine.runtime.targets.map(target => target.getName()), ['Stage', 'Sprite1']);
    assert.equal(machine.runtime.targets[0].variables.varId1.value, 0);
    assert.equal(machine.runtime.targets[1].x, 0);
    assert.equal(machine.runtime.threads.length, 0);
    assert.equal(!!machine.runtime.frameLoop.running, false);
    const archive = await JSZip.loadAsync(bytes, {checkCRC32: true});
    for (const target of machine.runtime.targets) {
      for (const costume of target.getCostumes()) {
        assert.ok(costume.asset, costume.name);
        assert.equal(hash(costume.asset.data), costume.assetId);
        assert.deepEqual(Buffer.from(costume.asset.data), Buffer.from(await archive.file(costume.md5).async('uint8array')));
      }
    }
    const project = JSON.parse(await archive.file('project.json').async('text'));
    compiled = await machine.compileProjectFromJSON(project, archive);
    assert.equal(compiled.format, '02engine-compiled-project');
    assert.equal(compiled.version, 1);
    assert.equal(compiled.projectVersion, 3);
    assert.deepEqual(Object.keys(compiled.compiledTargets), ['0', '1']);
    assert.match(compiled.compiledTargets[0].scripts.a.factorySource, /factory-ok/);
    assert.match(compiled.compiledTargets[1].scripts.c.factorySource, /10/);
    assert.equal(machine.runtime.targets[0].variables.varId1.value, 0);
    assert.equal(machine.runtime.targets[1].x, 0);
    // Execute only the trusted minimal fixture to prove actual compiled VM behavior.
    await machine.loadCompiledProject(structuredClone(compiled), archive);
    machine.greenFlag();
    assert.deepEqual(machine.runtime.threads.map(thread => thread.isCompiled), [true, true]);
    steps(machine);
    assert.equal(machine.runtime.targets[0].variables.varId1.value, 'factory-ok');
    assert.equal(machine.runtime.targets[1].x, 10);
  } finally { machine.quit(); }

  const conversion = await convertLegacy({data: fs.readFileSync('./minimal.sb2'), type: 'sb2', VirtualMachine});
  const legacyValidation = await validateSb3(conversion.bytes);
  assert.equal(legacyValidation.ok, true, legacyValidation.errors.join('\n'));
  assert.deepEqual(legacyValidation.warnings, []);
  assert.equal(conversion.metadata.conversion, 'actual-virtual-machine-loadProject-saveProjectSb3');
  assert.equal(conversion.metadata.sourceState.verified, true);
  assert.equal(conversion.metadata.assets.verified, true);
  assert.equal(conversion.metadata.scriptsExecuted, false);
  assert.equal(conversion.metadata.runtimeStarted, false);
  assert.equal(conversion.metadata.provenance.renderer, false);
  assert.equal(conversion.metadata.provenance.audioEngine, false);
  const archive = await JSZip.loadAsync(conversion.bytes, {checkCRC32: true});
  const project = JSON.parse(await archive.file('project.json').async('text'));
  const [stage, sprite] = project.targets;
  assert.deepEqual(project.targets.map(target => target.name), ['Stage', '角色 名字']);
  assert.deepEqual(byName(stage.variables), {'分数': 7});
  assert.deepEqual(byName(stage.lists), {'项目列表': ['开始', '结束', 3]});
  assert.deepEqual(byName(sprite.variables), {'分数': 11});
  assert.equal(sprite.x, 23);
  assert.equal(sprite.y, -17);
  assert.equal(sprite.size, 75);
  for (const target of project.targets) {
    for (const costume of target.costumes) {
      assert.equal(hash(await archive.file(costume.md5ext).async('uint8array')), costume.assetId);
    }
  }
  const legacyMachine = new VirtualMachine();
  try {
    legacyMachine.attachStorage(new VirtualMachine.Storage());
    legacyMachine.setCompilerOptions({enabled: true, warpTimer: false});
    await legacyMachine.loadProject(arrayBuffer(conversion.bytes));
    const legacyCompiled = await legacyMachine.compileProjectFromJSON(project, archive);
    assert.equal(legacyCompiled.format, '02engine-compiled-project');
    assert.equal(Object.values(legacyCompiled.compiledTargets).reduce((n, target) => n + Object.keys(target.scripts).length, 0), 2);
    await legacyMachine.loadCompiledProject(structuredClone(legacyCompiled), archive);
    legacyMachine.greenFlag();
    assert.deepEqual(legacyMachine.runtime.threads.map(thread => thread.isCompiled), [true, true]);
    steps(legacyMachine);
    assert.deepEqual(byName(Object.fromEntries(Object.entries(legacyMachine.runtime.targets[0].variables)
      .map(([id, variable]) => [id, [variable.name, variable.value]]))),
      {'分数': '转换后才运行', '项目列表': ['开始', '结束', 3, '新增']});
    assert.equal(legacyMachine.runtime.targets[1].x, 33);
  } finally { legacyMachine.quit(); }
  assert.equal(environmentHash(), initialEnvironmentHash, 'runtime must not change process environment');
  assert.deepEqual(Reflect.ownKeys(globalThis), [...initialGlobals.keys()], 'runtime must not install browser globals');
  for (const [key, descriptor] of initialGlobals) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
  Module._load = originalLoad;
  fs.writeFileSync('./result.json', JSON.stringify({
    sb3: {loaded: true, compiled: true, scripts: 2, score: 'factory-ok', spriteX: 10},
    sb2: {converted: true, valid: true, preservedState: true, preservedAssets: true, compiledScripts: 2, spriteX: 33},
    moduleLoads: [...moduleLoads].sort(), browserGlobals: false, cwd: root
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

test('vendor provenance records pinned real sources, bytes, licenses, and only builtin externals', async () => {
  const provenance = JSON.parse(await fs.readFile(path.join(vendor, '02-vm.provenance.json'), 'utf8'));
  assert.equal(provenance.vm.revision, '57871aba53cf739fd1f9bef2e57797f6a999f294');
  assert.equal(provenance.tools.webpack, '4.47.0');
  assert.equal(provenance.storage.name, '@turbowarp/scratch-storage');
  assert.equal(provenance.storage.version, '0.0.202505311821');
  assert.deepEqual(provenance.build.runtimeFiles, ['02-vm.cjs']);
  assert.deepEqual(provenance.build.behavioralShims, []);
  assert.equal(provenance.build.upstreamSourcesModified, false);
  assert.ok(provenance.build.builtinExternals.every(isBuiltin));
  assert.deepEqual(provenance.build.contexts, []);
  const bytes = await fs.readFile(bundlePath);
  assert.equal(sha256(bytes), provenance.outputs['02-vm.cjs'].sha256);
  const licenseBytes = await fs.readFile(path.join(vendor, '02-vm.LICENSES.txt'));
  assert.equal(sha256(licenseBytes), provenance.outputs['02-vm.LICENSES.txt'].sha256);
  assert.ok(provenance.dependencies.every(pkg => pkg.licenses.length > 0), 'license evidence required for every included package');
  assert.equal(sha256(await fs.readFile(path.join(vendor, '02-vm.license-supplements.json'))), provenance.build.licenseSupplementsSha256);
  assert.equal(sha256(await fs.readFile(path.join(factory, 'test/build-vm-adapter.mjs'))), provenance.build.scriptSha256);
  assert.ok(provenance.dependencies.some(pkg => pkg.name === 'scratch-vm' && pkg.license === 'MPL-2.0'));
  assert.ok(provenance.dependencies.some(pkg => pkg.name === '@turbowarp/scratch-storage' && pkg.license === 'BSD-3-Clause'));
  assert.equal(provenance.moduleInputSha256.filter(input => input.path.endsWith('.woff2')).length, 7);
  assert.equal(provenance.moduleInputSha256.filter(input => input.path.endsWith('.mp3')).length, 61);
  // Verify emitted font/music bytes rather than accepting only source filenames in the record.
  const bundleText = bytes.toString('utf8');
  for (const input of provenance.moduleInputSha256.filter(input => /\.(mp3|woff2)$/.test(input.path))) {
    const file = input.path.startsWith('scratch-vm/')
      ? path.resolve(packager, '../scratch-vm', input.path.slice('scratch-vm/'.length))
      : path.join(packager, input.path.slice('packager/'.length));
    const asset = await fs.readFile(file);
    assert.equal(sha256(asset), input.sha256);
    assert.ok(bundleText.includes(asset.toString('base64')), `asset bytes missing from bundle: ${input.path}`);
  }
});

test('detached CommonJS child loads genuine SB3, compiles/runs trusted scripts, and converts real SB2', {timeout: 60000}, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-vm-portable-'));
  try {
    await fs.copyFile(bundlePath, path.join(workspace, '02-vm.cjs'));
    await buildTestResources(workspace);
    const minimal = await makeMinimalSb3();
    const sb2 = await sb2Fixture();
    await fs.writeFile(path.join(workspace, 'minimal.sb3'), minimal.bytes);
    await fs.writeFile(path.join(workspace, 'minimal.sb2'), sb2.bytes);
    await fs.writeFile(path.join(workspace, 'child.cjs'), childSource);
    const env = {...process.env};
    for (const key of Object.keys(env)) {
      if (/^NODE_(PATH|OPTIONS)$/i.test(key) || /^FACTORY_/i.test(key)) delete env[key];
    }
    const {stdout, stderr} = await execFileAsync(process.execPath, ['--no-global-search-paths', 'child.cjs'], {
      cwd: workspace, env, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true
    });
    const result = JSON.parse(await fs.readFile(path.join(workspace, 'result.json'), 'utf8'));
    assert.deepEqual(result.sb3, {loaded: true, compiled: true, scripts: 2, score: 'factory-ok', spriteX: 10});
    assert.deepEqual(result.sb2, {converted: true, valid: true, preservedState: true, preservedAssets: true, compiledScripts: 2, spriteX: 33});
    assert.deepEqual(result.moduleLoads, ['02-vm.cjs', 'test-resources.cjs']);
    assert.equal(result.cwd, workspace);
    assert.equal(result.browserGlobals, false);
    assert.ok(!/(MODULE_NOT_FOUND|Cannot find module|ReferenceError|TypeError)/.test(stdout + stderr), stdout + stderr);
    t.diagnostic(`Detached child passed on ${process.version}; no research/node_modules resolution; only copied bundle and test resources`);
  } finally {
    await fs.rm(workspace, {recursive: true, force: true});
  }
});
