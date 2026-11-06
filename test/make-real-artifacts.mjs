// 用官方 @turbowarp/packager（Node API）把最小 sb3 打包成真实产物。
// 产物 = 真实运行时 + 真实容器格式，是工厂的最强回归基准。
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './helpers.mjs';

const require = createRequire(import.meta.url);
const Packager = require('@turbowarp/packager');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
await fsp.mkdir(dir, { recursive: true });

const { bytes } = await H.makeMinimalSb3();

console.log('加载工程…');
const loadedProject = await Packager.loadProject(bytes);

console.log('打包 HTML（真实运行时，需联网拉取 large assets）…');
const packager = new Packager.Packager();
packager.project = loadedProject;
packager.addEventListener('large-asset-fetch', ({ detail }) => {
  if (detail.loaded === detail.total) console.log(`  large assets: ${detail.total} 已就绪`);
});
const htmlResult = await packager.package();
await fsp.writeFile(path.join(dir, 'artifact-real-tw.html'), htmlResult.data);
console.log(`  artifact-real-tw.html: ${htmlResult.data.length} bytes`);

console.log('打包 ZIP（zip 环境）…');
const packager2 = new Packager.Packager();
packager2.project = loadedProject;
packager2.options.target = 'zip';
const zipResult = await packager2.package();
await fsp.writeFile(path.join(dir, 'artifact-real-tw.zip'), new Uint8Array(zipResult.data));
console.log(`  artifact-real-tw.zip: ${zipResult.data.byteLength ?? zipResult.data.length} bytes`);

console.log('真实产物生成完毕');
