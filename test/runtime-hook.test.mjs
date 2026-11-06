import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {RUNTIME_HOOK} from '../src/runtime-hook.mjs';

function harness() {
  const window = {};
  const callbacks = new Map();
  let id = 0;
  const context = {window, setInterval: fn => {callbacks.set(++id, fn); return id;},
    clearInterval: timer => callbacks.delete(timer), setTimeout: () => 0};
  vm.runInNewContext(RUNTIME_HOOK, context);
  return {window, poll: () => [...callbacks.values()].forEach(fn => fn())};
}

test('PROJECT_LOADED同步保存初态，禁止autoplay修改变量和广播', () => {
  const {window} = harness();
  const project = {targets: []};
  const runtime = new EventEmitter();
  runtime.targets = [];
  const original = {runtime, toJSON: () => JSON.stringify(project),
    start() {project.startCalled = true;}, greenFlag() {project.targets[0].variables.score[1] = 999;}};
  window.vm = original;
  assert.equal(window.__factoryState, 'vm-found');
  project.targets.push({isStage: true, variables: {score: ['分数', 1]}, broadcasts: {id: 'StartGame'}});
  runtime.targets = project.targets;
  runtime.emit('PROJECT_LOADED');
  original.start();
  original.greenFlag();
  assert.equal(window.__factoryState, 'ready');
  assert.equal(JSON.parse(window.__factorySnapshot).targets[0].variables.score[1], 1);
  assert.equal(project.targets[0].variables.score[1], 1);
  assert.equal(window.__factorySnapshotEvidence, 'PROJECT_LOADED-before-greenFlag');
  assert.ok(window.__factoryHookErrors.includes('autoplay-suppressed:greenFlag'));
});

test('fallback资产未settle不可ready；私有上下文无vm也不可ready', () => {
  const {window, poll} = harness();
  const runtime = {targets: [{isStage: true, sprite: {costumes: [{name: 'pending'}], sounds: []}}]};
  window.vm = {runtime, toJSON: () => '{}'};
  poll();
  assert.equal(window.__factoryState, 'vm-found');
  runtime.targets[0].sprite.costumes[0].skinId = 4;
  poll();
  assert.equal(window.__factoryState, 'ready');
  assert.equal(window.__factorySnapshotEvidence, 'settled-fallback-unverified');
  assert.equal(harness().window.__factoryState, 'waiting-for-vm');
});

test('序列化异常只记录错误，不能制造有效snapshot', () => {
  const {window} = harness();
  window.vm = {runtime: {targets: [{isStage: true}]}, toJSON: () => {throw new Error('serialization failed');}};
  assert.equal(window.__factorySnapshot, null);
  assert.ok(window.__factoryHookErrors.some(e => e.includes('serialization failed')));
});
