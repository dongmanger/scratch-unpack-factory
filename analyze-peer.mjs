import JSZip from '@turbowarp/jszip';
import fs from 'node:fs';
import {validateSb3} from './src/sb3-validate.mjs';
import {installedVirtualMachine} from './src/default-vm.mjs';

const readProject = async path => {
  const bytes = fs.readFileSync(path);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    const file = zip.file('project.json');
    return JSON.parse(await file.async('text'));
  }
  return JSON.parse(bytes.toString('utf8'));
};

const histogram = project => {
  const map = new Map();
  for (const target of project.targets || []) {
    for (const block of Object.values(target.blocks || {})) {
      const key = `${target.name}::${block.opcode}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return map;
};

const score = (truth, got) => {
  let hit = 0, gotTotal = 0, truthTotal = 0;
  for (const [key, count] of truth) {
    truthTotal += count;
    const mine = got.get(key) || 0;
    hit += Math.min(mine, count);
  }
  for (const count of got.values()) gotTotal += count;
  return {recall: truthTotal ? hit / truthTotal : 0, precision: gotTotal ? hit / gotTotal : 0,
    hit, truthTotal, gotTotal};
};

const loadInVm = async path => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { if (warnings.length < 3) warnings.push(String(args[0]).slice(0, 120)); };
  try {
    const VM = installedVirtualMachine();
    const vm = new VM();
    const storage = new VM.Storage();
    vm.attachStorage(storage);
    vm.setCompilerOptions({enabled: false, warpTimer: false});
    const buffer = fs.readFileSync(path);
    await vm.loadProject(buffer);
    const targets = vm.runtime?.targets || [];
    const stage = vm.runtime?.getTargetForStage?.();
    const blocks = null; // 无 renderer/audio 的验证环境下 VM 内块数不可靠计数，只记录载入结果与 target 数
    return {ok: targets.length > 0, targets: targets.length, stage: stage?.name || null, blocks};
  } catch (error) {
    return {ok: false, error: error.message.split('\n')[0].slice(0, 160)};
  } finally {
    console.warn = originalWarn;
  }
};

const cases = [
  {name: '原始源工程（基准）', path: '../samples/10128407.sb3'},
  {name: '我们 factory（模板恢复）', path: 'out-method-demo/10128407-strong-pretty/10128407-strong.partial.sb3'},
  {name: '朋友 o2-unpackager（重编译式反解）', path: '../02engine-unpackager-main/out-strong/rebuilt.sb3'}
];

const metrics = {generatedAt: new Date().toISOString(), input: 'compiled/o2/10128407-strong.html', truth: 'samples/10128407.sb3', cases: []};

const truth = await readProject(cases[0].path);
const truthHist = histogram(truth);
const truthTotal = [...truthHist.values()].reduce((a, b) => a + b, 0);
console.log('基准源工程: targets', truth.targets.length, 'blocks', truthTotal,
  'topLevel脚本', (truth.targets || []).reduce((s, t) => s + Object.values(t.blocks || {}).filter(b => b.topLevel).length, 0));

for (const item of cases.slice(1)) {
  console.log('\n=====', item.name, '=====');
  const bytes = fs.readFileSync(item.path);
  const validation = await validateSb3(bytes);
  console.log('结构校验:', validation.ok ? 'PASS' : 'FAIL',
    '| errors', (validation.errors || []).length, '| warnings', (validation.warnings || []).length);
  for (const e of (validation.errors || []).slice(0, 4)) console.log('   err:', String(e).slice(0, 140));
  for (const w of (validation.warnings || []).slice(0, 3)) console.log('   warn:', String(w).slice(0, 140));
  const project = await readProject(item.path);
  const got = histogram(project);
  const s = score(truthHist, got);
  console.log('积木召回率(对源工程同名同opcode):', (s.recall * 100).toFixed(1) + '%',
    '| 精确率:', (s.precision * 100).toFixed(1) + '%',
    '| 命中', s.hit, '/ 输出', s.gotTotal, '/ 源', s.truthTotal);
  const vmResult = await loadInVm(item.path);
  console.log('真实 02 VM 载入:', vmResult.ok ? 'OK' : 'FAIL', vmResult.ok ? `targets=${vmResult.targets} blocks=${vmResult.blocks}` : vmResult.error);
  metrics.cases.push({
    name: item.name, path: item.path,
    structuralValidation: {ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length,
      firstErrors: (validation.errors || []).slice(0, 5).map(e => String(e).slice(0, 200)),
      firstWarnings: (validation.warnings || []).slice(0, 3).map(e => String(e).slice(0, 200))},
    recall: Number((s.recall * 100).toFixed(1)), precision: Number((s.precision * 100).toFixed(1)),
    hit: s.hit, outputBlocks: s.gotTotal, truthBlocks: s.truthTotal,
    vmLoad: vmResult,
    targets: (project.targets || []).length,
    blocks: (project.targets || []).reduce((sum, t) => sum + Object.keys(t.blocks || {}).length, 0),
    topLevelScripts: (project.targets || []).reduce((s2, t) => s2 + Object.values(t.blocks || {}).filter(b => b.topLevel).length, 0),
    variables: (project.targets || []).reduce((s2, t) => s2 + Object.keys(t.variables || {}).length, 0),
    lists: (project.targets || []).reduce((s2, t) => s2 + Object.keys(t.lists || {}).length, 0),
    broadcasts: (project.targets || []).reduce((s2, t) => s2 + Object.keys(t.broadcasts || {}).length, 0)
  });
}
metrics.truth = {targets: truth.targets.length, blocks: truthTotal,
  topLevelScripts: (truth.targets || []).reduce((s, t) => s + Object.values(t.blocks || {}).filter(b => b.topLevel).length, 0)};
fs.writeFileSync('compare-metrics.json', JSON.stringify(metrics, null, 2));
console.log('\n已写出 compare-metrics.json');
