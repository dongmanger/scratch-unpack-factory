import {parentPort} from 'node:worker_threads';
import {deobfuscateSafely} from './deobfuscate-pool.mjs';

// Worker-thread entry for deobfuscate-pool.mjs. It lives in its own file so that importing the pool
// has no side effect: a module that imports the pool from inside a worker must not also acquire a
// second 'message' handler.
if (parentPort) {
  parentPort.on('message', ({index, source, options}) => {
    parentPort.postMessage({index, result: deobfuscateSafely(source, options)});
  });
}
