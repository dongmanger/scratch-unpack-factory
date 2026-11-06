import {createRequire} from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Load only an explicit, locally trusted VM module; never resolve an input artifact as an adapter. */
export async function loadLegacyAdapter(modulePath) {
  if (typeof modulePath !== 'string' || !modulePath) throw new Error('Legacy conversion requires --vm-module pointing to a trusted local VM');
  const resolved = path.resolve(modulePath);
  const info = await fsp.stat(resolved);
  if (!info.isFile()) throw new Error('VM module path must name an existing JavaScript module file');
  let VM;
  try { VM = require(resolved); }
  catch (cause) { throw new Error(`Cannot load trusted VM adapter ${resolved}: ${cause.message}`, {cause}); }
  VM = VM.default || VM;
  if (typeof VM !== 'function') throw new Error('Trusted VM module must export a VirtualMachine constructor');
  if (VM.Storage || VM.ScratchStorage || typeof VM.createStorage === 'function') return VM;
  let Storage;
  try { Storage = createRequire(resolved)('@turbowarp/scratch-storage'); }
  catch (cause) { throw new Error(`VM adapter needs actual @turbowarp/scratch-storage or static Storage/createStorage: ${cause.message}`, {cause}); }
  Storage = Storage.default || Storage;
  return class LegacyVirtualMachine extends VM { static Storage = Storage; };
}
