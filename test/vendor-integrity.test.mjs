import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertVendorBundleIntegrity} from '../src/vendor-integrity.mjs';
import {installedVirtualMachine} from '../src/default-vm.mjs';

const loadProvenance = () => readFile(new URL('../vendor/02-vm.provenance.json', import.meta.url), 'utf8').then(JSON.parse);

test('intact vendor bundle passes integrity and reports its recorded hash', async () => {
  const bytes = await readFile(new URL('../vendor/02-vm.cjs', import.meta.url));
  const provenance = await loadProvenance();
  const result = assertVendorBundleIntegrity(new Uint8Array(bytes), provenance, '02-vm.cjs');
  assert.equal(result.sha256, provenance.outputs['02-vm.cjs'].sha256);
  assert.equal(result.bytes, provenance.outputs['02-vm.cjs'].bytes);
});

test('a single flipped byte is rejected before any code runs', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../vendor/02-vm.cjs', import.meta.url)));
  const provenance = await loadProvenance();
  bytes[bytes.byteLength >> 1] ^= 0x01;
  assert.throws(() => assertVendorBundleIntegrity(bytes, provenance, '02-vm.cjs'), /failed integrity check/);
});

test('truncated bundle reports the length mismatch distinctly', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../vendor/02-vm.cjs', import.meta.url)));
  const provenance = await loadProvenance();
  assert.throws(() => assertVendorBundleIntegrity(bytes.subarray(0, bytes.byteLength - 1), provenance, '02-vm.cjs'),
    /length .* does not match/);
});

test('missing provenance entry fails closed', async () => {
  const provenance = await loadProvenance();
  assert.throws(() => assertVendorBundleIntegrity(new Uint8Array(10), {outputs: {}}, '02-vm.cjs'), /lacks a sha256/);
  assert.throws(() => assertVendorBundleIntegrity('not bytes', provenance, '02-vm.cjs'), TypeError);
});

test('default VM loads successfully only through the verified path', () => {
  const VM = installedVirtualMachine();
  assert.equal(typeof VM, 'function');
  assert.equal(typeof VM.Storage, 'function');
});
