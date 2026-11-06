// 这个“大型 TurboWarp zip”里的 project.json，与真值工程相比校验结果是否一致？
// 并用改动前的备份目录里的代码再校验一次，判断 521 个错误是不是我造成的。
import fs from 'node:fs';
import JSZip from '@turbowarp/jszip';
import {pathToFileURL} from 'node:url';

const root = 'd:/rebuild&unpack';
const twZip = fs.readFileSync(`${root}/compiled/tw/10128407-zip.zip`);
const truthJson = fs.readFileSync(`${root}/samples/10128407.sb3`);

const wrap = async (projectJsonBytes) => {
  const zip = new JSZip();
  zip.file('project.json', projectJsonBytes);
  return zip.generateAsync({type: 'uint8array'});
};

const summarize = (label, v) => console.log(`${label.padEnd(44)} ok=${v.ok} errors=${v.errors.length} warnings=${v.warnings.length}`);

for (const [label, modulePath] of [['CURRENT code', `${root}/factory/src/sb3-validate.mjs`], ['PRE-CHANGE backup code', `${root}/backup-pre-fix-20261029-222905/factory/src/sb3-validate.mjs`]]) {
  if (!fs.existsSync(modulePath)) { console.log(label, 'module missing:', modulePath); continue; }
  const { validateSb3 } = await import(pathToFileURL(modulePath).href);
  summarize(`${label}: truth project.json`, await validateSb3(await wrap(truthJson)));
  // the embedded project inside the TurboWarp zip
  const inner = await JSZip.loadAsync(twZip);
  const names = Object.keys(inner.files).filter(n => /(^|\/)project\.json$/.test(n));
  summarize(`${label}: project.json inside the TW zip`, await validateSb3(await wrap(await inner.file(names[0]).async('uint8array'))));
}
