import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import JSZip from '@turbowarp/jszip';
import crc32 from '@turbowarp/jszip/lib/crc32.js';
import {validateSb3} from './sb3-validate.mjs';

const MAX_LEGACY_BYTES = 256 * 1024 * 1024;
const bytesOf = data => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('legacy conversion data must be an ArrayBuffer or Uint8Array');
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const md5 = data => createHash('md5').update(data).digest('hex');
const isScratch1 = data => data.length >= 10 &&
  (Buffer.from(data.subarray(0, 10)).equals(Buffer.from('ScratchV01')) ||
   Buffer.from(data.subarray(0, 10)).equals(Buffer.from('ScratchV02')));
const readZip = async data => {
  // Check declarations before any decompression, then enforce zlib's hard output bound.
  const archive = await JSZip.loadAsync(data, {checkCRC32: false, recoverCorrupted: false});
  const files = Object.values(archive.files);
  if (files.length > 10000) throw new Error('Legacy ZIP entry count exceeds limit');
  const result = new JSZip();
  let total = 0;
  for (const file of files) {
    const name = file.unsafeOriginalName || file.name;
    if (name !== file.name || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) ||
        name.split('/').some(part => part === '..' || part === '.')) throw new Error(`Unsafe legacy ZIP path: ${name}`);
    if (file.dir) continue;
    const compressed = file._data;
    const size = compressed?.uncompressedSize;
    const limit = file.name === 'project.json' ? 32 * 1024 * 1024 : 128 * 1024 * 1024;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('Legacy ZIP entry size exceeds limit');
    total += size;
    if (total > 512 * 1024 * 1024) throw new Error('Legacy ZIP expanded size exceeds limit');
    const method = compressed.compression?.magic;
    const bytes = method === '\x00\x00' ? new Uint8Array(compressed.compressedContent) : method === '\x08\x00' ?
      inflateRawSync(compressed.compressedContent, {maxOutputLength: Math.max(1, size)}) : null;
    if (!bytes || bytes.length !== size || (crc32(bytes) >>> 0) !== (compressed.crc32 >>> 0)) {
      throw new Error('Legacy ZIP decompression or CRC32 verification failed');
    }
    result.file(file.name, bytes);
  }
  return result;
};

const sourceState = project => {
  if (!project || typeof project !== 'object') return {projectName: null, targets: []};
  const targets = [];
  const walk = (object, isStage, targetIndex) => {
    if (!object || typeof object !== 'object' || typeof object.objName !== 'string') return;
    const variables = (object.variables || []).map(variable => [variable.name, variable.value]);
    const lists = (object.lists || []).map(list => [list.listName, list.contents]);
    const properties = {};
    const mappings = {scratchX: 'x', scratchY: 'y', direction: 'direction', visible: 'visible', isDraggable: 'draggable',
      currentCostumeIndex: 'currentCostume', tempoBPM: 'tempo'};
    for (const [legacy, current] of Object.entries(mappings)) {
      if (Object.hasOwn(object, legacy)) properties[current] = object[legacy];
    }
    if (Object.hasOwn(object, 'scale')) properties.size = object.scale * 100;
    targets.push({targetIndex, name: object.objName, isStage, variables, lists, properties,
      scripts: Array.isArray(object.scripts) ? object.scripts.length : 0,
      costumes: Array.isArray(object.costumes) ? object.costumes.map(costume => costume.costumeName) : [],
      sounds: Array.isArray(object.sounds) ? object.sounds.map(sound => sound.soundName) : []});
    for (const child of object.children || []) walk(child, false, targets.length);
  };
  walk(project, true, 0);
  return {projectName: project.objName, targets};
};

const makeStorage = VirtualMachine => {
  const Storage = VirtualMachine.Storage || VirtualMachine.ScratchStorage;
  if (typeof VirtualMachine.createStorage === 'function') return VirtualMachine.createStorage();
  if (typeof Storage === 'function') return new Storage();
  throw new Error('Legacy conversion requires the explicit VM adapter to expose Storage or createStorage()');
};

const md5ext = descriptor => descriptor?.md5ext || descriptor?.baseLayerMD5 || descriptor?.md5 || null;
const sourceAssetRecords = async (project, zip) => {
  const records = [];
  const visit = object => {
    if (!object || typeof object !== 'object' || typeof object.objName !== 'string') return;
    for (const [index, costume] of (object.costumes || []).entries()) {
      if (costume.textLayerMD5) throw new Error('SB2 costume text layers require bitmap rendering and cannot be merged by inert conversion');
      const name = md5ext(costume);
      const ext = name?.split('.').pop();
      const fileName = costume.baseLayerID === undefined ? name : `${costume.baseLayerID}.${ext}`;
      records.push({targetName: object.objName, kind: 'costume', index, name: costume.costumeName, declared: name, fileName});
    }
    for (const [index, sound] of (object.sounds || []).entries()) {
      const name = md5ext(sound);
      const ext = name?.split('.').pop();
      const fileName = sound.soundID === undefined ? name : `${sound.soundID}.${ext}`;
      records.push({targetName: object.objName, kind: 'sound', index, name: sound.soundName, declared: name, fileName});
    }
    for (const child of object.children || []) visit(child);
  };
  visit(project);
  for (const record of records) {
    const file = record.fileName && zip.file(record.fileName);
    if (!file) { record.available = false; continue; }
    const data = await file.async('uint8array');
    record.actualMd5 = md5(data);
    record.declaredMd5 = record.declared?.split('.')[0] || null;
    record.available = !!record.declaredMd5 && record.actualMd5 === record.declaredMd5;
  }
  return records;
};
const outputAssetRecords = async (project, zip) => {
  const records = [];
  for (const target of project.targets || []) {
    for (const [kind, assets] of [['costume', target.costumes], ['sound', target.sounds]]) {
      for (const [index, asset] of (assets || []).entries()) {
        const declared = asset.md5ext || (asset.assetId && asset.dataFormat ? `${asset.assetId}.${asset.dataFormat}` : null);
        const file = declared && zip.file(declared);
        const data = file ? await file.async('uint8array') : null;
        const actualMd5 = data ? md5(data) : null;
        const declaredMd5 = asset.assetId || declared?.split('.')[0] || null;
        records.push({targetName: target.name, kind, index, name: asset.name, declared, declaredMd5, actualMd5,
          available: !!data && actualMd5 === declaredMd5});
      }
    }
  }
  return records;
};

/**
 * Convert an authentic SB1/SB2 project through a supplied real VM adapter.
 * The adapter is a real VM constructor with static Storage/ScratchStorage or createStorage().
 * It must construct an unpackaged VM without a renderer or audio engine. No VM paths are guessed.
 * Original IDs/layout/names go through the VM importer; metadata only verifies its stated scope.
 * @param {{data: ArrayBuffer|Uint8Array, type?: 'sb'|'sb1'|'sb2', VirtualMachine: Function}} options
 * @returns {Promise<{bytes: Uint8Array, metadata: object}>}
 */
export async function convertLegacy({data, type, VirtualMachine}) {
  if (typeof VirtualMachine !== 'function') throw new Error('Legacy conversion requires an explicit VirtualMachine adapter');
  const input = bytesOf(data);
  if (!input.byteLength || input.byteLength > MAX_LEGACY_BYTES) throw new Error(`Legacy input is empty or exceeds ${MAX_LEGACY_BYTES} byte limit`);
  const detectedSb1 = isScratch1(input);
  const acceptedType = type || (detectedSb1 ? 'sb' : 'sb2');
  if (!['sb', 'sb1', 'sb2'].includes(acceptedType)) throw new Error(`Unsupported legacy project type: ${acceptedType}`);
  if (['sb', 'sb1'].includes(acceptedType) && !detectedSb1) throw new Error('SB1 conversion requires a real ScratchV01/ScratchV02 header');
  let sourceZip = null;
  let source = null;
  if (acceptedType === 'sb2') {
    try {
      sourceZip = await readZip(input);
      const projectFile = sourceZip.file('project.json');
      source = projectFile ? JSON.parse(await projectFile.async('text')) : null;
      if (!source || typeof source.objName !== 'string' || 'targets' in source) throw new Error('expected objName');
    } catch (cause) {
      throw new Error(`SB2 conversion requires a valid ZIP project.json with objName: ${cause.message}`, {cause});
    }
  }
  const sourceAssets = sourceZip && source ? await sourceAssetRecords(source, sourceZip) : [];
  const machine = new VirtualMachine();
  const suppressedStarts = [];
  let output;
  try {
    if (typeof machine.attachStorage !== 'function') throw new Error('VirtualMachine adapter does not expose attachStorage()');
    machine.attachStorage(makeStorage(VirtualMachine));
    if (typeof machine.loadProject !== 'function' || typeof machine.saveProjectSb3 !== 'function' || !machine.runtime) {
      throw new Error('VirtualMachine adapter must expose loadProject(), saveProjectSb3() and runtime');
    }
    if (machine.runtime.renderer || machine.runtime.audioEngine || machine.runtime.isPackaged) {
      throw new Error('Legacy conversion requires an unpackaged VM without renderer or audio engine');
    }
    // Suppress automatic starts at both VM and runtime levels, including PROJECT_LOADED listeners.
    for (const [owner, methods] of [[machine, ['start', 'greenFlag']], [machine.runtime, ['start', 'greenFlag']],
      [machine.runtime.frameLoop, ['start']]]) {
      for (const name of methods) {
        if (owner && typeof owner[name] === 'function') owner[name] = () => { suppressedStarts.push(name); };
      }
    }
    // A custom extension is JavaScript supplied by the project; loading it would execute it.
    if (machine.extensionManager) machine.extensionManager.loadExtensionURL = async () => {
      throw new Error('Custom extension JavaScript is disabled during legacy conversion');
    };
    if (typeof machine.runtime.startHats === 'function') machine.runtime.startHats = () => {
      suppressedStarts.push('startHats');
      return [];
    };
    for (const name of ['_step', '_pushThread']) {
      if (typeof machine.runtime[name] === 'function') machine.runtime[name] = () => {
        throw new Error('Runtime stepping/thread execution is disabled during legacy conversion');
      };
    }
    if (typeof machine.setCompilerOptions === 'function') machine.setCompilerOptions({enabled: false});
    await machine.loadProject(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    if (machine.runtime.threads?.length || machine.runtime.frameLoop?.running) {
      throw new Error('VM attempted project execution during legacy conversion');
    }
    output = bytesOf(await machine.saveProjectSb3('arraybuffer'));
  } catch (cause) {
    throw new Error(`Legacy ${acceptedType} conversion failed: ${cause?.message || String(cause)}`, {cause});
  } finally {
    if (typeof machine.quit === 'function') machine.quit();
  }

  if (!output.byteLength || output.byteLength > MAX_LEGACY_BYTES) throw new Error('Converted SB3 output is empty or exceeds size limit');
  const archive = await readZip(output);
  const validation = await validateSb3(output);
  if (!validation.ok) throw new Error(`VirtualMachine returned invalid SB3: ${validation.errors.join('; ')}`);
  const projectFile = archive.file('project.json');
  if (!projectFile) throw new Error('VirtualMachine returned SB3 without root project.json');
  const project = JSON.parse(await projectFile.async('text'));
  if (!Array.isArray(project.targets) || !project.targets.some(target => target.isStage === true)) {
    throw new Error('VirtualMachine returned invalid SB3 targets');
  }
  const originalState = sourceState(source);
  const convertedState = {projectName: project.meta?.projectName || project.targets[0]?.name,
    targets: project.targets.map(target => ({name: target.name, isStage: !!target.isStage,
      variables: Object.values(target.variables || {}).map(value => [value[0], value[1]]),
      lists: Object.values(target.lists || {}).map(value => [value[0], value[1]]),
      properties: Object.fromEntries(Object.keys(originalState.targets.find(candidate => candidate.name === target.name && candidate.isStage === !!target.isStage)?.properties || {})
        .map(key => [key, target[key]])),
      scripts: Object.values(target.blocks || {}).filter(block => block && typeof block === 'object' && block.topLevel && !block.shadow).length,
      costumes: (target.costumes || []).map(costume => costume.name), sounds: (target.sounds || []).map(sound => sound.name)}))};
  const outputAssets = await outputAssetRecords(project, archive);
  const assetsPreserved = !!source && sourceAssets.length === outputAssets.length &&
    sourceAssets.every(record => record.available && outputAssets.some(candidate =>
      candidate.targetName === record.targetName && candidate.kind === record.kind && candidate.index === record.index &&
      candidate.name === record.name && candidate.available && candidate.actualMd5 === record.actualMd5));
  const preservedState = !!source && originalState.targets.length === convertedState.targets.length &&
    originalState.targets.every((target, index) => {
      const converted = convertedState.targets[index];
      return target.name === converted.name && target.isStage === converted.isStage &&
        isDeepStrictEqual(target.variables, converted.variables) &&
        isDeepStrictEqual(target.lists, converted.lists) &&
        isDeepStrictEqual(target.properties, converted.properties) &&
        isDeepStrictEqual(target.costumes, converted.costumes) &&
        isDeepStrictEqual(target.sounds, converted.sounds);
    });
  return {bytes: output, metadata: {
    sourceType: acceptedType,
    conversion: 'actual-virtual-machine-loadProject-saveProjectSb3',
    sourceSha256: sha256(input), outputSha256: sha256(output),
    sourceState: {verified: preservedState, preserved: preservedState, scope: ['target-names', 'variable-names-and-values', 'list-names-and-contents', 'asset-names', 'explicit-target-properties'],
      original: originalState, converted: convertedState},
    transformed: {blockIds: true, layout: true, names: true},
    scriptsExecuted: false,
    runtimeStarted: false,
    suppressedStarts,
    validation,
    assets: {verified: assetsPreserved, scope: 'referenced-costumes-and-sounds-by-target-name-slot-and-MD5', source: sourceAssets, output: outputAssets},
    provenance: {api: ['VirtualMachine.loadProject', "VirtualMachine.saveProjectSb3('arraybuffer')"],
      dependencySource: 'explicit-caller-supplied-vm-and-storage', renderer: false, audioEngine: false},
    limitations: ['SB1 binary source state is not independently inspected',
      'Legacy block IDs are generated and workspace coordinates are transformed by the VM',
      'VM normalization can change stage, sprite and broadcast names; only checked state fields are reported as preserved',
      'Unknown legacy opcodes may be omitted by the VM; code completeness and behavior equivalence are not verified',
      'Renderer-dependent bitmap/text-layer conversion is not performed; custom extension JavaScript is rejected',
      'Pen-layer pixels and unreferenced archive files are outside asset preservation scope']
  }};
}
