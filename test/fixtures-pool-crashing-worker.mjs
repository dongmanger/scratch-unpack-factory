// Test-only worker entry for deobfuscate-pool.test.mjs. It behaves like the real worker except that it
// kills itself without raising an error when it receives a factory that contains the marker, which is how
// a native crash or an unexpected process.exit looks from the pool's side.
import {parentPort} from 'node:worker_threads';
import {deobfuscateSafely} from '../src/deobfuscate-pool.mjs';

parentPort.on('message', ({index, source, options}) => {
  if (source.includes('__CRASH_THE_WORKER__')) process.exit(7);
  parentPort.postMessage({index, result: deobfuscateSafely(source, options)});
});
