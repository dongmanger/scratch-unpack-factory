import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {installedVirtualMachine, withVmLogsMuted} from '../src/default-vm.mjs';
import {compileProject} from '../src/recompile-oracle.mjs';

// The VM binds its loggers to console.warn/log/debug when the bundle is first evaluated, so muting has to
// work through forwarders installed at that moment. These tests pin the behaviour both ways: quiet while
// muted, audible otherwise, and no lasting change to the process's own console.

const captured = async fn => {
  const lines = [];
  const saved = {};
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push([level, args.join(' ')]);
  }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
};

// What the VM's loggers can emit. console.error is excluded: Node prints its own deprecation notices there.
const vmLevels = lines => lines.filter(([level]) => level !== 'error');

const COSTUME = resolution => ({name: 'c', assetId: 'a'.repeat(32), md5ext: `${'a'.repeat(32)}.png`, dataFormat: 'png',
  bitmapResolution: resolution, rotationCenterX: 0, rotationCenterY: 0});
const tinyProject = (resolution = 2) => ({
  targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0,
    costumes: [COSTUME(resolution)], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}],
  monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
});

// A project whose costume file IS in the archive. With no renderer the VM logs "No rendering module
// present" and carries on, without taking the failing default-costume path, so it is a safe way to make the
// VM talk without leaving an unhandled rejection behind for a later test to trip over.
const talkativeVm = async () => {
  const VM = installedVirtualMachine();
  const vm = new VM();
  vm.attachStorage(new VM.Storage());
  vm.setCompilerOptions({enabled: true});
  const archive = new JSZip();
  archive.file(`${'a'.repeat(32)}.png`, new Uint8Array([1, 2, 3]));
  await vm.compileProjectFromJSON(tinyProject(), archive);
  vm.quit();
};

/** Run `fn` and report any promise rejection nothing handled: what ends the CLI with ERR_UNHANDLED_REJECTION. */
const unhandledDuring = async fn => {
  const seen = [];
  const listener = reason => seen.push(String(reason));
  process.on('unhandledRejection', listener);
  try {
    await fn();
    // Rejections are reported after the microtask queue drains, so give the loop a few turns.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  } finally { process.off('unhandledRejection', listener); }
  return seen;
};

test('the console methods the process uses are the real ones after the VM is loaded', () => {
  const before = {warn: console.warn, log: console.log, debug: console.debug, error: console.error};
  installedVirtualMachine();
  assert.equal(console.warn, before.warn);
  assert.equal(console.log, before.log);
  assert.equal(console.debug, before.debug);
  assert.equal(console.error, before.error);
});

test('compiling a project whose costume cannot be decoded prints nothing from the VM', async () => {
  installedVirtualMachine();
  const lines = vmLevels(await captured(async () => { await compileProject(tinyProject()); }));
  assert.deepEqual(lines, [], `unexpected output: ${JSON.stringify(lines.slice(0, 3))}`);
});

test('the same VM output IS visible when nothing is muting it', async () => {
  const lines = vmLevels(await captured(talkativeVm));
  assert.ok(lines.some(([, text]) => /vm/.test(text)), 'VM diagnostics must stay visible by default (legacy conversion and verification rely on them)');
});

test('muting is scoped to the call and restores even when the call throws', async () => {
  await assert.rejects(withVmLogsMuted(async () => { throw new Error('boom'); }), /boom/);
  const lines = vmLevels(await captured(talkativeVm));
  assert.ok(lines.length > 0, 'the switch must be released after a failure');
  // And muting really does silence the same operation while it is held.
  const muted = vmLevels(await captured(() => withVmLogsMuted(talkativeVm)));
  assert.deepEqual(muted, []);
});

test('real errors are never muted', async () => {
  const lines = await captured(async () => { await withVmLogsMuted(async () => { console.error('a real error'); }); });
  assert.deepEqual(lines, [['error', 'a real error']]);
});

// --- regression: a costume the VM cannot find or decode must not end the process -----------------------

for (const [label, make] of [
  ['no archive at all', () => undefined],
  ['an archive that lacks the costume file', () => new JSZip()],
  ['an archive that has the costume file', () => { const z = new JSZip(); z.file(`${'a'.repeat(32)}.png`, new Uint8Array([1, 2, 3])); return z; }]
]) {
  for (const resolution of [1, 2]) {
    test(`compiling with ${label} and a bitmapResolution ${resolution} costume neither throws nor leaks an unhandled rejection`, async () => {
      const archive = make();
      let compiled;
      const unhandled = await unhandledDuring(async () => { compiled = await compileProject(tinyProject(resolution), archive); });
      assert.deepEqual(unhandled, [], 'an unhandled rejection would terminate the CLI with a failure exit code');
      assert.ok(compiled.bundle.compiledTargets, 'a compiled bundle must still be produced');
    });
  }
}

test('placeholder files added for missing assets are removed again and real assets are untouched', async () => {
  const archive = new JSZip();
  archive.file('keep.txt', 'unrelated');
  const real = new Uint8Array([9, 9, 9]);
  archive.file(`${'a'.repeat(32)}.png`, real);
  const project = tinyProject();
  project.targets[0].costumes.push({...COSTUME(2), assetId: 'b'.repeat(32), md5ext: `${'b'.repeat(32)}.png`, name: 'missing'});
  const before = Object.keys(archive.files).sort();
  await compileProject(project, archive);
  assert.deepEqual(Object.keys(archive.files).sort(), before, 'the caller\'s archive must be left exactly as it was');
  assert.deepEqual(new Uint8Array(await archive.file(`${'a'.repeat(32)}.png`).async('uint8array')), real);
});
