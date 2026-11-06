import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {validateSb3} from './sb3-validate.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function readSb3Project(data) {
  const zip = await JSZip.loadAsync(data, {checkCRC32: true});
  const projectFile = zip.file('project.json');
  if (!projectFile) throw new Error('候选 SB3 缺少根目录 project.json');
  const project = JSON.parse(await projectFile.async('text'));
  if (!Array.isArray(project.targets)) throw new Error('候选 project.json 缺少 targets');
  return project;
}

const runProcess = (command, args, {cwd, timeoutMs = 600000} = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {cwd, windowsHide: true});
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result);
  };
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => finish(error));
  child.on('close', (code, signal) => finish(null, {code, signal, stdout, stderr}));
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('朋友解包器超时（' + timeoutMs + 'ms）'));
  }, timeoutMs);
});

/** Run the peer tool only when explicitly requested. */
export async function runPeerUnpackager(inputPath, {
  peerRoot,
  outputPath,
  deobfuscator = 'none',
  allowPeerExecute = false,
  timeoutMs = 600000
} = {}) {
  if (!peerRoot) throw new Error('hybrid 需要 --peer-decompiler 或 --peer-output');
  const cliPath = path.resolve(peerRoot, 'bin', 'unpackager.js');
  await fs.access(cliPath);
  const output = outputPath ? path.resolve(outputPath) :
    await fs.mkdtemp(path.join(os.tmpdir(), 'factory-peer-'));
  await fs.mkdir(output, {recursive: true});
  const args = [cliPath, path.resolve(inputPath), '-o', output, '--verbose'];
  if (deobfuscator === 'none') args.push('--no-deobfuscate');
  else {
    if (!allowPeerExecute) throw new Error('朋友反混淆器可能执行输入代码；需要显式指定 --allow-peer-execute');
    args.push('--deobfuscator', deobfuscator);
  }
  const result = await runProcess(process.execPath, args, {cwd: peerRoot, timeoutMs});
  if (result.code !== 0) throw new Error('朋友解包器退出码 ' + result.code + ': ' + (result.stderr || result.stdout));
  const candidatePath = path.join(output, 'rebuilt.sb3');
  const candidateData = new Uint8Array(await fs.readFile(candidatePath));
  const project = await readSb3Project(candidateData);
  return {candidateData, project, outputPath: output, stdout: result.stdout, stderr: result.stderr};
}

export async function loadPeerOutput(peerOutputPath) {
  const absolute = path.resolve(peerOutputPath);
  const stat = await fs.stat(absolute);
  const candidatePath = stat.isDirectory() ? path.join(absolute, 'rebuilt.sb3') : absolute;
  const candidateData = new Uint8Array(await fs.readFile(candidatePath));
  const project = await readSb3Project(candidateData);
  return {candidateData, project, outputPath: path.dirname(candidatePath)};
}

const inputBlockRefs = input => {
  if (Array.isArray(input)) return input.length >= 2 && typeof input[1] === 'string' ? [input[1]] : [];
  if (!isObject(input)) return [];
  return ['block', 'shadow'].map(key => input[key]).filter(value => typeof value === 'string');
};

export function inspectCandidateGraph(blocks, rootId, expectedOpcode) {
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    const block = blocks[id];
    if (!isObject(block)) return {ok: false, reason: '悬空块引用：' + id};
    seen.add(id);
    if (typeof block.opcode !== 'string') return {ok: false, reason: '积木缺少 opcode：' + id};
    if (JSON.stringify(block).toLowerCase().includes('[unresolved block]') ||
        JSON.stringify(block).toLowerCase().includes('/* unresolved')) {
      return {ok: false, reason: '候选脚本包含 unresolved 占位'};
    }
    if (/^procedures_(?:call|definition|prototype)$/.test(block.opcode)) {
      return {ok: false, reason: '候选脚本依赖未单独验证的自定义过程'};
    }
    if (typeof block.next === 'string') queue.push(block.next);
    for (const input of Object.values(block.inputs || {})) {
      for (const ref of inputBlockRefs(input)) queue.push(ref);
    }
  }
  const root = blocks[rootId];
  if (root.opcode !== expectedOpcode) return {ok: false, reason: '帽子 opcode 不匹配：' + root.opcode + ' != ' + expectedOpcode};
  if (root.parent !== null || root.topLevel !== true) return {ok: false, reason: '候选脚本根块不是独立顶层帽子'};
  for (const id of seen) {
    const block = blocks[id];
    if (id !== rootId && typeof block.parent === 'string' && !seen.has(block.parent)) {
      return {ok: false, reason: 'parent 引用位于脚本图之外：' + block.parent};
    }
  }
  return {ok: true, ids: seen};
}

const targetFor = (targets, expected, index) => targets.find(target =>
  !!target.isStage === !!expected.isStage && target.name === expected.name) || targets[index] || null;

const definitionValue = (kind, value) => kind === 'broadcasts' ? value : value?.[0];
const findDefinition = (targets, kind, id, name) => {
  for (const target of targets) {
    if (id && Object.hasOwn(target?.[kind] || {}, id)) {
      return {id, name: definitionValue(kind, target[kind][id])};
    }
  }
  if (typeof name !== 'string' || !name) return null;
  const matches = targets.flatMap(target => Object.entries(target?.[kind] || {})
    .filter(([, value]) => String(definitionValue(kind, value)).toUpperCase() === name.toUpperCase())
    .map(([candidateId, value]) => ({id: candidateId, name: definitionValue(kind, value)})));
  return matches.length === 1 ? matches[0] : null;
};

const normalizeReferenceField = (field, kind, target, stage) => {
  const name = Array.isArray(field) ? field[0] : isObject(field) ? field.name : field;
  const id = Array.isArray(field) ? field[1] : isObject(field) ? field.id : null;
  const scopes = kind === 'broadcasts' ? [stage] : [target, stage];
  const definition = findDefinition(scopes, kind, id, name);
  if (!definition || typeof definition.name !== 'string') {
    return {ok: false, reason: '无法在原始工程定义中唯一匹配 ' + kind + ' 字段 ' + String(name)};
  }
  return {ok: true, value: [definition.name, definition.id]};
};

const remapInput = (input, idMap) => {
  if (Array.isArray(input)) {
    const result = input.slice();
    if (typeof result[1] === 'string' && idMap.has(result[1])) result[1] = idMap.get(result[1]);
    return result;
  }
  if (!isObject(input)) return input;
  const result = {...input};
  for (const key of ['block', 'shadow']) {
    if (typeof result[key] === 'string' && idMap.has(result[key])) result[key] = idMap.get(result[key]);
  }
  return result;
};

export function preparePeerGraph({peerTarget, baseTarget, sourceTargets, targetIndex, rootId, expectedOpcode}) {
  const blocks = peerTarget?.blocks || {};
  const inspected = inspectCandidateGraph(blocks, rootId, expectedOpcode);
  if (!inspected.ok) return inspected;
  const stage = sourceTargets.find(target => target.isStage) || sourceTargets[0];
  const used = new Set(Object.keys(baseTarget.blocks || {}));
  const idMap = new Map([[rootId, rootId]]);
  for (const oldId of inspected.ids) {
    if (oldId === rootId) continue;
    const prefix = 'hy_' + sha256(`${targetIndex}\0${rootId}\0${oldId}`).slice(0, 14);
    let newId = prefix;
    for (let suffix = 1; used.has(newId); suffix++) newId = `${prefix}_${suffix}`;
    used.add(newId);
    idMap.set(oldId, newId);
  }

  const prepared = {};
  for (const oldId of inspected.ids) {
    const source = clone(blocks[oldId]);
    const id = idMap.get(oldId);
    source.parent = oldId === rootId ? null : idMap.get(source.parent) || null;
    source.next = typeof source.next === 'string' ? idMap.get(source.next) || null : null;
    source.topLevel = oldId === rootId;
    source.inputs = Object.fromEntries(Object.entries(source.inputs || {}).map(([key, value]) =>
      [key, remapInput(value, idMap)]));
    for (const [fieldName, field] of Object.entries(source.fields || {})) {
      const kind = fieldName === 'VARIABLE' ? 'variables' : fieldName === 'LIST' ? 'lists' :
        fieldName === 'BROADCAST_OPTION' ? 'broadcasts' : null;
      if (!kind) continue;
      const normalized = normalizeReferenceField(field, kind, baseTarget, stage);
      if (!normalized.ok) return normalized;
      source.fields[fieldName] = normalized.value;
    }
    prepared[id] = source;
  }
  return {ok: true, blocks: prepared, ids: idMap, rootId};
}

const archiveWithProject = async (sourceData, project) => {
  const zip = await JSZip.loadAsync(sourceData, {checkCRC32: true});
  if (!zip.file('project.json')) throw new Error('原始归档缺少根 project.json');
  zip.file('project.json', JSON.stringify(project));
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
};

/** Create a one-script ordinary SB3 with authoritative source metadata and assets. */
export async function buildFocusedCandidate({baseData, sourceProject, peerProject, record, usedBlockIds = []}) {
  const targetIndex = record.targetIndex;
  const sourceTargets = sourceProject.targets;
  const baseTarget = sourceTargets[targetIndex];
  const peerTarget = targetFor(peerProject.targets, baseTarget, targetIndex);
  if (!baseTarget || !peerTarget) throw new Error('candidate target could not be mapped');
  const prepared = preparePeerGraph({peerTarget, baseTarget: {...baseTarget, blocks: Object.fromEntries(usedBlockIds.map(id => [id, true]))},
    sourceTargets, targetIndex, rootId: record.scriptId, expectedOpcode: record.opcode});
  if (!prepared.ok) return prepared;
  const project = clone(sourceProject);
  project.targets = project.targets.map(target => ({...target, blocks: {}, comments: {}}));
  project.targets[targetIndex].blocks = prepared.blocks;
  project.extensions = [];
  project.extensionURLs = {};
  project.monitors = [];
  delete project.customFonts;
  delete project.extensionStorage;
  const data = await archiveWithProject(baseData, project);
  const validation = await validateSb3(data);
  if (!validation.ok) return {ok: false, reason: '候选独立工程结构校验失败：' + validation.errors.slice(0, 8).join('; '), validation};
  return {ok: true, data, project, blocks: prepared.blocks, validation};
}

export async function mergeVerifiedGraph({baseData, project, targetIndex, graph}) {
  const merged = clone(project);
  const target = merged.targets[targetIndex];
  if (!target) throw new Error('合并目标不存在');
  target.blocks ||= {};
  for (const [id, block] of Object.entries(graph)) {
    if (Object.hasOwn(target.blocks, id)) throw new Error('确定性积木 ID 冲突：' + id);
    target.blocks[id] = clone(block);
  }
  const data = await archiveWithProject(baseData, merged);
  const validation = await validateSb3(data);
  if (!validation.ok) return {ok: false, reason: validation.errors.join('; '), validation};
  return {ok: true, data, project: merged, validation};
}

/** Collect high-recall peer scripts; acceptance still requires the real-VM focused verifier. */
export async function inspectPeerCandidate({baseProject, peerData, compiledProject}) {
  const peerProject = await readSb3Project(peerData);
  const peerValidation = await validateSb3(peerData);
  const stats = {
    peerTargets: peerProject.targets.length,
    peerBlocks: peerProject.targets.reduce((sum, target) => sum + Object.keys(target.blocks || {}).length, 0),
    knownScripts: 0, matchedPeerScripts: 0, duplicateOfFactoryScripts: 0,
    candidateOnlyScripts: 0, unavailableScripts: 0, rejectedScripts: 0, byStatus: {}
  };
  const records = [];
  const count = status => { stats.byStatus[status] = (stats.byStatus[status] || 0) + 1; };
  for (const [key, bundle] of Object.entries(compiledProject?.compiledTargets || {})) {
    const targetIndex = Number.isInteger(bundle?.targetIndex) ? bundle.targetIndex : Number(key);
    const target = baseProject.targets[targetIndex];
    if (!target) continue;
    const peerTarget = targetFor(peerProject.targets, target, targetIndex);
    for (const hat of bundle.hats || []) {
      if (!hat || typeof hat.topBlockId !== 'string' || typeof hat.opcode !== 'string') continue;
      stats.knownScripts++;
      const record = {targetIndex, targetName: target.name, scriptId: hat.topBlockId, opcode: hat.opcode};
      const root = peerTarget?.blocks?.[hat.topBlockId];
      if (target.blocks?.[hat.topBlockId]) {
        record.status = 'duplicate-of-factory-output';
        record.reason = 'factory 已有同 ID 帽子';
        stats.duplicateOfFactoryScripts++;
      } else if (!root) {
        record.status = 'unavailable';
        record.reason = '朋友输出中不存在 metadata 所指帽子';
        stats.unavailableScripts++;
      } else {
        const graph = inspectCandidateGraph(peerTarget.blocks, hat.topBlockId, hat.opcode);
        if (!graph.ok) {
          record.status = 'rejected-static-structure';
          record.reason = graph.reason;
          stats.rejectedScripts++;
        } else {
          record.status = 'candidate-only-unverified';
          record.reason = '等待隔离的真实 02 VM 单帽子差分验证';
          record.blockCount = graph.ids.size;
          stats.matchedPeerScripts++;
          stats.candidateOnlyScripts++;
        }
      }
      count(record.status);
      records.push(record);
    }
  }
  return {peerProject, peerValidation, stats, records};
}
