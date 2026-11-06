import test from 'node:test';
import assert from 'node:assert/strict';
import {deobfuscateMany, deobfuscateSafely, defaultWorkerCount} from '../src/deobfuscate-pool.mjs';

// Sources of different sizes so longest-first scheduling reorders them relative to the input.
const makeSources = count => Array.from({length: count}, (_, i) =>
  `(function(thread){const target=thread.target;${'x'.repeat(0)}${Array.from({length: (i * 7) % 11 + 1}, (_, k) => `target.v${i}_${k}=(${i}+${k})*2;`).join('')}return function*(){${i % 3 ? 'a&&b();' : 'if(c){d();}'}retire();return;};})`);

test('parallel results equal the serial results byte for byte, in input order', async () => {
  const sources = makeSources(40);
  const serial = sources.map(source => deobfuscateSafely(source));
  const parallel = await deobfuscateMany(sources, {workers: 4});
  assert.equal(parallel.length, sources.length);
  for (let i = 0; i < sources.length; i++) {
    assert.equal(parallel[i].ok, true);
    assert.equal(parallel[i].value.code, serial[i].value.code, `code differs at ${i}`);
    assert.deepEqual(parallel[i].value.report, serial[i].value.report, `report differs at ${i}`);
  }
});

test('one factory that fails does not affect the others', async () => {
  const sources = makeSources(12);
  sources[5] = '(function(';           // does not parse
  sources[9] = 'x'.repeat(5_000_000);  // over the size limit
  const results = await deobfuscateMany(sources, {workers: 3});
  assert.equal(results[5].ok, false);
  assert.equal(results[9].ok, false);
  assert.match(results[5].error.message, /./);
  for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 10, 11]) assert.equal(results[i].ok, true, `factory ${i} must still succeed`);
});

test('a single worker or a small batch takes the serial path and gives the same answer', async () => {
  const sources = makeSources(5);
  const direct = sources.map(source => deobfuscateSafely(source));
  const viaPool = await deobfuscateMany(sources, {workers: 8});    // below the parallel threshold
  const single = await deobfuscateMany(makeSources(20), {workers: 1});
  assert.deepEqual(viaPool.map(r => r.value.code), direct.map(r => r.value.code));
  assert.equal(single.length, 20);
});

test('a worker that exits silently mid-task fails only that factory and the run still completes', async () => {
  const sources = makeSources(24);
  sources[3] = '(function(){/*__CRASH_THE_WORKER__*/})';
  sources[17] = '(function(){/*__CRASH_THE_WORKER__*/})';
  const entry = new URL('./fixtures-pool-crashing-worker.mjs', import.meta.url);
  // A hang here would be the bug; the timeout turns it into a failure instead of a stuck test run.
  const results = await Promise.race([
    deobfuscateMany(sources, {workers: 3, workerEntry: entry}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pool hung after a worker exited')), 60000))
  ]);
  assert.equal(results.length, sources.length);
  for (const i of [3, 17]) {
    assert.equal(results[i].ok, false);
    assert.equal(results[i].error.name, 'WorkerError');
    assert.match(results[i].error.message, /exited with code 7/);
  }
  const serial = sources.map(source => deobfuscateSafely(source));
  for (let i = 0; i < sources.length; i++) {
    if (i === 3 || i === 17) continue;
    assert.equal(results[i].ok, true, `factory ${i} must survive its neighbours crashing`);
    assert.equal(results[i].value.code, serial[i].value.code, `factory ${i} must be unchanged`);
  }
});

test('progress is reported once per factory and ends at the total', async () => {
  const seen = [];
  await deobfuscateMany(makeSources(16), {workers: 3, onProgress: (done, total) => seen.push([done, total])});
  assert.equal(seen.length, 16);
  assert.deepEqual(seen.at(-1), [16, 16]);
  assert.ok(seen.every(([done], i) => done === i + 1), 'progress counts must increase one at a time');
});

test('empty input and the worker-count override behave', async () => {
  assert.deepEqual(await deobfuscateMany([]), []);
  const previous = process.env.FACTORY_WORKERS;
  try {
    process.env.FACTORY_WORKERS = '1';
    assert.equal(defaultWorkerCount(100), 1);
    process.env.FACTORY_WORKERS = '0';
    assert.equal(defaultWorkerCount(100), 0);
    process.env.FACTORY_WORKERS = 'nonsense';
    assert.ok(defaultWorkerCount(100) >= 1);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_WORKERS; else process.env.FACTORY_WORKERS = previous;
  }
});
