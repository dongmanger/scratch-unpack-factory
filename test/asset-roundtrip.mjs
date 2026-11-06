// Test-only real media and static-container helpers. No downloaded artifact code is evaluated.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync, inflateSync} from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import JSZip from '@turbowarp/jszip';
import {installedVirtualMachine} from '../src/default-vm.mjs';
import {buildTwHtmlV4, buildTwBase64Html, buildO2Html} from './helpers.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const text = value => Buffer.from(value, 'utf8');
const concat = (...parts) => Buffer.concat(parts);
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
const pngChunk = (kind, data) => {
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const body = concat(text(kind), data);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return concat(size, body, crc);
};
// A genuine 8x6 RGBA PNG, with opaque, differently colored pixels (not a placeholder).
const patternedPNG = seed => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(6, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc(6 * (1 + 8 * 4));
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
    const offset = y * 33 + 1 + x * 4;
    pixels.set([(seed * 31 + x * 29) % 256, (seed * 17 + y * 43) % 256,
      ((x + y + seed) % 2) ? 220 : 40, 255], offset);
  }
  return concat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)));
};
const visibleSVG = seed => text(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72" viewBox="0 0 96 72"><rect width="96" height="72" fill="#${(0x224466 + seed * 0x070503).toString(16)}"/><circle cx="${24 + seed}" cy="31" r="17" fill="#ffe178"/><path d="M9 60L48 8L87 60Z" fill="none" stroke="#f06b46" stroke-width="5"/></svg>`);
// PCM16 mono, 8kHz, 160 samples, with a non-silent deterministic waveform.
const pcmWAV = seed => {
  const bytes = Buffer.alloc(44 + 160 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(320, 40);
  for (let i = 0; i < 160; i++) bytes.writeInt16LE(Math.round(Math.sin(i * (seed + 2) * Math.PI / 40) * 12000), 44 + i * 2);
  return bytes;
};

export async function makeArchive(project, assets) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(assets)) zip.file(name, bytes);
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
export async function makeFilesZip(files) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes, {createFolders: false});
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
const primitive = value => [1, [10, String(value)]];
const block = (opcode, parent, next, inputs = {}, fields = {}, topLevel = false) =>
  ({opcode, parent, next, inputs, fields, shadow: false, topLevel, ...(topLevel ? {x: 83, y: 127} : {})});
const addStack = (target, id, commands) => {
  target.blocks = {[id]: block('event_whenflagclicked', null, `${id}-0`, {}, {}, true)};
  commands.forEach(([opcode, inputs, fields], index) => {
    target.blocks[`${id}-${index}`] = block(opcode, index ? `${id}-${index - 1}` : id,
      index + 1 < commands.length ? `${id}-${index + 1}` : null, inputs, fields);
  });
};
export async function makeAssetFixture() {
  const assets = {};
  const costume = (name, bytes, dataFormat, index) => {
    const assetId = md5(bytes); const md5ext = `${assetId}.${dataFormat}`; assets[md5ext] = bytes;
    return {name, assetId, md5ext, dataFormat, bitmapResolution: dataFormat === 'png' ? 2 : 1,
      rotationCenterX: 7.5 + index * 3, rotationCenterY: 9.25 + index * 2};
  };
  const sound = (name, seed) => {
    const bytes = pcmWAV(seed); const assetId = md5(bytes); const md5ext = `${assetId}.wav`; assets[md5ext] = bytes;
    return {name, assetId, md5ext, dataFormat: 'wav', format: '', rate: 8000, sampleCount: 160};
  };
  const target = (name, index, isStage = false) => ({
    isStage, name, variables: {[`selected-${index}`]: ['selected', 'not run']}, lists: {}, broadcasts: {},
    blocks: {}, comments: {}, currentCostume: 2,
    costumes: [costume(index === 1 ? '2' : 'shared', visibleSVG(index * 3 + 1), 'svg', index),
      costume(index === 1 ? 'shared' : '2', patternedPNG(index * 3 + 2), 'png', index + 1),
      costume('shared', visibleSVG(index * 3 + 3), 'svg', index + 2)],
    sounds: [sound('tone', index * 3 + 1), sound('tone', index * 3 + 2), sound('2', index * 3 + 3)],
    volume: 73 - index * 11, layerOrder: index,
    ...(isStage ? {tempo: 93, videoTransparency: 37, videoState: 'off', textToSpeechLanguage: null} :
      {visible: index === 1, x: 31 * index, y: -27 * index, size: 75 + index, direction: 45 * index,
        draggable: true, rotationStyle: index === 1 ? 'left-right' : "don't rotate"})
  });
  const project = {targets: [target('Stage', 0, true), target('Alpha', 1), target('Beta', 2)],
    monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '2.1.46', agent: 'asset-roundtrip-trusted-fixture'}};
  for (const [index, target] of project.targets.entries()) {
    const selector = target.isStage ? 'BACKDROP' : 'COSTUME';
    addStack(target, `media-hat-${index}`, [
      [target.isStage ? 'looks_switchbackdropto' : 'looks_switchcostumeto', {[selector]: primitive('2')}],
      ['sound_play', {SOUND_MENU: primitive(index === 1 ? 'tone' : '2')}],
      ['data_setvariableto', {VALUE: primitive('media selected')}, {VARIABLE: ['selected', `selected-${index}`]}]
    ]);
  }
  return {project, assets, bytes: await makeArchive(project, assets)};
}

export function assertRealMediaFixture(fixture) {
  assert.equal(Object.keys(fixture.assets).length, 18, 'all media have distinct real IDs');
  for (const [name, bytes] of Object.entries(fixture.assets)) {
    assert.equal(md5(bytes), name.split('.')[0]);
    if (name.endsWith('.svg')) {
      assert.match(bytes.toString(), /<rect[^>]+fill="#[0-9a-f]+"/);
      assert.match(bytes.toString(), /<circle/);
    } else if (name.endsWith('.png')) {
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(bytes.readUInt32BE(16), 8); assert.equal(bytes.readUInt32BE(20), 6);
      const parts = []; let offset = 8;
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset); const body = bytes.subarray(offset + 4, offset + 8 + length);
        assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(body));
        if (body.subarray(0, 4).toString() === 'IDAT') parts.push(body.subarray(4));
        offset += length + 12;
      }
      const raw = inflateSync(concat(...parts));
      assert.equal(raw.length, 198);
      const colors = new Set();
      for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
        const i = y * 33 + 1 + x * 4; assert.equal(raw[i + 3], 255); colors.add(raw.subarray(i, i + 3).toString('hex'));
      }
      assert.ok(colors.size > 20, 'nontrivial opaque PNG');
    } else {
      assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length); assert.equal(bytes.readUInt16LE(20), 1);
      assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt32LE(24), 8000);
      assert.equal(bytes.readUInt16LE(34), 16); assert.equal(bytes.readUInt32LE(40), 320);
      assert.ok([...bytes.subarray(44)].some(value => value !== 0), 'WAV is not silent');
    }
  }
  for (const target of fixture.project.targets) {
    assert.equal(target.currentCostume, 2);
    assert.equal(target.costumes.filter(item => item.name === 'shared').length, 2);
    assert.equal(target.sounds[0].name, target.sounds[1].name);
    assert.notEqual(target.sounds[0].assetId, target.sounds[1].assetId);
  }
}

export const mediaMetadata = project => project.targets.map(target => Object.fromEntries(
  Object.entries(target).filter(([key]) => !['blocks', 'comments'].includes(key))));

// Resolve media menus/primitive inputs without depending on original block IDs,
// generated menu shadows, layout, or a particular ID allocator.
export function mediaCode(project) {
  return project.targets.map(target => {
    const inputValue = input => {
      const value = input?.[1];
      if (Array.isArray(value)) return {literal: String(value[1])};
      if (typeof value === 'string') {
        const nested = target.blocks[value];
        assert.ok(nested, `connected input ${value}`);
        if (nested.shadow) return {literal: String(Object.values(nested.fields)[0][0])};
        return {opcode: nested.opcode, fields: nested.fields, inputs: Object.fromEntries(Object.entries(nested.inputs).map(([key, child]) => [key, inputValue(child)]))};
      }
      return null;
    };
    return Object.values(target.blocks).filter(item => item.topLevel && !item.shadow).map(hat => {
      const instructions = []; const seen = new Set(); let current = hat;
      while (current) {
        assert.ok(!seen.has(current), 'acyclic script'); seen.add(current);
        if (['looks_switchcostumeto', 'looks_switchbackdropto', 'sound_play', 'data_setvariableto'].includes(current.opcode))
          instructions.push({opcode: current.opcode, fields: current.fields,
            inputs: Object.fromEntries(Object.entries(current.inputs).map(([key, value]) => [key, inputValue(value)]))});
        current = current.next ? target.blocks[current.next] : null;
      }
      return {hat: hat.opcode, instructions};
    });
  });
}
// Complete selection inventory also finds commands nested in branches/procedures.
// It is an inventory contract, not a universal execution-equivalence proof.
export function mediaSelectionInventory(project) {
  return project.targets.map(target => {
    const resolve = (value, seen = new Set()) => {
      if (Array.isArray(value)) return {literal: String(value[1])};
      if (typeof value !== 'string' || !target.blocks[value]) return null;
      assert.ok(!seen.has(value), 'acyclic media input');
      const nested = target.blocks[value]; const nextSeen = new Set([...seen, value]);
      if (nested.shadow && Object.keys(nested.fields).length === 1)
        return {literal: String(Object.values(nested.fields)[0][0])};
      return {opcode: nested.opcode, fields: nested.fields,
        inputs: Object.fromEntries(Object.entries(nested.inputs).sort().map(([key, input]) => [key, resolve(input[1], nextSeen)]))};
    };
    return Object.values(target.blocks).filter(block => ['looks_switchcostumeto', 'looks_switchbackdropto',
      'looks_switchbackdroptoandwait', 'looks_nextcostume', 'looks_nextbackdrop', 'sound_play', 'sound_playuntildone'].includes(block.opcode))
      .map(block => ({opcode: block.opcode,
        inputs: Object.fromEntries(Object.entries(block.inputs).sort().map(([key, input]) => [key, resolve(input[1])]))}))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  });
}
export async function assertArchiveAssets(data, project, assets) {
  const zip = await JSZip.loadAsync(data, {checkCRC32: true});
  const actual = JSON.parse(await zip.file('project.json').async('text'));
  assert.deepEqual(mediaMetadata(actual), mediaMetadata(project), 'target order, ownership and every non-code target property');
  const paths = Object.values(zip.files).filter(file => !file.dir && file.name !== 'project.json').map(file => file.name).sort();
  assert.deepEqual(paths, Object.keys(assets).sort(), 'no media lost, renamed, added, or reassigned');
  for (const [name, expected] of Object.entries(assets)) {
    const actualBytes = await zip.file(name).async('uint8array');
    assert.equal(sha256(actualBytes), sha256(expected), `SHA256 ${name}`);
    assert.deepEqual(Buffer.from(actualBytes), Buffer.from(expected), `bytes ${name}`);
  }
  return {zip, project: actual};
}

// This guard is test-only and never replaces a VM primitive, loader, or asset.
// Global and Node transports are blocked, including cross-fetch's http path.
export async function withoutNetwork(action) {
  const saved = []; const calls = [];
  for (const [object, key] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'],
    [https, 'get'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
    const original = object[key]; saved.push(() => { object[key] = original; });
    object[key] = (...args) => { calls.push(`${key}:${String(args[0])}`); throw new Error(`Asset test forbids network ${key}`); };
  }
  try { return await action(calls); }
  finally { saved.reverse().forEach(restore => restore()); assert.deepEqual(calls, [], 'no remote fetch/network attempt'); }
}
const VM = installedVirtualMachine();
export const bundledVMClass = () => VM;
const asArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
export async function loadBundledAssets(bytes, expectedProject, assets, {runTrusted = false} = {}) {
  // This acceptance corpus is extension-free. Never ask a VM loader to import
  // an untrusted custom extension merely to inspect archive media.
  assert.deepEqual(expectedProject.extensions || [], [], 'asset VM loader only accepts extension-free fixtures');
  assert.equal(Object.keys(expectedProject.extensionURLs || {}).length, 0, 'no artifact extension URLs');
  return withoutNetwork(async () => {
    const machine = new VM();
    try {
      machine.attachStorage(new VM.Storage());
      machine.setCompilerOptions({enabled: false});
      await machine.loadProject(asArrayBuffer(bytes));
      assert.equal(Boolean(machine.runtime.renderer), false);
      assert.equal(Boolean(machine.runtime.audioEngine), false);
      assert.equal(machine.runtime.threads.length, 0, 'load does not start scripts');
      const targets = machine.runtime.targets.filter(target => target.isOriginal);
      assert.deepEqual(targets.map(target => target.getName()), expectedProject.targets.map(target => target.name));
      for (const [index, target] of targets.entries()) {
        const expected = expectedProject.targets[index];
        for (const key of ['currentCostume', 'volume', ...(target.isStage ? [] : ['x', 'y', 'size', 'direction', 'visible', 'draggable', 'rotationStyle'])])
          assert.deepEqual(target[key], expected[key], `${target.getName()}.${key}`);
        for (const [kind, records] of [['costumes', target.getCostumes()], ['sounds', target.getSounds()]]) {
          assert.equal(records.length, expected[kind].length);
          // Upstream Sprite.addCostume intentionally uniquifies duplicate names
          // during VM import. Static archives still must preserve originals exactly.
          const usedCostumeNames = [];
          for (const [position, record] of records.entries()) {
            const source = expected[kind][position];
            assert.ok(!record.broken, `${target.getName()}.${kind}[${position}] is broken`);
            for (const [key, value] of Object.entries(source)) {
              let expectedValue = value;
              if (kind === 'costumes' && key === 'name') {
                if (usedCostumeNames.includes(value)) {
                  const base = value.replace(/\d+$/, ''); let suffix = 2;
                  while (usedCostumeNames.includes(`${base}${suffix}`)) suffix++;
                  expectedValue = `${base}${suffix}`;
                }
                usedCostumeNames.push(expectedValue);
              }
              assert.deepEqual(record[key === 'md5ext' ? 'md5' : key], expectedValue, `${target.getName()}.${kind}[${position}].${key}`);
            }
            assert.ok(record.asset, 'storage attached real asset');
            assert.equal(sha256(record.asset.data), sha256(assets[source.md5ext]), `loaded ${source.md5ext}`);
            assert.equal(md5(record.asset.data), source.assetId);
          }
        }
      }
      if (runTrusted) {
        // Only locally authored fixtures/reconstructions reach this branch. Never user artifacts.
        machine.greenFlag();
        for (let step = 0; step < 40 && machine.runtime.threads.length; step++) {
          machine.runtime._step(); await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(machine.runtime.threads.filter(thread => !thread.updateMonitor).length, 0);
      }
      return targets.map(target => ({name: target.getName(), currentCostume: target.currentCostume,
        selectedAssetId: target.getCostumes()[target.currentCostume].assetId,
        variables: Object.fromEntries(Object.entries(target.variables).map(([id, variable]) => [id, variable.value]))}));
    } finally { machine.quit(); }
  });
}
export async function compileBundledFixture(fixture) {
  return withoutNetwork(async () => {
    const machine = new VM();
    try {
      machine.attachStorage(new VM.Storage()); machine.setCompilerOptions({enabled: true, warpTimer: false});
      return await machine.compileProjectFromJSON(structuredClone(fixture.project), await JSZip.loadAsync(fixture.bytes));
    } finally { machine.quit(); }
  });
}

// Minimal structurally valid PE, no machine code, never launched. This is NOT
// an actual NW.js/Electron distribution and cannot establish runtime identity.
export function syntheticPE(overlay) {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(224, 148); bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt32LE(512, 212);
  bytes.writeUInt32LE(16, 244); bytes.writeUInt32LE(512, 392); bytes.writeUInt32LE(512, 396);
  return concat(bytes, overlay);
}
export function syntheticASAR(files) {
  const root = {files: {}}; const chunks = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/'); let directory = root.files;
    for (const part of parts.slice(0, -1)) { directory[part] ||= {files: {}}; directory = directory[part].files; }
    const bytes = typeof content === 'string' ? text(content) : content;
    directory[parts.at(-1)] = {size: bytes.length, offset: String(offset)}; chunks.push(bytes); offset += bytes.length;
  }
  const json = text(JSON.stringify(root)); const payloadSize = 4 + Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(12 + payloadSize);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(payloadSize + 4, 4); header.writeUInt32LE(payloadSize, 8);
  header.writeUInt32LE(json.length, 12); header.set(json, 16);
  return concat(header, ...chunks);
}
export async function syntheticMatrix(fixture, bundle) {
  const stripped = structuredClone(fixture.project);
  for (const target of stripped.targets) { target.blocks = {}; target.comments = {}; }
  const archive = await makeArchive(stripped, fixture.assets);
  const compiledProject = JSON.stringify(bundle);
  const o2ZipFiles = {'project.zip': archive, 'compiled-project.json': compiledProject};
  const o2Zip = await makeFilesZip(o2ZipFiles);
  const o2HTML = buildO2Html(archive, {precompile: true, compiledProject});
  return [
    {name: 'SB3 ZIP', bytes: fixture.bytes, compiled: false},
    {name: 'synthetic TW v4 HTML', bytes: buildTwHtmlV4(fixture.bytes), compiled: false},
    {name: 'synthetic TW base64 HTML', bytes: buildTwBase64Html(fixture.bytes), compiled: false},
    {name: 'synthetic TW application ZIP', bytes: await makeFilesZip({'app/project.zip': fixture.bytes, 'app/index.html': '<script src="script.js"></script>'}), compiled: false},
    {name: 'synthetic O2 preserved HTML', bytes: buildO2Html(fixture.bytes), compiled: false},
    {name: 'synthetic O2 compiled HTML / actual bundled compiler', bytes: o2HTML, compiled: true},
    {name: 'synthetic O2 compiled ZIP / actual bundled compiler', bytes: o2Zip, compiled: true},
    {name: 'synthetic PE appended TW ZIP (not desktop distribution)', bytes: syntheticPE(await makeFilesZip({'project.zip': fixture.bytes})), compiled: false, executable: true},
    {name: 'synthetic PE appended O2 ZIP (not desktop distribution)', bytes: syntheticPE(o2Zip), compiled: true, executable: true},
    {name: 'synthetic ASAR TW HTML (not desktop distribution)', bytes: syntheticASAR({'renderer/index.html': buildTwBase64Html(fixture.bytes)}), compiled: false, executable: true},
    {name: 'synthetic ASAR O2 compiled ZIP (not desktop distribution)', bytes: syntheticASAR(o2ZipFiles), compiled: true, executable: true},
    {name: 'synthetic ASAR O2 compiled HTML (not desktop distribution)', bytes: syntheticASAR({'renderer/index.html': o2HTML}), compiled: true, executable: true}
  ];
}
