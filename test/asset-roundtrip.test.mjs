import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {makeAssetFixture, assertRealMediaFixture, compileBundledFixture, syntheticMatrix,
  mediaCode, mediaMetadata, assertArchiveAssets, loadBundledAssets, withoutNetwork,
  makeArchive, sha256} from './asset-roundtrip.mjs';

const require = createRequire(import.meta.url);
const fixture = await makeAssetFixture();
let context;
const prepare = () => context ||= (async () => {
  const bundle = await compileBundledFixture(fixture);
  assert.equal(bundle.format, '02engine-compiled-project');
  const source = Object.values(bundle.compiledTargets).flatMap(target => Object.values(target.scripts))
    .map(script => script.factorySource).join('\n');
  assert.match(source, /_setCostume\(target,/);
  assert.match(source, /_setBackdrop\(/);
  assert.match(source, /SOUND_MENU|playSound/);
  return {bundle, matrix: await syntheticMatrix(fixture, bundle),
    expectedRuntime: await loadBundledAssets(fixture.bytes, fixture.project, fixture.assets, {runTrusted: true})};
})();

async function assertRoundtrip(artifact, expectedRuntime) {
  const extracted = await staticUnpack(artifact.bytes);
  assert.equal(extracted.type, 'sb3');
  if (artifact.compiled) assert.ok(extracted.compiledProject, 'compiled code must survive container nesting');
  if (artifact.executable) {
    assert.equal(extracted.metadata.executableContainer.executesInput, false);
    assert.match(extracted.notes.join('\n'), /unverified|ASAR|static/i);
  }
  const outputs = [];
  for (const beautify of [false, true]) {
    const result = await restoreSb3({staticResult: extracted, inputSha256: sha256(artifact.bytes), format: extracted.format, beautify});
    assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
    assert.deepEqual(result.report.code.unresolved, [], `${artifact.name}: no missing media-selection code`);
    await assertArchiveAssets(result.data, fixture.project, fixture.assets);
    assert.deepEqual(mediaCode(result.project), mediaCode(fixture.project), 'media-selection opcode order/values, not original IDs');
    assert.equal(result.report.assets.length, Object.keys(fixture.assets).length);
    for (const record of result.report.assets)
      assert.equal(record.sha256, sha256(fixture.assets[record.path]), `reported hash ${record.path}`);
    const runtime = await loadBundledAssets(result.data, result.project, fixture.assets, {runTrusted: true});
    assert.deepEqual(runtime, expectedRuntime, 'actual bundled VM selects identical target-owned assets');
    outputs.push(result);
  }
  assert.deepEqual(mediaMetadata(outputs[0].project), mediaMetadata(outputs[1].project), 'beautify never changes media metadata');
  assert.deepEqual(mediaCode(outputs[0].project), mediaCode(outputs[1].project), 'beautify preserves media-selection code without block-ID assumptions');
  return {format: extracted.format, assets: Object.keys(fixture.assets).length, modes: outputs.length};
}

test('asset fixture contains visible SVG, patterned opaque PNG and valid non-silent PCM WAV across three targets', async () => {
  assertRealMediaFixture(fixture);
  const state = await loadBundledAssets(fixture.bytes, fixture.project, fixture.assets, {runTrusted: true});
  assert.deepEqual(state.map(target => target.currentCostume), [1, 0, 1], 'numeric costume name wins over numeric index');
  for (const [index, target] of state.entries()) {
    assert.equal(target.selectedAssetId, fixture.project.targets[index].costumes[[1, 0, 1][index]].assetId);
    assert.equal(target.variables[`selected-${index}`], 'media selected');
  }
});

// Focused finite batch: byte-identical assets, ownership/order, all non-code
// target metadata, selected costume behavior, and beautify on/off contracts.
// PE/ASAR cases are synthetic wrappers, NOT genuine desktop distributions.
for (let index = 0; index < 12; index++) {
  const names = ['SB3 ZIP', 'synthetic TW v4 HTML', 'synthetic TW base64 HTML', 'synthetic TW application ZIP',
    'synthetic O2 preserved HTML', 'synthetic O2 compiled HTML', 'synthetic O2 compiled ZIP',
    'synthetic PE + TW ZIP', 'synthetic PE + O2 ZIP', 'synthetic ASAR + TW HTML',
    'synthetic ASAR + O2 ZIP', 'synthetic ASAR + O2 HTML'];
  test(`real assets static unpack → restore → bundled VM / ${names[index]}`, {timeout: 60_000}, async t => {
    const {matrix, expectedRuntime} = await prepare();
    const result = await assertRoundtrip(matrix[index], expectedRuntime);
    t.diagnostic(`${matrix[index].name}; ${result.format}; ${result.assets} SHA256 assets; beautify modes=${result.modes}; storage=yes renderer=no audio=no network=0`);
  });
}

// These use unchanged locally built actual packager Node APIs and real runtime
// scaffolding. Generated HTML/JS is treated only as data, never launched/eval'd.
// Missing optional research checkouts are explicit skips, not support claims.
for (const [family, relative] of [['TW', '../../research/TurboWarp/packager/dist/packager.js'],
  ['O2', '../../research/02engine/packager/dist/packager.js']]) {
  for (const target of ['html', 'zip']) {
    test(`real asset fixture / actual local ${family} packager ${target} / not a desktop distribution`, {timeout: 120_000}, async t => {
      const modulePath = fileURLToPath(new URL(relative, import.meta.url));
      if (!existsSync(modulePath)) { t.skip(`Optional actual packager build unavailable: ${modulePath}`); return; }
      const actual = require(modulePath);
      const {expectedRuntime} = await prepare();
      const result = await withoutNetwork(async () => {
        const packager = new actual.Packager();
        packager.project = await actual.loadProject(fixture.bytes);
        packager.options.target = target;
        if (family === 'O2') {
          packager.options.compiler.compiledProject = true;
          packager.options.compiler.obfuscateCompiledProject = false;
        }
        packager.addEventListener('large-asset-fetch', ({detail}) => {
          assert.ok(['scaffolding', 'scaffolding-min', 'addons'].includes(detail.asset), `Unexpected packager download ${detail.asset}`);
        });
        return packager.package();
      });
      const bytes = typeof result.data === 'string' ? Buffer.from(result.data) : new Uint8Array(result.data);
      assert.equal(result.type, target === 'html' ? 'text/html' : 'application/zip');
      const counts = await assertRoundtrip({name: `actual ${family} ${target}`, bytes, compiled: family === 'O2'}, expectedRuntime);
      t.diagnostic(`${path.resolve(modulePath)}; input=${sha256(fixture.bytes)}; output=${sha256(bytes)}; ${counts.assets} assets × 2 beautify modes; no desktop packaging or generated JS execution`);
    });
  }
}

test('asset assertions reject metadata drift, duplicate-name ownership swaps, missing assets and corrupted bytes', async () => {
  const changedCenter = structuredClone(fixture.project); changedCenter.targets[1].costumes[0].rotationCenterX++;
  await assert.rejects(assertArchiveAssets(await makeArchive(changedCenter, fixture.assets), fixture.project, fixture.assets), /target order, ownership/);
  const swapped = structuredClone(fixture.project);
  [swapped.targets[1].costumes[1], swapped.targets[1].costumes[2]] = [swapped.targets[1].costumes[2], swapped.targets[1].costumes[1]];
  await assert.rejects(assertArchiveAssets(await makeArchive(swapped, fixture.assets), fixture.project, fixture.assets), /target order, ownership/);
  const assets = {...fixture.assets}; const name = Object.keys(assets)[0]; delete assets[name];
  await assert.rejects(assertArchiveAssets(await makeArchive(fixture.project, assets), fixture.project, fixture.assets), /no media lost/);
  assets[name] = Buffer.from(fixture.assets[name]); assets[name][10] ^= 1;
  await assert.rejects(assertArchiveAssets(await makeArchive(fixture.project, assets), fixture.project, fixture.assets), /SHA256/);
});
