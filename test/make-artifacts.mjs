// 生成真实文件形态的样例产物到 fixtures/，供 CLI 冒烟测试。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './helpers.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
await fsp.mkdir(dir, { recursive: true });

const { bytes, project, assets } = await H.makeMinimalSb3();
const projectJSONBytes = new TextEncoder().encode(JSON.stringify(project));
const {compiledFixture} = await import('./compiled-fixtures.mjs');
const compiled = await compiledFixture();
const compiledSample = compiled.compiledProject;

const w = (name, data) => fsp.writeFile(path.join(dir, name), data);

await w('artifact-tw-current.html', H.buildTwHtmlV4(bytes));
await w('artifact-o2-precompile.html', compiled.html);

const outer = await new H.JSZip();
outer.file('project.zip', compiled.bytes);
outer.file('compiled-project.json', compiledSample);
await w('artifact-o2-precompile.zip', await outer.generateAsync({ type: 'uint8array' }));

const inner = await new H.JSZip();
inner.file('project.json', projectJSONBytes);
for (const [name, b] of Object.entries(assets)) inner.file(name, b);
const plainSb3 = await inner.generateAsync({ type: 'uint8array' });
await w('artifact-plain.sb3', plainSb3);

console.log(`fixtures 已生成于 ${dir}`);
