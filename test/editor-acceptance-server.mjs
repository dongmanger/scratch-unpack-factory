import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from '@turbowarp/jszip';
import {recursiveRealFixture} from './real-02-recursive.mjs';
import {compileReal02} from './real-02-compiler.mjs';
import {restoreSb3} from '../src/restore.mjs';

const output = fileURLToPath(new URL('../fixtures/editor-acceptance-v1/', import.meta.url));
await fsp.mkdir(output, {recursive: true});
const fixture = await recursiveRealFixture();
const compiled = await compileReal02(fixture.project, fixture.assets);
const zip = new JSZip();
zip.file('project.json', JSON.stringify({...fixture.project, targets: compiled.bundle.targets}));
for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
const restored = await restoreSb3({staticResult: {type: 'sb3', format: 'o2-compiled-test',
  data: await zip.generateAsync({type: 'uint8array'}), compiledProject: JSON.stringify(compiled.bundle)}});
if (!restored.validation.ok || restored.report.code.unresolved.length) throw new Error(JSON.stringify(restored.report));
const file = path.join(output, 'recursive.reconstructed.sb3');
await fsp.writeFile(file, restored.data);
await fsp.writeFile(path.join(output, 'recursive.fidelity-report.json'), JSON.stringify(restored.report, null, 2));
await fsp.writeFile(path.join(output, 'provenance.json'), JSON.stringify(compiled.provenance, null, 2));
await fsp.writeFile(path.join(output, 'expected.json'), JSON.stringify(restored.project, null, 2));
const bytes = Buffer.from(restored.data);
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET' || req.url !== '/recursive.sb3') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length});
  res.end(bytes);
});
server.listen(8765, '127.0.0.1', () => console.log(`Editor test fixture: http://127.0.0.1:8765/recursive.sb3 (${bytes.length} bytes)`));
