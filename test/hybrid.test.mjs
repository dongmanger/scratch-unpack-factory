import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {buildFocusedCandidate, inspectPeerCandidate, readSb3Project} from '../src/hybrid.mjs';
import {makeMinimalSb3} from './helpers.mjs';

const zipProject = async project => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
};
const baseProject = () => ({
  targets: [
    {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {b1: 'hello'}, blocks: {}, comments: {}, costumes: [], sounds: []},
    {isStage: false, name: 'Sprite', variables: {v1: ['score', 0]}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, costumes: [], sounds: []}
  ], monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0'}
});
const peerProject = (tail = {}) => {
  const base = baseProject();
  base.targets[1].blocks = {
    hat1: {opcode: 'event_whenbroadcastreceived', next: 'set1', parent: null, inputs: {}, fields: {BROADCAST_OPTION: ['hello', 'b1']}, topLevel: true, shadow: false, x: 0, y: 0},
    set1: {opcode: 'data_setvariableto', next: null, parent: 'hat1', inputs: {VALUE: [1, 'num1']}, fields: {VARIABLE: ['score', 'v1']}, topLevel: false, shadow: false},
    num1: {opcode: 'math_number', next: null, parent: 'set1', inputs: {}, fields: {NUM: ['7']}, topLevel: false, shadow: true},
    ...tail
  };
  return base;
};
const compiledProject = () => ({
  format: '02engine-compiled-project', version: 1, targets: baseProject().targets,
  compiledTargets: {1: {targetIndex: 1, scripts: {hat1: {factorySource: 'candidate'}}, procedures: {},
    hats: [{topBlockId: 'hat1', opcode: 'event_whenbroadcastreceived'}]}}
});

test('hybrid records structurally valid peer scripts as candidates without modifying formal project', async () => {
  const base = baseProject();
  const peerData = await zipProject(peerProject());
  const result = await inspectPeerCandidate({baseProject: base, peerData, compiledProject: compiledProject()});
  assert.equal(result.stats.knownScripts, 1);
  assert.equal(result.stats.candidateOnlyScripts, 1);
  assert.equal(result.stats.matchedPeerScripts, 1);
  assert.equal(result.records[0].blockCount, 3);
  assert.equal(result.records[0].status, 'candidate-only-unverified');
  assert.deepEqual(base.targets[1].blocks, {}, 'candidate inspection must not mutate trusted project');
  assert.equal(Object.keys((await readSb3Project(peerData)).targets[1].blocks).length, 3);
});

test('hybrid rejects unresolved peer graphs and retains the reason', async () => {
  const peerData = await zipProject(peerProject({
    set1: {opcode: 'data_setvariableto', next: 'bad', parent: 'hat1', inputs: {VALUE: [1, 'num1']}, fields: {VARIABLE: ['score', 'v1']}, topLevel: false, shadow: false},
    bad: {opcode: 'looks_say', next: null, parent: 'set1', inputs: {}, fields: {MESSAGE: ['/* unresolved block */']}, topLevel: false, shadow: false}
  }));
  const result = await inspectPeerCandidate({baseProject: baseProject(), peerData, compiledProject: compiledProject()});
  assert.equal(result.stats.rejectedScripts, 1);
  assert.equal(result.stats.candidateOnlyScripts, 0);
  assert.equal(result.records[0].status, 'rejected-static-structure');
  assert.match(result.records[0].reason, /unresolved/);
});

test('focused candidate uses deterministic IDs and authoritative broadcast/variable definitions', async () => {
  const {project, assets} = await makeMinimalSb3();
  project.targets[0].broadcasts.b1 = 'hello';
  project.targets[1].variables.v1 = ['score', 0];
  for (const target of project.targets) { target.blocks = {}; target.comments = {}; }
  const sourceZip = new JSZip();
  sourceZip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(assets)) sourceZip.file(name, bytes);
  const baseData = await sourceZip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const peer = peerProject();
  const peerData = await zipProject(peer);
  const record = {targetIndex: 1, scriptId: 'hat1', opcode: 'event_whenbroadcastreceived'};
  const first = await buildFocusedCandidate({baseData, sourceProject: project, peerProject: peer, record});
  const second = await buildFocusedCandidate({baseData, sourceProject: project, peerProject: peer, record});
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.validation.ok, true);
  assert.deepEqual(first.blocks, second.blocks);
  assert.equal(first.blocks.hat1.fields.BROADCAST_OPTION[0], 'hello');
  assert.equal(first.blocks.hat1.fields.BROADCAST_OPTION[1], 'b1');
  // Non-root block IDs are rewritten to deterministic hy_ IDs, so find the assignment by opcode.
  const assignment = Object.values(first.blocks).find(block => block.opcode === 'data_setvariableto');
  assert.equal(assignment.fields.VARIABLE[1], 'v1');
  assert.equal(Object.keys(first.blocks).filter(id => id !== 'hat1').every(id => id.startsWith('hy_')), true);
});
