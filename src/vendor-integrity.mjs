import {createHash} from 'node:crypto';

/**
 * Verify vendored bundle bytes against provenance.outputs BEFORE any require().
 * A corrupted or tampered CommonJS bundle executes arbitrary code at load time,
 * so hashing after the require would be meaningless. Length is checked first to
 * report truncation distinctly from content substitution.
 */
export function assertVendorBundleIntegrity(bytes, provenance, filename) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${filename} must be read as bytes before verification`);
  const expected = provenance?.outputs?.[filename];
  if (!expected || typeof expected.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(expected.sha256)) {
    throw new Error(`Vendor provenance lacks a sha256 for ${filename}`);
  }
  if (typeof expected.bytes === 'number' && bytes.byteLength !== expected.bytes) {
    throw new Error(`Vendor bundle ${filename} length ${bytes.byteLength} does not match provenance ${expected.bytes}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.sha256.toLowerCase()) {
    throw new Error(`Vendor bundle ${filename} failed integrity check: expected ${expected.sha256}, got ${actual}`);
  }
  return {sha256: actual, bytes: bytes.byteLength};
}
