import JSZip from '@turbowarp/jszip';
import {createHash} from 'node:crypto';
import {recoverCompiledCode} from './recover-code.mjs';
import {analyzePreservedBlocks, compareRuntime, makeFidelityReport} from './fidelity.mjs';
import {validateSb3} from './sb3-validate.mjs';
import {deobfuscateMany} from './deobfuscate-pool.mjs';
import {recoverWithOracle} from './relaxed-recovery.mjs';
import {prettifyFactorySource} from './pretty-code.mjs';
import {layoutRecoveredProject} from './recovery-layout.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** 变量/列表别名美化的权威反查：严格限定声明作用域，查不到即保持原名。 */
const makeBindingResolver = (compiledProject, targetKey) => {
  const targets = compiledProject?.targets;
  if (!Array.isArray(targets)) return null;
  const entry = compiledProject.compiledTargets?.[targetKey];
  const index = Number.isInteger(entry?.targetIndex) ? entry.targetIndex : Number(targetKey);
  const current = targets[index];
  const stage = targets.find(candidate => candidate?.isStage) || targets[0];
  return (scope, id) => {
    const source = scope === 'stage' ? stage : current;
    if (source?.variables && Object.hasOwn(source.variables, id)) return {name: source.variables[id]?.[0], kind: 'variable'};
    if (source?.lists && Object.hasOwn(source.lists, id)) return {name: source.lists[id]?.[0], kind: 'list'};
    return null;
  };
};

/** 过程内层函数名：去掉 W/Z 变体前缀后按 proccode 清洗，脚本固定为 script。 */
const procedureInnerName = (kind, scriptId) => {
  if (kind !== 'procedures') return 'script';
  const proccode = /^[WZ]/.test(scriptId) ? scriptId.slice(1) : scriptId;
  const base = proccode.replace(/[^A-Za-z0-9_$]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return base ? `proc_${base}` : 'proc';
};

/** Original names, scope IDs and initial values outrank later runtime serialization. */
export async function restoreSb3({staticResult, dynamicResult, inputSha256, format = 'unknown', beautify = true, recoveryMode = 'oracle'}) {
  const fromContainer = staticResult?.type === 'sb3';
  const bytes = fromContainer ? staticResult.data : dynamicResult?.data;
  if (!bytes) throw new Error('没有可恢复的 SB3 数据；不会把 SB1/SB2 或未知二进制改扩展名冒充 SB3');
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
  const projectFile = zip.file('project.json') || Object.values(zip.files).find(f => !f.dir && f.name.endsWith('/project.json'));
  if (!projectFile) throw new Error('恢复输入缺少 project.json');
  const sourceText = await projectFile.async('text');
  const sourceProject = JSON.parse(sourceText);
  if (!Array.isArray(sourceProject.targets)) throw new Error('不是 SB3 targets 工程；当前不静默转换旧格式');
  let project = clone(sourceProject);
  const prefix = projectFile.name.slice(0, -'project.json'.length);
  let compiledProject = null;
  let bundleError = null;
  const precompileHint = /precompile/.test(staticResult?.format || format);
  if (staticResult?.compiledProject) {
    try {
      compiledProject = JSON.parse(staticResult.compiledProject);
      if (compiledProject.format !== '02engine-compiled-project' || compiledProject.version !== 1 ||
          !compiledProject.compiledTargets || typeof compiledProject.compiledTargets !== 'object' ||
          Array.isArray(compiledProject.compiledTargets)) throw new Error('不支持或无效的02编译包 schema/version');
      const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
      const mapped = new Set();
      for (const [key, target] of Object.entries(compiledProject.compiledTargets)) {
        const index = Number.isInteger(target?.targetIndex) ? target.targetIndex : Number(key);
        if (!dictionary(target) || !Number.isInteger(index) || index < 0 || index >= project.targets.length || mapped.has(index)) {
          throw new Error('compiledTargets 存在无效/重复的角色对应关系');
        }
        mapped.add(index);
        if (!dictionary(target.scripts) || !dictionary(target.procedures) || !Array.isArray(target.hats)) {
          throw new Error('编译角色缺少 scripts/procedures/hats schema，不能证明代码清单完整');
        }
        for (const entry of [...Object.values(target.scripts), ...Object.values(target.procedures)]) {
          if (!dictionary(entry) || typeof entry.factorySource !== 'string') throw new Error('编译函数缺少 factorySource');
        }
        for (const hat of target.hats) {
          if (!dictionary(hat) || typeof hat.topBlockId !== 'string' || typeof hat.opcode !== 'string') {
            throw new Error('事件帽子 metadata 无效');
          }
        }
      }
      if (mapped.size !== project.targets.length) throw new Error('compiledTargets 漏掉角色，不能确认遗漏角色的代码是否完整');
    } catch (error) {
      compiledProject = null;
      bundleError = `编译包无法用于代码恢复：${error.message}`;
    }
  } else if (precompileHint) {
    bundleError = '检测到预编译产物但缺少编译包，不能声明代码完整';
  }
  let decodedCompiledProject = null;
  const deobfuscationRecords = [];
  if (compiledProject) {
    decodedCompiledProject = clone(compiledProject);
    // Deobfuscation is the dominant cost (~99% of the per-factory time) and each factory is
    // independent, so run all of them up front on worker threads. Results come back indexed by
    // input position, and the loop below consumes them in the original traversal order, so the
    // report and the output are identical to the former one-at-a-time version.
    const jobs = [];
    for (const target of Object.values(decodedCompiledProject.compiledTargets)) {
      for (const kind of ['scripts', 'procedures']) {
        for (const script of Object.values(target[kind])) jobs.push(script.factorySource);
      }
    }
    const deobfuscated = await deobfuscateMany(jobs);
    let jobIndex = 0;
    for (const [targetKey, target] of Object.entries(decodedCompiledProject.compiledTargets)) {
      for (const kind of ['scripts', 'procedures']) {
        for (const [scriptId, script] of Object.entries(target[kind])) {
          const originalSource = script.factorySource;
          const outcome = deobfuscated[jobIndex++];
          try {
            if (!outcome.ok) throw new Error(outcome.error.message);
            const decoded = outcome.value;
            let finalCode = decoded.code;
            let prettyReport = null;
            // 代码美化：仅标识符重命名，自带 α-等价验证；失败回退解混淆原文。
            if (beautify !== false && decoded.status !== 'error') {
              const pretty = prettifyFactorySource(decoded.code, {
                resolveBinding: makeBindingResolver(decodedCompiledProject, targetKey),
                innerName: procedureInnerName(kind, scriptId)
              });
              prettyReport = pretty.report;
              if (pretty.report.applied) finalCode = pretty.code;
            }
            script.factorySource = finalCode;
            script.originalSourceSha256 = sha256(originalSource);
            script.analyzedSourceSha256 = sha256(finalCode);
            script.deobfuscation = decoded.report;
            if (prettyReport) script.pretty = prettyReport;
            deobfuscationRecords.push({targetKey, kind, scriptId, originalSha256: sha256(originalSource),
              decodedSha256: sha256(finalCode), prettyRenamed: prettyReport?.renamedCount ?? 0, ...decoded.report});
          } catch (error) {
            const originalSha256 = sha256(originalSource);
            script.originalSourceSha256 = originalSha256;
            script.analyzedSourceSha256 = originalSha256;
            script.deobfuscation = {status: 'error', transforms: [], residuals: [], warnings: [error.message]};
            deobfuscationRecords.push({targetKey, kind, scriptId, originalSha256,
              decodedSha256: originalSha256, ...script.deobfuscation});
          }
        }
      }
    }
  }
  let recovery;
  let oracleSummary = null;
  if (decodedCompiledProject && recoveryMode === 'oracle') {
    // Relaxed decoding proposes blocks; the real 02 compiler decides which of them are kept. Items that
    // needed no assumption are exactly the strict result and are never removed, so this can only add
    // verified code. If the pinned compiler cannot run here, fall back to strict recovery unchanged.
    try {
      const stripped = clone(project);
      for (const target of stripped.targets) { target.blocks = {}; target.comments = {}; }
      const archive = await JSZip.loadAsync(bytes, {checkCRC32: true});
      const judged = await recoverWithOracle(stripped, decodedCompiledProject, {archive});
      project = judged.project;
      recovery = judged.result;
      oracleSummary = {...judged.oracle, mode: 'oracle', engine: 'vendor/02-vm.cjs'};
    } catch (error) {
      // Falling back is honest but consequential: the recovered items are no longer compiler-verified, and
      // `--vm-module` cannot restore the oracle (it only drives sb1/sb2 conversion). Say so loudly rather
      // than leaving the reason buried in the JSON.
      oracleSummary = {mode: 'strict-fallback', reason: `重编译预言机不可用：${error.message}`};
      project = clone(sourceProject);
      recovery = recoverCompiledCode(project, decodedCompiledProject, {beautify: false});
      console.warn(`[factory] 重编译预言机不可用，已降级为 strict 恢复（积木未经重编译验证）：${error.message}`);
      console.warn('[factory] 该降级无法通过 --vm-module 恢复；请检查 vendor/02-vm.cjs 是否完整。');
    }
  } else {
    recovery = decodedCompiledProject ? recoverCompiledCode(project, decodedCompiledProject, {beautify: false}) : analyzePreservedBlocks(project);
    if (decodedCompiledProject) oracleSummary = {mode: 'strict'};
  }
  // `applied` is the structural rewrite only (the double-negation collapse); `layoutApplied` is the editor
  // layout pass. They are separate because the oracle path deliberately keeps the compiler-verified graph
  // and only moves blocks around, and a single flag would have to lie about one of the two.
  const beautyGate = {requested: beautify !== false, applied: false, layoutApplied: false, structurallyValidated: false,
    reason: beautify === false ? 'disabled-by-user' : !decodedCompiledProject ? 'preserved-source-graph' : 'requires-complete-unambiguous-validated-recovery'};
  const output = new JSZip();
  // Without reconstruction, retain the exact JSON bytes, including IDs, spelling and source layout.
  output.file('project.json', compiledProject ? JSON.stringify(project) : sourceText);
  const assets = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || name === projectFile.name || !name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (!relative || relative.split('/').some(part => part === '..') || relative.includes('\\')) {
      throw new Error(`不安全的资源路径：${relative}`);
    }
    const content = await file.async('uint8array');
    if (output.file(relative)) throw new Error(`重复资源路径：${relative}`);
    output.file(relative, content);
    assets.push({path: relative, bytes: content.length, sha256: sha256(content), source: fromContainer ? 'container' : 'runtime'});
  }
  for (const file of Object.values(output.files)) file.date = new Date('2026-01-01T00:00:00Z');
  let data = await output.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  let validation = await validateSb3(data);
  const complete = !recovery.unresolved.length && recovery.procedures.every(record => record.status !== 'unresolved') &&
    recovery.scripts.every(record => record.status === 'procedure-body-copy' ||
      record.status === 'reconstructed-unverified' && record.body.confidence.score >= 0.75 && record.event?.kind !== 'none');
  const clearDeobfuscation = deobfuscationRecords.every(record => record.status !== 'error' && record.status !== 'partial' &&
    !record.residuals?.length);
  if (beautify !== false && decodedCompiledProject) {
    beautyGate.structurallyValidated = validation.ok;
    if (!validation.ok) beautyGate.reason = 'structural-validation-failed';
    else if (!complete || !clearDeobfuscation) beautyGate.reason = 'incomplete-or-ambiguous-code';
    else {
      // Validate the unmodified reconstruction first. A failed display pass must
      // never replace that graph or change the associated recovery evidence.
      try {
        // After oracle recovery the project already holds the compiler-verified graph, including the
        // coercion unwrapping the oracle confirmed. Re-deriving it with strict recovery would silently
        // discard that result, so only the layout pass is applied to a copy of what was verified.
        //
        // The double-negation collapse is deliberately NOT applied here. It is only equivalent at the
        // Scratch level (`if (not (not x))` runs the same as `if (x)`), but the shipped factory spells the
        // cast out as `toBoolean(...)`, so collapsing it makes the graph compile to different JavaScript
        // than the artifact contains — the recompilation oracle then refuses the item. The oracle path
        // therefore keeps the verified graph and only moves blocks, and the report says exactly that
        // instead of claiming a structural rewrite it did not perform.
        const oracleApplied = oracleSummary?.mode === 'oracle';
        const candidate = oracleApplied ? clone(project) : clone(sourceProject);
        const candidateRecovery = oracleApplied ? recovery :
          recoverCompiledCode(candidate, decodedCompiledProject, {beautify: true, validatedForBeautify: true});
        if (candidateRecovery.unresolved.length || candidateRecovery.procedures.some(record => record.status === 'unresolved')) {
          throw new Error('Beautified recovery introduced unresolved code');
        }
        const candidateLayout = layoutRecoveredProject(candidate);
        output.file('project.json', JSON.stringify(candidate));
        const candidateData = await output.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
        const candidateValidation = await validateSb3(candidateData);
        if (!candidateValidation.ok) throw new Error(candidateValidation.errors.join('; '));
        project = candidate;
        recovery = candidateRecovery;
        data = candidateData;
        validation = candidateValidation;
        beautyGate.applied = !oracleApplied && candidateRecovery.scripts
          .concat(candidateRecovery.procedures)
          .some(record => (record.beautify?.doubleNotCollapsed ?? 0) > 0);
        beautyGate.layoutApplied = true;
        beautyGate.layout = candidateLayout;
        beautyGate.reason = oracleApplied ?
          'oracle-verified-graph-retained-structural-rewrite-not-applied-layout-only' :
          beautyGate.applied ? 'complete-reconstruction-validated-before-and-after' :
            'gate-passed-but-no-structural-rewrite-was-available-layout-only';
      } catch (error) {
        output.file('project.json', JSON.stringify(project));
        beautyGate.reason = 'display-pass-rejected-original-reconstruction-retained';
        beautyGate.error = error.message;
      }
    }
  }
  const runtime = compareRuntime(sourceProject, dynamicResult?.projectJSON);
  const report = makeFidelityReport({sourceProject, outputProject: project, inputSha256, format,
    compiledProject, recovery, validation, runtime, bundleError,
    sourceKind: fromContainer ? 'container' : 'runtime-only', assetRecords: assets, notes: staticResult?.notes || []});
  report.code.beautify = {...report.code.beautify, ...beautyGate};
  if (oracleSummary) {
    const recovered = [...recovery.scripts, ...recovery.procedures].filter(r => r.status === 'reconstructed-unverified' && r.event?.kind !== 'none');
    const verified = recovered.filter(r => r.recompilation?.status === 'match');
    report.code.recompilation = {...oracleSummary, recoveredItems: recovered.length, recompiledAndMatching: verified.length,
      meaning: '每个标记项的积木经随包真实02编译器重编译后，其factorySource与产物中的factorySource在标识符重命名、字面量折叠、积木ID之外完全一致。' +
        '这证明该项与打包产物行为相同，不证明它等于作者的原积木图（编译器会折叠常量、删除死分支、展开循环）。'};
    // The tool-wide flag only becomes true when nothing is left unrecovered and every recovered item matched;
    // otherwise the per-item counts above are the honest statement.
    // Same predicate as the whole-project score cap in fidelity.mjs: it counts every script and procedure,
    // including stand-alone stacks that were never put to the oracle (`recovered` above leaves them out).
    const everyItem = [...recovery.scripts, ...recovery.procedures];
    if (recoveryMode === 'oracle' && oracleSummary.mode === 'oracle' && !recovery.unresolved.length &&
        everyItem.length > 0 && verified.length > 0 &&
        everyItem.every(item => item.status === 'procedure-body-copy' || item.recompilation?.status === 'match')) {
      report.acceptance.roundTripRecompilationVerified = true;
    }
  }
  report.deobfuscation = {engine: 'bounded-static-ast', executesInput: false,
    factories: deobfuscationRecords, transformedFactories: deobfuscationRecords.filter(x => x.status === 'transformed').length,
    prettyFactories: deobfuscationRecords.filter(x => x.prettyRenamed > 0).length,
    prettyRenamedTotal: deobfuscationRecords.reduce((sum, x) => sum + (x.prettyRenamed || 0), 0)};
  return {data, project, report, validation, compiledProject: staticResult?.compiledProject || null,
    decodedCompiledProject: decodedCompiledProject ? JSON.stringify(decodedCompiledProject, null, 2) : null};
}
