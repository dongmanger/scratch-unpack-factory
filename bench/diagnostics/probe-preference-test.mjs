// 重放“偏好写法被编译器拒绝”场景，逐轮打印：编译了几次、其中几次项目含 data_deleteoflist、判定结果、最终写法
import {compileProject} from '../../src/recompile-oracle.mjs';
import {recoverWithOracle} from '../../src/relaxed-recovery.mjs';

const block = (opcode, parent, next, fields = {}, inputs = {}, topLevel = false) =>
  ({opcode, parent, next, fields, inputs, topLevel, shadow: false, ...(topLevel ? {x: 0, y: 0} : {})});
const text = v => [1, [10, String(v)]];
const stage = {isStage: true, name: 'Stage', variables: {vOut: ['out', 0]}, lists: {lList: ['list', ['a']]}, broadcasts: {}, comments: {}, currentCostume: 0,
  costumes: [], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null,
  blocks: {
    hat: block('event_whenflagclicked', null, 'del', {}, {}, true),
    del: block('data_deletealloflist', 'hat', 'set', {LIST: ['list', 'lList']}),
    set: block('data_setvariableto', 'del', null, {VARIABLE: ['out', 'vOut']}, {VALUE: text('done')})
  }};
const source = {targets: [stage], monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}};
const {bundle} = await compileProject(source);
const [id] = Object.keys(bundle.compiledTargets[0].scripts);
console.log('shipped:', bundle.compiledTargets[0].scripts[id].factorySource.replace(/\s+/g, ' ').slice(0, 260));

const stripped = structuredClone({targets: bundle.targets, monitors: [], extensions: [], meta: source.meta});
for (const t of stripped.targets) { t.blocks = {}; t.comments = {}; }

let calls = 0, sawPreferred = 0, tampered = 0;
const rejectsPreferred = async (project, archive) => {
  calls++;
  const result = await compileProject(project, archive);
  const ops = Object.values(project.targets[0].blocks).map(b => b.opcode);
  const usesPreferred = ops.includes('data_deleteoflist');
  if (usesPreferred) sawPreferred++;
  const before = JSON.stringify(Object.values(result.bundle.compiledTargets).map(e => Object.values(e.scripts).map(s => s.factorySource)));
  if (usesPreferred) for (const entry of Object.values(result.bundle.compiledTargets)) for (const s of Object.values(entry.scripts)) s.factorySource = s.factorySource.replace('.value = []', '.value = [0]');
  if (JSON.stringify(Object.values(result.bundle.compiledTargets).map(e => Object.values(e.scripts).map(s => s.factorySource))) !== before) tampered++;
  console.log(`  compile #${calls}: project ops=${[...new Set(ops)].join(',')} usesPreferred=${usesPreferred}`);
  return result;
};
const judged = await recoverWithOracle(stripped, bundle, {compile: rejectsPreferred});
const rec = judged.result.scripts.find(s => s.scriptId === id);
console.log('compiles:', calls, 'saw preferred:', sawPreferred, 'actually tampered:', tampered);
console.log('record: status=', rec.status, 'preferences=', JSON.stringify(rec.preferences), 'assumptions=', JSON.stringify(rec.assumptions), 'recompilation=', rec.recompilation?.status);
console.log('final ops:', Object.values(judged.project.targets[0].blocks).map(b => b.opcode).join(','));
console.log('oracle:', JSON.stringify(judged.oracle));
