import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {validateSb3} from '../src/sb3-validate.mjs';

const fixture = () => {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const assetId = createHash('md5').update(bytes).digest('hex');
  const costume = {name: 'backdrop', assetId, dataFormat: 'svg', md5ext: `${assetId}.svg`,
    rotationCenterX: 0, rotationCenterY: 0, bitmapResolution: 1};
  const sound = {name: 'sound', assetId, dataFormat: 'wav', md5ext: `${assetId}.wav`};
  return {
    project: {targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [costume],
      sounds: [sound], currentCostume: 0}], extensions: [], monitors: []},
    files: {[costume.md5ext]: bytes, [sound.md5ext]: bytes}, costume, sound, bytes
  };
};
const validate = async ({project, files}) => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  return validateSb3(await zip.generateAsync({type: 'uint8array'}));
};
const rejects = async (f, pattern) => {
  const result = await validate(f);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.errors.some(error => pattern.test(error)), JSON.stringify(result));
};

test('sound requires md5ext and dataFormat even when fallback asset exists', async () => {
  for (const key of ['md5ext', 'dataFormat']) {
    const f = fixture();
    delete f.sound[key];
    await rejects(f, new RegExp(key));
  }
});

test('sound md5ext format must agree with decoder selection; source assetId mismatch stays warning', async () => {
  const f = fixture();
  f.sound.dataFormat = 'mp3';
  await rejects(f, /扩展名与 dataFormat 不一致/);
  f.sound.dataFormat = 'WAV';
  f.sound.assetId = '0'.repeat(32);
  const result = await validate(f);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.warnings.some(warning => /MD5 不匹配/.test(warning)));
});

test('costume validates assetId/dataFormat lookup, not only a present md5ext', async () => {
  const f = fixture();
  f.costume.assetId = '0'.repeat(32);
  await rejects(f, /assetId\/dataFormat 文件名不一致/);
  await rejects(f, /缺少造型加载器查找的根目录资产/);
  f.files[`${f.costume.assetId}.svg`] = f.bytes;
  await rejects(f, /assetId\/dataFormat 文件名不一致/);
});

test('costume lookup is exact-case and supports md5ext absence and VM legacy format defaults', async () => {
  const f = fixture();
  delete f.costume.md5ext;
  assert.equal((await validate(f)).ok, true);
  f.costume.dataFormat = 'SVG';
  await rejects(f, /缺少根目录造型资产/);
  delete f.costume.dataFormat;
  f.costume.assetType = {runtimeFormat: 'svg'};
  assert.equal((await validate(f)).ok, true);
  delete f.costume.assetType;
  f.files[`${f.costume.assetId}.png`] = f.bytes;
  assert.equal((await validate(f)).ok, true);
});

test('currentCostume is an optional in-range integer, with empty-target default zero allowed', async () => {
  for (const value of [-1, 1, 0.5, '0', null]) {
    const f = fixture();
    f.project.targets[0].currentCostume = value;
    await rejects(f, /currentCostume/);
  }
  const f = fixture();
  delete f.project.targets[0].currentCostume;
  assert.equal((await validate(f)).ok, true);
  f.project.targets[0].costumes = [];
  f.project.targets[0].currentCostume = 0;
  assert.equal((await validate(f)).ok, true);
});

test('optional costume centers must be finite numbers and bitmapResolution positive', async () => {
  for (const [key, value] of [['rotationCenterX', 'bad'], ['rotationCenterY', null],
    ['bitmapResolution', 0], ['bitmapResolution', -2], ['bitmapResolution', '2']]) {
    const f = fixture();
    f.costume[key] = value;
    await rejects(f, new RegExp(key));
  }
  const f = fixture();
  delete f.costume.rotationCenterX;
  delete f.costume.rotationCenterY;
  delete f.costume.bitmapResolution;
  assert.equal((await validate(f)).ok, true);
});

test('customFonts follows fontManager schema and requires local bytes for non-system fonts', async () => {
  const f = fixture();
  const name = `${f.costume.assetId}.woff2`;
  f.project.customFonts = [
    {system: true, family: 'System Font', fallback: 'sans-serif'},
    {system: false, family: 'Custom Font', fallback: 'sans-serif', md5ext: name}
  ];
  await rejects(f, /缺少根目录字体资产/);
  f.files[`fonts/${name}`] = f.bytes;
  await rejects(f, /缺少根目录字体资产/);
  f.files[name] = f.bytes;
  assert.equal((await validate(f)).ok, true);
  f.project.customFonts[1].md5ext = `fonts/${name}`;
  await rejects(f, /md5ext 必须是根目录字体资产文件名/);
});

test('malformed or duplicate custom fonts are reported instead of VM silently dropping them', async () => {
  for (const font of [null, {system: true, family: 'Font'},
    {system: true, family: 'bad"font', fallback: 'sans-serif'}]) {
    const f = fixture();
    f.project.customFonts = [font];
    await rejects(f, /customFonts\[0\]/);
  }
  const f = fixture();
  f.project.customFonts = [
    {system: true, family: 'Font', fallback: 'sans-serif'},
    {system: true, family: 'font', fallback: 'serif'}
  ];
  await rejects(f, /重名/);
});

test('hash-only discrepancies remain warnings and validation does not infer media decoding', async () => {
  const f = fixture();
  f.files[f.costume.md5ext] = Buffer.from('changed bytes');
  const result = await validate(f);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.warnings.some(warning => /MD5 不匹配/.test(warning)));
});
