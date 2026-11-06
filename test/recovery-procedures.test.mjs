import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {compileReal02, runReal02} from './real-02-compiler.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {collectProcedureSignatures, addProcedureDefinition} from '../src/recovery-procedures.mjs';

const source = '(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function procbody(p0){b0.value=p0;return "";};})';

test('过程体和调用重建，原参数元数据丢失必须明确标为合成', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].procedures['Z写入 %s'] = {factorySource: source};
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = '(function entry(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();return function body(){thread.procedures["Z写入 %s"]("准备");retire();return;};})';
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.procedures[0].status, 'reconstructed-unverified', result.procedures[0].reason);
  assert.equal(result.procedures[0].syntheticMetadata.argumentNames, true);
  assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
  const blocks = Object.values(project.targets[0].blocks);
  assert.ok(blocks.some(block => block.opcode === 'procedures_definition'));
  assert.ok(blocks.some(block => block.opcode === 'procedures_call'));
  assert.ok(blocks.some(block => block.opcode === 'argument_reporter_string_number'));
});

test('reporter过程返回与调用恢复后由真实VM编译验证', async () => {
  const fixture = await compiledFixture();
  const returnSource = source.replace('b0.value=p0;return "";', 'return p0;');
  fixture.bundle.compiledTargets[0].procedures['Z结果 %s'] = {factorySource: returnSource};
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = '(function entry(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function body(){b0.value=thread.procedures["Z结果 %s"]("返回结果");retire();return;};})';
  fixture.bundle.compiledTargets[1].scripts = {};
  fixture.bundle.compiledTargets[1].hats = [];
  const project = {...fixture.project, targets: structuredClone(fixture.stripped.targets)};
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.unresolved.length, 0, JSON.stringify(result.unresolved));
  assert.equal(result.procedures[0].status, 'reconstructed-unverified', result.procedures[0].reason);
  assert.ok(Object.values(project.targets[0].blocks).some(block => block.opcode === 'procedures_return'));
  const compiled = await compileReal02(project, fixture.assets);
  const state = await runReal02(project, fixture.assets, {bundle: compiled.bundle});
  assert.equal(state.targets[0].variables.varId1.value, '返回结果');
});

test('warp-only过程重构保留执行模式，但原warp声明仍标为未知', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].procedures['W写入 %s'] = {factorySource: source};
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.procedures[0].status, 'reconstructed-unverified', result.procedures[0].reason);
  assert.equal(result.procedures[0].syntheticMetadata.originalWarpDeclarationUnknown, true);
  assert.equal(result.procedures[0].syntheticMetadata.chosenWarp, true);
  assert.equal(Object.values(project.targets[0].blocks).find(block => block.opcode === 'procedures_prototype').mutation.warp, 'true');
});

test('合成过程工程经过真实02编译，恢复后过程再编译与执行一致', async () => {
  const fixture = await compiledFixture();
  const target = fixture.project.targets[0];
  const signatures = collectProcedureSignatures({procedures: {'Z写入 %s': {factorySource: source}}}, 0);
  const signature = signatures.get('写入 %s');
  const {definitionId} = addProcedureDefinition({target, targetIndex: 0, signature});
  target.blocks[definitionId].next = 'proc-set';
  target.blocks['proc-set'] = {opcode: 'data_setvariableto', parent: definitionId, next: null, fields: {VARIABLE: ['分数', 'varId1']},
    inputs: {VALUE: [2, 'proc-value']}, topLevel: false, shadow: false};
  target.blocks['proc-value'] = {opcode: 'argument_reporter_string_number', parent: 'proc-set', next: null, fields: {VALUE: ['参数1', null]}, inputs: {}, topLevel: false, shadow: false};
  target.blocks.a.next = 'call';
  delete target.blocks.b; delete target.blocks.c;
  target.blocks.call = {opcode: 'procedures_call', parent: 'a', next: null, fields: {}, inputs: {[signature.ids[0]]: [1, [10, '过程结果']]},
    mutation: {tagName: 'mutation', children: [], proccode: signature.code, argumentids: JSON.stringify(signature.ids), warp: 'false'}, topLevel: false, shadow: false};
  // Isolate this procedural test from the second sprite's broadcast listener.
  fixture.project.targets[1].blocks = {};
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const decoded = structuredClone(compiled.bundle);
  for (const item of Object.values(decoded.compiledTargets)) {
    for (const entry of [...Object.values(item.scripts), ...Object.values(item.procedures)]) entry.factorySource = deobfuscate(entry.factorySource).code;
  }
  const recovered = {...fixture.project, targets: structuredClone(decoded.targets)};
  const result = recoverCompiledCode(recovered, decoded);
  assert.ok(result.procedures.some(procedure => procedure.status === 'reconstructed-unverified'), JSON.stringify(result.procedures));
  assert.equal(result.scripts.find(script => script.scriptId === 'a').status, 'reconstructed-unverified', JSON.stringify(result.unresolved));
  assert.equal(result.unresolved.length, 0, JSON.stringify(result.unresolved));
  assert.ok(result.scripts.some(script => script.event?.kind === 'none'));
  assert.equal(Object.values(recovered.targets[0].blocks).filter(block => block.opcode === 'event_whenflagclicked').length, 1);
  const recompiled = await compileReal02(recovered, fixture.assets);
  const before = await runReal02(fixture.project, fixture.assets, {bundle: compiled.bundle});
  const after = await runReal02(recovered, fixture.assets, {bundle: recompiled.bundle});
  assert.deepEqual(after.targets, before.targets);
  assert.equal(after.targets[0].variables.varId1.value, '过程结果');
});

// The three shapes below come from an older 02 compiler that the sample artifacts were built with. Each one
// used to make the whole procedure unresolved, which then cascaded into every caller ("no unique non-warp
// definition"). They are all recoverable: the decoded graph compiles back to the same program.
const envelope = body => `(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function procbody(p0){${body}};})`;

test('signature extraction accepts obfuscated parameter names and the IIFE factory envelope', () => {
  // Strong obfuscation renames `p0` to `_0x…`. Only the arity matters, not the spelling.
  const obfuscated = '(function f(thread){const target=thread.target;return function g(_0x3e36b5){target.x=_0x3e36b5;return "";};})';
  const direct = collectProcedureSignatures({procedures: {'W写入 %n': {factorySource: obfuscated}}}, 0);
  assert.equal(direct.size, 1, 'obfuscated parameter name must not hide the signature');
  assert.deepEqual(direct.get('写入 %n').types, ['n']);

  // An older compiler wrapped the factory in an IIFE and returned the body through a local.
  const iife = '(() => { const t1 = function* g(_0x24b19e){return "";}; return t1; })()';
  const wrapped = collectProcedureSignatures({procedures: {'W读 %n': {factorySource: iife}}}, 0);
  assert.equal(wrapped.size, 1, 'IIFE envelope must not hide the signature');
  assert.equal(wrapped.get('读 %n').variants[0].yields, true);
});

test('a short-circuit guarded body decodes as if, not as operator_and', () => {
  // `A && (B ? C : D)` is how the older compiler wrote `if (A) { if/else (B) {...} else {...} }`.
  const fixtureSource = '(function entry(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function body(){compareEqual(b0.value,1) && (compareLessThan(b0.value,2) ? (b0.value = 3) : (b0.value = 4));retire();return;};})';
  return (async () => {
    const fixture = await compiledFixture();
    fixture.bundle.compiledTargets[0].scripts.a.factorySource = fixtureSource;
    const project = structuredClone(fixture.stripped);
    const result = recoverCompiledCode(project, fixture.bundle, {relaxed: true});
    assert.equal(result.scripts[0].status, 'reconstructed-unverified', result.scripts[0].reason);
    const opcodes = Object.values(project.targets[0].blocks).map(block => block.opcode);
    assert.ok(opcodes.includes('control_if'), 'the guard becomes the outer if');
    assert.ok(opcodes.includes('control_if_else'), 'the conditional expression becomes the inner if/else');
    assert.equal(opcodes.filter(opcode => opcode === 'operator_and').length, 0, 'a guarded body is not a boolean and');
  })();
});

test('a comma-expression return and a ternary return both decode as statements', async () => {
  const fixture = await compiledFixture();
  const noArgs = body => `(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function procbody(){${body}};})`;
  // `return a = [], b = [], ''` — a run of statements ending the procedure.
  fixture.bundle.compiledTargets[0].procedures['Z清空'] = {factorySource: noArgs('b0.value = 1; return b0.value = 2, "";')};
  // `return cond ? (a, '') : (b, '')` — an if/else whose arms both end the procedure.
  fixture.bundle.compiledTargets[0].procedures['Z二选一 %b'] = {factorySource: envelope('return p0 ? (b0.value = 5, "") : (b0.value = 6, "");')};  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle, {relaxed: true});
  for (const variant of ['Z清空', 'Z二选一 %b']) {
    const record = result.procedures.find(item => item.variant === variant);
    assert.equal(record?.status, 'reconstructed-unverified', `${variant}: ${record?.reason}`);
  }
  const opcodes = Object.values(project.targets[0].blocks).map(block => block.opcode);
  assert.ok(opcodes.includes('control_if_else'), 'the ternary return becomes if/else');
});
