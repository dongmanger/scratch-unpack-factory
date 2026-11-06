import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyArtifact, VERIFY_LIMITS} from '../src/verify-artifact.mjs';
import {makeMinimalSb3, buildO2Html, JSZip} from './helpers.mjs';
import {compileReal02} from './real-02-compiler.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const zipProject = async (project, assets) => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(assets)) zip.file(name, bytes);
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
};
const packageBundle = (compiled, bundle = compiled.bundle) => buildO2Html(compiled.bytes,
  {precompile: true, compiledProject: JSON.stringify(bundle)});
const block = (opcode, next, parent, inputs = {}, fields = {}, topLevel = false) =>
  ({opcode, next, parent, inputs, fields, topLevel, shadow: false});
const focusedGraph = (blocks, rootId) => {
  const ids = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    if (ids.has(id)) continue;
    const item = blocks[id];
    assert.ok(item, `missing focused block ${id}`);
    ids.add(id);
    if (typeof item.next === 'string') queue.push(item.next);
    for (const input of Object.values(item.inputs || {})) {
      if (Array.isArray(input) && typeof input[1] === 'string') queue.push(input[1]);
      else if (input && typeof input === 'object') {
        for (const key of ['block', 'shadow']) if (typeof input[key] === 'string') queue.push(input[key]);
      }
    }
  }
  return Object.fromEntries([...ids].map(id => [id, structuredClone(blocks[id])]));
};
const focusedProjectBytes = async (fixture, project, targetIndex, scriptId) => {
  const focused = structuredClone(project);
  for (const target of focused.targets) { target.blocks = {}; target.comments = {}; }
  focused.targets[targetIndex].blocks = focusedGraph(project.targets[targetIndex].blocks, scriptId);
  focused.monitors = [];
  focused.extensions = [];
  focused.extensionURLs = {};
  return zipProject(focused, fixture.assets);
};

let fixturePromise;
const trustedFixture = () => fixturePromise ||= (async () => {
  const fixture = await makeMinimalSb3();
  const [stage, sprite] = fixture.project.targets;
  stage.lists.items = ['items', []];
  stage.broadcasts.messageId = 'ready';
  stage.blocks.b.next = 'send';
  stage.blocks.send = block('event_broadcastandwait', null, 'b',
    {BROADCAST_INPUT: [1, [11, 'ready', 'messageId']]});
  // Same variable name AND ID in two scopes: comparison must retain target scope.
  sprite.variables.varId1 = ['score', 'local-start'];
  sprite.blocks.receive = block('event_whenbroadcastreceived', 'append', null, {},
    {BROADCAST_OPTION: ['ready', 'messageId']}, true);
  sprite.blocks.append = block('data_addtolist', 'localSet', 'receive', {ITEM: [1, [10, 'received']]},
    {LIST: ['items', 'items']});
  sprite.blocks.localSet = block('data_setvariableto', null, 'append', {VALUE: [1, [10, 'local-done']]},
    {VARIABLE: ['score', 'varId1']});
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const recoveredProject = {targets: structuredClone(compiled.bundle.targets), extensions: [], monitors: []};
  const recovery = recoverCompiledCode(recoveredProject, compiled.bundle);
  assert.deepEqual(recovery.unresolved, [], 'Actual compiler source must be recoverable for this fixture');
  const recoveredData = await zipProject(recoveredProject, fixture.assets);
  return {...fixture, compiled, recoveredProject, recoveredData, originalData: packageBundle(compiled)};
})();

test('execution is refused before reading or evaluating source unless the flag is exactly true', async () => {
  const {compiled, recoveredData} = await trustedFixture();
  const hostile = structuredClone(compiled.bundle);
  hostile.compiledTargets[0].scripts.a.factorySource = '(function () { while (true) {} })()';
  for (const allowExecute of [undefined, false, 1, 'true']) {
    const report = await verifyArtifact({originalData: packageBundle(compiled, hostile), recoveredData, allowExecute});
    assert.equal(report.status, 'refused');
    assert.equal(report.error.code, 'EXECUTION_NOT_ALLOWED');
    assert.equal(report.execution.started, false);
    assert.equal(report.matched, false);
    assert.equal(report.originalSourceVerified, false);
  }
  const paths = await verifyArtifact({originalData: 'C:/arbitrary/file.html', recoveredData, allowExecute: true});
  assert.equal(paths.status, 'invalid');
  assert.equal(paths.execution.started, false);
  const oversized = new Uint8Array(VERIFY_LIMITS.inputBytes + 1);
  const excessive = await verifyArtifact({originalData: oversized, recoveredData, allowExecute: true});
  assert.equal(excessive.status, 'invalid');
  assert.match(excessive.error.message, /256 MiB/);
  const tooManySteps = await verifyArtifact({originalData: recoveredData, recoveredData,
    allowExecute: true, maxSteps: VERIFY_LIMITS.maxSteps + 1});
  assert.equal(tooManySteps.status, 'invalid');
  assert.match(tooManySteps.error.message, /1000000/);
  const tooLong = await verifyArtifact({originalData: recoveredData, recoveredData,
    allowExecute: true, timeoutMs: VERIFY_LIMITS.timeoutMs + 1});
  assert.equal(tooLong.status, 'invalid');
  assert.match(tooLong.error.message, /600000/);
  const tooMuchTotal = await verifyArtifact({originalData: new Uint8Array(VERIFY_LIMITS.inputBytes),
    recoveredData: new Uint8Array(VERIFY_LIMITS.inputBytes), allowExecute: true});
  assert.equal(tooMuchTotal.status, 'invalid');
  assert.match(tooMuchTotal.error.message, /total input limit/);
});

test('actual compiled original and recovered SB3 match with real VM, scoped state and broadcast/yield traces', async () => {
  const fixture = await trustedFixture();
  for (const originalData of [fixture.originalData, fixture.compiled.bytes]) {
    const report = await verifyArtifact({originalData, recoveredData: fixture.recoveredData, allowExecute: true});
    assert.equal(report.status, 'matched', JSON.stringify({error: report.error, behavior: report.behavior}));
    assert.equal(report.matched, true);
    assert.equal(report.behavior.scenarioOnly, true);
    assert.equal(report.originalSourceVerified, false);
    assert.equal(report.structural.original.ok, true);
    assert.equal(report.structural.recovered.ok, true);
    assert.equal(report.recompile.recovered.status, 'passed');
    assert.equal(report.recompile.original.status, originalData === fixture.originalData ? 'not-applicable' : 'not-run');
    assert.equal(report.engine.module, 'vendor/02-vm.cjs');
    assert.equal(report.engine.node, process.version);
    assert.match(report.engine.sha256, /^[a-f\d]{64}$/);
    assert.equal(report.hashes.originalInput, hash(originalData));
    assert.equal(report.hashes.recoveredInput, hash(fixture.recoveredData));
    assert.equal(report.execution.terminationRequested, true);
    assert.equal(report.execution.terminated, true);
    assert.equal(report.execution.terminationVerified, true);
    assert.ok(Number.isInteger(report.execution.terminationExitCode));
    assert.equal(report.execution.securitySandbox, false);
    assert.equal(report.adapters.storage, true);
    assert.equal(report.adapters.renderer, false);
    assert.equal(report.adapters.audio, false);
    for (const run of Object.values(report.runs)) {
      assert.equal(run.finished, true);
      assert.ok(run.steps > 0 && run.steps <= 1000);
      assert.ok(run.threads.every(thread => thread.statusName === 'done'));
      if (run === report.runs.recovered) assert.ok(run.threads.every(thread => thread.compiled));
      assert.ok(run.trace.some(event => event.type === 'broadcast' && event.name === 'ready'));
      assert.ok(run.trace.some(event => event.type === 'thread-status'));
      assert.ok(report.runs.original.trace.concat(report.runs.recovered.trace)
        .some(event => event.type === 'yield'));
      assert.deepEqual(run.broadcasts, [{name: 'ready', ids: ['messageId']}]);
      assert.equal(run.snapshot[0].variables.varId1.value, 'factory-ok');
      assert.equal(run.snapshot[1].variables.varId1.value, 'local-done');
      assert.deepEqual(run.snapshot[0].lists.items, {name: 'items', value: ['received'], isCloud: false});
      assert.equal(run.snapshot[0].broadcasts.messageId.name, 'ready');
      assert.equal(run.snapshot[1].properties.x, 10);
    }
    assert.deepEqual(report.runs.original.snapshot, report.runs.recovered.snapshot);
    assert.equal(typeof report.behavior.traceEqual, 'boolean');
    assert.match(report.behavior.traceComparison.originalSha256, /^[a-f\d]{64}$/);
    assert.match(report.behavior.traceComparison.recoveredSha256, /^[a-f\d]{64}$/);
    assert.ok(report.behavior.traceComparison.originalEvents > 0);
    assert.ok(report.behavior.traceComparison.recoveredEvents > 0);
    assert.deepEqual(report.behavior.differences, report.behavior.traceEqual ? [] : report.behavior.differences.filter(diff => diff.path.startsWith('$.trace')));
  }
});

test('focused verification runs one compiled hat and its recovered block graph in isolation', async () => {
  const fixture = await trustedFixture();
  const recoveredData = await focusedProjectBytes(fixture, fixture.recoveredProject, 0, 'a');
  const report = await verifyArtifact({originalData: fixture.compiled.bytes,
    originalCompiledProject: fixture.compiled.bundle, recoveredData,
    focusScript: {targetIndex: 0, scriptId: 'a', opcode: 'event_whenflagclicked'}, allowExecute: true});
  assert.equal(report.status, 'matched', JSON.stringify({error: report.error, behavior: report.behavior}));
  // The hash covers the bundle as supplied, not the focus-trimmed copy the worker executes.
  assert.equal(report.hashes.originalCompiledProject, hash(JSON.stringify(fixture.compiled.bundle)));
  assert.equal(report.scenario.manualTriggers, true);
  assert.equal(report.runs.original.focusThreadCount, 1);
  assert.equal(report.runs.recovered.focusThreadCount, 1);
  assert.equal(report.behavior.snapshotsEqual, true);
  assert.equal(report.behavior.broadcastsEqual, true);
});

test('focused verification rejects a changed peer-reconstructed script body', async () => {
  const fixture = await trustedFixture();
  const altered = structuredClone(fixture.recoveredProject);
  const assignment = Object.values(altered.targets[0].blocks).find(item => item.opcode === 'data_setvariableto');
  assignment.inputs.VALUE = [1, [10, 'peer-different']];
  const recoveredData = await focusedProjectBytes(fixture, altered, 0, 'a');
  const report = await verifyArtifact({originalData: fixture.compiled.bytes,
    originalCompiledProject: fixture.compiled.bundle, recoveredData,
    focusScript: {targetIndex: 0, scriptId: 'a', opcode: 'event_whenflagclicked'}, allowExecute: true});
  assert.equal(report.status, 'mismatch');
  assert.equal(report.matched, false);
  assert.equal(report.behavior.snapshotsEqual, false);
  assert.ok(report.behavior.differences.some(diff => diff.path.includes('variables') && diff.original === 'factory-ok'));
});

test('altered recovered variable produces a scoped difference despite successful structure and recompilation', async () => {
  const fixture = await trustedFixture();
  const altered = structuredClone(fixture.recoveredProject);
  const assignment = Object.values(altered.targets[1].blocks).find(value => value.opcode === 'data_setvariableto');
  assignment.inputs.VALUE = [1, [10, 'different-local-value']];
  const report = await verifyArtifact({originalData: fixture.originalData,
    recoveredData: await zipProject(altered, fixture.assets), allowExecute: true});
  assert.equal(report.status, 'mismatch');
  assert.equal(report.matched, false);
  assert.equal(report.structural.recovered.ok, true);
  assert.equal(report.recompile.recovered.status, 'passed');
  assert.equal(report.runs.original.finished, true);
  assert.equal(report.runs.recovered.finished, true);
  assert.equal(report.behavior.snapshotsEqual, false);
  assert.ok(report.behavior.differences.some(diff => diff.path === '$.snapshot["1"]["variables"]["varId1"]["value"]' &&
    diff.original === 'local-done' && diff.recovered === 'different-local-value'));
});

test('matching unfinished forever loops reach the step bound without being verified', async () => {
  const fixture = await makeMinimalSb3();
  fixture.project.targets[0].blocks.a.next = 'forever';
  fixture.project.targets[0].blocks = {
    a: fixture.project.targets[0].blocks.a,
    forever: block('control_forever', null, 'a', {SUBSTACK: [2, null]})
  };
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const report = await verifyArtifact({originalData: packageBundle(compiled),
    recoveredData: compiled.bytes, allowExecute: true, maxSteps: 3});
  assert.equal(report.status, 'incomplete');
  assert.equal(report.matched, false);
  assert.equal(report.behavior.snapshotsEqual, true);
  for (const run of Object.values(report.runs)) {
    assert.equal(run.finished, false);
    assert.equal(run.steps, 3);
    assert.ok(run.remainingThreads.length > 0);
    assert.ok(run.trace.some(event => event.type === 'yield'));
  }
  assert.ok(report.behavior.blockers.some(item => item.kind === 'unfinished-run'));
});

test('hostile compiled source with a synchronous endless while is terminated and returns a clean timeout', async () => {
  const fixture = await trustedFixture();
  const hostile = structuredClone(fixture.compiled.bundle);
  // This is deliberately evaluated by loadCompiledProject, before greenFlag.
  hostile.compiledTargets[0].scripts.a.factorySource = '(function () { while (true) {} })()';
  let heartbeat = 0;
  const interval = setInterval(() => heartbeat++, 10);
  const start = Date.now();
  let report;
  try {
    report = await verifyArtifact({originalData: packageBundle(fixture.compiled, hostile),
      recoveredData: fixture.recoveredData, allowExecute: true, timeoutMs: 2000});
  } finally { clearInterval(interval); }
  assert.equal(report.status, 'timeout');
  assert.equal(report.error.code, 'TIMEOUT');
  assert.equal(report.matched, false);
  assert.equal(report.execution.terminated, true);
  assert.equal(report.execution.securitySandbox, false);
  assert.equal(report.recompile.recovered.status, 'passed', 'Timeout must occur after reaching the hostile original');
  assert.equal(report.runs.recovered.finished, true);
  assert.equal(report.scenario.originalKind, '02engine-compiled-project');
  assert.ok(heartbeat > 2, 'Parent event loop remains responsive');
  assert.ok(Date.now() - start < 8000);
  // Parent remains able to verify a subsequent trusted input.
  const next = await verifyArtifact({originalData: fixture.originalData, recoveredData: fixture.recoveredData, allowExecute: true});
  assert.equal(next.status, 'matched');
});

test('structural failure blocks execution and absent adapters/unknown code never establish behavioral proof', async () => {
  const fixture = await trustedFixture();
  const incompleteAssets = {...fixture.assets};
  delete incompleteAssets[fixture.project.targets[0].costumes[0].md5ext];
  const invalid = await verifyArtifact({originalData: fixture.originalData,
    recoveredData: await zipProject(fixture.recoveredProject, incompleteAssets), allowExecute: true});
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.structural.recovered.ok, false);
  assert.equal(invalid.recompile.recovered.status, 'not-run');
  assert.equal(invalid.runs.original, null);
  assert.equal(invalid.matched, false);

  const minimal = await makeMinimalSb3();
  minimal.project.targets[1].blocks.d = block('sound_stopallsounds', null, 'c');
  minimal.project.targets[1].blocks.manual = block('event_whenkeypressed', null, null, {}, {KEY_OPTION: ['space']}, true);
  const compiled = await compileReal02(minimal.project, minimal.assets);
  const absentAdapters = await verifyArtifact({originalData: packageBundle(compiled), recoveredData: compiled.bytes, allowExecute: true});
  assert.equal(absentAdapters.behavior.snapshotsEqual, true);
  assert.equal(absentAdapters.status, 'unsupported');
  assert.equal(absentAdapters.matched, false);
  assert.ok(absentAdapters.behavior.blockers.some(item => item.kind === 'adapter-dependent-opcode'));
  assert.ok(absentAdapters.scenario.unsupportedTriggers.some(item => item.opcode === 'event_whenkeypressed'));

  const opaque = structuredClone(fixture.compiled.bundle);
  opaque.compiledTargets[0].scripts.a.factorySource = opaque.compiledTargets[0].scripts.a.factorySource
    .replace('b0.value =', 'void 0; b0.value =');
  opaque.extensions = ['unrecognizedCustomExtension'];
  const unknown = await verifyArtifact({originalData: packageBundle(fixture.compiled, opaque),
    recoveredData: fixture.recoveredData, allowExecute: true});
  assert.equal(unknown.matched, false);
  assert.ok(unknown.behavior.blockers.some(item => item.kind === 'extension' || item.kind === 'run-error'));
  assert.ok(unknown.behavior.blockers.some(item => item.kind === 'unclassified-compiled-source'));
});
