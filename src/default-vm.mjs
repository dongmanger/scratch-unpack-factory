import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {assertVendorBundleIntegrity} from './vendor-integrity.mjs';

const require = createRequire(import.meta.url);

/**
 * The bundled VM logs through `@turbowarp/nanolog`, whose loggers are `console.warn.bind(console, ...)`
 * captured the moment the VM module is first evaluated. Replacing `console.warn` afterwards therefore has
 * no effect on them, and compiling a real project prints thousands of "cannot load costume" lines because
 * there is no renderer or audio engine in Node.
 *
 * The only way to control that output without editing the integrity-checked vendor bundle is to be the
 * thing the VM binds to. While the bundle is evaluated for the first time, `console.debug/log/warn` are
 * temporarily forwarders that consult a switch, and the real methods are put back as soon as `require`
 * returns. The VM's loggers keep the forwarders; the rest of the process keeps the real console.
 * `console.error` is left alone: a real VM error should always be visible.
 *
 * By default the forwarders pass everything through, so VM diagnostics stay visible for legacy conversion
 * and verification. Only a call wrapped in `withVmLogsMuted` loses them, and only while it runs.
 */
const vmLogSwitch = {mutedDepth: 0};
const FORWARDED_LEVELS = ['debug', 'log', 'warn'];

/** Run `fn` with the VM's own log output discarded. Re-entrant; other console users are unaffected. */
export async function withVmLogsMuted(fn) {
  vmLogSwitch.mutedDepth++;
  try { return await fn(); } finally { vmLogSwitch.mutedDepth--; }
}

function requireWithLogForwarders(specifier) {
  const originals = {};
  const forwarders = {};
  for (const level of FORWARDED_LEVELS) {
    originals[level] = console[level];
    forwarders[level] = (...args) => {
      if (vmLogSwitch.mutedDepth !== 0) return;
      // While the bundle is being evaluated `console[level]` is this very forwarder, so use the saved
      // original then. Afterwards follow whatever `console[level]` is *now*, so that a program which
      // redirects or replaces the console (a test, a logging wrapper) still sees the VM's output.
      const current = console[level] === forwarders[level] ? originals[level] : console[level];
      current.apply(console, args);
    };
    console[level] = forwarders[level];
  }
  try {
    return require(specifier);
  } finally {
    for (const level of FORWARDED_LEVELS) console[level] = originals[level];
  }
}

export function installedVirtualMachine() {
  let VM, Storage;
  try {
    // Hash the pinned bundle against its provenance BEFORE require(): CommonJS
    // evaluation executes arbitrary top-level code, so integrity must be
    // established first. A corrupted vendor file is a supply-chain signal and
    // fails loudly rather than running.
    assertVendorBundleIntegrity(readFileSync(new URL('../vendor/02-vm.cjs', import.meta.url)),
      JSON.parse(readFileSync(new URL('../vendor/02-vm.provenance.json', import.meta.url), 'utf8')), '02-vm.cjs');
    VM = requireWithLogForwarders('../vendor/02-vm.cjs');
    Storage = VM.Storage || VM.ScratchStorage;
  } catch (cause) {
    throw new Error(`Pinned VM conversion dependencies unavailable; run npm ci or supply --vm-module: ${cause.message}`, {cause});
  }
  VM = VM.default || VM;
  Storage = Storage.default || Storage;
  if (typeof VM !== 'function' || typeof Storage !== 'function') throw new Error('Installed VM/storage adapters are not constructors');
  return class FactoryVirtualMachine extends VM { static Storage = Storage; };
}
