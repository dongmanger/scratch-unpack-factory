import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {createHash} from 'node:crypto';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {encode} from '../src/base85.mjs';

const bytes = text => new TextEncoder().encode(text);
const hash = content => createHash('sha256').update(content).digest('hex');
const source = 'globalThis.__embeddedNeverExecute = true; /* 资源 */';
const uri = `data:text/javascript;,${encodeURIComponent(source)}`;
const loop = urls => `for (const extension of ${JSON.stringify(urls)}) { vm.extensionManager.loadExtensionURL(extension); }`;
const pack = async (files) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content, {createFolders: false});
  return zip.generateAsync({type: 'uint8array'});
};
const project = {targets: [{name: 'Stage', isStage: true, blocks: {}, costumes: [], sounds: []}],
  extensions: ['example'], extensionURLs: {example: 'https://example.invalid/extension.js'}};
const fixture = async (extra = {}) => pack({'project.json': JSON.stringify(project), 'media.png': Uint8Array.of(1, 2, 3), ...extra});
const html = (payload, script) => bytes(`<script data='${encode(payload)}'>decodeChunk(${payload.length});</script><script>${script}</script>`);
const supplement = async result => {
  const zip = await JSZip.loadAsync(result.data);
  const path = result.metadata?.embeddedDependencies?.manifestPath;
  return {zip, manifest: path ? JSON.parse(await zip.file(path).async('text')) : null};
};

test('packager literal loop preserves baked JS bytes without guessing IDs or executing', async () => {
  delete globalThis.__embeddedNeverExecute;
  const payload = await fixture();
  const result = await staticUnpack(html(payload, loop([uri, uri])));
  const {zip, manifest} = await supplement(result);
  assert.equal(globalThis.__embeddedNeverExecute, undefined);
  assert.equal(manifest.executesInput, false);
  assert.equal(manifest.offlineDependenciesVerified, false);
  assert.equal(manifest.records.length, 1);
  assert.equal(manifest.records[0].evidence.length, 2);
  assert.equal(manifest.records[0].association, 'unproven');
  assert.equal(manifest.records[0].autoLoadingRestored, false);
  assert.equal(manifest.records[0].sha256, hash(source));
  assert.equal(await zip.file(manifest.records[0].path).async('text'), source);
  assert.deepEqual(JSON.parse(await zip.file('project.json').async('text')), project);
  assert.deepEqual(await zip.file('media.png').async('uint8array'), Uint8Array.of(1, 2, 3));
  assert.ok(result.notes.some(note => /association unproven; auto loading not restored/.test(note)));
  const restored = await restoreSb3({staticResult: result});
  assert.ok(restored.report.notes.some(note => /association unproven/.test(note)));
  assert.ok(restored.report.assets.some(asset => asset.path === manifest.records[0].path));
});

test('literal direct API call supports base64, never evaluates URI source', async () => {
  const dataURI = `data:application/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const result = await staticUnpack(html(await fixture(), `vm.extensionManager.loadExtensionURL(${JSON.stringify(dataURI)});`));
  const {zip, manifest} = await supplement(result);
  assert.equal(await zip.file(manifest.records[0].path).async('text'), source);
  assert.equal(manifest.records[0].evidence[0].arrayIndex, null);
});

test('ZIP script.js supplement does not overwrite prior manifests or extra files', async () => {
  const oldManifest = '{"previous":true}';
  const payload = await fixture({'.factory-embedded/manifest.json': oldManifest});
  const result = await staticUnpack(await pack({'project.zip': payload, 'script.js': loop([uri]),
    'index.html': '<script src="script.js"></script>'}));
  const {zip, manifest} = await supplement(result);
  assert.equal(await zip.file('.factory-embedded/manifest.json').async('text'), oldManifest);
  assert.ok(result.metadata.embeddedDependencies.manifestPath.startsWith('.factory-embedded-2/'));
  assert.equal(manifest.records[0].evidence[0].source, 'script.js');
  assert.equal(await zip.file(manifest.records[0].path).async('text'), source);
});

test('PNG/SVG strings, comments, JSON script tags and unrelated string literals do not capture JS', async () => {
  const fake = loop([uri]);
  const script = `const png = 'data:image/png;base64,AQID';
    const svg = '<svg>data:text/javascript;,no</svg>';
    const decoy = ${JSON.stringify(fake)};
    /* ${fake} */`;
  const payload = await fixture();
  const text = new TextDecoder().decode(html(payload, script)) +
    `<script type="application/json">${JSON.stringify({decoy: fake})}</script>`;
  const result = await staticUnpack(bytes(text));
  assert.equal((await supplement(result)).manifest, null);
  assert.equal(result.metadata?.embeddedDependencies, undefined);
});

test('dynamic and remote extension calls warn instead of inventing association or offline success', async () => {
  const result = await staticUnpack(html(await fixture(), `${loop(['https://example.invalid/live.js'])}
    vm.extensionManager.loadExtensionURL(makeUnknownURL());`));
  assert.equal((await supplement(result)).manifest, null);
  assert.equal(result.metadata.embeddedDependencies.autoLoadingRestored, false);
  assert.ok(result.warnings.some(warning => /Dynamic extension dependency/.test(warning)));
  assert.ok(result.notes.some(note => /full offline dependency availability is not verified/.test(note)));
});

test('invalid and excessive extension candidates are bounded and diagnosed', async () => {
  const invalid = await staticUnpack(html(await fixture(), loop(['data:text/javascript;base64,!invalid!'])));
  assert.ok(invalid.warnings.some(warning => /could not be decoded/.test(warning)));
  const excessive = await staticUnpack(html(await fixture(), loop(Array(129).fill(uri))));
  assert.ok(excessive.warnings.some(warning => /candidate limit exceeded/.test(warning)));
  assert.equal((await supplement(excessive)).manifest, null);
  const oversizedURI = await staticUnpack(html(await fixture(), loop([
    'data:text/javascript;,' + 'x'.repeat(8 * 1024 * 1024)
  ])));
  assert.ok(oversizedURI.warnings.some(warning => /URI size limit exceeded/.test(warning)));
});

test('inline source count is bounded and diagnoses incomplete inspection', async () => {
  const payload = await fixture();
  const text = new TextDecoder().decode(html(payload, '')) + '<script>/* harmless */</script>'.repeat(129);
  const result = await staticUnpack(bytes(text));
  assert.ok(result.warnings.some(warning => /source count\/size limit exceeded/.test(warning)));
  assert.equal(result.metadata.embeddedDependencies.offlineDependenciesVerified, false);
});
