import {createHash} from 'node:crypto';

const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = text => createHash('sha256').update(text).digest('hex');
const evidenceScore = (score, basis) => ({score, basis, calibratedProbability: false});

export function inventory(project) {
  return (project.targets || []).map((target, targetIndex) => ({
    targetIndex, name: target.name, isStage: !!target.isStage,
    variables: Object.entries(target.variables || {}).map(([id, value]) =>
      ({id, name: value[0], initialValue: clone(value[1]), cloud: !!value[2]})),
    lists: Object.entries(target.lists || {}).map(([id, value]) =>
      ({id, name: value[0], initialValue: clone(value[1])})),
    broadcasts: Object.entries(target.broadcasts || {}).map(([id, name]) => ({id, name}))
  }));
}

export function analyzePreservedBlocks(project) {
  const scripts = [];
  const blocks = [];
  for (const [targetIndex, target] of (project.targets || []).entries()) {
    for (const [blockId, block] of Object.entries(target.blocks || {})) {
      blocks.push({targetIndex, blockId, opcode: Array.isArray(block) ? `primitive:${block[0]}` : block.opcode,
        source: 'original-project-json', confidence: evidenceScore(1, 'copied-without-code-inference')});
      if ((!Array.isArray(block) && block.topLevel && !block.shadow) || Array.isArray(block)) {
        scripts.push({targetIndex, scriptId: blockId, source: 'original-project-json', status: 'preserved',
          body: {status: 'preserved', confidence: evidenceScore(1, 'original-block-graph-present')},
          originalStructure: evidenceScore(1, 'original-block-id-layout-inputs-fields-preserved')});
      }
    }
  }
  return {scripts, blocks, procedures: [], unresolved: [], notes: []};
}

/** Runtime values may already be mutated. Definitions and initial state remain container-authoritative. */
export function compareRuntime(source, runtimeJSON) {
  if (!runtimeJSON) return {available: false, usedForOriginalState: false, differences: []};
  const differences = [];
  try {
    const runtime = typeof runtimeJSON === 'string' ? JSON.parse(runtimeJSON) : runtimeJSON;
    if (!Array.isArray(runtime.targets) || runtime.targets.length !== source.targets.length) {
      differences.push({field: 'targets.length', reason: '运行时克隆/角色数量与容器初态不同'});
    }
    for (const [targetIndex, original] of source.targets.entries()) {
      const candidate = runtime.targets?.[targetIndex];
      if (!candidate || candidate.name !== original.name || !!candidate.isStage !== !!original.isStage) {
        differences.push({targetIndex, field: 'identity', reason: '角色顺序/身份不同，拒绝跨角色套用运行时状态'});
        continue;
      }
      for (const field of ['variables', 'lists', 'broadcasts', 'blocks', 'x', 'y', 'direction', 'size', 'visible', 'currentCostume']) {
        if (!equal(original[field], candidate[field])) differences.push({targetIndex, field,
          reason: field === 'blocks' ? '运行时序列化结构与原始图不同，保留原始图' : '运行时值不同，保留容器中的原始名称/ID/初始值'});
      }
    }
    return {available: true, usedForOriginalState: false, differences};
  } catch (error) {
    return {available: true, usedForOriginalState: false, differences: [{field: 'project.json', reason: error.message}]};
  }
}

export function makeFidelityReport({sourceProject, outputProject, inputSha256, format, compiledProject,
  recovery, validation, runtime, bundleError, sourceKind = 'container', assetRecords = [], notes = []}) {
  const originalInventory = inventory(sourceProject);
  const outputInventory = inventory(outputProject);
  const preservedDefinitions = equal(originalInventory, outputInventory);
  const before = sourceProject.targets || [];
  const after = outputProject.targets || [];
  const preservedTargetProperties = before.length === after.length && before.every((target, index) => {
    const fields = Object.keys(target).filter(key => !['blocks', 'comments'].includes(key));
    return fields.every(key => equal(target[key], after[index]?.[key]));
  });
  const uncertainty = [...recovery.unresolved, ...recovery.procedures.filter(p => p.status === 'unresolved')];
  const reconstructed = recovery.scripts.filter(s => s.status === 'reconstructed-unverified');
  // `enabled` answers "did a structural rewrite actually happen", not "was the gate allowed to try".
  // It used to be set from the records alone, so it stayed true when `--no-beautify` was passed (records
  // still carry coercion counts) or when the oracle path deliberately kept the verified graph — and the
  // report then contradicted its own `applied: false`. Callers merge the gate on top (restore.mjs).
  const beautifiedRecords = [...recovery.scripts, ...recovery.procedures].filter(r => (r.beautify?.doubleNotCollapsed ?? 0) > 0);
  const beautifySummary = beautifiedRecords.length ? {
    enabled: true, basis: 'provably-semantics-preserving-ir-rewrite-in-boolean-contexts',
    scriptsTouched: beautifiedRecords.length,
    doubleNotCollapsed: beautifiedRecords.reduce((sum, r) => sum + (r.beautify.doubleNotCollapsed || 0), 0)
  } : {enabled: false, scriptsTouched: 0, doubleNotCollapsed: 0};
  const hasCompiled = !!compiledProject || !!bundleError;
  const missingCompiledCode = hasCompiled && (uncertainty.length > 0 ||
    (!Object.keys(compiledProject?.compiledTargets || {}).length && !recovery.scripts.length));
  const runtimeOnly = sourceKind !== 'container';
  const errors = [...(validation.errors || [])];
  if (!preservedDefinitions) errors.push('变量/列表/广播名称、ID、初始值未原样保留');
  if (!preservedTargetProperties) errors.push('角色初始属性未原样保留');
  if (bundleError) errors.push(bundleError);
  const status = errors.length ? 'invalid' : missingCompiledCode || runtimeOnly ? 'partial' :
    hasCompiled || reconstructed.length ? 'reconstructed-unverified' : 'preserved';
  // The whole-project cap stays at the template score (0.85) unless the real compiler reproduced every
  // recovered item: one unverified or unrecovered item keeps the cap, and the minimum rule below already
  // lets the worst item pull the score down, so strong results cannot average away a weak one.
  // "Every item" must not be vacuously true: an empty recovery says nothing about the code, and an item
  // that is a stand-alone stack (no event) or was never put to the oracle has no `recompilation` and so
  // correctly keeps the cap at the template score.
  const recoveredItems = [...recovery.scripts, ...recovery.procedures];
  const everyItemRecompiled = hasCompiled && recoveredItems.length > 0 && recoveredItems.every(item =>
    item.status === 'procedure-body-copy' || item.recompilation?.status === 'match') &&
    recoveredItems.some(item => item.recompilation?.status === 'match');
  const codeCap = everyItemRecompiled ? 0.95 : 0.85;
  const codeScore = errors.length || missingCompiledCode ? 0 : runtimeOnly ? 0.5 : hasCompiled ?
    Math.min(codeCap, ...recovery.scripts.map(s => s.body.confidence.score), ...recovery.procedures.map(p => p.confidence.score), codeCap) : 1;
  const canClaimComplete = status === 'preserved' && !runtimeOnly;
  return {
    schemaVersion: 1,
    input: {sha256: inputSha256, format},
    priority: ['variable-names-and-scope-ids', 'broadcast-names-and-ids', 'block-code-and-links'],
    status,
    canClaimComplete,
    acceptance: {structural: validation.ok, originalStatePreserved: preservedDefinitions && preservedTargetProperties,
      codeCompleteAndVerified: canClaimComplete, browserEditorLoadVerified: false,
      roundTripRecompilationVerified: false, behaviorEquivalenceVerified: false},
    confidencePolicy: {kind: 'rule-based-evidence-score', calibratedProbability: false,
      meaning: '证据分而非统计正确率；复制原始积木=1，metadata帽子=0.98，封闭AST模板=0.85，唯一名称回退=0.65，未恢复=0。无缺失不能替代重编译/行为验证。',
      originalSourceGuarantee: '被优化或删除的信息不能保证恢复；未知操作绝不伪装为完整脚本'},
    confidence: {
      variableNames: evidenceScore(preservedDefinitions && !runtimeOnly ? 1 : 0.5, sourceKind),
      broadcastNames: evidenceScore(preservedDefinitions && !runtimeOnly ? 1 : 0.5, sourceKind),
      code: evidenceScore(codeScore, hasCompiled ? (everyItemRecompiled ? 'every-recovered-item-recompiles-to-shipped-factory' : 'partial-or-unverified-compiled-code-recovery') : sourceKind),
      originalBlockStructure: evidenceScore(hasCompiled ? 0 : runtimeOnly ? 0.5 : 1,
        hasCompiled ? 'original-block-graph-stripped' : sourceKind)
    },
    targets: outputInventory,
    code: {scripts: recovery.scripts, blocks: recovery.blocks, procedures: recovery.procedures,
      unresolved: recovery.unresolved, unresolvedSchema: 'kind/status/reason/confidence/sourceSha256/originalSourceSha256/analyzedSourceSha256/annotationId',
      originalCodeArtifact: compiledProject ? 'compiled-project.json (CLI sidecar)' : null,
      knownCompiledScripts: recovery.scripts.length,
      beautify: beautifySummary,
      counts: {preservedScripts: recovery.scripts.filter(s => s.status === 'preserved').length,
        templateReconstructedScripts: reconstructed.length, unresolvedScripts: recovery.scripts.filter(s => s.status === 'unresolved').length,
        unresolvedProcedures: recovery.procedures.filter(p => p.status === 'unresolved').length}},
    runtime,
    assets: assetRecords,
    validation: {ok: validation.ok, errors, warnings: validation.warnings || []},
    limitations: hasCompiled ? ['原始内部block ID、布局、普通注释和被优化结构无法保证恢复',
      '模板识别未进行真实02编译器重编译差分验证', '解混淆按静态AST支持范围处理；未知动态行为/未覆盖积木语法仍保留原代码与残留报告'] :
      ['保留的是产物内存留工程，不保证与打包前被minify/优化的源文件字节完全一致', '结构校验不是编辑器试开或行为等价证明'],
    notes,
    projectJsonSha256: digest(JSON.stringify(outputProject))
  };
}

export function fidelityMarkdown(report) {
  const lines = [
    '# 代码还原与置信度报告', '',
    `- 状态：**${report.status}**`,
    `- 可以宣称完整还原：**${report.canClaimComplete ? '是（产物内原始积木图保留）' : '否'}**`,
    `- 优先原则：变量名及ID作用域、广播名及ID、积木代码与连接。`,
    `- 置信度是规则证据分，不是统计正确率；0.85 不表示有85%概率正确。`,
    `- 解混淆原始代码 sidecar：${report.code.originalCodeArtifact || '由CLI输出 compiled-project.json；SB3不内嵌源码正文'}`,
    `- 结构校验：${report.acceptance.structural ? '通过' : '失败'}；编辑器试开/重编译/行为验证：未执行。`,
    '', '## 变量与广播', ''
  ];
  for (const target of report.targets) {
    lines.push(`### ${target.targetIndex}: ${target.name}`, '');
    for (const variable of target.variables) lines.push(`- 变量 ${JSON.stringify(variable.name)}；ID ${JSON.stringify(variable.id)}；初值 ${JSON.stringify(variable.initialValue)}`);
    for (const list of target.lists) lines.push(`- 列表 ${JSON.stringify(list.name)}；ID ${JSON.stringify(list.id)}；初值 ${JSON.stringify(list.initialValue)}`);
    for (const broadcast of target.broadcasts) lines.push(`- 广播 ${JSON.stringify(broadcast.name)}；ID ${JSON.stringify(broadcast.id)}`);
    lines.push('');
  }
  lines.push('## 脚本代码置信度', '');
  for (const script of report.code.scripts) {
    lines.push(`- target ${script.targetIndex} / ${JSON.stringify(script.scriptId)}：${script.status}；脚本体证据分 ${script.body.confidence.score}。${script.reason || ''}`);
    for (const menu of script.body.syntheticMenuDefaults || []) lines.push(`  - ${menu.inputName} 的未启用菜单阴影默认值为合成：${JSON.stringify(menu.value)}；实际reporter连接保留。`);
  }
  for (const entry of report.code.unresolved) lines.push(`- **未恢复**：target ${entry.targetIndex ?? entry.targetKey} / ${JSON.stringify(entry.scriptId || '')}：${entry.reason}`);
  for (const procedure of report.code.procedures) {
    lines.push(`- **过程${procedure.status === 'unresolved' ? '未恢复' : '重构尚未验证'}**：${JSON.stringify(procedure.variant)}；证据分 ${procedure.confidence.score}。${procedure.reason || ''}`);
    if (procedure.syntheticMetadata) lines.push(`  - 参数名称、ID、默认值为合成；原warp声明未知，所选执行模式：${procedure.syntheticMetadata.chosenWarp ? 'warp' : '普通'}。`);
  }
  if (report.legacyConversion) {
    lines.push('', '## 旧格式转换', '', `- 源格式：${report.legacyConversion.sourceType}；真实VM导入/保存，未运行脚本。`,
      `- 检查范围内原状态保持：${report.legacyConversion.sourceState.preserved ? '是' : '未证明'}；资源字节保持：${report.legacyConversion.assets.verified ? '是' : '未证明'}。`,
      '- 内部积木ID与布局经过VM转换；不能声称原图逐字节保留。');
  }
  if (report.deobfuscation) {
    lines.push('', '## 解混淆证据', '', `- 静态AST引擎；执行输入代码：否；转换factory数：${report.deobfuscation.transformedFactories}`);
    for (const factory of report.deobfuscation.factories) {
      lines.push(`- target ${factory.targetKey} / ${factory.kind} / ${JSON.stringify(factory.scriptId)}：${factory.status}，残留 ${factory.residuals.length}项。`);
    }
  }
  if (report.code.beautify?.requested && !report.code.beautify.applied) {
    lines.push('', '## 美化门槛', '', `- 未做结构改写：${report.code.beautify.reason}。完整恢复与结构校验通过后才进入显示优化。`);
    if (report.code.beautify.layoutApplied) {
      lines.push('- 布局已重排：仅重新生成编辑器坐标，不改积木连接、不改变量/角色坐标。');
    }
  }
  if (report.code.beautify?.enabled && report.code.beautify.applied) {
    lines.push('', '## 结构美化证据', '',
      `- 已应用：是；变换基础：布尔输入上下文中可证明的语义级等价改写（不伪造、不改嵌套语义）`,
      `- 触达脚本/过程数：${report.code.beautify.scriptsTouched}；双重非折叠：${report.code.beautify.doubleNotCollapsed}处`,
      '- 布局为重新生成的编辑器坐标；仅影响显示位置，不影响角色坐标或代码语义。');
  }
  lines.push('', '## 限制', '', ...report.limitations.map(x => `- ${x}`));
  if (report.validation.errors.length) lines.push('', '## 错误', '', ...report.validation.errors.map(x => `- ${x}`));
  if (report.validation.warnings.length) lines.push('', '## 警告', '', ...report.validation.warnings.map(x => `- ${x}`));
  return `${lines.join('\n')}\n`;
}
