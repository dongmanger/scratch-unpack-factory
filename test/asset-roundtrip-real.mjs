// Optional bounded static-only acceptance for existing local user artifacts.
// Usage: node test/asset-roundtrip-real.mjs [--sample ID] [--family tw|o2] [--format html|zip]
//        node test/asset-roundtrip-real.mjs --summarize-existing
// Never executes artifact HTML, JavaScript, factories, or recovered user scripts.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {sha256, mediaSelectionInventory, mediaMetadata, loadBundledAssets} from './asset-roundtrip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.dirname(root);
const output = path.join(root, 'fixtures', 'asset-acceptance', 'asset-roundtrip-real');
const summarizeExisting = process.argv.includes('--summarize-existing');
const args = process.argv.slice(2).filter(arg => arg !== '--summarize-existing'); const filters = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--sample', '--family', '--format'].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown argument ${args[i]}`);
  filters[args[i].slice(2)] = args[i + 1];
}
const exists = async file => fsp.access(file).then(() => true, () => false);
const errorRecord = error => ({name: error.name, code: error.code || null, message: error.message,
  cause: error.cause ? {name: error.cause.name, message: error.cause.message} : null});
const readProjectArchive = async bytes => {
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
  const file = zip.file('project.json');
  if (!file) throw new Error('Extracted archive has no root project.json');
  const project = JSON.parse(await file.async('text'));
  const assets = {};
  for (const file of Object.values(zip.files)) if (!file.dir && file.name !== 'project.json') assets[file.name] = await file.async('uint8array');
  return {project, assets};
};
const counts = ({project, assets}) => ({targets: project.targets.length,
  costumes: project.targets.reduce((n, target) => n + target.costumes.length, 0),
  sounds: project.targets.reduce((n, target) => n + target.sounds.length, 0), resources: Object.keys(assets).length,
  bytes: Object.values(assets).reduce((n, bytes) => n + bytes.length, 0),
  selectionCommands: mediaSelectionInventory(project).reduce((n, scripts) => n + scripts.length, 0)});
const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (expected, actual) => {
  const missing = Object.keys(expected.assets).filter(name => !Object.hasOwn(actual.assets, name));
  const added = Object.keys(actual.assets).filter(name => !Object.hasOwn(expected.assets, name));
  const changed = Object.keys(expected.assets).filter(name => Object.hasOwn(actual.assets, name) && sha256(expected.assets[name]) !== sha256(actual.assets[name]));
  const metadata = []; const before = mediaMetadata(expected.project); const after = mediaMetadata(actual.project);
  if (before.length !== after.length) metadata.push({property: 'targets.length', expected: before.length, actual: after.length});
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    for (const key of new Set([...Object.keys(before[index] || {}), ...Object.keys(after[index] || {})])) {
      if (!jsonEqual(before[index]?.[key], after[index]?.[key])) metadata.push({targetIndex: index, targetName: before[index]?.name,
        property: key, expected: before[index]?.[key], actual: after[index]?.[key]});
    }
  }
  const selectionsEqual = jsonEqual(mediaSelectionInventory(expected.project), mediaSelectionInventory(actual.project));
  return {missing, added, changed, metadata, selectionsEqual};
};
const clean = comparison => comparison.missing.length === 0 && comparison.added.length === 0 && comparison.changed.length === 0 && comparison.metadata.length === 0;
const staticAssetStatus = record => {
  const crossFormatOK = ['missing', 'added', 'changed'].every(key => record.crossFormatAssets[key].length === 0);
  return crossFormatOK && record.sourceMetadataChanges.length === 0 && record.modes.every(mode => clean(mode.changes) && mode.vmLoad.ok);
};
const projectValidationStatus = record => record.modes.every(mode => mode.validation.ok) ? 'valid' : 'invalid';
const plans = [
  ...['10128407-zip.zip', '437419376-html.html', '437419376-zip.zip'].map(name => ({family: 'tw', name})),
  ...['10128407-plain.html', '10128407-plain.zip', '10128407-strong.html', '10128407-strong.zip',
    '437419376-light.html', '437419376-light.zip', '437419376-strong.html', '437419376-strong.zip'].map(name => ({family: 'o2', name}))
].map(plan => ({...plan, sample: plan.name.split('-')[0], format: path.extname(plan.name).slice(1)}))
  .filter(plan => Object.entries(filters).every(([key, value]) => plan[key] === value));
const evidence = {kind: 'asset-roundtrip-existing-local-user-artifacts-static-only', startedAt: new Date().toISOString(),
  script: fileURLToPath(import.meta.url), sourceRoot: path.join(workspace, 'compiled'), outputRoot: output,
  policy: {artifactJavaScriptExecuted: false, compiledFactoriesExecuted: false, recoveredScriptsExecuted: false,
    browserUsed: false, renderer: false, audioEngine: false, networkAllowed: false,
    originalBlockIdsRequired: false, desktopDistributionCoverage: false,
    limitations: ['Source samples are JSON-only .sb3 files: original source asset bytes are unavailable; asset hashes are compared extracted container → restored output.',
      'Actual bundled VM load validates archive/storage ownership, bytes and broken markers without rendering or audio decoding.',
      'Selection-code inventory is a limited structural comparison, not universal behavior equivalence or full recovery support.']},
  filters, artifacts: []};
const sources = new Map();
const referenceAssets = new Map();
await fsp.mkdir(output, {recursive: true});
for (const plan of plans) {
  const artifactPath = path.join(workspace, 'compiled', plan.family, plan.name);
  const sourcePath = path.join(workspace, 'samples', `${plan.sample}.sb3`);
  // Keep .html/.zip in the directory name: same-stem inputs must never collide.
  const destination = path.join(output, plan.family, plan.name);
  const record = {...plan, artifactPath, sourcePath, destination, status: 'pending', stage: 'availability'};
  evidence.artifacts.push(record);
  if (!await exists(artifactPath) || !await exists(sourcePath)) {
    record.status = 'skipped'; record.reason = 'Optional local artifact or source sample is absent';
    console.log(JSON.stringify({artifact: `${plan.family}/${plan.name}`, status: record.status, reason: record.reason})); continue;
  }
  if (summarizeExisting) {
    const saved = JSON.parse(await fsp.readFile(path.join(destination, 'evidence.json'), 'utf8'));
    Object.assign(record, saved);
    if (record.status === 'skipped' || record.status === 'error') continue;
    record.inputSha256 = sha256(await fsp.readFile(artifactPath));
    assert.equal(record.inputSha256, saved.inputSha256, 'saved artifact evidence matches current input');
    for (const mode of record.modes) {
      const bytes = await fsp.readFile(mode.sb3Path);
      assert.equal(sha256(bytes), mode.outputSha256, 'saved VM evidence matches current output');
      const restored = await readProjectArchive(bytes);
      mode.selectionCodeSha256 = sha256(Buffer.from(JSON.stringify(mediaSelectionInventory(restored.project))));
      const validation = mode.validation;
      mode.validation = {ok: validation.ok, errorCount: validation.errors.length, errors: validation.errors,
        warningCount: validation.warnings.length, warnings: validation.warnings};
    }
    if (!referenceAssets.has(plan.sample)) referenceAssets.set(plan.sample, {artifact: `${plan.family}/${plan.name}`, assets: saved.extractedAssets});
    const reference = referenceAssets.get(plan.sample);
    record.crossFormatAssets = {referenceArtifact: reference.artifact,
      missing: Object.keys(reference.assets).filter(name => !saved.extractedAssets[name]),
      added: Object.keys(saved.extractedAssets).filter(name => !reference.assets[name]),
      changed: Object.keys(reference.assets).filter(name => saved.extractedAssets[name] && reference.assets[name].sha256 !== saved.extractedAssets[name].sha256)};
    record.projectValidation = projectValidationStatus(record);
    record.assetIntegrity = staticAssetStatus(record) ? 'pass' : 'fail';
    record.status = record.assetIntegrity === 'pass' ? 'asset-pass' : 'asset-fail';
    record.beautifyContract.modeSelectionInventoryEqual = record.modes[0].selectionCodeSha256 === record.modes[1].selectionCodeSha256;
    record.revalidatedExistingOutputHashes = true;
    await fsp.writeFile(path.join(destination, 'evidence.json'), JSON.stringify(record, null, 2));
    console.log(JSON.stringify({artifact: `${plan.family}/${plan.name}`, status: record.status, projectValidation: record.projectValidation,
      crossFormatAssets: record.crossFormatAssets, beautifyContract: record.beautifyContract}));
    continue;
  }
  try {
    if (!sources.has(plan.sample)) {
      const sourceBytes = await fsp.readFile(sourcePath);
      let source;
      if (sourceBytes[0] === 0x50 && sourceBytes[1] === 0x4b) source = await readProjectArchive(sourceBytes);
      else source = {project: JSON.parse(sourceBytes.toString('utf8')), assets: {}};
      sources.set(plan.sample, {sourceBytes, ...source});
    }
    const source = sources.get(plan.sample); const bytes = await fsp.readFile(artifactPath);
    record.inputSha256 = sha256(bytes); record.inputBytes = bytes.length; record.sourceSha256 = sha256(source.sourceBytes);
    record.source = counts(source);
    record.stage = 'static-extraction';
    const extraction = await staticUnpack(bytes);
    record.extractionFormat = extraction.format; record.extractionNotes = extraction.notes;
    record.hasCompiledProject = Boolean(extraction.compiledProject);
    const extracted = await readProjectArchive(extraction.data); record.extracted = counts(extracted);
    record.extractedAssets = Object.fromEntries(Object.entries(extracted.assets).map(([name, asset]) => [name, {bytes: asset.length, sha256: sha256(asset)}]));
    if (!referenceAssets.has(plan.sample)) referenceAssets.set(plan.sample, {artifact: `${plan.family}/${plan.name}`, extracted});
    const reference = referenceAssets.get(plan.sample);
    const referenceChanges = compare(reference.extracted, {project: reference.extracted.project, assets: extracted.assets});
    record.crossFormatAssets = {referenceArtifact: reference.artifact, missing: referenceChanges.missing,
      added: referenceChanges.added, changed: referenceChanges.changed};
    // Source JSON is authoritative for ownership/order and all non-code target state.
    record.sourceMetadataChanges = compare({project: source.project, assets: extracted.assets}, extracted).metadata;
    record.modes = [];
    await fsp.mkdir(destination, {recursive: true});
    for (const beautify of [false, true]) {
      record.stage = `restore-beautify-${beautify ? 'on' : 'off'}`;
      const result = await restoreSb3({staticResult: extraction, inputSha256: record.inputSha256, format: extraction.format, beautify});
      const restored = await readProjectArchive(result.data);
      const changes = compare(extracted, restored);
      const mode = {beautify, status: result.report.status,
        validation: {ok: result.validation.ok, errorCount: result.validation.errors.length,
          errors: result.validation.errors, warningCount: result.validation.warnings.length, warnings: result.validation.warnings},
        counts: counts(restored), changes,
        selectionCodeSha256: sha256(Buffer.from(JSON.stringify(mediaSelectionInventory(restored.project)))),
        sourceSelectionCodeEqual: jsonEqual(mediaSelectionInventory(source.project), mediaSelectionInventory(restored.project)),
        unresolved: result.report.code.unresolved, outputSha256: sha256(result.data)};
      record.modes.push(mode);
      const modeName = `beautify-${beautify ? 'on' : 'off'}`;
      mode.sb3Path = path.join(destination, `${modeName}.sb3`);
      await fsp.writeFile(mode.sb3Path, result.data);
      await fsp.writeFile(path.join(destination, `${modeName}.fidelity.json`), JSON.stringify(result.report, null, 2));
      record.stage = `bundled-VM-load-${modeName}`;
      try {
        await loadBundledAssets(result.data, result.project, extracted.assets);
        mode.vmLoad = {ok: true, renderer: false, audioEngine: false, scriptsExecuted: false, brokenCostumes: 0, brokenSounds: 0, remoteFetches: 0};
      } catch (error) { mode.vmLoad = {ok: false, error: errorRecord(error)}; }
    }
    record.beautifyContract = {metadataAndResourcesEqual: record.modes.every(mode => clean(mode.changes)),
      sourceSelectionInventoryEqualInBoth: record.modes.every(mode => mode.sourceSelectionCodeEqual),
      modeSelectionInventoryEqual: record.modes[0].selectionCodeSha256 === record.modes[1].selectionCodeSha256,
      countsEqual: jsonEqual(record.modes[0].counts, record.modes[1].counts)};
    record.projectValidation = projectValidationStatus(record);
    record.assetIntegrity = staticAssetStatus(record) ? 'pass' : 'fail';
    record.status = record.assetIntegrity === 'pass' ? 'asset-pass' : 'asset-fail';
    record.codeScope = record.modes.every(mode => mode.unresolved.length === 0 && mode.sourceSelectionCodeEqual) ? 'selection-inventory-matches' : 'partial-or-selection-diff';
    record.stage = 'complete';
    await fsp.writeFile(path.join(destination, 'evidence.json'), JSON.stringify(record, null, 2));
  } catch (error) {
    record.status = 'error'; record.error = errorRecord(error);
    await fsp.mkdir(destination, {recursive: true});
    await fsp.writeFile(path.join(destination, 'evidence.json'), JSON.stringify(record, null, 2));
  }
  console.log(JSON.stringify({artifact: `${plan.family}/${plan.name}`, status: record.status, stage: record.stage,
    extracted: record.extracted, modes: record.modes?.map(mode => ({beautify: mode.beautify, status: mode.status,
      resources: mode.counts.resources, missing: mode.changes.missing.length, changed: mode.changes.changed.length,
      metadata: mode.changes.metadata.length, vm: mode.vmLoad?.ok, unresolved: mode.unresolved.length,
      sourceSelectionCodeEqual: mode.sourceSelectionCodeEqual})), error: record.error}));
}
evidence.finishedAt = new Date().toISOString();
evidence.summary = {planned: plans.length, passed: evidence.artifacts.filter(item => item.status === 'asset-pass').length,
  failed: evidence.artifacts.filter(item => item.status === 'asset-fail').length, errors: evidence.artifacts.filter(item => item.status === 'error').length,
  skipped: evidence.artifacts.filter(item => item.status === 'skipped').length};
const evidenceFile = path.join(output, filters.sample || filters.family || filters.format ? `evidence-${Object.values(filters).join('-')}.json` : 'evidence.json');
await fsp.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({evidenceFile, summary: evidence.summary}));
if (evidence.summary.failed || evidence.summary.errors) process.exitCode = 1;
