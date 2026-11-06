import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {compiledFixture} from './compiled-fixtures.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const factory = body => `(function factory(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function* body(){${body}retire();return;};})`;
const restoreFixture = async (fixture, options = {}) => restoreSb3({staticResult: {
  type: 'sb3', format: 'o2-html-precompile', data: fixture.bytes,
  compiledProject: JSON.stringify(fixture.bundle)
}, recoveryMode: 'strict', ...options});
const graphs = project => project.targets.map(target => target.blocks);

async function booleanFixture() {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = factory('if(toBoolean(compareEqual(b0.value,1))){b0.value=2;}');
  return fixture;
}

test('beautification follows complete recovery and structural validation; Boolean proof preserves graph validity', async () => {
  const fixture = await booleanFixture();
  const plain = await restoreFixture(fixture, {beautify: false});
  const pretty = await restoreFixture(fixture);
  assert.equal(pretty.validation.ok, true);
  assert.equal(pretty.report.code.unresolved.length, 0);
  assert.equal(pretty.report.code.beautify.requested, true);
  assert.equal(pretty.report.code.beautify.applied, true);
  assert.equal(pretty.report.code.beautify.structurallyValidated, true);
  assert.equal(pretty.report.code.beautify.doubleNotCollapsed, 1);
  assert.equal(pretty.report.code.beautify.layout.estimated, true);
  assert.equal(pretty.report.code.beautify.layout.measured, false);
  assert.equal(pretty.report.code.beautify.layout.rootsPlaced, 2);
  assert.equal(plain.report.code.beautify.applied, false);
  const notCount = project => project.targets.flatMap(target => Object.values(target.blocks)).filter(block => block.opcode === 'operator_not').length;
  assert.equal(notCount(plain.project) - notCount(pretty.project), 2);
  assert.deepEqual(pretty.project.targets.map(({costumes, sounds, x, y}) => ({costumes, sounds, x, y})),
    plain.project.targets.map(({costumes, sounds, x, y}) => ({costumes, sounds, x, y})));
});

test('one unresolved script disables all rewriting and layout changes across the project', async () => {
  const fixture = await booleanFixture();
  fixture.bundle.compiledTargets[1].scripts.r.factorySource = factory('unknownRuntimeOperation();');
  const plain = await restoreFixture(fixture, {beautify: false});
  const pretty = await restoreFixture(fixture);
  assert.equal(pretty.report.status, 'partial');
  assert.equal(pretty.report.code.beautify.applied, false);
  assert.equal(pretty.report.code.beautify.reason, 'incomplete-or-ambiguous-code');
  assert.equal(pretty.report.code.beautify.enabled, false);
  assert.deepEqual(graphs(pretty.project), graphs(plain.project));
  assert.ok(pretty.report.code.unresolved.some(record => record.scriptId === 'r'));
});

test('missing media prevents the display pass even when every script matches', async () => {
  const fixture = await booleanFixture();
  const zip = await JSZip.loadAsync(fixture.bytes);
  zip.remove(fixture.stripped.targets[1].costumes[0].md5ext);
  fixture.bytes = await zip.generateAsync({type: 'uint8array'});
  const plain = await restoreFixture(fixture, {beautify: false});
  const pretty = await restoreFixture(fixture);
  assert.equal(pretty.report.status, 'invalid');
  assert.equal(pretty.report.code.unresolved.length, 0);
  assert.equal(pretty.report.code.beautify.applied, false);
  assert.equal(pretty.report.code.beautify.reason, 'structural-validation-failed');
  assert.deepEqual(graphs(pretty.project), graphs(plain.project));
});

test('direct decoder use does not apply unvalidated beautification', async () => {
  const fixture = await booleanFixture();
  const project = structuredClone(fixture.stripped);
  const recovery = recoverCompiledCode(project, fixture.bundle, {beautify: true});
  assert.equal(recovery.unresolved.length, 0);
  assert.ok(recovery.scripts.every(record => !record.beautify));
  assert.equal(Object.values(project.targets[0].blocks).filter(block => block.opcode === 'operator_not').length, 2);
});

// The report used to claim a structural rewrite it had not performed: `enabled` was derived from the
// per-record counts (which also carry coercion-unwrap statistics), so it stayed true under
// `--no-beautify` and on the oracle path, and the JSON said `enabled: true, applied: false` at once.
test('the report never claims a structural rewrite that did not happen', async () => {
  const fixture = await booleanFixture();
  // Strict recovery really does collapse the pair, so there `enabled` must be true. The two cases below
  // are the ones that used to lie; in both, no rewrite happens and every count must say so.
  for (const [label, options] of [
    ['disabled by the user', {beautify: false}],
    ['oracle recovery', {recoveryMode: 'oracle'}]
  ]) {
    const restored = await restoreFixture(fixture, options);
    const gate = restored.report.code.beautify;
    assert.equal(gate.enabled, false, `${label}: enabled must mean "a rewrite happened"`);
    assert.equal(gate.applied, false, label);
    assert.equal(gate.scriptsTouched, 0, label);
    assert.equal(gate.doubleNotCollapsed, 0, label);
  }
  const strict = await restoreFixture(fixture, {recoveryMode: 'strict'});
  assert.equal(strict.report.code.beautify.enabled, true, 'strict recovery does rewrite, so this must stay true');
  assert.equal(strict.report.code.beautify.doubleNotCollapsed, 1);
});

test('--no-beautify leaves the editor layout alone as well', async () => {
  const fixture = await booleanFixture();
  const plain = await restoreFixture(fixture, {beautify: false});
  const pretty = await restoreFixture(fixture);
  assert.equal(plain.report.code.beautify.layoutApplied, false);
  assert.equal(pretty.report.code.beautify.layoutApplied, true);
  // Coordinates are the observable difference between the two layout passes.
  const positions = project => project.targets.flatMap(target =>
    Object.values(target.blocks).filter(block => block.topLevel).map(block => `${block.x},${block.y}`));
  assert.notDeepEqual(positions(plain.project), positions(pretty.project));
});

// The oracle keeps the compiler-verified graph, so the double-negation collapse cannot be applied there:
// it makes the blocks compile to different JavaScript than the shipped `toBoolean(...)` spelling. The
// report has to say "layout only", not "rewrite applied".
test('the oracle path keeps the verified graph and reports layout only', async () => {
  const fixture = await booleanFixture();
  const restored = await restoreFixture(fixture, {recoveryMode: 'oracle'});
  assert.equal(restored.report.code.beautify.applied, false);
  assert.equal(restored.report.code.beautify.layoutApplied, true);
  assert.match(restored.report.code.beautify.reason, /oracle-verified-graph-retained/);
  assert.equal(restored.report.code.beautify.doubleNotCollapsed, 0);
  // The `not (not x)` pair the compiler wrote is still there, because it is what the artifact contains.
  assert.equal(Object.values(restored.project.targets[0].blocks).filter(block => block.opcode === 'operator_not').length, 2);
});
