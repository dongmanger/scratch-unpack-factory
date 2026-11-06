// Build the delivery zip: the factory tool plus the compiled sample artifacts and their recovered output.
//
// Layout:
//   factory/            the tool itself (source, tests, vendored compiler, README) — no node_modules
//   artifacts/          the compiled samples the tool was run against
//   output/             what the tool produced from each artifact, with fidelity reports
//   metrics/            recall/precision scores against the ground-truth projects
//   README.md           what is inside, how to run it, what the numbers mean
//
// Usage: node make-delivery-zip.mjs [out.zip]
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join, relative, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from '@turbowarp/jszip';

const here = dirname(fileURLToPath(import.meta.url));
const factory = join(here, '..');          // the tool
const root = join(factory, '..');          // the workspace that holds compiled/ samples/ work/
const staging = join(here, 'staging');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Files of the tool itself: source, tests, benchmarks, vendored compiler, docs. */
const TOOL_DIRS = ['src', 'bin', 'test', 'bench', 'vendor', 'fixtures'];
const TOOL_FILES = ['package.json', 'package-lock.json', 'README.md', 'DEOBFUSCATION.md', 'V1-ACCEPTANCE.md', 'V1-PROGRESS.md'];
// `fixtures/asset-acceptance` holds 111 MB of intermediate acceptance output that the test suite regenerates;
// shipping it would triple the archive for no benefit. Everything else under fixtures is small input data.
const SKIP = /(^|[/\\])(node_modules|out-.*|\.git)([/\\]|$)|\.log$|^_|fixtures[/\\]asset-acceptance/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP.test(relative(root, full))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const entries = [];
const add = (zipPath, bytes) => entries.push({path: zipPath, bytes});

// 1. The tool.
for (const dir of TOOL_DIRS) {
  const full = join(factory, dir);
  if (!existsSync(full)) continue;
  for (const file of walk(full)) add(`factory/${relative(factory, file).split('\\').join('/')}`, readFileSync(file));
}
for (const name of TOOL_FILES) {
  const full = join(factory, name);
  if (existsSync(full)) add(`factory/${name}`, readFileSync(full));
}

// 2. The compiled artifacts the tool was run against, and the ground-truth projects.
const artifacts = join(root, 'compiled');
if (existsSync(artifacts)) {
  for (const file of walk(artifacts)) add(`artifacts/${relative(artifacts, file).split('\\').join('/')}`, readFileSync(file));
}
const samples = join(root, 'samples');
if (existsSync(samples)) {
  for (const file of walk(samples)) add(`artifacts/ground-truth/${relative(samples, file).split('\\').join('/')}`, readFileSync(file));
}

// 3. What the tool produced.
const output = join(root, 'work', 'final');
if (existsSync(output)) {
  for (const file of walk(output)) add(`output/${relative(output, file).split('\\').join('/')}`, readFileSync(file));
}

// 4. Metrics.
const metrics = join(here, 'metrics');
if (existsSync(metrics)) {
  for (const file of walk(metrics)) add(`metrics/${relative(metrics, file).split('\\').join('/')}`, readFileSync(file));
}

const out = process.argv[2] ? join(process.argv[2]) : join(here, 'factory-delivery.zip');
rmSync(out, {force: true});
const zip = new JSZip();
const manifest = [];
for (const {path, bytes} of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
  zip.file(path, bytes);
  manifest.push({path, bytes: bytes.length, sha256: sha256(bytes)});
}
const readme = join(here, 'DELIVERY-README.md');
if (existsSync(readme)) zip.file('README.md', readFileSync(readme));
zip.file('manifest.json', JSON.stringify({createdAt: new Date().toISOString(), files: manifest}, null, 2));

const data = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 9}});
writeFileSync(out, data);
console.log(`wrote ${out}`);
console.log(`files ${entries.length}, ${(data.length / 1048576).toFixed(1)} MiB`);
