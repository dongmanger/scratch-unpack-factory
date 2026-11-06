import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {serveStatic} from '../src/dynamic-extract.mjs';

test('artifact server serves project files but refuses encoded traversal/backslash outside root (no browser)', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'factory-http-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'app');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'index.html'), 'project page');
  await fsp.writeFile(path.join(dir, 'private.txt'), 'outside');
  const server = await serveStatic(root);
  t.after(() => server.close());
  const response = await fetch(server.url + '/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'project page');
  for (const request of ['/..%2fprivate.txt', '/..%5cprivate.txt', '/%00private.txt']) {
    const r = await fetch(server.url + request);
    assert.equal(r.status, 404);
    assert.notEqual(await r.text(), 'outside');
  }
});
