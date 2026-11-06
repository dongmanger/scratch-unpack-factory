import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compiledFixture} from './compiled-fixtures.mjs';
import {JSZip} from './helpers.mjs';

const require = createRequire(import.meta.url);
const Packager = require('@turbowarp/packager');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'confidence-v02');
await fsp.mkdir(dir, {recursive: true});
const plain = await compiledFixture();
const unresolved = await compiledFixture({obfuscated: true});
const zip = new JSZip();
zip.file('project.json', JSON.stringify(plain.project));
for (const [name, bytes] of Object.entries(plain.assets)) zip.file(name, bytes);
const sourceBytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
const files = [['original.sb3', sourceBytes], ['template-02-synthetic.html', plain.html],
  ['unsupported-eval-shape-synthetic.html', unresolved.html]];
for (const [name, data] of files) await fsp.writeFile(path.join(dir, name), data, {flag: 'wx'});
const loaded = await Packager.loadProject(sourceBytes);
const packager = new Packager.Packager();
packager.project = loaded;
const result = await packager.package();
await fsp.writeFile(path.join(dir, 'real-tw-preserved.html'), result.data, {flag: 'wx'});
await fsp.writeFile(path.join(dir, 'README.md'), `# 置信度样例来源\n\n- original.sb3：多角色同名变量和大小写广播的源工程。\n- real-tw-preserved.html：官方 @turbowarp/packager 3.13.0 Node API 的真实普通打包产物。\n- template-02-synthetic.html：符合02 schema的合成明文factory，工程blocks确实清空；用于模板单测，未运行真实02编译器。\n- unsupported-eval-shape-synthetic.html：拒绝执行的eval形状合成fixture，验证未恢复标记；不是官方Strong混淆产物。\n\n这组样例不证明02三档混淆已解混淆，编辑器试开、重编译差分和行为验证尚未执行。\n`, {flag: 'wx'});
console.log(dir);
