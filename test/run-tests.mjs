// 静态解包全格式往返测试：fixture → staticUnpack → 与原始 sb3 逐字节比对。
import { strict as assert } from 'node:assert';
import { identify } from '../src/identify.mjs';
import { staticUnpack } from '../src/static-unpack.mjs';
import * as H from './helpers.mjs';

const { bytes, project, assets } = await H.makeMinimalSb3();
const projectJSONBytes = new TextEncoder().encode(JSON.stringify(project));
const {compiledFixture} = await import('./compiled-fixtures.mjs');
const compiled = await compiledFixture();
const compiledSample = compiled.compiledProject;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const expectId = async (fixture, family, format) => {
  const id = await identify(fixture);
  assert.equal(id.family, family, `identify family: got ${id.family}/${id.format}`);
  assert.equal(id.format, format, `identify format: got ${id.format}`);
  return id;
};

const expectUnpack = async (fixture, expectFormat) => {
  const r = await staticUnpack(fixture);
  assert.equal(r.type, 'sb3', `type: got ${r.type}`);
  if (expectFormat) assert.equal(r.format, expectFormat);
  await H.assertSameProject(r.data, project, assets);
  return r;
};

// ---- TurboWarp HTML 各世代 ----
test('tw-html-chunk-v4（现行分块 base85）', async () => {
  const f = H.buildTwHtmlV4(bytes);
  await expectId(f, 'turbowarp', 'tw-html-chunk-v4');
  await expectUnpack(f, 'tw-html-chunk-v4');
});
test('tw-html-p4-project v1', async () => {
  const f = H.buildP4ProjectHtml(bytes, 1);
  await expectId(f, 'turbowarp', 'tw-html-p4-project');
  await expectUnpack(f, 'tw-html-p4-project');
});
test('tw-html-p4-project v2', async () => {
  const f = H.buildP4ProjectHtml(bytes, 2);
  await expectUnpack(f, 'tw-html-p4-project');
});
test('tw-html-p4-project v3', async () => {
  const f = H.buildP4ProjectHtml(bytes, 3);
  await expectUnpack(f, 'tw-html-p4-project');
});
test('tw-html-p4-encoded', async () => {
  const f = H.buildP4EncodedHtml(bytes);
  await expectId(f, 'turbowarp', 'tw-html-p4-encoded');
  await expectUnpack(f, 'tw-html-p4-encoded');
});
test('tw base85decode()', async () => {
  const f = H.buildBase85DecodeHtml(bytes);
  await expectUnpack(f, 'tw-html-p4-encoded');
});
test('tw-html-base64（getProjectData fetch data URI）', async () => {
  const f = H.buildTwBase64Html(bytes);
  await expectId(f, 'turbowarp', 'tw-html-base64');
  await expectUnpack(f, 'tw-html-base64');
});
test('tw-legacy __PACKAGER__', async () => {
  const f = H.buildLegacyHtml(bytes);
  await expectId(f, 'turbowarp', 'tw-legacy-html-base64');
  await expectUnpack(f, 'tw-legacy-html-base64');
});

// ---- 02Engine ----
test('o2-html-chunk（私有容器）', async () => {
  const f = H.buildO2Html(bytes);
  await expectId(f, '02engine', 'o2-html-chunk');
  await expectUnpack(f, 'o2-html-chunk');
});
test('o2-html-precompile（真实剥离结构：仅验证提取，不是反编译）', async () => {
  const f = compiled.html;
  await expectId(f, '02engine', 'o2-html-precompile');
  const r = await staticUnpack(f);
  assert.equal(r.format, 'o2-html-precompile');
  await H.assertSameProject(r.data, compiled.stripped, compiled.assets);
  const zip = await H.JSZip.loadAsync(r.data);
  const project = JSON.parse(await zip.file('project.json').async('text'));
  assert.equal(project.targets.reduce((sum, t) => sum + Object.keys(t.blocks).length, 0), 0);
  assert.equal(r.compiledProject, compiledSample, 'compiled-project.json 提取不一致');
});

// ---- HTMLifier ----
test('htmlifier initOptions', async () => {
  const f = H.buildHtmlifierInitOptions(projectJSONBytes, assets);
  await expectId(f, 'htmlifier', 'htmlifier-initoptions');
  await expectUnpack(f, 'htmlifier-initoptions');
});
test('htmlifier TYPE=json（旧版）', async () => {
  const f = H.buildHtmlifierTypeJson(projectJSONBytes, assets);
  await expectId(f, 'htmlifier', 'htmlifier-type-json');
  await expectUnpack(f, 'htmlifier-type-json');
});

// ---- forkphorus ----
test('forkphorus html', async () => {
  const f = H.buildForkphorusHtml(bytes);
  await expectId(f, 'forkphorus', 'forkphorus-html-base64');
  await expectUnpack(f, 'forkphorus-html-base64');
});

// ---- zip 容器 ----
test('zip: 裸 sb3 直通', async () => {
  await expectUnpack(bytes, 'zip-sb3');
});
test('zip: 内嵌 project.zip', async () => {
  const outer = await new H.JSZip();
  outer.file('project.zip', bytes);
  const f = await outer.generateAsync({ type: 'uint8array' });
  await expectUnpack(f, 'zip-inner');
});
test('zip: 工程在子目录 + 杂物剔除', async () => {
  const outer = await new H.JSZip();
  outer.file('sub/project.json', projectJSONBytes);
  for (const [name, b] of Object.entries(assets)) outer.file(`sub/${name}`, b);
  outer.file('sub/script.js', new TextEncoder().encode('console.log(1)'));
  outer.file('readme.txt', new TextEncoder().encode('junk'));
  const f = await outer.generateAsync({ type: 'uint8array' });
  await expectUnpack(f, 'zip-sb3');
});
test('zip: o2 precompile 包', async () => {
  const outer = await new H.JSZip();
  outer.file('project.zip', compiled.bytes);
  outer.file('compiled-project.json', compiledSample);
  outer.file('index.html', new TextEncoder().encode('<html></html>'));
  const f = await outer.generateAsync({ type: 'uint8array' });
  const r = await staticUnpack(f);
  assert.equal(r.format, 'o2-zip-precompile');
  await H.assertSameProject(r.data, compiled.stripped, compiled.assets);
  assert.equal(r.compiledProject, compiledSample);
});

// ---- 失败诊断 ----
test('zip 环境 HTML 给出明确指引', async () => {
  await assert.rejects(() => staticUnpack(H.buildZipEnvErrorHtml()), /完整 zip 包/);
});
test('加载后导出的 HTML 被识别', async () => {
  await assert.rejects(() => staticUnpack(H.buildLoadedExportHtml()), /另存/);
});

// ---- 执行 ----
let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
