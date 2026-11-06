#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {identify} from '../src/identify.mjs';
import {staticUnpack} from '../src/static-unpack.mjs';
import {restoreSb3} from '../src/restore.mjs';
import {fidelityMarkdown, inventory} from '../src/fidelity.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {prettifyFactorySource} from '../src/pretty-code.mjs';
import {verifyArtifact} from '../src/verify-artifact.mjs';
import {buildFocusedCandidate, inspectPeerCandidate, loadPeerOutput, mergeVerifiedGraph, runPeerUnpackager} from '../src/hybrid.mjs';

const usage = `用法：
  factory identify <file>
  factory validate <file.sb3>
  factory deobfuscate <file.js> [-o outdir] [--overwrite]
  factory verify <original> <recovered> --allow-execute [--timeout-ms 毫秒] [--max-steps 步数]
  factory unpack <file> [-o outdir] [--mode auto|static|dynamic] [--strategy factory|hybrid]
                       [--recovery oracle|strict]
                       [--peer-output dir|rebuilt.sb3] [--peer-decompiler dir]
                       [--peer-deobfuscator none|webcrack|javascript-deobfuscator] [--allow-peer-execute]
                       [--allow-execute] [--max-steps 步数]
                       [--allow-partial] [--overwrite] [--no-beautify] [--headed]
                       [--timeout 秒] [--vm-module 可信本地VM模块（仅 sb1/sb2 转换）]

优先保留变量名、广播名、作用域ID、初值及原始积木图。
auto 默认静态提取，不运行未知HTML；static 禁止运行时；dynamic 显式执行产物并收集辅助证据。
--vm-module 只用于旧格式（sb1/sb2）转换；代码恢复的重编译预言机固定使用随包 vendor/02-vm.cjs
（该文件先做 sha256 完整性校验再加载），不随此选项改变。
结构美化默认开启：仅对模板恢复的IR做可证明的语义级等价变换与布局重排；--no-beautify 关闭。
  注意：oracle 恢复模式会保留编译器验证过的积木图，只重排布局，不做布尔双重否定折叠——
  该折叠会让积木重编译出与产物不同的 JavaScript，因而无法通过重编译校验。报告会如实标注。
代码美化默认开启：对解混淆后的 factorySource 只做标识符重命名（变量/列表别名按工程元数据
权威反查命名，混淆临时量编号化），逐工厂做 α-等价验证，失败自动回退原文；--no-beautify 关闭。
未知/混淆代码不猜测；输出附带 fidelity-report.json 和可读 .md，未恢复代码在积木注释中标记。
退出码：0=完整保留；2=结构无效；3=部分/未验证重构；--allow-partial 可接受后者但不改变报告。
  安全提示：dynamic 会执行输入中的JavaScript，仅用于你拥有或获授权的产物，应在隔离环境运行。
verify 也会执行原始/恢复产物中的编译代码；必须显式指定 --allow-execute。worker/V8限制不是安全沙箱，不能隔离文件系统或原生资源。`;

function options(argv) {
  const opts = {out: './unpacked', mode: 'auto', strategy: 'factory', recovery: 'oracle', headed: false, timeout: 120,
    timeoutMs: 10000, maxSteps: 1000, allowExecute: false, allowPeerExecute: false,
    allowPartial: false, overwrite: false, beautify: true, peerDeobfuscator: 'none'};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['-o', '--out', '--mode', '--strategy', '--recovery', '--peer-output', '--peer-decompiler', '--peer-deobfuscator',
      '--timeout', '--timeout-ms', '--max-steps', '--vm-module'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
      if (arg === '--mode') opts.mode = value;
      else if (arg === '--recovery') opts.recovery = value;
      else if (arg === '--strategy') opts.strategy = value;
      else if (arg === '--peer-output') opts.peerOutput = value;
      else if (arg === '--peer-decompiler') opts.peerDecompiler = value;
      else if (arg === '--peer-deobfuscator') opts.peerDeobfuscator = value;
      else if (arg === '--timeout') opts.timeout = Number(value);
      else if (arg === '--timeout-ms') opts.timeoutMs = Number(value);
      else if (arg === '--max-steps') opts.maxSteps = Number(value);
      else if (arg === '--vm-module') opts.vmModule = value;
      else opts.out = value;
    } else if (arg === '--headed') opts.headed = true;
    else if (arg === '--no-beautify') opts.beautify = false;
    else if (arg === '--allow-execute') opts.allowExecute = true;
    else if (arg === '--allow-peer-execute') opts.allowPeerExecute = true;
    else if (arg === '--allow-partial') opts.allowPartial = true;
    else if (arg === '--overwrite') opts.overwrite = true;
    else if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
    else positional.push(arg);
  }
  if (!['auto', 'static', 'dynamic'].includes(opts.mode)) throw new Error('mode 必须为 auto/static/dynamic');
  if (!['factory', 'hybrid'].includes(opts.strategy)) throw new Error('strategy must be factory/hybrid');
  if (!['strict', 'oracle'].includes(opts.recovery)) throw new Error('recovery 必须为 strict/oracle');
  if (!['none', 'webcrack', 'javascript-deobfuscator'].includes(opts.peerDeobfuscator)) {
    throw new Error('peer-deobfuscator must be none/webcrack/javascript-deobfuscator');
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0 || opts.timeout > 600) throw new Error('timeout 必须为1至600秒');
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 600000) throw new Error('timeout-ms 必须为1至600000毫秒的整数');
  if (!Number.isSafeInteger(opts.maxSteps) || opts.maxSteps < 1 || opts.maxSteps > 1000000) throw new Error('max-steps 必须为1至1000000的整数');
  return {opts, positional};
}

/**
 * A readable listing of exactly the scripts and procedures that could not be turned back into blocks, with
 * their deobfuscated source and the reason. These are the items that still need a person; everything else
 * is already in the SB3. The listing is a side file, so the SB3 stays free of generated source comments.
 */
function unrecoveredSourceListing(decodedCompiledText, report) {
  const compiled = JSON.parse(decodedCompiledText);
  const targets = compiled.targets || [];
  const sections = [];
  for (const entry of report.code.unresolved) {
    if (entry.kind !== 'script' && entry.kind !== 'procedure') continue;
    const key = Object.keys(compiled.compiledTargets).find(k => (compiled.compiledTargets[k].targetIndex ?? Number(k)) === entry.targetIndex);
    const bundle = key !== undefined ? compiled.compiledTargets[key] : null;
    const source = entry.kind === 'script' ? bundle?.scripts?.[entry.scriptId]?.factorySource : bundle?.procedures?.[entry.variant]?.factorySource;
    if (typeof source !== 'string') continue;
    const target = targets[entry.targetIndex];
    const label = entry.kind === 'script' ? `script ${entry.scriptId}` : `procedure ${entry.variant}`;
    const hat = entry.kind === 'script' ? bundle?.hats?.find(h => h.topBlockId === entry.scriptId)?.opcode : null;
    sections.push({order: `${String(entry.targetIndex).padStart(4, '0')}\u0000${entry.kind}\u0000${label}`,
      text: `// ${'='.repeat(70)}\n// ${target?.isStage ? 'Stage' : 'Sprite'} "${target?.name ?? entry.targetIndex}"  ${label}${hat ? `  (${hat})` : ''}\n` +
        `// not recovered: ${String(entry.reason).replace(/\s+/g, ' ')}\n// ${'='.repeat(70)}\n${source}\n`});
  }
  sections.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  return `// Deobfuscated source of the ${sections.length} item(s) that were NOT turned back into blocks.\n` +
    `// Items that were recovered are in the SB3; see the fidelity report for the reason each one here was refused.\n\n${sections.map(s => s.text).join('\n')}`;
}

async function writeOutputs(files, overwrite) {
  if (!overwrite) {
    for (const [name] of files) {
      try { await fsp.access(name); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`文件已存在，未覆盖：${name}（明确需要时使用 --overwrite）`);
    }
  }
  for (const [name, data] of files) await fsp.writeFile(name, data, {flag: overwrite ? 'w' : 'wx'});
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(usage); return 0; }
  const [command, ...rest] = argv;
  const {opts, positional} = options(rest);
  if (command === 'verify') {
    if (positional.length !== 2) throw new Error(`verify 需要且仅需要两个输入文件（原始、恢复）。
${usage}`);
    if (!opts.allowExecute) {
      const report = await verifyArtifact({allowExecute: false, timeoutMs: opts.timeoutMs, maxSteps: opts.maxSteps});
      console.log(JSON.stringify(report, null, 2));
      return 4;
    }
    const [originalPath, recoveredPath] = positional;
    const report = await verifyArtifact({
      originalData: new Uint8Array(await fsp.readFile(originalPath)),
      recoveredData: new Uint8Array(await fsp.readFile(recoveredPath)),
      allowExecute: true,
      timeoutMs: opts.timeoutMs,
      maxSteps: opts.maxSteps
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'matched') return 0;
    if (report.status === 'invalid') return 2;
    if (report.status === 'refused') return 4;
    if (report.status === 'error') return 1;
    return 3;
  }
  if (positional.length !== 1) throw new Error(`需要且仅需要一个输入文件。
${usage}`);
  const input = positional[0];
  const data = new Uint8Array(await fsp.readFile(input));
  if (command === 'identify') { console.log(JSON.stringify(await identify(data), null, 2)); return 0; }
  if (command === 'validate') {
    const validation = await validateSb3(data);
    console.log(JSON.stringify(validation, null, 2));
    return validation.ok ? 0 : 2;
  }
  if (command === 'deobfuscate') {
    const result = deobfuscate(new TextDecoder('utf-8', {fatal: true}).decode(data));
    let outCode = result.code;
    // 代码美化：仅标识符重命名（无工程元数据时别名保留原名），α-等价验证失败自动回退
    if (opts.beautify) {
      const pretty = prettifyFactorySource(result.code, {});
      result.report.pretty = pretty.report;
      if (pretty.report.applied) outCode = pretty.code;
    }
    const base = path.basename(input).replace(/\.[^.]+$/, '');
    await fsp.mkdir(opts.out, {recursive: true});
    const files = [[path.join(opts.out, `${base}.deobfuscated.js`), outCode + '\n'],
      [path.join(opts.out, `${base}.deobfuscation-report.json`), JSON.stringify(result.report, null, 2)]];
    await writeOutputs(files, opts.overwrite);
    console.log(`解混淆：${result.report.status}；残留项：${result.report.residuals.length}；转换：${result.report.transforms.length}步；未执行输入代码。`);
    if (result.report.pretty) console.log(`代码美化：重命名 ${result.report.pretty.renamedCount} 个标识符（验证 ${result.report.pretty.verification}）；--no-beautify 关闭。`);
    for (const [name] of files) console.log(`输出：${path.resolve(name)}`);
    return result.report.status === 'partial' ? 3 : 0;
  }
  if (command !== 'unpack') throw new Error(`未知命令：${command}`);
  const id = await identify(data);
  console.log(`识别：${id.family} / ${id.format}`);
  let staticResult;
  let staticError;
  // Even explicit dynamic mode needs original asset bytes and initial symbol definitions.
  try { staticResult = await staticUnpack(data); }
  catch (error) { staticError = error; console.log(`静态提取未成功：${error.message}`); }
  let dynamicResult;
  let dynamicError;
  if (opts.mode === 'dynamic') {
    console.log('动态辅助：执行产物；保留容器初始状态，不用运行后变量覆盖原始值。');
    try {
      const {dynamicExtract} = await import('../src/dynamic-extract.mjs');
      dynamicResult = await dynamicExtract(input, {timeoutMs: opts.timeout * 1000, headed: opts.headed});
    } catch (error) { dynamicError = error; console.log(`动态辅助失败：${error.message}`); }
  }
  if (!staticResult && !dynamicResult) throw staticError || dynamicError || new Error('没有可用工程');
  let legacyConversion = null;
  if (staticResult && ['sb', 'sb1', 'sb2'].includes(staticResult.type)) {
    const {loadLegacyAdapter} = await import('../src/legacy-adapter.mjs');
    const {convertLegacy} = await import('../src/legacy-convert.mjs');
    const VirtualMachine = opts.vmModule ? await loadLegacyAdapter(opts.vmModule) :
      (await import('../src/default-vm.mjs')).installedVirtualMachine();
    const converted = await convertLegacy({data: staticResult.data, type: staticResult.type, VirtualMachine});
    legacyConversion = converted.metadata;
    staticResult = {...staticResult, type: 'sb3', data: converted.bytes, notes: [...(staticResult.notes || []),
      '旧格式经显式真实VM转换；内部ID/布局已变化，代码完整度与行为等价未验证']};
  }
  if (staticResult && staticResult.type !== 'sb3' && !dynamicResult) {
    throw new Error(`提取出 ${staticResult.type}；转换为SB3需要 --vm-module 指定可信本地VM模块，不会改扩展名冒充成功`);
  }
  const restored = await restoreSb3({staticResult, dynamicResult,
    inputSha256: createHash('sha256').update(data).digest('hex'), format: staticResult?.format || id.format,
    beautify: opts.beautify, recoveryMode: opts.recovery});
  if (dynamicError) restored.report.notes.push(`动态辅助失败：${dynamicError.message}`);
  let hybridResult = null;
  let hybridCandidate = null;
  if (opts.strategy === 'hybrid') {
    if (!opts.peerOutput && !opts.peerDecompiler) {
      throw new Error('hybrid 需要 --peer-output 或 --peer-decompiler');
    }
    try {
      hybridCandidate = opts.peerOutput
        ? await loadPeerOutput(opts.peerOutput)
        : await runPeerUnpackager(input, {
          peerRoot: opts.peerDecompiler,
          deobfuscator: opts.peerDeobfuscator,
          allowPeerExecute: opts.allowPeerExecute,
          timeoutMs: opts.timeout * 1000
        });
      const compiledText = restored.decodedCompiledProject || restored.compiledProject;
      const compiledObject = compiledText ? JSON.parse(compiledText) : null;
      if (!compiledObject?.compiledTargets || !Array.isArray(compiledObject.targets)) {
        throw new Error('未提取到完整 compiledTargets/targets，无法聚焦验证候选');
      }
      hybridResult = await inspectPeerCandidate({
        baseProject: restored.project,
        peerData: hybridCandidate.candidateData,
        compiledProject: compiledObject
      });
      const verifiedRecords = [];
      for (const record of hybridResult.records.filter(item => item.status === 'candidate-only-unverified')) {
        if (!opts.allowExecute) {
          record.status = 'candidate-only-execution-not-authorized';
          record.reason = '静态结构通过；需显式传入 --allow-execute 才会运行候选代码验证';
          continue;
        }
        const target = restored.project.targets[record.targetIndex];
        const candidate = await buildFocusedCandidate({
          baseData: staticResult.data,
          sourceProject: restored.project,
          peerProject: hybridResult.peerProject,
          record,
          usedBlockIds: Object.keys(target.blocks || {})
        });
        if (!candidate.ok) {
          record.status = 'rejected-focused-project';
          record.reason = candidate.reason;
          record.validation = candidate.validation || null;
          hybridResult.stats.rejectedScripts++;
          hybridResult.stats.candidateOnlyScripts--;
          continue;
        }
        const verification = await verifyArtifact({
          originalData: staticResult.data,
          originalCompiledProject: compiledObject,
          recoveredData: candidate.data,
          focusScript: {targetIndex: record.targetIndex, scriptId: record.scriptId, opcode: record.opcode},
          allowExecute: true,
          timeoutMs: opts.timeout * 1000,
          maxSteps: opts.maxSteps
        });
        record.focusedVerification = {
          status: verification.status,
          matched: verification.matched,
          elapsedMs: verification.execution.elapsedMs,
          engine: verification.engine,
          originalRun: verification.runs.original && {finished: verification.runs.original.finished,
            focusThreadCount: verification.runs.original.focusThreadCount},
          recoveredRun: verification.runs.recovered && {finished: verification.runs.recovered.finished,
            focusThreadCount: verification.runs.recovered.focusThreadCount},
          behavior: verification.behavior,
          recompile: verification.recompile,
          structural: verification.structural
        };
        if (!verification.matched) {
          record.status = 'candidate-only-verification-failed';
          record.reason = '聚焦 02 VM 状态/广播/事件轨迹未匹配';
          hybridResult.stats.candidateOnlyScripts--;
          continue;
        }
        const merged = await mergeVerifiedGraph({baseData: restored.data, project: restored.project,
          targetIndex: record.targetIndex, graph: candidate.blocks});
        if (!merged.ok) {
          record.status = 'candidate-only-merge-failed';
          record.reason = merged.reason;
          record.mergeValidation = merged.validation;
          hybridResult.stats.candidateOnlyScripts--;
          hybridResult.stats.rejectedScripts++;
          continue;
        }
        record.status = 'verified-and-merged';
        record.reason = '隔离的单帽子场景经真实 02 VM 重编译与执行差分匹配';
        record.acceptedBlockCount = Object.keys(candidate.blocks).length;
        restored.data = merged.data;
        restored.project = merged.project;
        restored.validation = merged.validation;
        verifiedRecords.push(record);
      }
      for (const record of verifiedRecords) {
        restored.report.code.unresolved = restored.report.code.unresolved.filter(entry =>
          !(entry.targetIndex === record.targetIndex && entry.scriptId === record.scriptId));
        restored.report.code.scripts = restored.report.code.scripts.filter(entry =>
          !(entry.targetIndex === record.targetIndex && entry.scriptId === record.scriptId));
        restored.report.code.scripts.push({targetIndex: record.targetIndex, scriptId: record.scriptId,
          source: 'peer-high-recall-decompiler', status: 'peer-reconstructed-focused-verified',
          reason: '真实 02 VM 单帽子场景匹配；不代表未执行事件或全局行为已验证',
          body: {status: 'focused-runtime-match', confidence: {score: 0.9,
            basis: 'actual-02-vm-focused-script-state-and-trace-match', calibratedProbability: false}}});
        for (const [id, block] of Object.entries(restored.project.targets[record.targetIndex].blocks)) {
          if (block.topLevel && id !== record.scriptId) continue;
          restored.report.code.blocks.push({targetIndex: record.targetIndex, blockId: id,
            opcode: block.opcode, source: 'peer-high-recall-decompiler', status: 'focused-runtime-match'});
        }
      }
      restored.report.code.counts.unresolvedScripts = restored.report.code.scripts.filter(entry => entry.status === 'unresolved').length;
      restored.report.code.counts.hybridVerifiedScripts = verifiedRecords.length;
      restored.report.code.counts.hybridVerifiedBlocks = verifiedRecords.reduce((sum, entry) => sum + entry.acceptedBlockCount, 0);
      restored.report.targets = inventory(restored.project);
      restored.report.projectJsonSha256 = createHash('sha256').update(JSON.stringify(restored.project)).digest('hex');
      restored.report.acceptance.structural = restored.validation.ok;
      restored.report.validation = {ok: restored.validation.ok,
        errors: restored.validation.errors, warnings: restored.validation.warnings};
      restored.report.hybrid = {
        strategy: 'peer-candidate-focused-02vm-verification',
        peerOutput: hybridCandidate.outputPath,
        peerBlocks: hybridResult.stats.peerBlocks,
        knownScripts: hybridResult.stats.knownScripts,
        matchedPeerScripts: hybridResult.stats.matchedPeerScripts,
        candidateOnlyScripts: hybridResult.records.filter(item => item.status.startsWith('candidate-only')).length,
        verifiedAndMergedScripts: verifiedRecords.length,
        verifiedAndMergedBlocks: verifiedRecords.reduce((sum, entry) => sum + entry.acceptedBlockCount, 0),
        duplicateOfFactoryScripts: hybridResult.stats.duplicateOfFactoryScripts,
        unavailableScripts: hybridResult.stats.unavailableScripts,
        rejectedScripts: hybridResult.stats.rejectedScripts,
        byStatus: hybridResult.stats.byStatus,
        peerValidation: hybridResult.peerValidation,
        candidateSha256: createHash('sha256').update(hybridCandidate.candidateData).digest('hex'),
        formalProjectSha256: createHash('sha256').update(restored.data).digest('hex'),
        records: hybridResult.records
      };
      restored.report.notes.push('hybrid：候选 ' + hybridResult.stats.peerBlocks + ' 块；真实 02 VM 聚焦验证通过并合入 ' +
        verifiedRecords.length + ' 个脚本；未通过或未授权验证的候选仅保留在候选包中');
    } catch (error) {
      throw new Error('hybrid 候选处理失败：' + error.message);
    }
  }
  const report = restored.report;
  if (legacyConversion) {
    report.legacyConversion = legacyConversion;
    report.status = 'reconstructed-unverified';
    report.canClaimComplete = false;
    report.acceptance.codeCompleteAndVerified = false;
    report.acceptance.originalStatePreserved = !!legacyConversion.sourceState.preserved;
    report.confidence.variableNames = {score: legacyConversion.sourceState.preserved ? 1 : 0.5, basis: 'checked-legacy-source-state', calibratedProbability: false};
    report.confidence.broadcastNames = {score: 0.5, basis: 'legacy-broadcast-normalization-not-independently-proved', calibratedProbability: false};
    report.confidence.code = {score: 0.65, basis: 'real-vm-legacy-import-without-opcode-completeness-proof', calibratedProbability: false};
    report.confidence.originalBlockStructure = {score: 0, basis: 'legacy-vm-conversion-regenerates-ids-and-layout', calibratedProbability: false};
    report.limitations.push(...legacyConversion.limitations);
  }
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const suffix = report.status === 'preserved' ? '' : report.status === 'reconstructed-unverified' ? '.reconstructed' : '.partial';
  await fsp.mkdir(opts.out, {recursive: true});
  const reportPath = path.join(opts.out, `${base}.fidelity-report.json`);
  const files = [[reportPath, JSON.stringify(report, null, 2)],
    [path.join(opts.out, `${base}.fidelity-report.md`), fidelityMarkdown(report)]];
  if (restored.compiledProject) files.push([path.join(opts.out, `${base}.compiled-project.json`), restored.compiledProject]);
  if (restored.decodedCompiledProject) files.push([path.join(opts.out, `${base}.deobfuscated-compiled-project.json`), restored.decodedCompiledProject]);
  if (restored.decodedCompiledProject && report.code.unresolved.length) {
    files.push([path.join(opts.out, `${base}.unrecovered-source.js`), unrecoveredSourceListing(restored.decodedCompiledProject, report)]);
  }
  if (hybridCandidate) files.push([path.join(opts.out, `${base}.peer-candidate.sb3`), hybridCandidate.candidateData]);
  if (hybridResult) files.push([path.join(opts.out, `${base}.hybrid-report.json`), JSON.stringify(report.hybrid, null, 2)]);
  if (report.status !== 'invalid') files.unshift([path.join(opts.out, `${base}${suffix}.sb3`), restored.data]);
  await writeOutputs(files, opts.overwrite);
  console.log(`状态：${report.status}；代码置信度证据分：${report.confidence.code.score}（非统计概率）`);
  console.log(`变量名证据分：${report.confidence.variableNames.score}；广播名证据分：${report.confidence.broadcastNames.score}`);
  console.log(`完整还原声明：${report.canClaimComplete ? '产物内积木图原样保留' : '不满足，详见未恢复脚本与限制'}`);
  for (const [name] of files) console.log(`输出：${path.resolve(name)}`);
  if (report.status === 'invalid') return 2;
  if (!report.canClaimComplete && !opts.allowPartial) return 3;
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[factory] ${error.message}`);
    process.exitCode = 1;
  });
}
