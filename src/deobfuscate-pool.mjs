import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {deobfuscate} from './deobfuscate.mjs';

/**
 * Parallel front for `deobfuscate`.
 *
 * `deobfuscate(source)` is a pure function of its input (module state is read-only constant sets),
 * and every factory is independent, so running factories on worker threads cannot change any result.
 * The pool preserves that guarantee mechanically:
 *  - results are written back by input index, so output order equals input order;
 *  - the work is the exact same function, so each result is identical to the serial one (the tests
 *    compare serial and parallel outputs byte for byte);
 *  - a worker that throws or dies only fails the factory it was running, which is then reported with
 *    the same `{ok:false,error}` shape the serial path produces for a thrown error.
 * Scheduling is longest-first: per-factory cost is heavy-tailed (one 39 KB factory took 13.7 s while
 * the median is well under a second), so starting the biggest first keeps all workers busy to the end.
 */

const MIN_PARALLEL_TASKS = 8;
const WORKER_HEAP_MB = 2048;

/** Number of worker threads to use. FACTORY_WORKERS overrides; 0 or 1 forces the serial path. */
export function defaultWorkerCount(taskCount) {
  const requested = process.env.FACTORY_WORKERS;
  if (requested !== undefined && requested !== '') {
    const n = Number(requested);
    if (Number.isInteger(n) && n >= 0) return Math.min(n, taskCount);
  }
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Leave one core for the main thread, which does the (cheap) pretty-printing and recovery.
  return Math.max(1, Math.min(cpus - 1, taskCount, 16));
}

/** The same call the serial path makes, with a thrown error captured instead of propagated. */
export function deobfuscateSafely(source, options) {
  try {
    return {ok: true, value: deobfuscate(source, options)};
  } catch (error) {
    return {ok: false, error: {message: String(error?.message || error), name: error?.name || 'Error'}};
  }
}

/**
 * @param {string[]} sources factorySource texts
 * @param {object} [options]
 * @param {number} [options.workers] override the thread count
 * @param {object} [options.deobfuscateOptions] forwarded to deobfuscate()
 * @param {(done:number,total:number)=>void} [options.onProgress]
 * @returns {Promise<Array<{ok:boolean,value?:object,error?:{message:string,name:string}}>>}
 */
export async function deobfuscateMany(sources, {workers, deobfuscateOptions, onProgress, workerEntry = new URL('./deobfuscate-worker.mjs', import.meta.url)} = {}) {
  const total = sources.length;
  const results = new Array(total);
  const count = workers ?? defaultWorkerCount(total);
  if (count <= 1 || total < MIN_PARALLEL_TASKS) {
    for (let i = 0; i < total; i++) {
      results[i] = deobfuscateSafely(sources[i], deobfuscateOptions);
      onProgress?.(i + 1, total);
    }
    return results;
  }

  // Longest-first order; ties broken by index so the schedule itself is deterministic.
  const order = sources.map((_, index) => index)
    .sort((a, b) => sources[b].length - sources[a].length || a - b);
  let cursor = 0;
  let done = 0;
  const live = new Set();

  await new Promise(resolve => {
    const record = (index, result) => {
      if (results[index] !== undefined) return;
      results[index] = result;
      done++;
      onProgress?.(done, total);
      if (done === total) resolve();
    };
    const next = worker => {
      if (cursor >= order.length) {
        live.delete(worker);
        worker.terminate();
        return;
      }
      const index = order[cursor++];
      worker.currentIndex = index;
      worker.postMessage({index, source: sources[index], options: deobfuscateOptions});
    };
    const spawn = () => {
      const worker = new Worker(workerEntry, {resourceLimits: {maxOldGenerationSizeMb: WORKER_HEAP_MB}});
      live.add(worker);
      worker.on('message', ({index, result}) => {
        worker.currentIndex = undefined;
        record(index, result);
        next(worker);
      });
      // A worker can end mid-task in two ways: an uncaught exception / resource-limit kill ('error',
      // followed by 'exit'), or leaving without any error ('exit' alone, e.g. process.exit or a native
      // crash). Both must charge the factory it was running and replace the worker, or `done` never
      // reaches `total` and the whole run hangs. `currentIndex` is cleared by the first handler to run,
      // so the second one finds nothing left to do.
      const lost = reason => {
        const index = worker.currentIndex;
        worker.currentIndex = undefined;
        if (!live.delete(worker)) return;
        if (index !== undefined) {
          record(index, {ok: false, error: {message: `worker failed: ${reason}`, name: 'WorkerError'}});
        }
        if (done < total && cursor < order.length) next(spawn());
      };
      worker.on('error', error => lost(error?.message || String(error)));
      worker.on('exit', code => lost(`exited with code ${code}`));
      return worker;
    };
    if (!total) { resolve(); return; }
    for (let i = 0; i < count; i++) next(spawn());
  }).finally(() => { for (const worker of live) worker.terminate(); });

  return results;
}
