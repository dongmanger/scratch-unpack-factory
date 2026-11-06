// 测试辅助：构造最小合法 sb3 + 各世代容器 fixture。
// 资产文件名遵循 sb3 约定 md5ext（内容真实 md5）。

import { createHash } from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import { encode, encodeV1, encodeV2WithLength, encodeV3WithLength } from '../src/base85.mjs';

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

// 1x1 透明 PNG 与最小 SVG
const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0)
);
const SVG_MIN = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>'
);

export const makeMinimalSb3 = async () => {
  const pngMd5 = md5(PNG_1X1);
  const svgMd5 = md5(SVG_MIN);
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { varId1: ['score', 0] },
        lists: {},
        broadcasts: {},
        blocks: {
          a: { opcode: 'event_whenflagclicked', next: 'b', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 },
          b: {
            opcode: 'data_setvariableto', next: null, parent: 'a',
            inputs: { VALUE: [1, [10, 'factory-ok']] },
            fields: { VARIABLE: ['score', 'varId1'] }, shadow: false, topLevel: false
          }
        },
        comments: {},
        currentCostume: 0,
        costumes: [{ name: 'backdrop1', assetId: svgMd5, md5ext: `${svgMd5}.svg`, dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [],
        volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {}, lists: {}, broadcasts: {},
        blocks: {
          c: { opcode: 'event_whenflagclicked', next: 'd', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 },
          d: { opcode: 'motion_movesteps', next: null, parent: 'c', inputs: { STEPS: [1, [4, '10']] }, fields: {}, shadow: false, topLevel: false }
        },
        comments: {},
        currentCostume: 0,
        costumes: [{ name: 'costume1', assetId: pngMd5, md5ext: `${pngMd5}.png`, dataFormat: 'png', bitmapResolution: 2, rotationCenterX: 0, rotationCenterY: 0 }],
        sounds: [],
        volume: 100, layerOrder: 1,
        visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '2.1.46', agent: 'unpack-factory-fixture' }
  };
  const projectJSONBytes = new TextEncoder().encode(JSON.stringify(project));

  const zip = new JSZip();
  zip.file('project.json', projectJSONBytes);
  zip.file(`${svgMd5}.svg`, SVG_MIN);
  zip.file(`${pngMd5}.png`, PNG_1X1);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { bytes, project, assets: { [`${svgMd5}.svg`]: SVG_MIN, [`${pngMd5}.png`]: PNG_1X1 } };
};

const htmlPage = (body) => new TextEncoder().encode(
  `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`
);

const dataUri = (bytes) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;

const chunked = (bytes, sizes, tagFn) => {
  let html = '';
  let off = 0;
  for (const size of sizes) {
    const chunk = bytes.subarray(off, off + size);
    html += tagFn(encode(chunk), chunk.length);
    off += size;
  }
  return html;
};

export const buildTwHtmlV4 = (bytes) => htmlPage(
  chunked(bytes, [1024, 512, Infinity], (b85, len) => `<script data="${b85}">decodeChunk(${len})</script>\n`)
);

export const buildP4ProjectHtml = (bytes, ver) => {
  // v1-v3 都带明文/偏移长度头，仅 v4 无长度头
  const payload =
    ver === 1 ? `${bytes.length},${encodeV1(bytes)}` :
    ver === 2 ? encodeV2WithLength(bytes) :
    encodeV3WithLength(bytes);
  return htmlPage(`<script type="p4-project">${payload}</script>`);
};

export const buildP4EncodedHtml = (bytes) => htmlPage(
  `<script id="p4-encoded-project-data" type="p4-encoded-project-data">${encodeV3WithLength(bytes)}</script>`
);

export const buildBase85DecodeHtml = (bytes) => htmlPage(
  `<script>const result = base85decode("${encodeV3WithLength(bytes)}");</script>`
);

export const buildTwBase64Html = (bytes) => htmlPage(
  `<script>const getProjectData = () => fetch("data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}")</script>`
);

export const buildForkphorusHtml = (bytes) => htmlPage(
  `<script>var project = '${dataUri(bytes)}';</script>`
);

export const buildLegacyHtml = (bytes) => new TextEncoder().encode(
  `<html><script>window.__PACKAGER__ = {\n    projectData: "${dataUri(bytes)}",\n    projectName: "x"\n};</script></html>`
);

export const buildO2Html = (bytes, { precompile = false, compiledProject = null } = {}) => {
  let body = chunked(bytes, [1024, Infinity], (b85, len) =>
    `<script type="application/x-o2-project-chunk" data-size="${len}">${b85}</script>\n`);
  if (precompile) {
    body += `<script>const boot = async () => scaffolding.loadCompiledProject(getProjectData());</script>\n`;
    body += `<script>projectData: JSON.parse(decodeURIComponent("${encodeURIComponent(compiledProject)}"))</script>\n`;
  }
  return htmlPage(body);
};

export const buildHtmlifierInitOptions = (projectJSONBytes, assets) => {
  const map = { project: dataUri(projectJSONBytes) };
  for (const [name, bytes] of Object.entries(assets)) map[name] = dataUri(bytes);
  return new TextEncoder().encode(
    `<script>\nconst GENERATED = 1\nconst initOptions = ${JSON.stringify({ assets: map })}\ninit(initOptions)\n</script>`
  );
};

export const buildHtmlifierTypeJson = (projectJSONBytes, assets) => {
  const map = {};
  for (const [name, bytes] of Object.entries(assets)) map[name] = dataUri(bytes);
  return new TextEncoder().encode(
    `var TYPE = 'json',\nPROJECT_JSON = "${dataUri(projectJSONBytes)}",\nASSETS = ${JSON.stringify(map)},\n/* */`
  );
};

export const buildZipEnvErrorHtml = () => htmlPage('<script src="script.js"></script>');
export const buildLoadedExportHtml = () => htmlPage('<canvas class="sc-canvas" width="480" height="360"></canvas>');

export const assertSameProject = async (sb3Bytes, expectProject, expectAssets) => {
  const assert = (await import('node:assert')).strict;
  const zip = await JSZip.loadAsync(sb3Bytes);
  const jsonFile = zip.file('project.json') || Object.keys(zip.files).map((n) => zip.file(n)).filter(Boolean).find((f) => /\/project\.json$/.test(f.name));
  assert.ok(jsonFile, 'output zip 中没有 project.json');
  const gotProject = JSON.parse(await jsonFile.async('text'));
  assert.deepStrictEqual(gotProject, expectProject);
  for (const [name, bytes] of Object.entries(expectAssets)) {
    const f = zip.file(name) || Object.keys(zip.files).map((n) => zip.file(n)).filter(Boolean).find((x) => x.name.endsWith(`/${name}`));
    assert.ok(f, `output zip 中缺少资产 ${name}`);
    const got = await f.async('uint8array');
    assert.ok(Buffer.from(got).equals(Buffer.from(bytes)), `资产 ${name} 内容不一致`);
  }
};

export { JSZip };
