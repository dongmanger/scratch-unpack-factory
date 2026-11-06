import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutRecoveredProject, RECOVERY_LAYOUT_LIMITS} from '../src/recovery-layout.mjs';
import {buildRecoveredStack} from '../src/recovered-blocks.mjs';
import {addProcedureDefinition} from '../src/recovery-procedures.mjs';

const block = (opcode, extra = {}) => ({opcode, next: null, parent: null, inputs: {}, fields: {}, topLevel: false, shadow: false, ...extra});
const target = name => ({name, isStage: name === 'Stage', blocks: {}, comments: {},
  variables: {id: ['exact variable', 12]}, lists: {}, broadcasts: {}, currentCostume: 1,
  costumes: [{name: 'owned costume', assetId: 'exact-asset-id'}], sounds: [{name: 'owned sound'}], x: 101, y: -90, size: 33});
const addStack = (owner, id, operations) => {
  owner.blocks[id] = block('event_whenflagclicked', {topLevel: true, x: -30, y: -40});
  buildRecoveredStack({target: owner, parentId: id, operations, idFor: key => `${id}/${key}`, recordBlock() {}});
};
const comment = (blockId, width = 360, height = 130) => ({blockId, x: -100, y: -200, width, height,
  minimized: false, text: 'exact confidence evidence; preserve all text'});
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const withoutEditorCoordinates = project => {
  const copy = structuredClone(project);
  for (const owner of copy.targets) {
    for (const b of Object.values(owner.blocks)) {
      if (Array.isArray(b)) { if (b.length === 5) {b[3] = 0; b[4] = 0;} }
      else {delete b.x; delete b.y;}
    }
    for (const c of Object.values(owner.comments)) {delete c.x; delete c.y;}
  }
  return copy;
};
const fixture = () => {
  const owner = target('Stage');
  for (let i = 0; i < 7; i++) {
    const longStack = Array.from({length: i === 0 ? 35 : 2}, () => ({opcode: 'looks_say', inputs: {MESSAGE: {literal: i === 0 ? 'long display message '.repeat(15) : 'message'}}}));
    const operation = {opcode: 'control_if_else', inputs: {CONDITION: {opcode: 'operator_equals', inputs: {
      OPERAND1: {opcode: 'operator_join', inputs: {STRING1: {literal: 'nested reporter '.repeat(12)}, STRING2: {variable: {name: 'exact variable', id: 'id'}}}},
      OPERAND2: {literal: 'comparison'}
    }}}, substacks: {SUBSTACK: longStack, SUBSTACK2: [{opcode: 'looks_switchcostumeto', inputs: {COSTUME: {literal: 'owned costume'}},
      shadowInputs: {COSTUME: {opcode: 'looks_costume', fields: {COSTUME: ['owned costume', null]}}}}]}};
    addStack(owner, `hat-${i}`, [operation]);
    owner.comments[`comment-${i}`] = comment(i === 0 ? 'hat-0/0/SUBSTACK/2' : `hat-${i}`, i === 1 ? 800 : 360, i === 2 ? 900 : 130);
  }
  owner.comments.another = comment('hat-0', 440, 300);
  const signature = {code: 'procedure %s', types: ['s'], names: ['arg'], ids: ['arg-id'], warp: false};
  const {definitionId} = addProcedureDefinition({target: owner, targetIndex: 0, signature});
  buildRecoveredStack({target: owner, parentId: definitionId, operations: [{opcode: 'looks_say', inputs: {MESSAGE: {literal: 'procedure'}}}],
    idFor: key => `proc/${key}`, recordBlock() {}});
  owner.comments.procedure = comment(definitionId);
  owner.comments.detached = comment(null, 500, 350);
  const sprite = target('Sprite');
  addStack(sprite, 'own-hat', [{opcode: 'motion_movesteps', inputs: {STEPS: {literal: 10}}}]);
  sprite.comments.own = comment('own-hat');
  return {targets: [owner, sprite], extensions: [], meta: {exact: 'metadata'}};
};

test('estimated shelf bounds include nested stacks, reporters, shadows, procedures, and real comment sizes', () => {
  const project = fixture();
  const before = withoutEditorCoordinates(project);
  const report = layoutRecoveredProject(project);
  assert.equal(report.estimated, true);
  assert.equal(report.measured, false);
  assert.equal(report.reason, 'synthetic-editor-layout-original-coordinates-unavailable');
  assert.equal(report.targets[0].roots, 8, 'seven event stacks and one procedure');
  assert.ok(report.targets[0].items[0].codeBounds.height > 720, 'long C-shaped stack exceeds old fixed row');
  for (const t of report.targets) {
    for (let i = 0; i < t.items.length; i++) {
      const item = t.items[i];
      for (const other of t.items.slice(i + 1)) assert.equal(overlaps(item.bounds, other.bounds), false);
      for (const c of item.comments) {
        if (item.blockId !== null) assert.equal(overlaps(c.bounds, item.codeBounds), false);
        assert.equal(project.targets[t.targetIndex].comments[c.commentId].x, c.bounds.x);
        assert.equal(project.targets[t.targetIndex].comments[c.commentId].y, c.bounds.y);
        assert.equal(project.targets[t.targetIndex].comments[c.commentId].width, c.bounds.width);
        assert.equal(project.targets[t.targetIndex].comments[c.commentId].height, c.bounds.height);
      }
      for (let j = 0; j < item.comments.length; j++) for (const other of item.comments.slice(j + 1)) {
        assert.equal(overlaps(item.comments[j].bounds, other.bounds), false);
      }
    }
  }
  assert.deepEqual(withoutEditorCoordinates(project), before, 'only block/comment editor coordinates may change');
  assert.equal(project.targets[0].x, 101);
  assert.equal(project.targets[0].y, -90);
  assert.equal(project.targets[0].currentCostume, 1);
});

test('layout is deterministic, idempotent, target-local, and independent of dictionary insertion order', () => {
  const first = fixture(), second = fixture();
  for (const owner of second.targets) {
    owner.blocks = Object.fromEntries(Object.entries(owner.blocks).reverse());
    owner.comments = Object.fromEntries(Object.entries(owner.comments).reverse());
  }
  const a = layoutRecoveredProject(first), b = layoutRecoveredProject(second);
  assert.deepEqual(a, b);
  assert.deepEqual(layoutRecoveredProject(first), a);
  assert.deepEqual(a.targets[0].items[0].bounds.x, 60);
  assert.equal(first.targets[1].blocks['own-hat'].x, 60);
  assert.equal(first.targets[1].blocks['own-hat'].y, 60);
  first.targets[0].blocks.extra = block('event_whenflagclicked', {topLevel: true, x: 0, y: 0});
  layoutRecoveredProject(first);
  assert.equal(first.targets[1].blocks['own-hat'].x, 60, 'other target script count cannot affect ordinal');
  assert.equal(first.targets[1].blocks['own-hat'].y, 60);
});

test('top-level variable/list primitives keep IDs, names, and ownership, changing only their editor coordinates', () => {
  const owner = target('Stage');
  owner.blocks.variable = [12, 'exact variable', 'id', 900, 800];
  owner.blocks.list = [13, 'exact list', 'list-id', -10, -20];
  owner.comments.note = comment('variable');
  const project = {targets: [owner]};
  const before = withoutEditorCoordinates(project);
  const r = layoutRecoveredProject(project);
  assert.equal(r.rootsPlaced, 2);
  assert.deepEqual(withoutEditorCoordinates(project), before);
  assert.equal(owner.blocks.list[3], 60);
  assert.equal(owner.blocks.list[4], 60);
});

const rejectsWithoutMutation = (project, pattern) => {
  const before = structuredClone(project);
  assert.throws(() => layoutRecoveredProject(project), pattern);
  assert.deepEqual(project, before, 'failed layout must not mutate a prefix of targets');
};

test('cycles, shared graph ownership, missing references, orphan blocks, and invalid comments reject transactionally', () => {
  for (const corrupt of [
    p => {p.targets[1].blocks['own-hat/0'].next = 'own-hat';},
    p => {p.targets[1].blocks['own-hat/0'].inputs.CYCLE = [2, 'own-hat'];},
    p => {p.targets[1].blocks['own-hat'].inputs.SHARED = [2, 'own-hat/0'];},
    p => {p.targets[1].blocks['own-hat'].inputs.MISSING = [2, 'missing'];},
    p => {p.targets[1].blocks.orphan = block('looks_say');},
    p => {p.targets[1].comments.own.blockId = 'missing';},
    p => {p.targets[1].comments.own.width = -2;},
    p => {p.targets[1].comments.own.height = Infinity;}
  ]) { const p = fixture(); corrupt(p); rejectsWithoutMutation(p, /recovery layout/); }
});

test('node, depth, and coordinate limits reject cleanly without recursion overflow', () => {
  const long = target('Stage');
  for (let i = 0; i < RECOVERY_LAYOUT_LIMITS.maxNodes + 1; i++) long.blocks[`b${i}`] = block('looks_say', {
    topLevel: i === 0, next: i === RECOVERY_LAYOUT_LIMITS.maxNodes ? null : `b${i + 1}`
  });
  rejectsWithoutMutation({targets: [long]}, /node limit/);
  const deep = target('Stage');
  for (let i = 0; i < RECOVERY_LAYOUT_LIMITS.maxDepth + 2; i++) deep.blocks[`b${i}`] = block('control_repeat', {
    topLevel: i === 0, inputs: i === RECOVERY_LAYOUT_LIMITS.maxDepth + 1 ? {} : {SUBSTACK: [2, `b${i + 1}`]}
  });
  rejectsWithoutMutation({targets: [deep]}, /depth limit/);
  const oversized = fixture(); oversized.targets[1].comments.own.width = RECOVERY_LAYOUT_LIMITS.maxCoordinate;
  rejectsWithoutMutation(oversized, /coordinate limit/);
});

test('nonwritable coordinates reject before any target layout changes', () => {
  const project = fixture();
  Object.freeze(project.targets[1].comments.own);
  rejectsWithoutMutation(project, /writable/);
});
