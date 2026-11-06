import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMinimalSb3, JSZip} from './helpers.mjs';
import {compiledFixture} from './compiled-fixtures.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';
import {mergeProjectJSON} from '../src/merge.mjs';
import {fidelityMarkdown} from '../src/fidelity.mjs';

const read = async bytes => JSON.parse(await (await JSZip.loadAsync(bytes)).file('project.json').async('text'));
const staticResult = fixture => ({type: 'sb3', format: 'o2-html-precompile', data: fixture.bytes, compiledProject: fixture.compiledProject, notes: []});

// These are explicitly schema/template unit tests, not real 02 obfuscation success claims.
test('普通产物原始JSON、积木ID、变量名及初值原样保留', async () => {
  const original = await makeMinimalSb3();
  const restored = await restoreSb3({staticResult: {type: 'sb3', format: 'zip-sb3', data: original.bytes}, format: 'zip-sb3'});
  const originalZip = await JSZip.loadAsync(original.bytes);
  const restoredZip = await JSZip.loadAsync(restored.data);
  assert.equal(await restoredZip.file('project.json').async('text'), await originalZip.file('project.json').async('text'));
  assert.equal(restored.report.status, 'preserved');
  assert.equal(restored.report.canClaimComplete, true);
  assert.equal(restored.report.confidence.code.score, 1);
  assert.equal(restored.report.confidencePolicy.calibratedProbability, false);
  assert.equal(restored.report.acceptance.behaviorEquivalenceVerified, false);
});

test('运行时值变更和角色串位不覆盖容器初态，广播大小写完整保留', async () => {
  const fixture = await compiledFixture();
  const source = structuredClone(fixture.project);
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(source));
  for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
  const sourceBytes = await zip.generateAsync({type: 'uint8array'});
  const runtime = structuredClone(source);
  runtime.targets[0].variables.varId1 = ['SCORE_CHANGED', 999];
  runtime.targets[0].broadcasts.bStart = 'STARTGAME';
  runtime.targets[1].variables.localScore = ['分数', 999];
  runtime.targets[1].x = 150;
  const merged = await mergeProjectJSON(JSON.stringify(runtime), sourceBytes);
  const got = await read(merged.data);
  assert.deepEqual(got, source);
  assert.ok(merged.report.runtime.differences.some(x => x.field === 'variables'));
  assert.ok(merged.report.runtime.differences.some(x => x.field === 'broadcasts'));
  assert.equal(merged.report.targets[0].broadcasts.find(b => b.id === 'bStart').name, 'StartGame');
  runtime.targets.reverse();
  const reordered = await mergeProjectJSON(JSON.stringify(runtime), sourceBytes);
  assert.deepEqual(await read(reordered.data), source);
  assert.ok(reordered.report.runtime.differences.some(x => x.field === 'identity'));
});

test('明文模板重构变量赋值与广播，按ID回填原始广播拼写，明确未验证', async () => {
  const fixture = await compiledFixture();
  const restored = await restoreSb3({staticResult: staticResult(fixture), format: 'o2-html-precompile'});
  assert.equal(restored.report.status, 'reconstructed-unverified');
  assert.equal(restored.report.canClaimComplete, false);
  assert.equal(restored.report.confidence.code.score, 0.85);
  assert.equal(restored.report.confidence.originalBlockStructure.score, 0);
  const [stage, sprite] = restored.project.targets;
  assert.deepEqual(stage.variables, fixture.stripped.targets[0].variables);
  assert.deepEqual(sprite.variables, fixture.stripped.targets[1].variables);
  assert.deepEqual(stage.broadcasts, fixture.stripped.targets[0].broadcasts);
  assert.deepEqual(sprite.blocks.r.fields.BROADCAST_OPTION, ['StartGame', 'bStart']);
  const operations = Object.values(sprite.blocks);
  assert.ok(operations.some(b => b.opcode === 'data_setvariableto' && b.fields.VARIABLE[1] === 'localScore'));
  assert.ok(operations.some(b => b.opcode === 'event_broadcastandwait' && b.inputs.BROADCAST_INPUT[1][2] === 'bChinese'));
  assert.equal(restored.report.code.counts.templateReconstructedScripts, 2);
  assert.ok(Object.values(sprite.comments).some(c => c.text.includes('尚未重编译验证')));
  assert.ok(fidelityMarkdown(restored.report).includes('不是统计正确率'));
});

test('eval混淆输入不执行，只恢复确定的帽子，脚本体置信度0', async () => {
  delete globalThis.__factory_should_not_execute;
  const fixture = await compiledFixture({obfuscated: true});
  const restored = await restoreSb3({staticResult: staticResult(fixture)});
  assert.equal(globalThis.__factory_should_not_execute, undefined);
  assert.equal(restored.report.status, 'partial');
  assert.equal(restored.report.confidence.code.score, 0);
  assert.equal(restored.report.code.counts.unresolvedScripts, 2);
  assert.equal(Object.keys(restored.project.targets[0].blocks).length, 1);
  assert.equal(Object.keys(restored.project.targets[1].blocks).length, 1);
  assert.deepEqual(restored.project.targets[1].blocks.r.fields.BROADCAST_OPTION, ['StartGame', 'bStart']);
  assert.ok(Object.values(restored.project.targets[1].comments).some(c => c.text.includes('脚本体未还原')));
  assert.ok(restored.compiledProject.includes('__factory_should_not_execute'));
});

test('大小写重名广播且metadata缺ID时，不猜测广播引用', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[1].hats[0].fieldsOfInputs.BROADCAST_OPTION = {value: 'READY'};
  const result = recoverCompiledCode(structuredClone(fixture.stripped), fixture.bundle);
  assert.ok(result.unresolved.some(x => /不唯一/.test(x.reason)));
  const script = result.scripts.find(s => s.scriptId === 'r');
  assert.equal(script.status, 'unresolved');
  assert.equal(script.hat, undefined);
});

test('单脚本未知语句不能跳过后冒充完整代码，已知前缀也不部分执行式拼接', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = fixture.bundle.compiledTargets[0].scripts.a.factorySource.replace('retire(); return;', 'target.unknownOperation(); retire(); return;');
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.scripts[0].status, 'unresolved');
  assert.equal(Object.keys(project.targets[0].blocks).length, 1);
  assert.ok(result.unresolved.some(x => /尚未支持/.test(x.reason)));
});

test('未实现自定义过程必须单独列出，不能因其他脚本成功抬高完整度', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].procedures['Z做事情 %s'] = {factorySource: '(function(){})'};
  const restored = await restoreSb3({staticResult: {...staticResult(fixture), compiledProject: JSON.stringify(fixture.bundle)}});
  assert.equal(restored.report.status, 'partial');
  assert.equal(restored.report.code.counts.unresolvedProcedures, 1);
  assert.equal(restored.report.confidence.code.score, 0);
  const entry = restored.report.code.unresolved.find(item => item.kind === 'procedure');
  assert.ok(entry);
  assert.equal(entry.status, 'unresolved');
  assert.equal(typeof entry.annotationId, 'string');
  assert.match(entry.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.sourceSha256, entry.analyzedSourceSha256);
  assert.match(entry.originalSourceSha256, /^[0-9a-f]{64}$/);
  const comment = restored.project.targets[entry.targetIndex].comments[entry.annotationId];
  assert.ok(comment);
  assert.equal(comment.blockId, null);
  assert.match(comment.text, new RegExp(entry.originalSourceSha256));
  assert.match(comment.text, new RegExp(entry.analyzedSourceSha256));
});

test('每条未恢复记录都能回指SB3不确定性注释和源码哈希', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource =
    fixture.bundle.compiledTargets[0].scripts.a.factorySource.replace(
      'a0.value = "准备";',
      'target.unknownOperation(); a0.value = "准备";'
    );
  const restored = await restoreSb3({
    staticResult: {...staticResult(fixture), compiledProject: JSON.stringify(fixture.bundle)},
    format: 'o2-html-precompile'
  });
  const unresolved = restored.report.code.unresolved.filter(entry => entry.kind === 'script');
  assert.equal(unresolved.length, 1);
  const [entry] = unresolved;
  assert.equal(entry.status, 'unresolved');
  assert.equal(typeof entry.annotationId, 'string');
  assert.equal(entry.sourceSha256, entry.analyzedSourceSha256);
  assert.match(entry.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(entry.originalSourceSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(entry.originalSourceSha256, entry.analyzedSourceSha256);
  const comment = restored.project.targets[entry.targetIndex].comments[entry.annotationId];
  assert.ok(comment);
  assert.equal(comment.blockId, entry.scriptId);
  assert.match(comment.text, new RegExp(entry.originalSourceSha256));
  assert.match(comment.text, new RegExp(entry.analyzedSourceSha256));
  assert.match(restored.report.code.unresolvedSchema, /annotationId/);
});

test('角色身份冲突拒绝按name模糊合并，局部变量不会串角色', async () => {
  const fixture = await compiledFixture();
  fixture.bundle.compiledTargets[1].name = 'AnotherSprite';
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(Object.keys(project.targets[1].blocks).length, 0);
  assert.ok(result.unresolved.some(x => /拒绝串角色/.test(x.reason)));
});

test('缺失或无效compiled包显式invalid；纯运行时结果不声称原始初态完整', async () => {
  const fixture = await compiledFixture();
  const missing = await restoreSb3({staticResult: {...staticResult(fixture), compiledProject: undefined}});
  assert.equal(missing.report.status, 'invalid');
  assert.equal(missing.report.canClaimComplete, false);
  const invalid = await restoreSb3({staticResult: {...staticResult(fixture), compiledProject: '{bad'}});
  assert.equal(invalid.report.status, 'invalid');
  const runtimeOnly = await restoreSb3({dynamicResult: {data: fixture.bytes, projectJSON: JSON.stringify(fixture.stripped)}});
  assert.equal(runtimeOnly.report.status, 'partial');
  assert.equal(runtimeOnly.report.canClaimComplete, false);
});
