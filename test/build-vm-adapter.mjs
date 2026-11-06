import assert from 'node:assert/strict';
import {createRequire, isBuiltin} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

// Development tools and original sources are read only. No runtime npm install is needed.
const factory = fileURLToPath(new URL('../', import.meta.url));
const research = path.resolve(factory, '../research/02engine');
const packager = path.join(research, 'packager');
const vmRoot = path.join(research, 'scratch-vm');
const vendor = path.join(factory, 'vendor');
const expectedRevision = '57871aba53cf739fd1f9bef2e57797f6a999f294';
const requireTool = createRequire(path.join(packager, 'package.json'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
const posix = file => file.split(path.sep).join('/');
const locate = name => path.dirname(requireTool.resolve(`${name}/package.json`));
const logicalPath = file => {
  if (file.startsWith(vmRoot + path.sep)) return `scratch-vm/${posix(path.relative(vmRoot, file))}`;
  if (file.startsWith(packager + path.sep)) return `packager/${posix(path.relative(packager, file))}`;
  if (file.startsWith(factory + path.sep)) return `factory/${posix(path.relative(factory, file))}`;
  return posix(file);
};

assert.equal(git(vmRoot, 'rev-parse', 'HEAD'), expectedRevision, 'local VM revision must match');
for (const root of [vmRoot, packager]) {
  assert.equal(git(root, 'diff', 'HEAD', '--name-only', '--', 'src', 'package.json', 'webpack.config.js', 'bun.lock'), '',
    `upstream sources must be unchanged: ${root}`);
}
const webpack = requireTool('webpack');
assert.equal(webpack.version, '4.47.0');
const vmPackage = await readJSON(path.join(vmRoot, 'package.json'));
const storageRoot = locate('@turbowarp/scratch-storage');
const svgRoot = locate('@turbowarp/scratch-svg-renderer');
const sb1Root = locate('scratch-sb1-converter');
const sourceRoots = [vmRoot, storageRoot, svgRoot, sb1Root, locate('scratch-render-fonts')];
const modules = path.join(packager, 'node_modules');
const evidenceFiles = ['.factory-build/webpack.real-02.cjs', 'webpack.config.js',
  'src/build/inline-worker-loader/worker-loader.js', 'src/build/eager-dynamic-import-plugin.js', 'bun.lock'];
const evidence = Object.fromEntries(await Promise.all(evidenceFiles.map(async file =>
  [file, sha256(await fs.readFile(path.join(packager, file)))])));
const EagerDynamicImportPlugin = requireTool(path.join(packager, 'src/build/eager-dynamic-import-plugin.js'));

await fs.mkdir(vendor, {recursive: true});
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-vm-build-'));
try {
  const entry = path.join(workspace, 'entry.cjs');
  const entrySource = "'use strict';\nconst VM = require('scratch-vm');\nconst Storage = require('@turbowarp/scratch-storage');\n" +
    'class FactoryVirtualMachine extends VM {}\nFactoryVirtualMachine.Storage = Storage;\nmodule.exports = FactoryVirtualMachine;\n';
  await fs.writeFile(entry, entrySource);
  const aliases = Object.fromEntries(Object.keys(vmPackage.dependencies).map(name => [`${name}$`, requireTool.resolve(name)]));
  Object.assign(aliases, {
    'scratch-vm$': path.join(vmRoot, 'src/index.js'),
    '@turbowarp/scratch-storage$': path.join(storageRoot, 'src/index.js'),
    '@turbowarp/scratch-svg-renderer$': path.join(svgRoot, 'src/index.js'),
    // The installed SB1 package's Node main is a prebuilt eval bundle; use its original source.
    'scratch-sb1-converter$': path.join(sb1Root, 'index.js'),
    'scratch-render-fonts$': path.join(locate('scratch-render-fonts'), 'src/index.js')
  });
  const config = {
    context: workspace,
    mode: 'production',
    target: 'node',
    devtool: false,
    entry,
    output: {path: workspace, filename: '02-vm.cjs', libraryTarget: 'commonjs2', hashFunction: 'sha256'},
    node: {__dirname: false, __filename: false},
    externals: [(context, request, callback) => isBuiltin(request)
      ? callback(null, `commonjs ${request}`) : callback()],
    resolve: {modules: ['node_modules', modules], alias: aliases, mainFields: ['main'], extensions: ['.mjs', '.js', '.json']},
    resolveLoader: {modules: [path.join(packager, 'src/build/inline-worker-loader'), modules]},
    module: {rules: [
      {test: /\.(c|m)?jsx?$/, include: [workspace, ...sourceRoots], loader: requireTool.resolve('babel-loader'),
        options: {babelrc: false, configFile: false, presets: [[requireTool.resolve('@babel/preset-env'), {targets: {node: '12'}, modules: false}]]}},
      // Storage's builtins are ArrayBuffers, not asset URLs. Preserve its real asset contract.
      {test: /\.(png|svg|wav)$/i, include: path.join(storageRoot, 'src/builtins'), loader: requireTool.resolve('arraybuffer-loader')},
      {test: /\.(png|svg|mp3|wav)$/i, exclude: path.join(storageRoot, 'src/builtins'),
        use: [{loader: requireTool.resolve('url-loader'), options: {esModule: false, limit: true}}]},
      {test: /\.css$/i, use: [requireTool.resolve('style-loader'), requireTool.resolve('css-loader')]}
      // Font sources explicitly use base64-loader!*.woff2; resolveLoader preserves that inline rule.
    ]},
    optimization: {minimize: false, concatenateModules: false, splitChunks: false, runtimeChunk: false, moduleIds: 'hashed'},
    plugins: [new webpack.DefinePlugin({'process.env.NODE_ENV': JSON.stringify('production')}),
      new EagerDynamicImportPlugin(), new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1})],
    performance: {hints: false}
  };
  console.log(`Building real 02Engine ${expectedRevision} with webpack ${webpack.version}`);
  const compiler = webpack(config);
  const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
  const diagnostics = stats.toJson({all: false, errors: true, warnings: true});
  if (stats.hasErrors()) throw new Error(diagnostics.errors.join('\n\n'));

  const inputs = new Set();
  const runtimeInputs = new Set();
  const loaderInputs = new Set();
  const externals = new Set();
  const contexts = [];
  const visit = compilation => {
    for (const module of compilation.modules) {
      if (module.external) {
        assert.equal(typeof module.request, 'string', 'external must be a single Node builtin');
        assert.ok(isBuiltin(module.request), `nonbuiltin external: ${module.request}`);
        externals.add(module.request);
      }
      if (module.resource) {
        const file = module.resource.split('?')[0];
        inputs.add(file);
        runtimeInputs.add(file);
      }
      for (const loader of module.loaders || []) {
        inputs.add(loader.loader);
        loaderInputs.add(loader.loader);
      }
      if (module.constructor.name === 'ContextModule') contexts.push(module.identifier());
    }
    for (const child of compilation.children) visit(child);
  };
  visit(stats.compilation);
  const assets = Object.keys(stats.compilation.assets);
  assert.deepEqual(assets, ['02-vm.cjs'], 'workers, dynamic imports, and assets must all be inline');
  const vmModules = [...inputs].filter(file => file.startsWith(vmRoot + path.sep));
  assert.ok(vmModules.includes(path.join(vmRoot, 'src/virtual-machine.js')));
  assert.ok(vmModules.includes(path.join(vmRoot, 'src/compiler/compile.js')));
  assert.ok(![...inputs].some(file => file.includes(`${path.sep}node_modules${path.sep}scratch-vm${path.sep}src${path.sep}`)),
    'only the pinned local VM source may be bundled');

  const packages = new Map();
  const packageFor = async file => {
    let dir = path.dirname(file);
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      try {
        const pkg = await readJSON(manifest);
        if (pkg.name) return {root: dir, pkg, manifest};
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      dir = path.dirname(dir);
    }
    return null;
  };
  const inputRecords = [];
  for (const file of [...inputs].sort()) {
    if (file === entry) continue;
    const info = await packageFor(file);
    if (info) packages.set(info.root, info);
    inputRecords.push({path: logicalPath(file), sha256: sha256(await fs.readFile(file))});
  }
  const supplementsPath = path.join(vendor, '02-vm.license-supplements.json');
  const supplements = (await readJSON(supplementsPath)).supplements;
  const licenseSections = [];
  const dependencyRecords = [];
  for (const {root, pkg, manifest} of [...packages.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.root.localeCompare(b.root))) {
    const entries = await fs.readdir(root, {withFileTypes: true});
    const licenseFiles = entries.filter(item => item.isFile() && /^(licen[cs]e|copying|notice|ofl)(\.|$|-)/i.test(item.name));
    const licenses = [];
    for (const item of licenseFiles) {
      const text = await fs.readFile(path.join(root, item.name), 'utf8');
      licenses.push({path: item.name, sha256: sha256(text)});
      licenseSections.push(`===== ${pkg.name}@${pkg.version} (${logicalPath(root)}) / ${item.name} =====\n${text}\n`);
    }
    if (!licenses.length) {
      const supplement = supplements.find(item => item.packages.includes(pkg.name));
      if (supplement) {
        assert.equal(pkg.license, supplement.license);
        licenses.push({path: '02-vm.license-supplements.json', sourceUrls: supplement.sourceUrls, sha256: sha256(supplement.text)});
        licenseSections.push(`===== ${pkg.name}@${pkg.version} / original upstream LICENSE-MIT =====\n${supplement.text}\n`);
      } else {
        const readme = entries.find(item => item.isFile() && /^readme(\.|$)/i.test(item.name));
        if (readme) {
          const text = await fs.readFile(path.join(root, readme.name), 'utf8');
          const section = text.match(/(?:^|\n)(?:#+\s*License|License\n-+)[\s\S]*/i)?.[0];
          if (section) {
            licenses.push({path: readme.name, kind: 'original-readme-license-section', sha256: sha256(section)});
            licenseSections.push(`===== ${pkg.name}@${pkg.version} / ${readme.name} license section =====\n${section}\n`);
          }
        }
      }
    }
    let bunTag = null;
    try { bunTag = (await fs.readFile(path.join(root, '.bun-tag'), 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    dependencyRecords.push({name: pkg.name, version: pkg.version, license: pkg.license || pkg.licenses || null,
      repository: pkg.repository || null, source: logicalPath(root), packageSha256: sha256(await fs.readFile(manifest)),
      includedAs: {
        runtime: [...runtimeInputs].some(file => file.startsWith(root + path.sep)),
        loader: [...loaderInputs].some(file => file.startsWith(root + path.sep))
      }, bunTag, licenses});
  }
  assert.ok(dependencyRecords.every(record => record.licenses.length > 0), 'every included package needs retained license evidence');
  const sourceHashes = {};
  for (const file of git(vmRoot, 'ls-files', '--', 'src', 'package.json', 'LICENSE').split('\n').filter(Boolean)) {
    sourceHashes[file] = sha256(await fs.readFile(path.join(vmRoot, file)));
  }
  const bundle = await fs.readFile(path.join(workspace, '02-vm.cjs'));
  const licenses = licenseSections.join('\n');
  const provenance = {
    schemaVersion: 1, kind: 'portable-actual-02engine-vm-node-bundle',
    tools: {node: process.version, webpack: webpack.version, babelLoader: requireTool('babel-loader/package.json').version,
      babelPresetEnv: requireTool('@babel/preset-env/package.json').version},
    vm: {version: vmPackage.version, repository: vmPackage.repository.url, revision: expectedRevision,
      license: vmPackage.license, sourceSha256: sourceHashes, bundledSourceModules: vmModules.length},
    storage: {name: '@turbowarp/scratch-storage', version: (await readJSON(path.join(storageRoot, 'package.json'))).version,
      entry: logicalPath(path.join(storageRoot, 'src/index.js')), installedNodeMain: logicalPath(requireTool.resolve('@turbowarp/scratch-storage')),
      reason: 'Original installed package source allows inline worker/builtin bytes and complete transitive provenance'},
    packager: {revision: git(packager, 'rev-parse', 'HEAD'), evidenceSha256: evidence,
      lockedVmRevision: 'a1f3a7d', localVmOverride: expectedRevision},
    build: {command: 'node factory/test/build-vm-adapter.mjs', target: 'node', mode: 'production', runtimeNode: '22', babelSyntaxTarget: '12',
      commonJS: true, runtimeFiles: ['02-vm.cjs'], builtinExternals: [...externals].sort(),
      aliases: Object.fromEntries(Object.entries(aliases).map(([key, file]) => [key, logicalPath(file)])),
      dependencyResolution: 'Original package-local node_modules first; packager node_modules fallback. Exact VM direct dependencies use installed packager packages.',
      licenseSupplementsSha256: sha256(await fs.readFile(supplementsPath)),
      loaders: ['babel-loader (isolated config)', 'url-loader (always inline music/image URLs)',
        'arraybuffer-loader (Storage builtin SVG/PNG/WAV bytes)', 'base64-loader (original inline WOFF2 requests)',
        'packager inline-worker-loader (inline, fallback=false)', 'style-loader + css-loader (packager evidence)'],
      eagerDynamicImports: true, behavioralShims: [], upstreamSourcesModified: false,
      entrySource, entrySha256: sha256(entrySource), scriptSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
      warnings: diagnostics.warnings, contexts: contexts.map(value => value.replaceAll(workspace, '<build-workspace>'))},
    dependencies: dependencyRecords,
    moduleInputSha256: inputRecords,
    outputs: {'02-vm.cjs': {bytes: bundle.length, sha256: sha256(bundle)},
      '02-vm.LICENSES.txt': {bytes: Buffer.byteLength(licenses), sha256: sha256(licenses)}}
  };
  // Publish only after successful compilation, external audit, and single-file checks.
  await fs.writeFile(path.join(vendor, '02-vm.cjs'), bundle);
  await fs.writeFile(path.join(vendor, '02-vm.LICENSES.txt'), licenses);
  await fs.writeFile(path.join(vendor, '02-vm.provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  console.log(`BUILD OK: ${bundle.length} bytes; ${vmModules.length} local VM inputs; ${dependencyRecords.length} packages; only Node builtin externals`);
  console.log(`Bundle SHA256 ${sha256(bundle)}; warnings=${diagnostics.warnings.length}`);
  for (const warning of diagnostics.warnings) console.log(warning);
} finally {
  await fs.rm(workspace, {recursive: true, force: true});
}
