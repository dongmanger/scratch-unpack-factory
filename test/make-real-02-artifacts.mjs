// Generate trusted fixtures through the actual local 02Engine packager Node API.
// Recovery below is static: generated HTML and factorySource are never executed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from '@turbowarp/jszip';
import {recursiveRealFixture} from './real-02-recursive.mjs';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {inventory} from '../src/fidelity.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';

const filename = fileURLToPath(import.meta.url);
const factoryRoot = path.resolve(path.dirname(filename), '..');
const packagerRoot = path.resolve(factoryRoot, '..', 'research', '02engine', 'packager');
const vmRoot = path.resolve(packagerRoot, '..', 'scratch-vm');
const buildRoot = path.join(packagerRoot, '.factory-build');
const outputRoot = path.join(factoryRoot, 'fixtures', 'real-02-v1');
const expectedVMRevision = '57871aba53cf739fd1f9bef2e57797f6a999f294';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
const byteData = data => typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
const verifyOnly = process.argv.slice(2).includes('--verify-only');
if (process.argv.slice(2).some(arg => arg !== '--verify-only')) {
  throw new Error('Usage: node factory/test/make-real-02-artifacts.mjs [--verify-only]');
}

async function readProject(bytes) {
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
  const project = JSON.parse(await zip.file('project.json').async('text'));
  const assets = {};
  for (const file of Object.values(zip.files)) {
    if (!file.dir && file.name !== 'project.json') assets[file.name] = await file.async('uint8array');
  }
  return {project, assets};
}

const opcodes = project => project.targets.map(target => ({
  name: target.name,
  counts: Object.fromEntries(Object.entries(Object.values(target.blocks || {}).reduce((counts, block) => {
    const opcode = Array.isArray(block) ? `primitive:${block[0]}` : block.opcode;
    counts[opcode] = (counts[opcode] || 0) + 1;
    return counts;
  }, {})).sort(([a], [b]) => a.localeCompare(b)))
}));

const targetPropertyDifferences = (expected, actual) => expected.targets.flatMap((target, index) => {
  const candidate = actual.targets[index] || {};
  return [...new Set([...Object.keys(target), ...Object.keys(candidate)])]
    .filter(key => !['blocks', 'comments'].includes(key) && JSON.stringify(target[key]) !== JSON.stringify(candidate[key]))
    .map(key => ({targetIndex: index, property: key, expected: target[key], actual: candidate[key]}));
});

async function compareArtifact(bytes, source, {compiled = null, archiveBytes = null} = {}) {
  const extracted = await staticUnpack(bytes);
  assert.equal(extracted.type, 'sb3');
  assert.ok(extracted.compiledProject, 'Static extraction must find the actual compiled-project JSON');
  const bundle = JSON.parse(extracted.compiledProject);
  assert.equal(bundle.format, '02engine-compiled-project');
  if (compiled) assert.deepEqual(bundle, compiled, 'Extracted bundle differs from getCompiledProjectData()');
  const stripped = await readProject(extracted.data);
  if (archiveBytes) assert.deepEqual(stripped, await readProject(archiveBytes), 'Extracted project archive differs from the packager API');
  assert.ok(stripped.project.targets.every(target => Object.keys(target.blocks).length === 0));
  assert.deepEqual(inventory(stripped.project), inventory(source.project));
  assert.deepEqual(Object.keys(stripped.assets).sort(), Object.keys(source.assets).sort());
  for (const [name, data] of Object.entries(source.assets)) {
    assert.deepEqual(Buffer.from(stripped.assets[name]), Buffer.from(data), `Asset changed: ${name}`);
  }
  const restored = await restoreSb3({staticResult: extracted, inputSha256: sha256(bytes), format: extracted.format});
  assert.equal(restored.validation.ok, true, restored.validation.errors.join('\n'));
  assert.deepEqual(inventory(restored.project), inventory(source.project));
  const recoveredArchive = await readProject(restored.data);
  assert.deepEqual(recoveredArchive.assets, stripped.assets);
  const counts = restored.report.code.counts;
  const summary = {
    extraction: {
      format: extracted.format, compiledProjectMatchesAPI: compiled ? true : null,
      compiledProjectSha256: sha256(extracted.compiledProject),
      compiledArchiveMatchesAPI: archiveBytes ? true : null,
      strippedBlockCounts: stripped.project.targets.map(target => Object.keys(target.blocks).length),
      variableListBroadcastNamesIdsInitialValuesPreserved: true, assetsPreserved: true,
      targetPropertyDifferencesFromTrustedSource: targetPropertyDifferences(source.project, stripped.project),
      notes: extracted.notes, warnings: extracted.warnings || [], metadata: extracted.metadata
    },
    recovery: {
      mode: 'static-only', executesInput: false, status: restored.report.status,
      canClaimComplete: restored.report.canClaimComplete,
      validation: restored.validation, counts, unresolved: restored.report.code.unresolved,
      recoveredOpcodes: opcodes(restored.project),
      originalOpcodes: opcodes(source.project),
      variableListBroadcastNamesIdsInitialValuesPreserved: true, assetsPreserved: true,
      sourceGraphExactlyPreserved: false,
      behaviorEquivalenceVerified: false, roundTripRecompilationVerified: false,
      deobfuscation: restored.report.deobfuscation.factories.map(factory => ({
        targetKey: factory.targetKey, kind: factory.kind, scriptId: factory.scriptId,
        status: factory.status, residuals: factory.residuals, warnings: factory.warnings
      }))
    }
  };
  return {bundle, extracted, restored, summary};
}

async function verifyExisting() {
  const manifest = JSON.parse(await fsp.readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'actual-02engine-packager-fixture-corpus');
  for (const [name, record] of Object.entries(manifest.files)) {
    assert.ok(!name.includes('..') && !path.isAbsolute(name));
    const bytes = await fsp.readFile(path.join(outputRoot, name));
    assert.equal(bytes.length, record.bytes, name);
    assert.equal(sha256(bytes), record.sha256, name);
  }
  const source = await readProject(await fsp.readFile(path.join(outputRoot, manifest.input.path)));
  for (const artifact of manifest.artifacts) {
    const bytes = await fsp.readFile(path.join(outputRoot, artifact.path));
    const compiled = JSON.parse(await fsp.readFile(path.join(outputRoot, artifact.compiledProjectPath), 'utf8'));
    const archiveBytes = await fsp.readFile(path.join(outputRoot, artifact.compiledArchivePath));
    const compared = await compareArtifact(bytes, source, {compiled, archiveBytes});
    assert.deepEqual(compared.summary, artifact.comparison, artifact.path);
    console.log(`Verified ${artifact.path}: ${compared.summary.recovery.status}`);
  }
  console.log(`Verified ${manifest.artifacts.length} actual artifacts and ${Object.keys(manifest.files).length} file hashes.`);
}

async function generate() {
  const revision = git(vmRoot, 'rev-parse', 'HEAD');
  assert.equal(revision, expectedVMRevision, 'Exact intended local VM HEAD is required');
  const buildRecordPath = path.join(buildRoot, 'build-record.json');
  const buildRecord = JSON.parse(await fsp.readFile(buildRecordPath, 'utf8'));
  assert.equal(buildRecord.success, true, 'Run .factory-build/build-real-02.cjs successfully first');
  assert.equal(buildRecord.vm.revision, revision);
  assert.equal(buildRecord.packager.revision, git(packagerRoot, 'rev-parse', 'HEAD'));
  assert.ok(buildRecord.vm.bundledModules.length > 0);
  assert.deepEqual(buildRecord.vm.unexpectedVMModules, []);
  for (const root of [packagerRoot, vmRoot]) {
    assert.equal(git(root, 'diff', 'HEAD', '--name-only', '--', 'src', 'package.json', 'webpack.config.js', 'bun.lock'), '',
      `Upstream source/config modified at ${root}`);
  }
  for (const [root, sourceFiles] of [[packagerRoot, buildRecord.packager.trackedSourceSha256], [vmRoot, buildRecord.vm.trackedSourceSha256]]) {
    for (const [name, expected] of Object.entries(sourceFiles)) {
      assert.equal(sha256(await fsp.readFile(path.join(root, name))), expected, `Build source changed: ${name}`);
    }
  }
  for (const [file, expected] of Object.entries({...buildRecord.moduleInputSha256, ...buildRecord.outputSha256,
    [buildRecord.config.path]: buildRecord.config.sha256, [buildRecord.config.runnerPath]: buildRecord.config.runnerSha256})) {
    assert.equal(sha256(await fsp.readFile(file)), expected, `Build input/output changed: ${file}`);
  }
  // Verify Node externals too: these are loaded from the installed locked packages.
  for (const [name, dependency] of Object.entries(buildRecord.installation.dependencies)) {
    const packageFile = path.join(packagerRoot, 'node_modules', name, 'package.json');
    assert.equal(sha256(await fsp.readFile(packageFile)), dependency.packageSha256, `Dependency changed: ${name}`);
    if (dependency.mainSha256) {
      const pkg = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
      assert.equal(sha256(await fsp.readFile(path.resolve(path.dirname(packageFile), pkg.main || 'index.js'))), dependency.mainSha256);
    }
  }
  const require = createRequire(import.meta.url);
  const actual = require(path.join(packagerRoot, 'dist', 'packager.js'));
  assert.equal(typeof actual.Packager.prototype.getCompiledProjectData, 'function');
  assert.equal(typeof actual.Packager.prototype.package, 'function');
  const fixture = await recursiveRealFixture();
  assert.deepEqual(fixture.project.extensions, []);
  assert.equal(Object.keys(fixture.project.extensionURLs || {}).length, 0);
  const sourceZip = new JSZip();
  const zipOptions = {date: new Date('2026-01-01T00:00:00Z')};
  sourceZip.file('project.json', JSON.stringify(fixture.project), zipOptions);
  for (const [name, bytes] of Object.entries(fixture.assets)) sourceZip.file(name, bytes, zipOptions);
  // recursiveRealFixture().bytes still describes its minimal helper; rebuild from the modified project.
  const sourceBytes = await sourceZip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const sourceValidation = await validateSb3(sourceBytes);
  assert.equal(sourceValidation.ok, true, sourceValidation.errors.join('\n'));
  await fsp.mkdir(path.dirname(outputRoot), {recursive: true});
  await fsp.mkdir(outputRoot); // Refuse to overwrite an existing corpus.
  const manifest = {
    schemaVersion: 1, kind: 'actual-02engine-packager-fixture-corpus', generatedAt: new Date().toISOString(),
    provenance: {
      api: ['loadProject', 'Packager.getCompiledProjectData', 'Packager.getCompiledProjectArchiveData', 'Packager.package'],
      packagerRoot, packagerRevision: buildRecord.packager.revision,
      vmRoot, vmRevision: revision, lockfileVMRevision: buildRecord.vm.lockfileRevision,
      exactLocalVMAlias: true, buildRecordPath: 'provenance/build-record.json',
      buildConfigPath: 'provenance/webpack.real-02.cjs', buildRunnerPath: 'provenance/build-real-02.cjs',
      upstreamSourcePackageDocsModified: false,
      tools: buildRecord.tools,
      sourceSha256: {packager: buildRecord.packager.trackedSourceSha256, vm: buildRecord.vm.trackedSourceSha256},
      factorySourceSha256: {},
      compilerEnvironment: {document: typeof document, rendererAttached: false, audioEngineAttached: false,
        storageAttached: true, bitmapAdapterAttached: true, videoProvider: 'upstream CompileTimeVideoProvider'},
      downloads: {scaffolding: 'local dist/scaffolding via unchanged NodeAdapter', nwjs: false, electron: false},
      nondeterminism: ['Upstream javascript-obfuscator has no explicit seed; identifiers and obfuscated bytes may differ between runs',
        'Upstream VM generates a project signature UUID; JSZip and serialized compiler metadata may also vary']
    },
    input: {path: 'trusted-recursive.sb3', projectPath: 'trusted-project.json',
      generator: 'factory/test/real-02-recursive.mjs:recursiveRealFixture', extensions: [], trusted: true,
      sha256: sha256(sourceBytes), validation: sourceValidation, inventory: inventory(fixture.project), opcodes: opcodes(fixture.project),
      assets: Object.fromEntries(Object.entries(fixture.assets).map(([name, bytes]) => [name, {bytes: bytes.length, sha256: sha256(bytes)}]))},
    files: {}, artifacts: [], comparisonPolicy: {
      staticExtractionAndRecoveryOnly: true, generatedHTMLExecuted: false, compiledFactoryExecuted: false,
      originalInternalBlockIdsAndLayoutRecoverable: false, goalCompletionMarked: false
    }
  };
  async function write(name, data, kind) {
    const bytes = byteData(data);
    const dest = path.join(outputRoot, name);
    await fsp.mkdir(path.dirname(dest), {recursive: true});
    await fsp.writeFile(dest, bytes, {flag: 'wx'});
    manifest.files[name] = {kind, bytes: bytes.length, sha256: sha256(bytes)};
  }
  const factoryFiles = ['test/make-real-02-artifacts.mjs', 'test/real-02-recursive.mjs', 'test/helpers.mjs',
    'src/static-unpack.mjs', 'src/restore.mjs', 'src/deobfuscate.mjs', 'src/static-evaluator.mjs',
    'src/recover-code.mjs', 'src/compiled-factory.mjs', 'src/fidelity.mjs', 'src/sb3-validate.mjs',
    'src/recovered-blocks.mjs', 'src/recovery-opcode-schema.mjs', 'src/recovery-symbols.mjs', 'src/recovery-procedures.mjs'];
  for (const name of factoryFiles) manifest.provenance.factorySourceSha256[name] = sha256(await fsp.readFile(path.join(factoryRoot, name)));
  await write(manifest.input.path, sourceBytes, 'trusted-source-sb3');
  await write(manifest.input.projectPath, json(fixture.project), 'trusted-source-project-json');
  for (const name of ['build-record.json', 'webpack.real-02.cjs', 'build-real-02.cjs', 'build-final.log',
    'install-attempt-1.log', 'install-attempt-2.log', 'install-attempt-3.log', 'install-attempt-4.log']) {
    await write(`provenance/${name}`, await fsp.readFile(path.join(buildRoot, name)), 'build-provenance');
  }
  try {
    for (const level of ['none', 'light', 'balanced', 'strong']) {
      for (const target of ['html', 'zip']) {
        const stem = `recursive-${level}`;
        const name = `${stem}.${target}`;
        console.log(`Actual packager: ${name}`);
        const packager = new actual.Packager();
        packager.project = await actual.loadProject(sourceBytes);
        packager.options.target = target;
        packager.options.compiler.compiledProject = true;
        packager.options.compiler.obfuscateCompiledProject = level !== 'none';
        packager.options.compiler.obfuscateCompiledProjectLevel = level === 'none' ? 'balanced' : level;
        packager.options.app.windowTitle = stem;
        packager.options.app.packageName = stem;
        const options = structuredClone(packager.options);
        const resourceEvents = [];
        packager.addEventListener('large-asset-fetch', ({detail}) => {
          assert.ok(['scaffolding', 'scaffolding-min', 'addons'].includes(detail.asset), `Unexpected large download: ${detail.asset}`);
          resourceEvents.push({...detail});
        });
        const compiled = await packager.getCompiledProjectData();
        assert.equal(compiled.obfuscation?.level || 'none', level);
        const archiveBytes = await packager.getCompiledProjectArchiveData();
        const result = await packager.package();
        assert.equal(result.type, target === 'html' ? 'text/html' : 'application/zip');
        const bytes = byteData(result.data);
        await write(name, bytes, 'actual-packager-artifact');
        const compiledProjectPath = `compiled/${stem}-${target}.json`;
        const compiledArchivePath = `compiled/${stem}-${target}.sb3`;
        await write(compiledProjectPath, json(compiled), 'actual-getCompiledProjectData-result');
        await write(compiledArchivePath, archiveBytes, 'actual-getCompiledProjectArchiveData-result');
        const comparison = await compareArtifact(bytes, fixture, {compiled, archiveBytes});
        const recoveryStem = `recovery/${stem}-${target}`;
        await write(`${recoveryStem}.sb3`, comparison.restored.data, 'static-recovery-sb3');
        await write(`${recoveryStem}.fidelity.json`, json(comparison.restored.report), 'static-recovery-evidence');
        await write(`${recoveryStem}.decoded-compiled-project.json`, comparison.restored.decodedCompiledProject, 'static-deobfuscation-result');
        if (level === 'none') {
          assert.equal(comparison.summary.recovery.unresolved.length, 0);
          assert.equal(comparison.summary.recovery.counts.templateReconstructedScripts, 2);
          for (const opcode of ['control_repeat', 'control_if_else', 'operator_gt', 'data_addtolist', 'event_broadcast']) {
            assert.ok(comparison.summary.recovery.recoveredOpcodes[0].counts[opcode], `Baseline missing ${opcode}`);
          }
        }
        manifest.artifacts.push({path: name, sha256: sha256(bytes), bytes: bytes.length, target, level,
          options, returnedFilename: result.filename, returnedType: result.type,
          compiledProjectPath, compiledArchivePath,
          compiledFactoryHashes: Object.fromEntries(Object.entries(compiled.compiledTargets).map(([key, data]) => [key,
            Object.fromEntries(Object.entries(data.scripts).map(([id, script]) => [id, sha256(script.factorySource)]))])),
          resourceEvents, recoverySb3Path: `${recoveryStem}.sb3`, fidelityReportPath: `${recoveryStem}.fidelity.json`,
          comparison: comparison.summary});
        console.log(`  ${bytes.length} bytes; ${comparison.summary.extraction.format}; recovery=${comparison.summary.recovery.status}; unresolved=${comparison.summary.recovery.unresolved.length}`);
      }
    }
    manifest.generationStatus = 'generated-and-statically-compared';
  } catch (error) {
    manifest.generationStatus = 'failed';
    manifest.failure = {name: error.name, message: error.message, stack: error.stack};
    throw error;
  } finally {
    await fsp.writeFile(path.join(outputRoot, 'manifest.json'), json(manifest), {flag: 'wx'});
  }
  console.log(`Manifest: ${path.join(outputRoot, 'manifest.json')}`);
}

if (verifyOnly) await verifyExisting();
else await generate();
