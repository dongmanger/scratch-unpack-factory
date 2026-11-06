// 逐脚本评测基准：对真值工程打分，替代按 "角色::opcode" 计数的粗直方图。
//
// 用法: node bench/score.mjs <候选.sb3|project.json> [--truth ../samples/10128407.sb3] [--artifact ../compiled/o2/10128407-plain.html] [--json out.json]
//
// 三个指标：
//  1. structural  结构签名匹配：把每个顶层脚本规约成 opcode 树签名（忽略 ID/布局/字面量值），
//                 与真值同角色的脚本多重集合匹配。给出脚本级召回/精确率。
//  2. recompile   重编译一致：候选工程经真实 02 编译器重编译，其 factorySource 与原始产物逐串（规范化后）
//                 相同的脚本数。这是"语义等价"的强证据，也是 hybrid 采纳候选的预言机。
//  3. integrity   结构校验错误数、广播定义数（真值对照）、块数膨胀率。
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import JSZip from '@turbowarp/jszip';
import {validateSb3} from '../src/sb3-validate.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const readProjectFile = async file => {
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    const entry = zip.file('project.json');
    if (!entry) throw new Error('缺少 project.json: ' + file);
    return {project: JSON.parse(await entry.async('text')), bytes, zip};
  }
  return {project: JSON.parse(bytes.toString('utf8')), bytes, zip: null};
};

const inputRefs = input => {
  if (Array.isArray(input)) return typeof input[1] === 'string' ? [input[1]] : [];
  if (!isObject(input)) return [];
  return ['block', 'shadow'].map(k => input[k]).filter(v => typeof v === 'string');
};

/**
 * `if_else` with an empty else branch is the same program as `if`. Authors leave those behind (30 in the
 * sample project), and the compiler emits the identical code for both, so a decoder that returns `if` is
 * right — comparing the two opcodes literally would mark every such script wrong. Only the empty case is
 * folded; an `if_else` with a real else branch keeps its opcode.
 */
const normalizedOpcode = (block, blocks) => {
  if (block.opcode !== 'control_if_else') return block.opcode;
  const elseRef = Array.isArray(block.inputs?.SUBSTACK2) ? block.inputs.SUBSTACK2[1] : null;
  return elseRef && isObject(blocks[elseRef]) ? 'control_if_else' : 'control_if';
};

/** 规约一个顶层脚本为 opcode 树签名。忽略 ID、布局、字面量值与菜单阴影，保留结构。 */
export function scriptSignature(blocks, topId, {withFields = false} = {}) {
  const visit = (id, depth = 0) => {
    const block = blocks[id];
    if (!isObject(block) || depth > 400) return '?';
    // A custom-block call names its inputs by argument ID. IDs are generated when the procedure is defined and
    // cannot be recovered (the compiler keeps only positions), so comparing the *names* would call every call
    // site wrong. Compare by position within the procedure's argument list instead; an input that is left
    // empty is simply absent, exactly as before.
    const isCall = block.opcode === 'procedures_call';
    const argumentOrder = isCall ? (() => { try { return JSON.parse(block.mutation?.argumentids || '[]'); } catch { return []; } })() : null;
    const inputNames = Object.keys(block.inputs || {}).sort((a, b) => isCall
      ? (argumentOrder.indexOf(a) - argumentOrder.indexOf(b)) || a.localeCompare(b) : a.localeCompare(b));
    const inputs = inputNames.map(name => {
      const refs = inputRefs(block.inputs[name]).filter(ref => blocks[ref]);
      const own = refs.filter(ref => !blocks[ref].shadow);
      const label = isCall ? `arg${argumentOrder.indexOf(name)}` : name;
      return own.length ? `${label}=(${own.map(ref => visit(ref, depth + 1)).join('|')})` : null;
    }).filter(Boolean);
    const fields = withFields ? Object.keys(block.fields || {}).sort().map(k => `${k}:${JSON.stringify(block.fields[k]?.[0])}`) : [];
    const head = `${normalizedOpcode(block, blocks)}${block.mutation?.proccode ? '<' + block.mutation.proccode + '>' : ''}`;
    const self = fields.length || inputs.length ? `${head}{${[...fields, ...inputs].join(',')}}` : head;
    return typeof block.next === 'string' && blocks[block.next] ? `${self};${visit(block.next, depth + 1)}` : self;
  };
  return visit(topId);
}

export function listScripts(project, options) {
  const scripts = [];
  (project.targets || []).forEach((target, index) => {
    for (const [id, block] of Object.entries(target.blocks || {})) {
      if (!isObject(block) || !block.topLevel) continue;
      scripts.push({targetIndex: index, target: target.name, isStage: !!target.isStage, id, opcode: block.opcode,
        signature: scriptSignature(target.blocks, id, options), blockCount: countBlocks(target.blocks, id)});
    }
  });
  return scripts;
}

function countBlocks(blocks, topId) {
  const seen = new Set();
  const stack = [topId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !isObject(blocks[id])) continue;
    seen.add(id);
    if (typeof blocks[id].next === 'string') stack.push(blocks[id].next);
    for (const input of Object.values(blocks[id].inputs || {})) for (const ref of inputRefs(input)) stack.push(ref);
  }
  return seen.size;
}

const multiset = list => list.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map());

/** 结构签名多重集合匹配（按角色名分组）。 */
export function structuralScore(truth, candidate, options = {}) {
  const truthScripts = listScripts(truth, options);
  const candScripts = listScripts(candidate, options);
  const key = script => `${script.isStage ? '#stage' : script.target}\u0000${script.signature}`;
  const truthSet = multiset(truthScripts.map(key));
  const candSet = multiset(candScripts.map(key));
  let hit = 0;
  for (const [k, n] of truthSet) hit += Math.min(n, candSet.get(k) || 0);
  const truthBlocks = truthScripts.reduce((s, x) => s + x.blockCount, 0);
  const candBlocks = candScripts.reduce((s, x) => s + x.blockCount, 0);
  // 块级：按签名匹配到的脚本所含块数
  let hitBlocks = 0;
  const remaining = new Map(candSet);
  for (const script of truthScripts) {
    const k = key(script);
    if ((remaining.get(k) || 0) > 0) { remaining.set(k, remaining.get(k) - 1); hitBlocks += script.blockCount; }
  }
  return {
    truthScripts: truthScripts.length, candidateScripts: candScripts.length, matchedScripts: hit,
    scriptRecall: truthScripts.length ? hit / truthScripts.length : 0,
    scriptPrecision: candScripts.length ? hit / candScripts.length : 0,
    truthBlocks, candidateBlocks: candBlocks, matchedBlocks: hitBlocks,
    blockRecall: truthBlocks ? hitBlocks / truthBlocks : 0,
    blockPrecision: candBlocks ? hitBlocks / candBlocks : 0,
    inflation: truthBlocks ? candBlocks / truthBlocks : 0
  };
}

export function broadcastReport(truth, candidate) {
  const names = project => {
    const out = [];
    for (const target of project.targets || []) for (const name of Object.values(target.broadcasts || {})) out.push(name);
    return out;
  };
  const t = names(truth), c = names(candidate);
  const tset = new Set(t);
  return {truth: t.length, candidate: c.length, extra: c.filter(name => !tset.has(name)).length,
    missing: t.filter(name => !new Set(c).has(name)).length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const candidatePath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const truthPath = opt('--truth') || path.resolve('..', 'samples', '10128407.sb3');
  if (!candidatePath) throw new Error('用法: node bench/score.mjs <候选.sb3> [--truth ...] [--json out.json]');
  const truth = (await readProjectFile(path.resolve(truthPath))).project;
  const {project: candidate, bytes} = await readProjectFile(candidatePath);
  const structural = structuralScore(truth, candidate);
  const validation = bytes[0] === 0x50 ? await validateSb3(new Uint8Array(bytes)) : null;
  const report = {candidate: candidatePath, structural, broadcasts: broadcastReport(truth, candidate),
    validation: validation && {ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length}};
  const f = x => (x * 100).toFixed(1) + '%';
  console.log(`脚本召回 ${f(structural.scriptRecall)} (${structural.matchedScripts}/${structural.truthScripts})  ` +
    `脚本精确 ${f(structural.scriptPrecision)} (${structural.matchedScripts}/${structural.candidateScripts})`);
  console.log(`块召回 ${f(structural.blockRecall)}  块精确 ${f(structural.blockPrecision)}  块膨胀 ${structural.inflation.toFixed(2)}x ` +
    `(候选 ${structural.candidateBlocks} / 真值 ${structural.truthBlocks})`);
  console.log(`广播定义 真值 ${report.broadcasts.truth} / 候选 ${report.broadcasts.candidate} (多出 ${report.broadcasts.extra}, 缺失 ${report.broadcasts.missing})`);
  if (report.validation) console.log(`结构校验 ${report.validation.ok ? 'PASS' : 'FAIL'} errors=${report.validation.errors} warnings=${report.validation.warnings}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2));
}
