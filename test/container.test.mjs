import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import { staticUnpack, inspectCompiledProjectHTML } from '../src/static-unpack.mjs';
import { identify } from '../src/identify.mjs';
import {
  encode, encodeV1, encodeV2WithLength, encodeV3WithLength,
  decodeWithoutLengthHeader, decodeWithLengthHeader, MAX_PROJECT_BYTES
} from '../src/base85.mjs';
import { compiledFixture } from './compiled-fixtures.mjs';

const textBytes = (text) => new TextEncoder().encode(text);
const dataURI = (bytes) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
const scratch3 = () => ({
  targets: [{
    isStage: true, name: 'Stage', variables: { score: ['score', 0] }, lists: {}, broadcasts: {},
    blocks: {
      hat: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 },
      set: { opcode: 'data_setvariableto', next: null, parent: 'hat', inputs: { VALUE: [1, [4, '7']] }, fields: { VARIABLE: ['score', 'score'] }, shadow: false, topLevel: false }
    },
    comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0,
    tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null
  }],
  monitors: [], extensions: [], meta: { semver: '3.0.0', vm: '2.1.46', agent: 'container-test' }
});
const makeZip = async (files, compression = 'DEFLATE') => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'uint8array', compression });
};
const projectZip = (json = scratch3(), extra = {}) => makeZip({ 'project.json': JSON.stringify(json), ...extra });
const readProject = async (result) => {
  const zip = await JSZip.loadAsync(result.data);
  return { zip, json: JSON.parse(await zip.file('project.json').async('text')) };
};
const assertProject = async (result, json) => assert.deepEqual((await readProject(result)).json, json);
const chunkHTML = (bytes, kind = 'o2', sizes = [1, 3, 5, 7, 9]) => {
  let offset = 0;
  const scripts = [];
  for (const size of [...sizes, bytes.length]) {
    if (offset >= bytes.length) break;
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + size));
    const payload = encode(part);
    scripts.push(kind === 'o2'
      ? `<script data-size='${part.length}' nonce="x" type = 'application/x-o2-project-chunk'>${payload}</script>`
      : `<script nonce='x' data = '${payload}'> decodeChunk ( ${part.length} ); </script>`);
    offset += part.length;
  }
  return scripts.join('\n');
};
const precompileHTML = (fixture, script) => textBytes(chunkHTML(fixture.bytes) + script);
const withPatchedCentral = (bytes, fieldOffset, transform) => {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  for (let i = 0; i <= copy.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    view.setUint32(i + fieldOffset, transform(view.getUint32(i + fieldOffset, true)), true);
    return copy;
  }
  throw new Error('Test fixture has no central directory');
};

for (const [name, makeTag] of [
  ['single quotes, reordered attributes', (bytes) => `<script data-size='${bytes.length}' type='application/x-o2-project-chunk'>${encode(bytes)}</script>`],
  ['double quotes and extra attributes', (bytes) => `<script nonce="a>b" data-size="${bytes.length}" id="payload" type="application/x-o2-project-chunk">${encode(bytes)}</script>`],
  ['attribute whitespace and mixed quotes', (bytes) => `<SCRIPT\n data-size = '${bytes.length}'\n TYPE = "application/x-o2-project-chunk" >\n${encode(bytes)}\n</SCRIPT >`]
]) {
  test(`o2 attributes: ${name}; identify agrees with extraction`, async () => {
    const project = scratch3();
    const html = textBytes(makeTag(await projectZip(project)));
    assert.equal((await identify(html)).format, 'o2-html-chunk');
    const result = await staticUnpack(html);
    assert.equal(result.format, 'o2-html-chunk');
    assert.equal(result.type, 'sb3');
    await assertProject(result, project);
  });
}

for (const kind of ['o2', 'tw']) {
  test(`${kind} odd chunks discard padding separately`, async () => {
    const project = scratch3();
    const html = textBytes(chunkHTML(await projectZip(project), kind));
    const id = await identify(html);
    const result = await staticUnpack(html);
    assert.equal(result.format, kind === 'o2' ? 'o2-html-chunk' : 'tw-html-chunk-v4');
    assert.equal(id.format, result.format);
    assert.equal(id.details.chunks, 6);
    await assertProject(result, project);
  });
}

for (const length of [NaN, Infinity, -1, 0.5, '4', MAX_PROJECT_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
  test(`base85 rejects invalid declared length ${String(length)}`, () => {
    assert.throws(() => decodeWithoutLengthHeader('*****', length), /length/);
  });
}

test('base85 checks exact groups, alphabet, uint32 range, and zero padding', () => {
  for (const payload of ['****', '******', '**********']) {
    assert.throws(() => decodeWithoutLengthHeader(payload, 4), /group count/);
  }
  for (const char of ['<', '>', ' ', '\n', 'é', '\x00', '"']) {
    assert.throws(() => decodeWithoutLengthHeader(char + '****', 4), /character/);
  }
  assert.throws(() => decodeWithoutLengthHeader('~~~~~', 4), /overflow/);
  assert.throws(() => decodeWithLengthHeader('4,\\****', 1), /requested version/);
  assert.throws(() => decodeWithoutLengthHeader(encode(Uint8Array.of(1, 2, 3, 4)), 3), /padding/);
  assert.throws(() => decodeWithoutLengthHeader(encode(Uint8Array.of(1)), 0), /group count/);
  for (const payload of ['', '4*****', '-4,*****', '1e2,*****', 'k,*****', 'Infinity,*****', '999999999999999999999,*****']) {
    assert.throws(() => decodeWithLengthHeader(payload), /header|length/);
  }
});

test('base85 v1-v3 round trip valid padding, zero bytes, and explicit ambiguous versions', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 9, 16]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 53) & 255);
    assert.deepEqual(decodeWithoutLengthHeader(encode(bytes), length), bytes);
    assert.deepEqual(decodeWithLengthHeader(`${length},${encodeV1(bytes)}`, 1), bytes);
    assert.deepEqual(decodeWithLengthHeader(encodeV2WithLength(bytes), 2), bytes);
    assert.deepEqual(decodeWithLengthHeader(encodeV3WithLength(bytes)), bytes);
  }
  assert.throws(() => decodeWithLengthHeader('4,*****'), /Ambiguous/);
  assert.deepEqual(decodeWithLengthHeader('4,*****', 2), new Uint8Array(4));
});

for (const version of [1, 2, 3]) {
  test(`p4 base85 v${version} validates a decoded project rather than guessing Scratch1`, async () => {
    const project = scratch3();
    const bytes = await projectZip(project);
    const payload = version === 1 ? `${bytes.length},${encodeV1(bytes)}` :
      version === 2 ? encodeV2WithLength(bytes) : encodeV3WithLength(bytes);
    const result = await staticUnpack(textBytes(`<script type='p4-project'>${payload}</script>`));
    assert.equal(result.type, 'sb3');
    await assertProject(result, project);
  });
}

test('corrupt o2 chunks and excessive cumulative lengths are rejected consistently', async () => {
  for (const body of [
    `<script type='application/x-o2-project-chunk' data-size='4'><****</script>`,
    `<script type='application/x-o2-project-chunk' data-size='3'>${encode(Uint8Array.of(1, 2, 3, 4))}</script>`,
    `<script type='application/x-o2-project-chunk' data-size='-1'>*****</script>`,
    `<script type='application/x-o2-project-chunk' data-size='4.1'>*****</script>`,
    `<script type='application/x-o2-project-chunk' data-size='${MAX_PROJECT_BYTES}'></script><script type='application/x-o2-project-chunk' data-size='1'></script>`
  ]) {
    const html = textBytes(body);
    assert.equal((await identify(html)).family, 'unknown');
    await assert.rejects(staticUnpack(html), /base85|chunk|length/);
  }
});

test('arbitrary binary, fake Scratch magic, and fake HTMLifier sb1 are never successful', async () => {
  const bad = textBytes('not a Scratch project');
  for (const bytes of [bad, textBytes('ScratchV03garbage'), textBytes('ScratchV00'), new Uint8Array(12)]) {
    await assert.rejects(staticUnpack(bytes));
    await assert.rejects(staticUnpack(textBytes(chunkHTML(bytes))), /neither.*Scratch/);
    await assert.rejects(staticUnpack(textBytes(`<script type='p4-project'>${encodeV2WithLength(bytes)}</script>`)), /No valid project/);
  }
  await assert.rejects(staticUnpack(textBytes(`<script>const getProjectData = () => fetch("${dataURI(bad)}")</script>`)), /neither.*Scratch/);
  const initOptions = JSON.stringify({ assets: { file: dataURI(bad) } });
  await assert.rejects(staticUnpack(textBytes(`<script>\nconst GENERATED = 1\nconst initOptions = ${initOptions}\ninit(initOptions)\n</script>`)), /neither.*Scratch/);
});

test('Scratch1 classification requires exact ScratchV01 or ScratchV02 magic', async () => {
  // 本测试只覆盖 magic 门槛，不宣称这段最小字节包含完整 Squeak 工程。
  for (const magic of ['ScratchV01', 'ScratchV02']) {
    const bytes = textBytes(magic);
    assert.equal((await identify(bytes)).format, 'scratch1-binary');
    const result = await staticUnpack(textBytes(chunkHTML(bytes)));
    assert.equal(result.type, 'sb');
    assert.deepEqual(result.data, bytes);
  }
});

test('ZIP type comes from targets/objName even with misleading or absent asset names', async () => {
  const sb2 = { objName: 'Stage', scripts: [], costumes: [], sounds: [], children: [] };
  const cases = [
    { project: sb2, extra: {}, type: 'sb2' },
    { project: sb2, extra: { [`${'a'.repeat(32)}.png`]: new Uint8Array(1) }, type: 'sb2' },
    { project: scratch3(), extra: { '0.png': new Uint8Array(1) }, type: 'sb3' }
  ];
  for (const { project, extra, type } of cases) {
    const result = await staticUnpack(await projectZip(project, extra));
    assert.equal(result.type, type);
    assert.equal(result.format, `zip-${type}`);
    await assertProject(result, project);
  }
  for (const invalid of [null, [], { targets: 'bad' }, { targets: [null] }, { objName: 7 }, { targets: [], objName: 'Stage' }]) {
    await assert.rejects(staticUnpack(await projectZip(invalid)), /project.json/);
  }
});

test('normalization keeps referenced woff2/fonts and extension data but excludes root siblings', async () => {
  const project = scratch3();
  const fontName = `${'c'.repeat(32)}.woff2`;
  project.customFonts = [{ system: false, family: 'Container Font', md5ext: fontName }];
  project.extensionStorage = { example: { dataFile: 'extensions/example/data.json' } };
  const files = {
    'chosen/project.json': JSON.stringify(project),
    [`chosen/${fontName}`]: Uint8Array.of(1, 3, 5, 7),
    'chosen/fonts/readme.txt': 'font metadata',
    'chosen/extensions/example/data.json': '{"value":42}',
    'chosen/custom.binary': Uint8Array.of(9, 8, 7),
    'outside.txt': 'must not leak',
    'chosen-other/private.json': 'must not leak either'
  };
  const result = await staticUnpack(await makeZip(files));
  const { zip, json } = await readProject(result);
  assert.deepEqual(json, project);
  assert.deepEqual(Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(),
    ['project.json', fontName, 'fonts/readme.txt', 'extensions/example/data.json', 'custom.binary'].sort());
  assert.deepEqual(await zip.file(fontName).async('uint8array'), files[`chosen/${fontName}`]);
  assert.equal(await zip.file('extensions/example/data.json').async('text'), '{"value":42}');
});

test('ZIP refuses traversal names and absolute names rather than normalizing them into the project', async () => {
  for (const name of ['chosen/../escape.txt', '../project.json', '/project.json', 'C:/project.json', 'chosen\\project.json']) {
    const files = { 'chosen/project.json': JSON.stringify(scratch3()), [name]: 'unsafe' };
    await assert.rejects(staticUnpack(await makeZip(files)), /Unsafe/);
  }
});

for (const [name, extra] of [
  ['two nested projects', { 'a/project.json': '{}', 'b/project.json': '{}' }],
  ['root project plus another project', { 'project.json': JSON.stringify(scratch3()), 'a/project.json': JSON.stringify(scratch3()) }]
]) {
  test(`ZIP rejects ambiguous ${name}`, async () => {
    await assert.rejects(staticUnpack(await makeZip(extra)), /Ambiguous/);
  });
}

test('ZIP validates entry CRC, rejects truncated archives, and bounds declared sizes', async () => {
  const bytes = await projectZip();
  await assert.rejects(staticUnpack(withPatchedCentral(bytes, 16, (crc) => crc ^ 1)), /CRC32/);
  await assert.rejects(staticUnpack(bytes.subarray(0, bytes.length - 22)), /Invalid ZIP/);
  await assert.rejects(staticUnpack(withPatchedCentral(bytes, 24, () => 129 * 1024 * 1024)), /size.*limit/);
  await assert.rejects(staticUnpack(withPatchedCentral(bytes, 24, () => 1)), /output|length|larger|Cannot create/i);
});

for (const [name, makeScript] of [
  ['URI JSON.parse chain', (fixture) => `<script>const normal = JSON.parse(decodeURIComponent("%7B%22a%22%3A1%7D")); const projectData = JSON.parse(decodeURIComponent("${encodeURIComponent(fixture.compiledProject)}"));</script>`],
  ['single-quoted URI JSON.parse chain', (fixture) => `<script>const compiledProject = JSON . parse ( decodeURIComponent ( '${encodeURIComponent(fixture.compiledProject).replaceAll("'", '%27')}' ) );</script>`],
  ['direct JSON.parse string', (fixture) => `<script>const compiledProject = JSON.parse(${JSON.stringify(fixture.compiledProject)});</script>`],
  ['application/json', (fixture) => `<script id='compiled-project' type='application/json'>${fixture.compiledProject}</script>`],
  ['JSON data URI', (fixture) => `<script>const bundleURL = "data:application/json,${encodeURIComponent(fixture.compiledProject)}";</script>`],
  ['base64 JSON data URI', (fixture) => `<script>const bundleURL = "data:application/json;base64,${Buffer.from(fixture.compiledProject).toString('base64')}";</script>`]
]) {
  test(`precompile ${name} extracts the schema bundle without a loader substring`, async () => {
    const fixture = await compiledFixture();
    assert.ok(Object.values(fixture.project.targets[0].blocks).length > 0);
    assert.ok(fixture.stripped.targets.every((target) => Object.keys(target.blocks).length === 0));
    const html = precompileHTML(fixture, makeScript(fixture));
    assert.ok(!new TextDecoder().decode(html).includes('loadCompiledProject'));
    const id = await identify(html);
    assert.equal(id.format, 'o2-html-precompile');
    assert.equal(id.details.compiledProjectExtracted, true);
    const result = await staticUnpack(html);
    assert.equal(result.format, id.format);
    assert.equal(result.type, 'sb3');
    assert.equal(result.compiledProject, fixture.compiledProject);
    assert.deepEqual(JSON.parse(result.compiledProject), fixture.bundle);
    assert.equal(result.metadata.projectBlocks, 'empty');
    assert.equal(result.metadata.sourceBlocksRecovered, false);
    assert.deepEqual(result.warnings, []);
    await assertProject(result, fixture.stripped);
  });
}

test('large compiled JSON literals are scanned without RegExp stack overflow', () => {
  const compiledProject = JSON.stringify({
    format: '02engine-compiled-project', version: 1, targets: [], compiledTargets: {},
    // The real strong 10128407 HTML contains a 13.6 MB URI-encoded literal.
    padding: 'x'.repeat(14 * 1024 * 1024)
  });
  for (const expression of [
    `JSON.parse(decodeURIComponent(${JSON.stringify(encodeURIComponent(compiledProject))}))`,
    `JSON.parse(${JSON.stringify(compiledProject)})`
  ]) {
    const info = inspectCompiledProjectHTML(`<script>const compiledProject = ${expression};</script>`);
    assert.equal(info.compiledProject, compiledProject);
    assert.deepEqual(info.warnings, []);
  }
});

test('compiled literal scanner honors escaped quotes and rejects incomplete calls', () => {
  const compiledProject = JSON.stringify({
    format: '02engine-compiled-project', version: 1, description: 'quote " and backslash \\'
  });
  const call = `JSON.parse(${JSON.stringify(compiledProject)})`;
  assert.equal(inspectCompiledProjectHTML(call).compiledProject, compiledProject);
  for (const text of [call.slice(0, -1), `JSON.parse(decodeURIComponent(${JSON.stringify(encodeURIComponent(compiledProject))})`]) {
    assert.equal(inspectCompiledProjectHTML(text).compiledProject, undefined);
  }
});

test('precompile ZIP validates bundle and stripped project in the same folder', async () => {
  const fixture = await compiledFixture();
  const bytes = await makeZip({
    'app/project.zip': fixture.bytes, 'app/compiled-project.json': fixture.compiledProject,
    'outside.txt': 'outer file'
  });
  const result = await staticUnpack(bytes);
  assert.equal(result.format, 'o2-zip-precompile');
  assert.equal(result.compiledProject, fixture.compiledProject);
  assert.equal(result.metadata.projectBlocks, 'empty');
  await assertProject(result, fixture.stripped);
  const missing = await makeZip({ 'compiled-project.json': fixture.compiledProject });
  await assert.rejects(staticUnpack(missing), /no project archive.*extracted/);
});

test('missing compiledProject gives clear extraction warning and no compiled success claim', async () => {
  const fixture = await compiledFixture();
  const html = precompileHTML(fixture, '<script>scaffolding.loadCompiledProject(projectData)</script>');
  assert.equal((await identify(html)).format, 'o2-html-precompile');
  const result = await staticUnpack(html);
  assert.equal(result.compiledProject, undefined);
  assert.equal(result.metadata.compiledProjectExtracted, false);
  assert.ok(result.notes.some((note) => /编译包未提取/.test(note)));
  assert.ok(!result.notes.some((note) => /编译.*已提取/.test(note)));
  await assertProject(result, fixture.stripped);
});

for (const [name, transform] of [
  ['wrong format', (bundle) => ({ ...bundle, format: 'other-format' })],
  ['missing version', ({ version, ...bundle }) => bundle],
  ['version zero', (bundle) => ({ ...bundle, version: 0 })],
  ['string version', (bundle) => ({ ...bundle, version: '1' })],
  ['fractional version', (bundle) => ({ ...bundle, version: 1.5 })],
  ['invalid targets', (bundle) => ({ ...bundle, targets: {} })],
  ['invalid compiledTargets', (bundle) => ({ ...bundle, compiledTargets: null })]
]) {
  test(`invalid compiled ${name}: HTML warns without success, ZIP rejects`, async () => {
    const fixture = await compiledFixture();
    const invalid = JSON.stringify(transform(fixture.bundle));
    const script = `<script>const compiledProject = JSON.parse(decodeURIComponent("${encodeURIComponent(invalid)}"));</script>`;
    const result = await staticUnpack(precompileHTML(fixture, script));
    assert.equal(result.format, 'o2-html-precompile');
    assert.equal(result.compiledProject, undefined);
    assert.equal(result.metadata.compiledProjectExtracted, false);
    assert.ok(result.notes.some((note) => /编译包未提取/.test(note)));
    assert.ok(!result.notes.some((note) => /编译.*已提取/.test(note)));
    await assert.rejects(staticUnpack(await makeZip({ 'project.zip': fixture.bytes, 'compiled-project.json': invalid })), /Invalid compiledProject/);
  });
}

test('malformed compiled URI/JSON emits missing data notes rather than a success claim', async () => {
  const fixture = await compiledFixture();
  for (const script of [
    `<script>const compiledProject = JSON.parse(decodeURIComponent("%GG"));</script>`,
    `<script>const projectData = JSON.parse(decodeURIComponent("%7B%22format%22%3A%2202engine-compiled-project%22"));</script>`,
    `<script type='application/json' id='compiled-project'>{"format":"02engine-compiled-project",</script>`
  ]) {
    const html = precompileHTML(fixture, script);
    assert.equal((await identify(html)).format, 'o2-html-precompile');
    const result = await staticUnpack(html);
    assert.equal(result.compiledProject, undefined);
    assert.ok(result.notes.some((note) => /编译包未提取/.test(note)));
    assert.ok(!result.notes.some((note) => /编译.*已提取/.test(note)));
  }
});

test('bundle missing target/bundle data warns, and source blocks are reported honestly', async () => {
  const bytes = await projectZip();
  const compiled = JSON.stringify({ format: '02engine-compiled-project', version: 1 });
  const html = textBytes(chunkHTML(bytes) + `<script type='application/json'>${compiled}</script>`);
  const result = await staticUnpack(html);
  assert.equal(result.metadata.projectBlocks, 'present');
  assert.ok(result.warnings.some((warning) => /缺少 targets\/compiledTargets/.test(warning)));
  assert.ok(!result.notes.some((note) => /块数据已剥离/.test(note)));
});

test('ordinary loader implementation/format comparison does not imply precompile', async () => {
  const html = textBytes(chunkHTML(await projectZip()) +
    `<script>class VM { loadCompiledProject(data) { if (data.format === '02engine-compiled-project') return data; } }</script>`);
  assert.equal((await identify(html)).format, 'o2-html-chunk');
  assert.equal((await staticUnpack(html)).format, 'o2-html-chunk');
});

test('multiple distinct compiled bundles are rejected rather than taking the first', async () => {
  const fixture = await compiledFixture();
  const other = JSON.stringify({ ...fixture.bundle, version: 2 });
  const html = precompileHTML(fixture,
    `<script type='application/json'>${fixture.compiledProject}</script><script type='application/json'>${other}</script>`);
  await assert.rejects(staticUnpack(html), /Ambiguous/);
  assert.equal((await identify(html)).family, 'unknown');
});
