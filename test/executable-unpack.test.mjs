// Provenance: every PE, ZIP overlay and ASAR below is constructed here from
// trusted synthetic bytes. They are never launched and are not real NW.js or
// Electron release fixtures; these tests prove static container handling only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import { staticUnpack, STATIC_UNPACK_LIMITS, assertSafePath } from '../src/static-unpack.mjs';
import { identify } from '../src/identify.mjs';
import { readASAR, inspectPE, scanPEZipCandidates, executableUnpack, MAX_EXECUTABLE_CANDIDATES, MAX_EOCD_SIGNATURES } from '../src/executable-unpack.mjs';
import { makeMinimalSb3, buildTwBase64Html, assertSameProject } from './helpers.mjs';
import { compiledFixture } from './compiled-fixtures.mjs';

const options = { limits: STATIC_UNPACK_LIMITS, safePath: assertSafePath };
const encoder = new TextEncoder();
const text = (value) => encoder.encode(value);
const concat = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const fixture = await makeMinimalSb3();
const makeZip = async (files, { compression = 'DEFLATE', comment = '', streamFiles = false } = {}) => {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes, { createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression, comment, streamFiles });
};
// Minimal structurally consistent PE32: headers + one raw section, no code.
const syntheticPE = (overlay = new Uint8Array(), { pe64 = false } = {}) => {
  const pe = new Uint8Array(1024);
  const v = view(pe);
  v.setUint16(0, 0x5a4d, true);
  v.setUint32(60, 128, true);
  v.setUint32(128, 0x00004550, true);
  v.setUint16(132, pe64 ? 0x8664 : 0x14c, true);
  v.setUint16(134, 1, true);
  const optionalSize = pe64 ? 240 : 224;
  v.setUint16(148, optionalSize, true);
  v.setUint16(152, pe64 ? 0x20b : 0x10b, true);
  v.setUint32(152 + 60, 512, true);
  v.setUint32(152 + (pe64 ? 108 : 92), 16, true);
  const section = 152 + optionalSize;
  v.setUint32(section + 16, 512, true);
  v.setUint32(section + 20, 512, true);
  return concat(pe, overlay);
};
const headerASAR = (header, body = new Uint8Array()) => {
  const json = typeof header === 'string' ? text(header) : text(JSON.stringify(header));
  const payloadSize = 4 + Math.ceil(json.length / 4) * 4;
  const prefix = new Uint8Array(12 + payloadSize);
  const v = view(prefix);
  v.setUint32(0, 4, true);
  v.setUint32(4, payloadSize + 4, true);
  v.setUint32(8, payloadSize, true);
  v.setUint32(12, json.length, true);
  prefix.set(json, 16);
  return concat(prefix, body);
};
const syntheticASAR = (files) => {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let directory = root.files;
    for (const part of parts.slice(0, -1)) {
      directory[part] ||= { files: {} };
      directory = directory[part].files;
    }
    const bytes = typeof content === 'string' ? text(content) : content;
    directory[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length;
    chunks.push(bytes);
  }
  return headerASAR(root, concat(...chunks));
};
const patch = (bytes, mutate) => {
  const copy = Uint8Array.from(bytes);
  mutate(view(copy), copy);
  return copy;
};
const central = (bytes) => Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
const eocd = (bytes) => Buffer.from(bytes).lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
const errorAndFingerprint = async (bytes, pattern, family) => {
  await assert.rejects(staticUnpack(bytes), pattern);
  const id = await identify(bytes);
  assert.equal(id.family, family);
  assert.equal(id.details.projectValidated, false);
};

test('synthetic PE32/PE32+ appended ZIP preserves project/assets and source facts', async () => {
  for (const pe64 of [false, true]) {
    const bytes = syntheticPE(fixture.bytes, { pe64 });
    const id = await identify(bytes);
    assert.equal(id.family, 'exe');
    assert.equal(id.format, 'nwjs-exe-zip');
    assert.equal(id.details.projectValidated, false);
    const result = await staticUnpack(bytes);
    assert.equal(result.format, id.format);
    assert.equal(result.metadata.executableContainer.start, 1024);
    assert.equal(result.metadata.executableContainer.end, bytes.length);
    assert.equal(result.metadata.executableContainer.innerFormat, 'zip-sb3');
    assert.equal(result.metadata.executableContainer.executesInput, false);
    assert.match(result.notes[0], /runtime identity unverified/);
    await assertSameProject(result.data, fixture.project, fixture.assets);
  }
});

test('synthetic NW ZIP project.zip and self-contained HTML reuse project validation', async () => {
  for (const files of [
    { 'app/project.zip': fixture.bytes, 'app/index.html': '<script src="script.js"></script>' },
    { 'app/index.html': buildTwBase64Html(fixture.bytes), 'package.json': '{"main":"app/index.html"}' }
  ]) {
    const result = await staticUnpack(syntheticPE(await makeZip(files)));
    assert.equal(result.format, 'nwjs-exe-zip');
    await assertSameProject(result.data, fixture.project, fixture.assets);
  }
});

test('synthetic false PK locals/EOCDs do not choose first signatures; EOCD in comment is safe', async () => {
  const falsePK = concat(text('PK\x03\x04decoy'), Buffer.from([0x50, 0x4b, 5, 6]), new Uint8Array(22));
  const bytes = syntheticPE(concat(falsePK, await makeZip({ 'project.zip': fixture.bytes }, {
    comment: 'synthetic PK\x05\x06' + '\0'.repeat(22)
  })));
  const scan = scanPEZipCandidates(bytes, options);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].start, 1024 + falsePK.length);
  assert.equal(scan.rejected.length, 2);
  await assertSameProject((await staticUnpack(bytes)).data, fixture.project, fixture.assets);
});

test('synthetic ZIP stored/deflated data descriptors are validated', async () => {
  for (const compression of ['STORE', 'DEFLATE']) {
    const archive = await makeZip({ 'project.zip': fixture.bytes }, { compression, streamFiles: true });
    await assertSameProject((await staticUnpack(syntheticPE(archive))).data, fixture.project, fixture.assets);
  }
});

test('synthetic PE candidate ambiguity is refused even for equal valid projects', async () => {
  const bytes = syntheticPE(concat(fixture.bytes, fixture.bytes));
  assert.equal((await identify(bytes)).details.zipCandidates.length, 2);
  await assert.rejects(staticUnpack(bytes), /Ambiguous executable/);
});

test('synthetic separate malformed ZIP is refused even beside a valid project archive', async () => {
  const malformed = patch(fixture.bytes, (v) => v.setUint16(eocd(fixture.bytes) + 10, 1, true));
  for (const archives of [concat(malformed, fixture.bytes), concat(fixture.bytes, malformed)]) {
    await assert.rejects(staticUnpack(syntheticPE(archives)), /Invalid appended ZIP candidate/);
  }
});

test('synthetic unrelated ZIP is not a project and does not hide a second valid candidate', async () => {
  const unrelated = await makeZip({ 'note.txt': 'synthetic unrelated archive' });
  const result = await staticUnpack(syntheticPE(concat(unrelated, fixture.bytes)));
  assert.equal(result.metadata.executableContainer.candidateCount, 2);
  assert.equal(result.metadata.executableContainer.start, 1024 + unrelated.length);
  await assertSameProject(result.data, fixture.project, fixture.assets);
  await assert.rejects(staticUnpack(syntheticPE(unrelated)), /no validated static Scratch payload/);
});

test('synthetic EXE cannot extract fake/corrupt HTML or invalid project data', async () => {
  for (const files of [
    { 'index.html': '<html><script>globalThis.syntheticMustNeverRun = true;</script></html>' },
    { 'project.json': '{"ordinary":"JSON"}' },
    { 'index.html': buildTwBase64Html(text('not a Scratch project')) },
    { 'bad.html': buildTwBase64Html(text('invalid')), 'good.html': buildTwBase64Html(fixture.bytes) }
  ]) await assert.rejects(staticUnpack(syntheticPE(await makeZip(files))), /no validated|project.json|Invalid static HTML/);
  assert.equal(globalThis.syntheticMustNeverRun, undefined);
});

test('synthetic corrupt/truncated ZIP and metadata are not recovered', async () => {
  const archive = await makeZip({ 'project.zip': fixture.bytes });
  const badArchives = [
    archive.subarray(0, archive.length - 1),
    archive.subarray(0, archive.length - 22),
    patch(archive, (v) => v.setUint32(central(archive) + 42, 1, true)),
    patch(archive, (v) => v.setUint16(eocd(archive) + 10, 2, true)),
    patch(archive, (v) => v.setUint32(eocd(archive) + 12, 1, true)),
    patch(archive, (v) => v.setUint32(central(archive) + 24, STATIC_UNPACK_LIMITS.entryBytes + 1, true)),
    patch(archive, (v) => { v.setUint32(central(archive) + 16, 0, true); v.setUint32(14, 0, true); }),
    patch(archive, (v) => v.setUint16(eocd(archive) + 4, 1, true)),
    patch(archive, (v) => v.setUint32(eocd(archive) + 16, 0xffffffff, true))
  ];
  for (const bytes of badArchives) await errorAndFingerprint(syntheticPE(bytes), /ZIP|CRC32/, 'exe');
});

test('synthetic corrupt ZIP data descriptor/traversal names are rejected', async () => {
  const descriptorZip = await makeZip({ 'project.zip': fixture.bytes }, { streamFiles: true });
  const descriptor = Buffer.from(descriptorZip).indexOf(Buffer.from([0x50, 0x4b, 7, 8]));
  const broken = patch(descriptorZip, (v) => v.setUint32(descriptor + 4, 0, true));
  await assert.rejects(staticUnpack(syntheticPE(broken)), /descriptor|ZIP/);
  for (const name of ['../project.json', 'C:/project.json', 'bad\\project.json', '/project.json']) {
    await assert.rejects(staticUnpack(syntheticPE(await makeZip({ [name]: '{}' }))), /Unsafe|no validated/);
  }
});

test('synthetic PE section/header bounds and bare MZ fail before ZIP processing', async () => {
  const bytes = syntheticPE(fixture.bytes);
  for (const invalid of [
    text('MZ'), bytes.subarray(0, 100),
    patch(bytes, (v) => v.setUint32(60, 0xffffffff, true)),
    patch(bytes, (v) => v.setUint16(134, 97, true)),
    patch(bytes, (v) => v.setUint32(152 + 60, 1, true)),
    patch(bytes, (v) => v.setUint32(152 + 224 + 20, bytes.length, true))
  ]) await errorAndFingerprint(invalid, /PE/, 'exe');
  assert.equal(inspectPE(bytes).overlayOffset, 1024);
});

test('synthetic candidate/signature count limits bound scanning and validation work', async () => {
  await assert.rejects(staticUnpack(syntheticPE(concat(...Array(MAX_EXECUTABLE_CANDIDATES + 1).fill(fixture.bytes)))), /candidate count.*limit/);
  const signature = Buffer.from([0x50, 0x4b, 5, 6]);
  await assert.rejects(staticUnpack(syntheticPE(concat(...Array(MAX_EOCD_SIGNATURES + 1).fill(concat(signature, new Uint8Array(22)))))), /signature scan limit/);
  let reads = 0;
  await assert.rejects(executableUnpack(syntheticPE(concat(...Array(5).fill(fixture.bytes))), {
    ...options, unpack: staticUnpack, readZipEntries: () => { reads++; throw new Error('should not be called'); }
  }), /candidate count.*limit/);
  assert.equal(reads, 0);
});

test('synthetic opaque trailing bytes are disclosed; damaged trailing ZIP is not hidden', async () => {
  const result = await staticUnpack(syntheticPE(concat(fixture.bytes, text('synthetic trailer'))));
  assert.equal(result.metadata.executableContainer.trailingBytes, 17);
  assert.match(result.notes[0], /17 trailing bytes/);
  await assert.rejects(staticUnpack(syntheticPE(concat(fixture.bytes, Buffer.from([0x50, 0x4b, 5, 6])))), /Invalid trailing ZIP/);
});

test('synthetic standalone ASAR project.zip and HTML preserve assets and source detection', async () => {
  for (const files of [
    { 'app/project.zip': fixture.bytes, 'app/index.html': '<script src="script.js"></script>' },
    { 'renderer/index.html': buildTwBase64Html(fixture.bytes), 'package.json': '{"main":"synthetic.js"}' }
  ]) {
    const bytes = syntheticASAR(files);
    const id = await identify(bytes);
    assert.equal(id.family, 'asar');
    assert.equal(id.format, 'electron-asar');
    assert.equal(id.details.projectValidated, false);
    const result = await staticUnpack(bytes);
    assert.equal(result.format, id.format);
    assert.equal(result.metadata.executableContainer.executesInput, false);
    assert.ok(result.metadata.executableContainer.dataOffset >= 16);
    await assertSameProject(result.data, fixture.project, fixture.assets);
  }
});

test('synthetic ASAR project.json preserves root assets and excludes sibling data', async () => {
  const files = { 'chosen/project.json': JSON.stringify(fixture.project), 'outside.txt': 'synthetic sibling' };
  for (const [name, bytes] of Object.entries(fixture.assets)) files[`chosen/${name}`] = bytes;
  files['chosen/fonts/extra.woff2'] = Uint8Array.of(1, 2, 3);
  const result = await staticUnpack(syntheticASAR(files));
  await assertSameProject(result.data, fixture.project, fixture.assets);
  const zip = await JSZip.loadAsync(result.data);
  assert.equal(zip.file('outside.txt'), null);
  assert.deepEqual(await zip.file('fonts/extra.woff2').async('uint8array'), Uint8Array.of(1, 2, 3));
  assert.equal(result.metadata.executableContainer.innerFormat, 'zip-sb3');
});

test('synthetic ASAR/EXE precompile extraction retains warnings and compiled source facts', async () => {
  const compiled = await compiledFixture();
  const files = { 'app/project.zip': compiled.bytes, 'app/compiled-project.json': compiled.compiledProject };
  for (const bytes of [syntheticASAR(files), syntheticPE(await makeZip(files))]) {
    const result = await staticUnpack(bytes);
    assert.equal(result.compiledProject, compiled.compiledProject);
    assert.equal(result.metadata.precompile, true);
    assert.equal(result.metadata.projectBlocks, 'empty');
    assert.equal(result.metadata.sourceBlocksRecovered, false);
    assert.equal(result.metadata.executableContainer.innerFormat, 'o2-zip-precompile');
    assert.deepEqual(result.warnings, []);
    await assertSameProject(result.data, compiled.stripped, compiled.assets);
  }
});

test('synthetic ASAR strict size-pickle/header bounds reject truncation, UTF8 and padding damage', async () => {
  const bytes = syntheticASAR({ 'project.zip': fixture.bytes });
  const invalid = [
    bytes.subarray(0, 4), bytes.subarray(0, 12), bytes.subarray(0, 17), bytes.subarray(0, bytes.length - 1),
    patch(bytes, (v) => v.setUint32(4, v.getUint32(4, true) + 4, true)),
    patch(bytes, (v) => v.setUint32(8, v.getUint32(8, true) - 1, true)),
    patch(bytes, (v) => v.setUint32(12, STATIC_UNPACK_LIMITS.jsonBytes + 1, true)),
    patch(bytes, (_, copy) => { copy[16] = 0xff; }),
    headerASAR('{'), headerASAR({ files: [] })
  ];
  // Force a header whose JSON has padding, then corrupt exactly the padding.
  let padded = headerASAR({ files: {}, provenance: 'synthetic' });
  if (view(padded).getUint32(12, true) % 4 === 0) padded = headerASAR({ files: {}, provenance: 'synthetic!' });
  invalid.push(patch(padded, (_, copy) => { copy[16 + view(copy).getUint32(12, true)] = 1; }));
  for (const bytes of invalid) await errorAndFingerprint(bytes, /ASAR|JSON|UTF-8|encoded data|Unexpected|Expected/i, 'asar');
});

test('synthetic ASAR traversal, absolute and Windows path components are refused', async () => {
  for (const name of ['..', '.', '../project.json', '/project.json', 'C:', 'x\\project.json', 'bad\0name', '']) {
    const bytes = headerASAR({ files: { [name]: { size: 1, offset: '0' } } }, Uint8Array.of(0));
    await assert.rejects(staticUnpack(bytes), /Unsafe/);
  }
  await assert.rejects(staticUnpack(headerASAR({ files: { link: { link: '../project.zip' } } })), /links.*unsupported/);
});

test('synthetic ASAR offsets, file sizes, overlaps and ambiguous nodes are refused', async () => {
  for (const node of [
    { size: 1, offset: '-1' }, { size: 1, offset: '1.5' }, { size: 1, offset: 0 },
    { size: 1, offset: '9007199254740992' }, { size: 2, offset: '0' }, { size: 0, offset: '2' },
    { size: -1, offset: '0' }, { size: 0.1, offset: '0' },
    { size: STATIC_UNPACK_LIMITS.entryBytes + 1, offset: '0' },
    { size: 1, offset: '0', files: {} }, { size: 1, offset: '0', unpacked: 'yes' },
    { size: 1, offset: '0', unpacked: true }
  ]) await assert.rejects(staticUnpack(headerASAR({ files: { entry: node } }, Uint8Array.of(0))), /ASAR/);
  await assert.rejects(staticUnpack(headerASAR({ files: {
    a: { size: 1, offset: '0' }, b: { size: 1, offset: '0' }
  } }, Uint8Array.of(0))), /Overlapping/);
});

test('synthetic ASAR declared integrity checks packed bytes instead of accepting damaged assets', async () => {
  const body = fixture.bytes;
  const hash = createHash('sha256').update(body).digest('hex');
  const integrity = { algorithm: 'SHA256', hash, blockSize: body.length, blocks: [hash] };
  const bytes = headerASAR({ files: { 'project.zip': { size: body.length, offset: '0', integrity } } }, body);
  await assertSameProject((await staticUnpack(bytes)).data, fixture.project, fixture.assets);
  const corrupt = Uint8Array.from(bytes);
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(staticUnpack(corrupt), /integrity hash mismatch/);
  const bad = { ...integrity, blocks: ['0'.repeat(64)] };
  await assert.rejects(staticUnpack(headerASAR({ files: { asset: { size: body.length, offset: '0', integrity: bad } } }, body)), /integrity block mismatch/);
});

test('synthetic ASAR missing unpacked files are reported explicitly without filesystem access', async () => {
  const bytes = headerASAR({ files: {
    'project.zip': { size: fixture.bytes.length, offset: '0' },
    'native.node': { size: 12, unpacked: true },
    assets: { unpacked: true, files: { 'missing.svg': { size: 3 } } }
  } }, fixture.bytes);
  const id = await identify(bytes);
  assert.equal(id.details.missingExternalAssets.length, 2);
  assert.deepEqual(readASAR(bytes, options).missingExternalAssets.map((file) => file.path).sort(), ['assets/missing.svg', 'native.node']);
  await assert.rejects(staticUnpack(bytes), (error) => {
    assert.equal(error.code, 'ASAR_MISSING_UNPACKED');
    assert.equal(error.missingExternalAssets.length, 2);
    assert.match(error.message, /standalone ASAR.*\.asar.unpacked/);
    return true;
  });
  await assert.rejects(staticUnpack(headerASAR({ files: { 'project.zip': { size: 1, unpacked: true } } })), /Missing external/);
});

test('synthetic ASAR entry/total/depth bounds and duplicate JSON keys cannot be bypassed', async () => {
  const smaller = { ...options, limits: { ...STATIC_UNPACK_LIMITS, entries: 1, totalBytes: 1 } };
  const two = syntheticASAR({ a: Uint8Array.of(0), b: Uint8Array.of(1) });
  assert.throws(() => readASAR(two, smaller), /entry count/);
  assert.throws(() => readASAR(syntheticASAR({ a: Uint8Array.of(0, 1) }), smaller), /total file size/);
  await assert.rejects(staticUnpack(headerASAR('{"files":{"a":{"size":0,"offset":"0"},"a":{"size":0,"offset":"0"}}}')), /Duplicate ASAR/);
  await assert.rejects(staticUnpack(headerASAR('{"files":{"a":{"size":0,"size":1,"offset":"0"}}}', Uint8Array.of(0))), /Duplicate ASAR/);
  let files = {};
  for (let i = 0; i < 140; i++) files = { dir: { files } };
  await assert.rejects(staticUnpack(headerASAR({ files })), /nesting|depth/);
});

test('synthetic nested project ZIP count/truncation damage is rejected in ASAR and EXE', async () => {
  const corrupted = patch(fixture.bytes, (v) => v.setUint16(eocd(fixture.bytes) + 10, 1, true));
  for (const project of [corrupted, fixture.bytes.subarray(0, fixture.bytes.length - 1)]) {
    await assert.rejects(staticUnpack(syntheticASAR({ 'project.zip': project })), /nested project ZIP/);
    await assert.rejects(staticUnpack(syntheticPE(await makeZip({ 'project.zip': project }))), /nested project ZIP/);
  }
});

test('synthetic ASAR HTML/project ambiguity and invalid project archives are rejected', async () => {
  for (const files of [
    { 'a.html': buildTwBase64Html(fixture.bytes), 'b.html': buildTwBase64Html(fixture.bytes) },
    { 'a/project.json': '{"targets":[]}', 'b/project.json': '{"targets":[]}' },
    { 'project.zip': text('not a project') },
    { 'project.json': '{"ordinary":"json"}' },
    { 'bad.html': buildTwBase64Html(text('corrupt')), 'good.html': buildTwBase64Html(fixture.bytes) }
  ]) await assert.rejects(staticUnpack(syntheticASAR(files)), /Ambiguous|neither|project.json|Invalid static HTML/);
  await assert.rejects(staticUnpack(syntheticASAR({ 'main.js': 'globalThis.syntheticNeverExecute = true' })), /no validated static/);
  assert.equal(globalThis.syntheticNeverExecute, undefined);
});

test('synthetic ASAR and PE limits match staticUnpack limits and honor Uint8Array byteOffset', async () => {
  for (const bytes of [syntheticASAR({ 'project.zip': fixture.bytes }), syntheticPE(fixture.bytes)]) {
    const padded = concat(Uint8Array.of(9, 9), bytes, Uint8Array.of(9));
    await assertSameProject((await staticUnpack(padded.subarray(2, padded.length - 1))).data, fixture.project, fixture.assets);
    const constrained = { ...options, limits: { ...STATIC_UNPACK_LIMITS, inputBytes: bytes.length - 1 } };
    assert.throws(() => bytes[0] === 0x4d ? scanPEZipCandidates(bytes, constrained) : readASAR(bytes, constrained), /container size limit/);
  }
});
