import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from '@turbowarp/jszip';
import {createHash} from 'node:crypto';

const factory = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.dirname(factory);
const evidenceRoot = path.join(factory, 'fixtures', 'asset-acceptance');
await fsp.mkdir(evidenceRoot, {recursive: true});
const files = new Map();
const expected = new Map();
const digest = data => createHash('sha256').update(data).digest('hex');
for (const [label, relative, sourceId] of [
  ['fresh-small-o2-off', 'fixtures/asset-acceptance/asset-roundtrip-real/o2/437419376-strong.html/beautify-off.sb3', '437419376'],
  ['fresh-small-o2-on', 'fixtures/asset-acceptance/asset-roundtrip-real/o2/437419376-strong.html/beautify-on.sb3', '437419376'],
  ['fresh-small-tw-off', 'fixtures/asset-acceptance/asset-roundtrip-real/tw/437419376-html.html/beautify-off.sb3', '437419376'],
  ['fresh-large-o2-off', 'fixtures/asset-acceptance/asset-roundtrip-real/o2/10128407-plain.html/beautify-off.sb3', '10128407'],
  ['fresh-large-o2-on', 'fixtures/asset-acceptance/asset-roundtrip-real/o2/10128407-plain.html/beautify-on.sb3', '10128407']
]) {
  const bytes = await fsp.readFile(path.join(factory, relative));
  files.set(`/${label}.sb3`, bytes);
  const archive = await JSZip.loadAsync(bytes, {checkCRC32: true});
  const project = JSON.parse(await archive.file('project.json').async('text'));
  const assetHashes = Object.fromEntries(await Promise.all(Object.values(archive.files)
    .filter(file => !file.dir && file.name !== 'project.json')
    .map(async file => [file.name, digest(await file.async('uint8array'))])));
  expected.set(`/${label}.sb3`, {project, assetHashes, sha256: digest(bytes)});
  const sourceId = label.startsWith('fresh-small') ? '437419376' : '10128407';
  const source = JSON.parse(await fsp.readFile(path.join(workspace, 'samples', `${sourceId}.sb3`), 'utf8'));
  archive.file('project.json', JSON.stringify(source));
  const sourceBytes = await archive.generateAsync({type: 'nodebuffer'});
  files.set(`/${label}-source.sb3`, sourceBytes);
  expected.set(`/${label}-source.sb3`, {project: source, assetHashes, sha256: digest(sourceBytes)});
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {res.writeHead(204); res.end(); return;}
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/browser-asset-check.mjs') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await fsp.readFile(new URL('./browser-asset-check.mjs', import.meta.url))); return;
  }
  if (req.method === 'GET' && url.pathname === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({files: [...files.keys()], evidence: '/evidence.json'})); return;
  }
  if (req.method === 'GET' && url.pathname === '/expected.json' && expected.has(url.searchParams.get('file'))) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(expected.get(url.searchParams.get('file')))); return;
  }
  if (req.method === 'GET' && files.has(url.pathname)) {
    const bytes = files.get(url.pathname);
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': bytes.byteLength});res.end(bytes);return;
  }
  if (req.method === 'POST' && url.pathname === '/evidence.json') {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {res.writeHead(413); res.end();return;}
      chunks.push(chunk);
    }
    try {
      const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof evidence.label !== 'string' || !/^[a-z0-9-]{1,64}$/.test(evidence.label)) throw new Error('Invalid evidence label');
      await fsp.writeFile(path.join(evidenceRoot, `${evidence.label}.json`), JSON.stringify(evidence, null, 2));
      res.writeHead(201);res.end('saved');
    } catch (error) {res.writeHead(400);res.end(error.message);}
    return;
  }
  res.writeHead(404);res.end('Not found');
});
server.listen(8766, '127.0.0.1', () => console.log(`Asset acceptance manifest: http://127.0.0.1:8766/manifest.json\n${[...files.keys()].join('\n')}`));
