'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const vmRoot = path.resolve(root, '..', 'scratch-vm');
const expectedVM = '57871aba53cf739fd1f9bef2e57797f6a999f294';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();
const revision = git(vmRoot, 'rev-parse', 'HEAD');
if (revision !== expectedVM) throw new Error(`Unexpected local VM revision: ${revision}`);
for (const dir of [root, vmRoot]) {
  const changes = git(dir, 'diff', 'HEAD', '--name-only', '--', 'src', 'package.json', 'webpack.config.js', 'bun.lock');
  if (changes) throw new Error(`Source/config changes at ${dir}: ${changes}`);
}
process.chdir(root);
const webpack = require(path.join(root, 'node_modules', 'webpack'));
const configPath = path.join(__dirname, 'webpack.real-02.cjs');
const configs = require(configPath);
const recordPath = path.join(__dirname, 'build-record.json');
const startedAt = new Date().toISOString();
const compiler = webpack(configs);
compiler.run((error, stats) => {
  if (error) { console.error(error); process.exitCode = 1; return; }
  console.log(stats.toString({colors: false, modules: false, children: true}));
  const children = stats.stats || [stats];
  const inputs = new Set();
  const outputs = new Set();
  const sourceModules = [];
  const visit = (compilation, target) => {
    for (const module of compilation.modules || []) {
      if (!module.resource) continue;
      const file = module.resource.split('?')[0];
      if (fs.existsSync(file) && fs.statSync(file).isFile()) inputs.add(file);
      if (/[/\\]scratch-vm[/\\]src[/\\]/.test(file)) sourceModules.push({target, path: file});
    }
    for (const child of compilation.children || []) visit(child, target);
  };
  const results = children.map((child, i) => {
    visit(child.compilation, configs[i].target || 'web');
    for (const file of Object.keys(child.compilation.assets)) outputs.add(path.join(root, 'dist', file));
    const json = child.toJson({all: false, errors: true, warnings: true});
    return {entry: configs[i].entry, target: configs[i].target || 'web', hash: child.hash,
      errors: json.errors, warnings: json.warnings};
  });
  const unexpectedVMModules = sourceModules.filter(module => !module.path.startsWith(vmRoot + path.sep));
  if (!sourceModules.length || unexpectedVMModules.length) {
    console.error('VM source provenance check failed', unexpectedVMModules);
    process.exitCode = 1;
  }
  const hashFiles = files => Object.fromEntries([...files].sort().map(file => [file, hash(fs.readFileSync(file))]));
  const trackedHashes = dir => {
    const files = git(dir, 'ls-files', '--', 'src', 'package.json', 'webpack.config.js', 'babel.config.js', 'bun.lock')
      .split('\n').filter(Boolean);
    return Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(dir, file)))]));
  };
  const lockedVM = fs.readFileSync(path.join(root, 'bun.lock'), 'utf8').match(/"scratch-vm": \["scratch-vm@github:02engine\/scratch-vm#([^"\s]+)"/)[1];
  const dependencies = {};
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  for (const name of Object.keys({...declared.dependencies, ...declared.devDependencies}).sort()) {
    const file = path.join(root, 'node_modules', name, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file));
    const main = path.resolve(path.dirname(file), pkg.main || 'index.js');
    dependencies[name] = {version: pkg.version, packageSha256: hash(fs.readFileSync(file)),
      realPath: fs.realpathSync(path.dirname(file)),
      ...(fs.existsSync(main) ? {mainSha256: hash(fs.readFileSync(main))} : {}),
      ...(fs.existsSync(path.join(path.dirname(file), '.bun-tag')) ? {
        bunTag: fs.readFileSync(path.join(path.dirname(file), '.bun-tag'), 'utf8').trim()
      } : {})};
  }
  const record = {
    schemaVersion: 1, kind: 'actual-source-webpack-node-and-scaffolding-build', startedAt,
    finishedAt: new Date().toISOString(), success: !stats.hasErrors() && !process.exitCode,
    tools: {node: process.version, bun: execFileSync('bun', ['--version'], {encoding: 'utf8'}).trim(), webpack: webpack.version},
    packager: {root, revision: git(root, 'rev-parse', 'HEAD'), trackedSourceSha256: trackedHashes(root)},
    vm: {root: vmRoot, revision, lockfileRevision: lockedVM, intendedLocalOverride: true,
      trackedSourceSha256: trackedHashes(vmRoot), bundledModules: sourceModules, unexpectedVMModules},
    config: {path: configPath, sha256: hash(fs.readFileSync(configPath)),
      runnerPath: __filename, runnerSha256: hash(fs.readFileSync(__filename)),
      mode: 'development', buildMode: 'node', upstreamFilesModified: false,
      adjustments: ['absolute context and Babel preset resolution', 'exact local VM source alias',
        'locked renderer/audio/SVG source entry aliases because GitHub tarballs lack dist',
        'Babel transpilation for local VM and source library entries',
        'Node CSS and MP3 URL loaders; upstream inline raw-loader preserves shader/CSS text',
        'Node javascript-obfuscator and jsdom stay locked CommonJS externals'],
      dependencyRepair: 'Bun interrupted isolated copy of scratch-render was repaired from retained .old_modules copy; both .bun-tag values are 02engine-scratch-render-6762ea8'},
    installation: {command: 'bun install --cwd "D:/rebuild&unpack/research/02engine/packager" --frozen-lockfile --linker hoisted --ignore-scripts --network-concurrency 8',
      successfulLog: path.join(__dirname, 'install-attempt-4.log'), scriptsSkipped: true,
      lockfileSha256: hash(fs.readFileSync(path.join(root, 'bun.lock'))), dependencies},
    results, moduleInputSha256: hashFiles(inputs), outputSha256: hashFiles(outputs)
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`Build provenance: ${recordPath}; success=${record.success}; VM modules=${sourceModules.length}`);
  if (!record.success) process.exitCode = 1;
});
