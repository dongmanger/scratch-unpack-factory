import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {convertLegacy} from '../src/legacy-convert.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import {makeMinimalSb3, JSZip} from './helpers.mjs';
import {actualVMClass, actualVMRoot} from './real-02-compiler.mjs';

// Actual local 02 VM + the actual installed ScratchStorage. No loader/serializer doubles.
const RealVM = actualVMClass();
const vmRequire = createRequire(path.join(actualVMRoot(), 'package.json'));
const storageRequire = createRequire(path.join(actualVMRoot(), '../packager/package.json'));
let storagePath;
for (const [loader, name] of [[vmRequire, 'scratch-storage'], [vmRequire, '@turbowarp/scratch-storage'],
  [storageRequire, '@turbowarp/scratch-storage']]) {
  try { storagePath = loader.resolve(name); break; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
if (!storagePath) throw new Error(`Actual ScratchStorage dependency missing for ${actualVMRoot()}`);
const ScratchStorage = vmRequire(storagePath);
class ConversionVM extends RealVM {
  static Storage = ScratchStorage;
}

async function sb2Fixture({hostile = false, stageName = 'Stage'} = {}) {
  const {project: sb3, assets} = await makeMinimalSb3();
  const stageCostume = sb3.targets[0].costumes[0];
  const spriteCostume = sb3.targets[1].costumes[0];
  const text = 'globalThis.__legacyScriptExecuted = true';
  const source = {
    objName: stageName,
    variables: [{name: '分数', value: 7, isPersistent: false}, {name: '代码文本', value: text, isPersistent: false}],
    lists: [{listName: '项目列表', contents: ['开始', '结束', 3], isPersistent: false,
      x: 12, y: 20, width: 100, height: 100, visible: false}],
    scripts: [[32, 64, [['whenGreenFlag'], ['setVar:to:', '分数', hostile ? 999 : '转换后才运行'],
      ['append:toList:', hostile ? text : '新增', '项目列表'],
      ...(hostile ? [['doForever', [['changeVar:by:', '分数', 1]]]] : [])]]],
    costumes: [{costumeName: '背景 中文', baseLayerID: 0, baseLayerMD5: stageCostume.md5ext,
      bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180}],
    sounds: [], currentCostumeIndex: 0, tempoBPM: 60, videoAlpha: 0.5,
    penLayerMD5: spriteCostume.md5ext, penLayerID: 2,
    children: [{
      objName: '角色 名字', variables: [{name: '分数', value: 11, isPersistent: false}],
      lists: [{listName: '项目列表', contents: ['本地'], isPersistent: false,
        x: 110, y: 20, width: 100, height: 100, visible: false}],
      scripts: [[48, 96, [['whenGreenFlag'], ['forward:', 10], ['setVar:to:', '分数', 99]]]],
      costumes: [{costumeName: '造型 中文', baseLayerID: 1, baseLayerMD5: spriteCostume.md5ext,
        bitmapResolution: 2, rotationCenterX: 0, rotationCenterY: 0}],
      sounds: [], currentCostumeIndex: 0, scratchX: 23, scratchY: -17, scale: 0.75,
      direction: 90, rotationStyle: 'normal', isDraggable: false, visible: true, indexInLibrary: 1
    }], info: {videoOn: false}
  };
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(source));
  // SB2 archives use numeric baseLayerID filenames, not SB3 md5 filenames.
  zip.file('0.svg', assets[stageCostume.md5ext]);
  zip.file('1.png', assets[spriteCostume.md5ext]);
  zip.file('2.png', assets[spriteCostume.md5ext]);
  return {source, assets, data: await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'})};
}

const projectFrom = async bytes => {
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
  return {zip, project: JSON.parse(await zip.file('project.json').async('text'))};
};
const byName = dictionary => Object.fromEntries(Object.values(dictionary).map(value => [value[0], value[1]]));

test('genuine SB2 converts through actual 02 loadProject/saveProjectSb3 with Unicode definitions and real SVG/PNG assets', async t => {
  assert.equal(typeof vmRequire('scratch-parser'), 'function');
  const fixture = await sb2Fixture();
  const result = await convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: ConversionVM});
  assert.ok(result.bytes instanceof Uint8Array);
  const validation = await validateSb3(result.bytes);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(validation.warnings, []);
  const {zip, project} = await projectFrom(result.bytes);
  assert.deepEqual(project.targets.map(target => target.name), ['Stage', '角色 名字']);
  const [stage, sprite] = project.targets;
  assert.deepEqual(byName(stage.variables), {分数: 7, 代码文本: 'globalThis.__legacyScriptExecuted = true'});
  assert.deepEqual(byName(stage.lists), {项目列表: ['开始', '结束', 3]});
  assert.deepEqual(byName(sprite.variables), {分数: 11});
  assert.deepEqual(byName(sprite.lists), {项目列表: ['本地']});
  assert.equal(sprite.x, 23);
  assert.equal(sprite.y, -17);
  assert.equal(sprite.size, 75);
  assert.equal(sprite.direction, 90);
  assert.ok(Object.values(stage.blocks).some(block => block.opcode === 'data_setvariableto'));
  assert.ok(Object.values(stage.blocks).some(block => block.opcode === 'data_addtolist'));
  assert.ok(Object.values(sprite.blocks).some(block => block.opcode === 'motion_movesteps'));
  const set = Object.values(sprite.blocks).find(block => block.opcode === 'data_setvariableto');
  assert.equal(sprite.variables[set.fields.VARIABLE[1]][0], '分数');
  assert.equal(Object.values(stage.blocks).find(block => block.topLevel).x, 32 * 1.5);
  for (const [name, bytes] of Object.entries(fixture.assets)) {
    assert.ok(zip.file(name), `missing real asset ${name}`);
    assert.deepEqual(await zip.file(name).async('uint8array'), bytes);
  }
  assert.equal(stage.costumes[0].name, '背景 中文');
  assert.equal(sprite.costumes[0].name, '造型 中文');
  assert.equal(result.metadata.sourceState.verified, true);
  assert.equal(result.metadata.assets.verified, true);
  assert.deepEqual(result.metadata.transformed, {blockIds: true, layout: true, names: true});
  assert.equal(result.metadata.scriptsExecuted, false);
  assert.equal(result.metadata.runtimeStarted, false);
  t.diagnostic(`VM root ${actualVMRoot()}; parser ${vmRequire.resolve('scratch-parser')}; storage ${storagePath}`);
});

test('green flag scripts and hostile code strings are loaded as data without executing or mutating initial state', async () => {
  delete globalThis.__legacyScriptExecuted;
  const fixture = await sb2Fixture({hostile: true});
  const {bytes} = await convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: ConversionVM});
  const {project} = await projectFrom(bytes);
  assert.equal(globalThis.__legacyScriptExecuted, undefined);
  assert.equal(byName(project.targets[0].variables).分数, 7);
  assert.deepEqual(byName(project.targets[0].lists).项目列表, ['开始', '结束', 3]);
  assert.equal(byName(project.targets[1].variables).分数, 11);
  assert.equal(project.targets[1].x, 23);
});

test('stage normalization is reported as unpreserved source state rather than claiming original names', async () => {
  const fixture = await sb2Fixture({stageName: '舞台原名'});
  const result = await convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: ConversionVM});
  assert.equal(result.metadata.sourceState.verified, false);
  assert.equal(result.metadata.sourceState.original.targets[0].name, '舞台原名');
  assert.equal(result.metadata.sourceState.converted.targets[0].name, 'Stage');
});

test('actual VM converts a genuine ScratchV02 SB1 parser fixture; binary source state stays unverified', async t => {
  const parserRoot = path.dirname(vmRequire.resolve('scratch-parser'));
  const fixturePath = path.join(parserRoot, 'test/fixtures/data/_empty.sb');
  const data = await fs.readFile(fixturePath);
  assert.match(data.subarray(0, 10).toString('ascii'), /^ScratchV0[12]$/);
  const result = await convertLegacy({data, type: 'sb', VirtualMachine: ConversionVM});
  const validation = await validateSb3(result.bytes);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const {project} = await projectFrom(result.bytes);
  assert.ok(project.targets.length > 0);
  assert.equal(result.metadata.sourceState.verified, false);
  assert.equal(result.metadata.assets.verified, false);
  t.diagnostic(`SB1 input is installed scratch-parser fixture ${fixturePath}; SHA256 ${result.metadata.sourceSha256}`);
});

test('genuine scripted SB1 fixture retains actual motion/data blocks and local assets without running forever loops', async t => {
  const parserRoot = path.dirname(vmRequire.resolve('scratch-parser'));
  const fixturePath = path.join(parserRoot, 'test/fixtures/data/_example.sb');
  const data = await fs.readFile(fixturePath);
  assert.equal(data.subarray(0, 10).toString('ascii'), 'ScratchV02');
  const original = new (vmRequire('scratch-sb1-converter').SB1File)(data);
  const {bytes} = await convertLegacy({data, type: 'sb1', VirtualMachine: ConversionVM});
  const validation = await validateSb3(bytes);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const {project, zip} = await projectFrom(bytes);
  const sprite = project.targets.find(target => !target.isStage);
  const sourceSprite = original.json.children.find(target => target.objName === sprite.name);
  assert.deepEqual(Object.values(sprite.variables).map(value => value.slice(0, 2)), sourceSprite.variables.map(value => [value.name, value.value]));
  assert.deepEqual(Object.values(sprite.lists).map(value => value.slice(0, 2)), sourceSprite.lists.map(value => [value.listName, value.contents]));
  for (const [legacyKey, key] of [['scratchX', 'x'], ['scratchY', 'y'], ['direction', 'direction'], ['currentCostumeIndex', 'currentCostume']]) {
    assert.equal(sprite[key], sourceSprite[legacyKey]);
  }
  const opcodes = Object.values(sprite.blocks).map(block => block.opcode);
  for (const opcode of ['event_whenflagclicked', 'motion_movesteps', 'motion_turnright',
    'control_forever', 'sound_play', 'looks_switchcostumeto']) assert.ok(opcodes.includes(opcode), opcode);
  const sourceZip = original.zip;
  for (const sourceTarget of [original.json, ...original.json.children]) {
    for (const asset of sourceTarget.costumes) {
      const ext = asset.baseLayerMD5.split('.').pop();
      const sourceBytes = await sourceZip.file(`${asset.baseLayerID}.${ext}`).async('uint8array');
      const fileName = `${createHash('md5').update(sourceBytes).digest('hex')}.${ext}`;
      assert.deepEqual(await zip.file(fileName).async('uint8array'), sourceBytes);
    }
    for (const asset of sourceTarget.sounds) {
      const ext = asset.md5.split('.').pop();
      const sourceBytes = await sourceZip.file(`${asset.soundID}.${ext}`).async('uint8array');
      const fileName = `${createHash('md5').update(sourceBytes).digest('hex')}.${ext}`;
      assert.deepEqual(await zip.file(fileName).async('uint8array'), sourceBytes);
    }
  }
  t.diagnostic(`Scripted SB1 fixture ${fixturePath}; actual SB1 decoder inspected source state without script execution`);
});

test('real VM PROJECT_LOADED listeners cannot automatically start the VM or mutate project state', async () => {
  const fixture = await sb2Fixture({hostile: true});
  let loaded = false;
  class AutoStartingRealVM extends ConversionVM {
    constructor() {
      super();
      this.runtime.on('PROJECT_LOADED', () => {
        loaded = true;
        this.start();
        this.greenFlag();
        this.runtime.start();
        this.runtime.greenFlag();
        this.runtime.frameLoop.start();
        this.runtime.startHats('event_whenflagclicked');
      });
    }
  }
  const result = await convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: AutoStartingRealVM});
  assert.equal(loaded, true);
  assert.deepEqual(result.metadata.suppressedStarts, ['start', 'greenFlag', 'start', 'greenFlag', 'start', 'startHats']);
  const {project} = await projectFrom(result.bytes);
  assert.equal(byName(project.targets[0].variables).分数, 7);
  assert.deepEqual(byName(project.targets[0].lists).项目列表, ['开始', '结束', 3]);
  assert.equal(project.targets[1].x, 23);
  assert.equal(result.metadata.runtimeStarted, false);
  assert.equal(result.metadata.scriptsExecuted, false);
});

test('ScratchX JavaScript is rejected inside the genuine VM loader and cleanup still occurs', async () => {
  delete globalThis.__legacyExtensionExecuted;
  const fixture = await sb2Fixture();
  const source = structuredClone(fixture.source);
  source.info.savedExtensions = [{extensionName: 'hostile',
    javascriptURL: 'data:text/javascript,globalThis.__legacyExtensionExecuted=true'}];
  source.scripts.push([100, 120, [['hostile\u001fexec']]]);
  const zip = await JSZip.loadAsync(fixture.data);
  zip.file('project.json', JSON.stringify(source));
  let cleaned = false;
  class CleanupRealVM extends ConversionVM {
    quit() { cleaned = true; return super.quit(); }
  }
  await assert.rejects(convertLegacy({data: await zip.generateAsync({type: 'uint8array'}),
    type: 'sb2', VirtualMachine: CleanupRealVM}), /extension.*JavaScript.*disabled|Project extension scripts are disabled/i);
  assert.equal(globalThis.__legacyExtensionExecuted, undefined);
  assert.equal(cleaned, true);
});

test('actual VM accepts offset byte views and generates scoped variable/list reference IDs', async () => {
  const fixture = await sb2Fixture();
  const padded = new Uint8Array(fixture.data.length + 16);
  padded.set(fixture.data, 7);
  const input = padded.subarray(7, 7 + fixture.data.length);
  const result = await convertLegacy({data: input, type: 'sb2', VirtualMachine: ConversionVM});
  const {project} = await projectFrom(result.bytes);
  const [stage, sprite] = project.targets;
  const stageId = Object.keys(stage.variables).find(id => stage.variables[id][0] === '分数');
  const spriteId = Object.keys(sprite.variables).find(id => sprite.variables[id][0] === '分数');
  // The actual SB2 importer reuses IDs when global/local names match. Scope still
  // lives in each target dictionary; do not invent different IDs or patch VM output.
  assert.equal(stage.variables[stageId][1], 7);
  assert.equal(sprite.variables[spriteId][1], 11);
  const stageList = Object.keys(stage.lists)[0];
  const spriteList = Object.keys(sprite.lists)[0];
  assert.deepEqual(stage.lists[stageList][1], ['开始', '结束', 3]);
  assert.deepEqual(sprite.lists[spriteList][1], ['本地']);
  assert.equal(Object.values(stage.blocks).find(block => block.opcode === 'data_setvariableto').fields.VARIABLE[1], stageId);
  assert.equal(Object.values(sprite.blocks).find(block => block.opcode === 'data_setvariableto').fields.VARIABLE[1], spriteId);
  assert.equal((await validateSb3(result.bytes)).ok, true);
});

test('converted SB3 reloads through the real runtime with matching definitions, names, initial properties, and asset hashes', async () => {
  const fixture = await sb2Fixture();
  const {bytes} = await convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: ConversionVM});
  const {project} = await projectFrom(bytes);
  const machine = new RealVM();
  try {
    machine.attachStorage(new ScratchStorage());
    machine.setCompilerOptions({enabled: false});
    // A bare actual VM has no host autostart listeners. Do not start it or fire a green flag.
    await machine.loadProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(machine.runtime.threads.length, 0);
    const reloaded = JSON.parse(machine.toJSON());
    assert.equal(reloaded.targets.length, project.targets.length);
    for (const [index, target] of project.targets.entries()) {
      const runtimeTarget = reloaded.targets[index];
      for (const key of ['name', 'isStage', 'variables', 'lists', 'broadcasts', 'blocks',
        'x', 'y', 'size', 'direction', 'visible', 'draggable', 'rotationStyle', 'currentCostume']) {
        assert.deepEqual(runtimeTarget[key], target[key], `${index}.${key}`);
      }
      assert.deepEqual(runtimeTarget.costumes, target.costumes);
      assert.deepEqual(runtimeTarget.sounds, target.sounds);
    }
    const exported = await machine.saveProjectSb3('arraybuffer');
    const validation = await validateSb3(new Uint8Array(exported));
    assert.equal(validation.ok, true, validation.errors.join('\n'));
    const {zip} = await projectFrom(exported);
    for (const [name, assetBytes] of Object.entries(fixture.assets)) {
      assert.deepEqual(await zip.file(name).async('uint8array'), assetBytes);
    }
  } finally { machine.quit(); }
});

test('a real parser validation error is preserved as the conversion error cause', async () => {
  const fixture = await sb2Fixture();
  const malformed = structuredClone(fixture.source);
  delete malformed.tempoBPM;
  const zip = await JSZip.loadAsync(fixture.data);
  zip.file('project.json', JSON.stringify(malformed));
  await assert.rejects(convertLegacy({data: await zip.generateAsync({type: 'uint8array'}),
    type: 'sb2', VirtualMachine: ConversionVM}), error => {
    assert.match(error.message, /Legacy sb2 conversion failed/);
    assert.match(String(error.cause), /validationError/);
    assert.match(String(error.cause), /tempoBPM/);
    return true;
  });
});

test('legacy archive traversal, CRC damage, and excessive declared sizes fail before invoking the real loader', async () => {
  const fixture = await sb2Fixture();
  let loads = 0;
  class CountingRealVM extends ConversionVM {
    loadProject(input) { loads++; return super.loadProject(input); }
  }
  const traversal = await JSZip.loadAsync(fixture.data);
  traversal.file('../secret.txt', 'hostile path');
  await assert.rejects(convertLegacy({data: await traversal.generateAsync({type: 'uint8array'}),
    type: 'sb2', VirtualMachine: CountingRealVM}), /Unsafe legacy ZIP path/);

  const stored = await JSZip.loadAsync(fixture.data);
  const bytes = await stored.generateAsync({type: 'uint8array', compression: 'STORE'});
  const damaged = Buffer.from(bytes);
  const assetOffset = damaged.indexOf(Buffer.from('<svg'));
  assert.ok(assetOffset > 0);
  damaged[assetOffset + 1] ^= 1;
  await assert.rejects(convertLegacy({data: damaged, type: 'sb2', VirtualMachine: CountingRealVM}), /CRC32 verification failed/);

  const oversized = Buffer.from(bytes);
  const centralOffset = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > 0);
  oversized.writeUInt32LE(32 * 1024 * 1024 + 1, centralOffset + 24);
  await assert.rejects(convertLegacy({data: oversized, type: 'sb2', VirtualMachine: CountingRealVM}), /entry size exceeds limit/);
  assert.equal(loads, 0);
});

test('incorrect source asset MD5 does not gain a preservation claim from VM rehashing', async () => {
  const fixture = await sb2Fixture();
  const source = structuredClone(fixture.source);
  source.costumes[0].baseLayerMD5 = `${'0'.repeat(32)}.svg`;
  const zip = await JSZip.loadAsync(fixture.data);
  zip.file('project.json', JSON.stringify(source));
  const result = await convertLegacy({data: await zip.generateAsync({type: 'uint8array'}), type: 'sb2', VirtualMachine: ConversionVM});
  assert.equal(result.metadata.assets.verified, false);
  assert.equal(result.metadata.assets.source[0].available, false);
  assert.notEqual(result.metadata.assets.source[0].actualMd5, result.metadata.assets.source[0].declaredMd5);
  assert.ok(result.metadata.assets.output.every(asset => asset.available));
  assert.equal((await validateSb3(result.bytes)).ok, true);
});

test('empty and oversized byte input is rejected before VM construction or ZIP parsing', async () => {
  await assert.rejects(convertLegacy({data: new Uint8Array(), type: 'sb2', VirtualMachine: ConversionVM}), /input is empty/);
  const excessive = new Uint8Array(256 * 1024 * 1024 + 1);
  await assert.rejects(convertLegacy({data: excessive, type: 'sb2', VirtualMachine: ConversionVM}), /exceeds 268435456 byte limit/);
});

test('missing adapters, malformed data and actual VM loader errors fail explicitly', async () => {
  const fixture = await sb2Fixture();
  await assert.rejects(convertLegacy({data: fixture.data, type: 'sb2'}), /explicit VirtualMachine adapter/);
  await assert.rejects(convertLegacy({data: fixture.data, type: 'sb3', VirtualMachine: ConversionVM}), /Unsupported legacy project type/);
  await assert.rejects(convertLegacy({data: new Uint8Array([1, 2]), type: 'sb2', VirtualMachine: ConversionVM}), /valid ZIP project.json/);
  await assert.rejects(convertLegacy({data: new Uint8Array([1, 2]), type: 'sb1', VirtualMachine: ConversionVM}), /real ScratchV01\/ScratchV02 header/);
  await assert.rejects(convertLegacy({data: fixture.data, type: 'sb2', VirtualMachine: RealVM}), /expose Storage or createStorage/);
  await assert.rejects(convertLegacy({data: new TextEncoder().encode('ScratchV02invalid'), type: 'sb1', VirtualMachine: ConversionVM}), /Legacy sb1 conversion failed/);
});
