import {isMainThread, parentPort, workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import JSZip from '@turbowarp/jszip';
import {staticUnpack} from './static-unpack.mjs';
import {validateSb3} from './sb3-validate.mjs';
import {recoverCompiledCode} from './recover-code.mjs';
import {assertVendorBundleIntegrity} from './vendor-integrity.mjs';

const require = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const dict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_TRACE = 20000;
const adapters = {storage: false, renderer: false, audio: false, video: false, cloud: false,
  userInput: false, network: false};
const report = {
  status: 'error', hashes: {algorithm: 'sha256'}, engine: null, adapters,
  structural: {original: null, recovered: null, compiledTargets: null},
  recompile: {original: {status: 'not-run'}, recovered: {status: 'not-run'}},
  runs: {original: null, recovered: null},
  scenario: {trigger: workerData?.focusScript ? `startHats:${workerData.focusScript.opcode}` : 'greenFlag',
    focusedScript: workerData?.focusScript || null, scheduling: 'bounded runtime._step followed by setImmediate',
    maxStepsPerRun: workerData?.maxSteps, manualTriggers: !!workerData?.focusScript, headless: true, unsupportedTriggers: []},
  behavior: {status: 'not-run', matched: false, scenarioOnly: true, snapshotsEqual: null,
    broadcastsEqual: null, traceEqual: null, traceComparison: null, differences: [], blockers: []}, error: null
};
const send = type => parentPort.postMessage({type, report});
const blockMatch = (kind, side, detail) => {
  const item = {kind, side, detail};
  if (!report.behavior.blockers.some(existing => isDeepStrictEqual(existing, item))) report.behavior.blockers.push(item);
};

// Real archives from staticUnpack have already passed entry/output/CRC bounds.
// Keep the actual JSZip archive for VM asset loading, rather than a synthetic shim.
const readZip = async bytes => {
  const archive = await JSZip.loadAsync(bytes, {checkCRC32: true, recoverCorrupted: false});
  const file = archive.file('project.json');
  if (!file) throw new Error('Missing root project.json');
  return {archive, project: JSON.parse(await file.async('text'))};
};

function disableNetwork() {
  const denied = () => { throw new Error('Network access disabled during artifact verification (best effort)'); };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts']) {
    try { Object.defineProperty(globalThis, name, {value: denied, writable: false, configurable: false}); }
    catch { /* Best effort only; arbitrary factories retain Node capabilities. */ }
  }
  for (const [module, names] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:dgram', ['createSocket']]]) {
    const exports = require(module);
    for (const name of names) exports[name] = denied;
  }
}

const externalOpcode = opcode => /^(?:sound_|music_|pen_|videoSensing_|text2speech_|translate_|speech2text_|makeymakey_|microbit_|ev3_|wedo2_|boost_|gdxfor_)/.test(opcode) ||
  /^(?:looks_(?:say|think|switchcostume|nextcostume|switchbackdrop|nextbackdrop|changeeffectby|seteffectto|cleargraphiceffects|gotofrontback|goforwardbackwardlayers)|motion_(?:ifonedgebounce|goto$|glideto$|pointtowards)|sensing_(?:touching|coloristouchingcolor|distanceto|askandwait|answer|mouse|keypressed|loudness|username|userid|current|dayssince2000)|event_(?:whenthisspriteclicked|whenstageclicked|whenkeypressed|whengreaterthan|whenbackdropswitchesto)|data_(?:showvariable|hidevariable|showlist|hidelist))/.test(opcode);
const corePrefix = /^(?:motion|looks|sound|event|control|sensing|operator|data|procedures|argument)_/;

function inspectProject(project, side, primitiveOpcodes) {
  for (const id of project.extensions || []) blockMatch('extension', side, String(id));
  for (const [id, url] of Object.entries(project.extensionURLs || {})) blockMatch('custom-extension-url', side, {id, url});
  if (project.customFonts?.length) blockMatch('renderer-fonts', side, 'customFonts');
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [id, variable] of Object.entries(target.variables || {})) {
      if (variable[2] === true) blockMatch('cloud-variable', side, {targetIndex, id});
    }
    for (const comment of Object.values(target.comments || {})) {
      if (typeof comment?.text === 'string' && /^#code/m.test(comment.text)) blockMatch('arbitrary-js-comment', side, targetIndex);
    }
    for (const [blockId, block] of Object.entries(target.blocks || {})) {
      if (!dict(block)) continue;
      const opcode = block.opcode;
      if (externalOpcode(opcode) && !(workerData.focusScript && opcode === workerData.focusScript.opcode)) {
        blockMatch('adapter-dependent-opcode', side, opcode);
      }
      if (!corePrefix.test(opcode) || (!primitiveOpcodes.has(opcode) &&
        !/^argument_reporter_|^procedures_(?:definition|prototype|call)$/.test(opcode) &&
        !/(?:_menu|_of_menu|_costume|_backdrops)$/.test(opcode))) {
        blockMatch('unknown-opcode', side, opcode);
      }
      if (block.topLevel && !block.shadow && opcode !== 'procedures_definition' &&
        !['event_whenflagclicked', 'event_whenbroadcastreceived', 'control_start_as_clone'].includes(opcode)) {
        report.scenario.unsupportedTriggers.push({side, targetIndex, blockId, opcode,
          reason: 'Manual or external trigger is not exercised by this green-flag scenario'});
      }
    }
  }
}

function inspectBundle(bundle, side, primitiveOpcodes) {
  // Reuse the closed, static compiler-template decoder to discover adapter/unknown
  // operations hidden by stripped blocks. Unknown source is NOT considered proof.
  const project = {targets: structuredClone(bundle.targets), extensions: bundle.extensions,
    extensionURLs: bundle.extensionURLs, customFonts: bundle.customFonts};
  for (const target of project.targets) target.blocks = {};
  const decoded = recoverCompiledCode(project, bundle);
  for (const unresolved of decoded.unresolved) blockMatch('unclassified-compiled-source', side, unresolved);
  for (const procedure of decoded.procedures) {
    if (procedure.status === 'unresolved') blockMatch('unclassified-compiled-procedure', side, procedure.variant);
  }
  inspectProject(project, side, primitiveOpcodes);
  for (const [targetKey, target] of Object.entries(bundle.compiledTargets)) {
    for (const hat of target.hats || []) {
      if (!['event_whenflagclicked', 'event_whenbroadcastreceived', 'control_start_as_clone'].includes(hat.opcode)) {
        report.scenario.unsupportedTriggers.push({side, targetIndex: target.targetIndex ?? Number(targetKey),
          blockId: hat.topBlockId, opcode: hat.opcode,
          reason: 'Manual or external trigger is not exercised by this green-flag scenario'});
      }
    }
  }
}

function checkBundle(bundle) {
  if (!dict(bundle) || bundle.format !== '02engine-compiled-project' || bundle.version !== 1 ||
    !Array.isArray(bundle.targets) || !dict(bundle.compiledTargets)) throw new Error('Unsupported or incomplete 02Engine compiled bundle');
  for (const [key, target] of Object.entries(bundle.compiledTargets)) {
    const index = target?.targetIndex ?? Number(key);
    const source = bundle.targets[index];
    if (!Number.isInteger(index) || !source || target.name !== source.name || !!target.isStage !== !!source.isStage ||
      !dict(target.scripts) || !dict(target.procedures) || !Array.isArray(target.hats)) throw new Error('Compiled target identity or scripts/procedures/hats are invalid');
    for (const script of [...Object.values(target.scripts), ...Object.values(target.procedures)]) {
      if (typeof script?.factorySource !== 'string') throw new Error('Compiled factorySource must be a string');
    }
    for (const hat of target.hats) {
      if (typeof hat?.opcode !== 'string' || !Object.hasOwn(target.scripts, hat.topBlockId)) throw new Error('Compiled hat references an absent script');
    }
  }
}

function makeVM(VM, side) {
  const machine = new VM();
  const storage = new VM.Storage();
  const denied = () => { throw new Error('External asset or extension loading disabled during verification'); };
  // Assets are supplied from the checked archive. No default remote fallback.
  if (storage.scratchFetch) storage.scratchFetch.scratchFetch = denied;
  machine.attachStorage(storage);
  adapters.storage = true;
  storage.load = denied;
  machine.extensionManager.loadExtensionURL = denied;
  if (typeof machine.extensionManager.loadURL === 'function') machine.extensionManager.loadURL = denied;
  if (machine.extensionManager.securityManager) {
    machine.extensionManager.securityManager.canLoadExtensionFromProject = () => Promise.resolve(false);
  }
  machine.setCompilerOptions({enabled: true, warpTimer: false});
  machine.runtime.on('COMPILE_ERROR', (_target, error) => blockMatch('compile-error', side, String(error?.message || error)));
  return machine;
}

const snapshot = (runtime, sourceTargets) => runtime.targets.map((target, targetIndex) => {
  const definitions = {variables: Object.create(null), lists: Object.create(null), broadcasts: Object.create(null)};
  // The real VM's workspace update removes broadcasts after stripped blocks
  // are loaded. Preserve declared named IDs as evidence, explicitly distinguishing
  // them from live runtime variables; do not change the VM to keep them alive.
  const indexedSource = sourceTargets[targetIndex];
  const source = indexedSource?.name === target.getName() && !!indexedSource.isStage === !!target.isStage ? indexedSource :
    sourceTargets.find(item => item.name === target.getName() && !!item.isStage === !!target.isStage);
  for (const id of Object.keys(source?.broadcasts || {}).sort()) {
    const name = source.broadcasts[id];
    definitions.broadcasts[id] = {name, value: name, isCloud: false};
  }
  for (const id of Object.keys(target.variables).sort()) {
    const variable = target.variables[id];
    const kind = variable.type === 'list' ? 'lists' : variable.type === 'broadcast_msg' ? 'broadcasts' : 'variables';
    if (kind === 'broadcasts') continue;
    definitions[kind][id] = {name: variable.name, value: structuredClone(variable.value), isCloud: !!variable.isCloud};
  }
  return {scope: {targetIndex, name: target.getName(), isStage: !!target.isStage, isOriginal: !!target.isOriginal},
    properties: Object.fromEntries(['x', 'y', 'direction', 'size', 'visible', 'draggable', 'rotationStyle',
      'currentCostume', 'volume', 'tempo', 'videoState', 'videoTransparency', 'textToSpeechLanguage', 'effects']
      .filter(key => target[key] !== undefined).map(key => [key, structuredClone(target[key])])), ...definitions};
});
const statusNames = ['running', 'promise-wait', 'yield', 'yield-tick', 'done'];

async function execute(machine, maxSteps, sourceTargets, focusScript = null) {
  const runtime = machine.runtime;
  const trace = [], known = new Map(), broadcasts = [];
  let step = 0, traceTruncated = false;
  const record = event => { if (trace.length < MAX_TRACE) trace.push({step, ...event}); else traceTruncated = true; };
  const threadState = thread => ({thread: known.get(thread), targetIndex: runtime.targets.indexOf(thread.target),
    target: thread.target?.getName(), topBlock: thread.topBlock, compiled: !!thread.isCompiled,
    status: thread.status, statusName: statusNames[thread.status] || 'unknown', killed: !!thread.isKilled});
  const observe = thread => {
    if (thread.updateMonitor) return;
    if (!known.has(thread)) { known.set(thread, known.size); record({type: 'thread-start', ...threadState(thread)}); }
    const generator = thread.generator;
    if (generator && !generator.verifyObserved) {
      const next = generator.next;
      Object.defineProperty(generator, 'verifyObserved', {value: true});
      generator.next = function (...args) {
        const result = next.apply(this, args);
        if (!result.done && thread.status !== 4) record({type: 'yield', ...threadState(thread)});
        return result;
      };
    }
  };
  const pushThread = runtime._pushThread;
  runtime._pushThread = function (...args) { const thread = pushThread.apply(this, args); observe(thread); return thread; };
  const startHats = runtime.startHats;
  runtime.startHats = function (opcode, fields, ...args) {
    if (opcode === 'event_whenbroadcastreceived') {
      const name = fields?.BROADCAST_OPTION ?? null;
      const declared = sourceTargets.find(target => target.isStage)?.broadcasts || {};
      const ids = [...new Set([
        ...Object.entries(declared).filter(([, value]) => value === name).map(([id]) => id),
        ...Object.entries(runtime.getTargetForStage()?.variables || {})
          .filter(([, variable]) => variable.type === 'broadcast_msg' && variable.name === name).map(([id]) => id)
      ])].sort();
      const broadcast = {name, ids};
      if (broadcasts.length < MAX_TRACE) broadcasts.push(broadcast); else traceTruncated = true;
      record({type: 'broadcast', ...broadcast});
    }
    return startHats.call(this, opcode, fields, ...args);
  };
  const stepThread = runtime.sequencer.stepThread;
  runtime.sequencer.stepThread = function (thread) {
    observe(thread);
    const result = stepThread.call(this, thread);
    if (!thread.updateMonitor) record({type: 'thread-status', ...threadState(thread)});
    return result;
  };
  if (focusScript) {
    record({type: 'focused-hat', opcode: focusScript.opcode, scriptId: focusScript.scriptId});
    runtime.startHats(focusScript.opcode, focusScript.matchFields || {}, runtime.targets[focusScript.targetIndex]);
  } else {
    record({type: 'green-flag'});
    machine.greenFlag();
  }
  const initialThreads = runtime.threads.filter(thread => !thread.updateMonitor).length;
  // DONE threads still awaiting VM cleanup need a tick; monitor threads never
  // keep this scenario running or count as completion evidence.
  const remaining = () => runtime.threads.filter(thread => !thread.updateMonitor);
  while (step < maxSteps && remaining().length) {
    step++;
    runtime._step();
    await tick();
  }
  await tick();
  const threads = [...known.keys()].map(threadState);
  const finalSnapshot = snapshot(runtime, sourceTargets);
  const focusThreadCount = focusScript ? [...known.keys()].filter(thread =>
    thread.topBlock === focusScript.scriptId && runtime.targets.indexOf(thread.target) === focusScript.targetIndex).length : null;
  return {finished: remaining().length === 0, steps: step, initialThreads, focusThreadCount, remainingThreads: remaining().map(threadState),
    threads, trace, traceTruncated, broadcasts, snapshot: finalSnapshot,
    snapshotSha256: sha256(JSON.stringify(finalSnapshot)),
    runtimeBroadcastIds: runtime.targets.flatMap(target => Object.entries(target.variables)
      .filter(([, variable]) => variable.type === 'broadcast_msg').map(([id]) => id)).sort()};
}

function differences(original, recovered, path = '$', result = []) {
  if (isDeepStrictEqual(original, recovered) || result.length >= 100) return result;
  if (original !== null && recovered !== null && typeof original === 'object' && typeof recovered === 'object' &&
    Array.isArray(original) === Array.isArray(recovered)) {
    for (const key of new Set([...Object.keys(original), ...Object.keys(recovered)])) {
      if (!Object.hasOwn(original, key) || !Object.hasOwn(recovered, key)) {
        result.push({path: `${path}[${JSON.stringify(key)}]`, original: Object.hasOwn(original, key) ? original[key] : {missing: true},
          recovered: Object.hasOwn(recovered, key) ? recovered[key] : {missing: true}});
      } else differences(original[key], recovered[key], `${path}[${JSON.stringify(key)}]`, result);
      if (result.length >= 100) break;
    }
  } else result.push({path, original, recovered});
  return result;
}

async function main() {
  if (workerData?.allowExecute !== true) throw new Error('Worker requires allowExecute === true');
  for (const data of [workerData.originalData, workerData.recoveredData]) {
    if (!(data instanceof Uint8Array) || data.byteLength > 256 * 1024 * 1024) throw new Error('Worker accepts only input bytes up to 256 MiB');
  }
  report.hashes.originalInput = sha256(workerData.originalData);
  report.hashes.recoveredInput = sha256(workerData.recoveredData);
  const original = await staticUnpack(workerData.originalData);
  const recovered = await staticUnpack(workerData.recoveredData);
  if (original.type !== 'sb3' || recovered.type !== 'sb3' || recovered.metadata?.precompile) throw new Error('Original must contain SB3; recoveredData must be an ordinary SB3 archive');
  if (original.metadata?.precompile && !original.compiledProject) throw new Error('Original precompiled bundle was detected but could not be extracted');
  report.scenario.originalKind = workerData.originalCompiledProject || original.compiledProject ? '02engine-compiled-project' : 'sb3';
  report.scenario.originalFormat = original.format;
  report.hashes.originalSb3 = sha256(original.data);
  report.hashes.recoveredSb3 = sha256(recovered.data);
  report.structural.original = await validateSb3(original.data);
  // The output under test must itself be an ordinary, root-valid SB3 archive,
  // rather than an HTML/container normalized into one by staticUnpack.
  report.structural.recovered = await validateSb3(workerData.recoveredData);
  send('progress');
  if (!report.structural.original.ok || !report.structural.recovered.ok) {
    report.status = 'invalid'; report.behavior.status = 'not-run'; return;
  }
  const originalZip = await readZip(original.data);
  const recoveredZip = await readZip(recovered.data);
  const originalBundle = workerData.originalCompiledProject ||
    (original.compiledProject ? JSON.parse(original.compiledProject) : null);
  // Hash the bundle exactly as supplied, before the focus trimming below edits it in
  // place. An explicit override has no container text, so hash its canonical JSON.
  const originalBundleSha256 = !originalBundle ? null :
    sha256(workerData.originalCompiledProject ? JSON.stringify(workerData.originalCompiledProject) : original.compiledProject);
  let focusScript = workerData.focusScript || null;
  if (originalBundle) {
    if (focusScript) {
      const targetData = Object.values(originalBundle.compiledTargets || {}).find(entry =>
        (Number.isInteger(entry.targetIndex) ? entry.targetIndex : Number(entry.targetKey)) === focusScript.targetIndex);
      const hat = targetData?.hats?.find(entry => entry.topBlockId === focusScript.scriptId && entry.opcode === focusScript.opcode);
      const script = targetData?.scripts?.[focusScript.scriptId];
      if (!targetData || !hat || !script) throw new Error('Focused compiled script or hat metadata is missing');
      const matchFields = Object.fromEntries(Object.entries(hat.fieldsOfInputs || {}).map(([key, value]) =>
        [key, typeof value?.value === 'string' ? value.value : value?.value]));
      focusScript = {...focusScript, matchFields};
      for (const entry of Object.values(originalBundle.compiledTargets)) {
        const index = Number.isInteger(entry.targetIndex) ? entry.targetIndex : Number(entry.targetKey);
        if (index === focusScript.targetIndex) {
          entry.scripts = {[focusScript.scriptId]: script};
          entry.hats = [hat];
          entry.procedures = {};
        } else {
          entry.scripts = {};
          entry.hats = [];
          entry.procedures = {};
        }
      }
      originalBundle.extensions = [];
      originalBundle.extensionURLs = {};
      originalBundle.monitors = [];
      delete originalBundle.customFonts;
      for (const target of originalBundle.targets) {
        target.blocks = {};
        target.comments = {};
      }
    }
    checkBundle(originalBundle);
    // loadCompiledProject deserializes bundle.targets, so validate those exact
    // targets against the real assets too, not just the stripped project.json.
    const overlay = await JSZip.loadAsync(original.data);
    overlay.file('project.json', JSON.stringify({targets: originalBundle.targets, monitors: originalBundle.monitors || [],
      extensions: originalBundle.extensions || []}));
    report.structural.compiledTargets = await validateSb3(await overlay.generateAsync({type: 'uint8array'}));
    report.hashes.originalCompiledProject = originalBundleSha256;
    if (!report.structural.compiledTargets.ok) { report.status = 'invalid'; return; }
  }

  disableNetwork();
  // Verify the pinned bundle hash BEFORE require(): a tampered or truncated
  // CommonJS file executes arbitrary code at load time.
  const vmURL = new URL('../vendor/02-vm.cjs', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('../vendor/02-vm.provenance.json', import.meta.url), 'utf8'));
  const integrity = assertVendorBundleIntegrity(await readFile(vmURL), provenance, '02-vm.cjs');
  const VM = require('../vendor/02-vm.cjs');
  if (typeof VM !== 'function' || typeof VM.Storage !== 'function') throw new Error('Bundled real VM/Storage exports unavailable');
  report.engine = {module: 'vendor/02-vm.cjs', version: provenance.vm.version, revision: provenance.vm.revision,
    sha256: integrity.sha256, node: process.version, v8: process.versions.v8,
    compilerOptions: {enabled: true, warpTimer: false}};

  // Each side owns a fresh VM. Compile recovered source, reload its resulting
  // bundle and run it; then dispose before starting the original side.
  for (const side of ['recovered', 'original']) {
    const machine = makeVM(VM, side);
    try {
      const {project, archive} = side === 'original' ? originalZip : recoveredZip;
      const primitives = new Set([...Object.keys(machine.runtime._primitives), ...Object.keys(machine.runtime._hats)]);
      if (focusScript) {
        project.extensions = [];
        project.extensionURLs = {};
        delete project.customFonts;
        project.monitors = [];
        // Only the original side runs from its compiled bundle, so only its (already stripped) block
        // graphs are cleared. The recovered side IS the block graph under test; wiping it would make
        // the recompiled project empty and every focused verification vacuously fail.
        if (side === 'original') {
          for (const target of project.targets) {
            target.blocks = {};
            target.comments = {};
          }
        }
      }
      inspectProject(project, side, primitives);
      let sourceTargets = project.targets;
      if (side === 'original' && originalBundle) {
        report.recompile.original = {status: 'not-applicable', reason: 'Original compiled source bundle is loaded directly'};
        checkBundle(originalBundle);
        inspectBundle(originalBundle, side, primitives);
        sourceTargets = originalBundle.targets;
        send('progress');
        await machine.loadCompiledProject(originalBundle, archive);
      } else if (side === 'original') {
        report.recompile.original = {status: 'not-run', reason: 'Original ordinary SB3 is executed as source'};
        // Keep this side as ordinary VM source. This is the trusted original
        // baseline; it is intentionally not replaced by a generated bundle.
        machine.setCompilerOptions({enabled: false, warpTimer: false});
        await machine.loadProject(original.data);
      } else {
        report.recompile[side] = {status: 'compiling'}; send('progress');
        const bundle = await machine.compileProjectFromJSON(project, archive);
        report.recompile[side] = {status: 'passed', bundleSha256: sha256(JSON.stringify(bundle))};
        inspectBundle(bundle, side, primitives);
        sourceTargets = bundle.targets;
        send('progress');
        await machine.loadCompiledProject(bundle, archive);
      }
      report.runs[side] = await execute(machine, workerData.maxSteps, sourceTargets, focusScript);
      send('progress');
    } catch (error) {
      if (report.recompile[side].status === 'compiling') report.recompile[side] = {status: 'failed', error: String(error?.message || error)};
      report.runs[side] = {finished: false, error: String(error?.message || error)};
      blockMatch('run-error', side, String(error?.message || error));
      send('progress');
    } finally { machine.quit(); }
  }
  const before = report.runs.original, after = report.runs.recovered;
  const behavior = report.behavior;
  if (before.snapshot && after.snapshot) {
    behavior.snapshotsEqual = isDeepStrictEqual(before.snapshot, after.snapshot);
    behavior.broadcastsEqual = isDeepStrictEqual(before.broadcasts, after.broadcasts);
    const eventProjection = run => run.trace.map(event => {
      if (event.type === 'thread-start' || event.type === 'thread-status' || event.type === 'yield') {
        return {type: event.type, targetIndex: event.targetIndex, topBlock: event.topBlock,
          statusName: event.statusName, compiled: event.compiled};
      }
      if (event.type === 'broadcast') return {type: event.type, name: event.name, ids: event.ids};
      return {type: event.type};
    });
    const originalTrace = eventProjection(before);
    const recoveredTrace = eventProjection(after);
    behavior.traceEqual = isDeepStrictEqual(originalTrace, recoveredTrace);
    behavior.traceComparison = {algorithm: 'event projection exact sequence', originalEvents: originalTrace.length,
      recoveredEvents: recoveredTrace.length, originalSha256: sha256(JSON.stringify(originalTrace)),
      recoveredSha256: sha256(JSON.stringify(recoveredTrace))};
    differences(before.snapshot, after.snapshot, '$.snapshot', behavior.differences);
    differences(before.broadcasts, after.broadcasts, '$.broadcasts', behavior.differences);
    if (!behavior.traceEqual) differences(originalTrace, recoveredTrace, '$.trace', behavior.differences);
  }
  for (const side of ['original', 'recovered']) {
    const run = report.runs[side];
    if (!run.finished) blockMatch('unfinished-run', side, run.error || `Step limit ${workerData.maxSteps} reached`);
    if (focusScript && !run.focusThreadCount) blockMatch('focused-script-not-started', side, focusScript.scriptId);
    if (!focusScript && !run.initialThreads) blockMatch('no-green-flag-threads', side, 'No executable green-flag thread was observed');
    if (run.traceTruncated) blockMatch('trace-limit', side, `Trace exceeded ${MAX_TRACE} events`);
    if (side === 'recovered' && run.threads?.some(thread => !thread.compiled)) {
      blockMatch('uncompiled-thread', side, 'Recovered scenario did not execute as a compiled thread');
    }
  }
  behavior.matched = before.finished && after.finished && behavior.snapshotsEqual === true &&
    behavior.broadcastsEqual === true && (!focusScript || (before.focusThreadCount > 0 && after.focusThreadCount > 0)) &&
    behavior.blockers.length === 0;
  report.status = behavior.matched ? 'matched' : before.error || after.error ? 'error' :
    !before.finished || !after.finished ? 'incomplete' : behavior.blockers.length ? 'unsupported' : 'mismatch';
  behavior.status = report.status;
}

if (!isMainThread && parentPort) {
  try { await main(); }
  catch (error) {
    report.status = 'error'; report.behavior.status = 'error'; report.behavior.matched = false;
    report.error = {code: 'VERIFICATION_ERROR', message: String(error?.message || error)};
  }
  send('result');
}
