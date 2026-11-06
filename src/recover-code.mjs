import {createHash} from 'node:crypto';
import {decodeCompiledFactory} from './compiled-factory.mjs';
import {decodeHat, failRecovery as fail} from './recovery-symbols.mjs';
import {buildRecoveredStack} from './recovered-blocks.mjs';
import {collectProcedureSignatures, addProcedureDefinition, orderProcedureVariants} from './recovery-procedures.mjs';
import {beautifyOperations, beautifyLayout} from './beautify.mjs';
import {unwrapCoercions} from './coercion-unwrap.mjs';

const confidence = (score, basis) => ({score, basis, calibratedProbability: false});
export const CODE_CONFIDENCE = Object.freeze({
  preserved: 1, hatByMetadata: 0.98, template: 0.85, nameOnly: 0.65, unresolved: 0
});
const digest = source => createHash('sha256').update(source || '').digest('hex');
const newId = (targetIndex, scriptId, position) =>
  `rf_${createHash('sha256').update(`${targetIndex}:${scriptId}:${position}`).digest('hex').slice(0, 20)}`;
const analyzedHash = record => record?.analyzedSourceSha256 || record?.sourceSha256 || null;
const originalHash = record => record?.originalSourceSha256 || record?.deobfuscation?.originalSha256 || null;

function uncertaintyComment({target, targetIndex, key, anchorId = null, label, reason, record}) {
  if (!target || typeof target !== 'object') return null;
  target.comments ||= {};
  const baseId = newId(targetIndex, key, 'uncertainty');
  let commentId = baseId;
  for (let suffix = 1; Object.hasOwn(target.comments, commentId); suffix++) commentId = `${baseId}_${suffix}`;
  const anchor = anchorId && target.blocks?.[anchorId] && !Array.isArray(target.blocks[anchorId]) ? target.blocks[anchorId] : null;
  const x = Number.isFinite(anchor?.x) ? anchor.x + 260 : 860;
  const y = Number.isFinite(anchor?.y) ? anchor.y : 80 + Object.keys(target.comments).length * 24;
  const sourceLine = originalHash(record) ? `原始源码哈希 ${originalHash(record)}。` : '原始源码正文保存在 compiled-project sidecar 中。';
  const analyzedLine = analyzedHash(record) ? `分析源码哈希 ${analyzedHash(record)}。` : '';
  target.comments[commentId] = {
    blockId: anchor ? anchorId : null, x, y, width: 420, height: 170, minimized: false,
    text: `还原工厂：${label}。\n${label.includes('未恢复') ? '脚本体未还原，不是完整代码。' : ''}\n代码置信度 0（规则证据分，非统计概率）。\n原因：${reason}\n${sourceLine}${analyzedLine}\n该积木/过程未被猜测恢复；请以报告中的原始代码和证据为准。`
  };
  return commentId;
}

function unresolvedEntry(record, reason, extra = {}) {
  const bodyConfidence = record?.body?.confidence || record?.confidence || confidence(0, 'unresolved-or-ambiguous');
  return {
    kind: extra.kind || (record?.variant !== undefined ? 'procedure' : 'script'),
    targetIndex: record?.targetIndex ?? extra.targetIndex,
    ...(record?.scriptId !== undefined ? {scriptId: record.scriptId} : {}),
    ...(record?.variant !== undefined ? {variant: record.variant} : {}),
    status: 'unresolved', reason, confidence: bodyConfidence,
    sourceSha256: analyzedHash(record),
    analyzedSourceSha256: analyzedHash(record),
    originalSourceSha256: originalHash(record),
    ...(extra.annotationId ? {annotationId: extra.annotationId} : {}),
    ...(extra.targetKey !== undefined ? {targetKey: extra.targetKey} : {})
  };
}

/** Unknown statements reject the whole body; existing source block graphs remain authoritative. */
export function recoverCompiledCode(project, compiledProject, options = {}) {
  const beautify = options.beautify === true && options.validatedForBeautify === true;
  const relaxed = options.relaxed === true;
  const result = {scripts: [], blocks: [], unresolved: [], procedures: [], notes: []};
  // Every decode goes through here so relaxed mode is applied uniformly. Strict mode (the default) is unchanged.
  // `preferencesOff` maps an item key to the kinds of preferred (common) spelling that the compiler did not
  // reproduce for that item (PREFERENCE_KINDS, or '*' for all). Those are decoded with the plain spelling
  // instead, so one refused preference does not take the item's other preferences down with it.
  // `preferences: false` switches every preference off for every item.
  const preferencesOff = options.preferencesOff instanceof Map ? options.preferencesOff : new Map();
  const everythingOff = new Set(['*']);
  const offFor = key => options.preferences === false ? everythingOff : preferencesOff.get(key) ?? null;
  const decodeFactory = (source, ctxProject, ctxIndex, {key, ...extra} = {}) => decodeCompiledFactory(source, ctxProject, ctxIndex,
    relaxed ? {...extra, relaxed: true, preferencesOff: offFor(key)} : extra);
  // Items that needed an unproven assumption are kept only when the recompilation oracle has already
  // confirmed them (`relaxedAllow`). On the first pass `relaxedAllow` is null and everything is let
  // through so that the oracle can judge it. Items decoded without any assumption are never filtered.
  const relaxedAllow = options.relaxedAllow instanceof Set ? options.relaxedAllow : null;
  const vetted = (key, decoded) => {
    if (decoded.assumptions?.length && relaxedAllow && !relaxedAllow.has(key)) {
      throw new Error(`重编译预言机未确认：${decoded.assumptions[0]}`);
    }
  };
  // Coercion unwrapping (x + 0 -> x) is a preference too: `unwrapCoercions` is `true` to unwrap every item, or a
  // Set of the items to unwrap. An item whose 'unwrap' preference is off keeps the faithful `x + 0` spelling.
  // Its counts live in their own `coercions` bucket rather than in `beautify`: unwrapping is not the display
  // rewrite, and mixing them made `--no-beautify` report a structural rewrite that never happened.
  const unwrapAllow = options.unwrapCoercions;
  const shapeOperations = (operations, beautifyOn, key) => {
    const base = beautifyOn ? beautifyOperations(operations) : {operations, stats: null};
    const off = offFor(key);
    const unwrapOn = (unwrapAllow === true || unwrapAllow instanceof Set && unwrapAllow.has(key)) && !off?.has('*');
    const add = unwrapOn && !off?.has('unwrap-plus'), multiply = unwrapOn && !off?.has('unwrap-times');
    if (!add && !multiply) return base;
    const unwrapped = unwrapCoercions(base.operations, {add, multiply});
    return {operations: unwrapped.operations, stats: base.stats,
      coercions: {unwrapped: unwrapped.stats.unwrapped, plus: unwrapped.stats.add, times: unwrapped.stats.multiply}};
  };
  // Scripts (as `s:<target>:<id>`) that the oracle recognized as the compiler's own copy of a procedure definition.
  const definitionCopies = options.definitionCopies instanceof Set ? options.definitionCopies : new Set();
  const sourceBlocks = project.targets.map(target => Object.keys(target.blocks || {}).length);
  for (const [targetKey, targetData] of Object.entries(compiledProject.compiledTargets || {})) {
    const index = Number.isInteger(targetData.targetIndex) ? targetData.targetIndex : Number(targetKey);
    const target = project.targets[index];
    if (!target || target.name !== targetData.name || !!target.isStage !== !!targetData.isStage) {
      const reason = '编译 targetIndex/name/isStage 与工程不一致，拒绝串角色恢复';
      const annotationId = uncertaintyComment({target, targetIndex: index, key: targetKey, label: '角色身份存在歧义，未恢复', reason,
        record: {confidence: confidence(0, 'identity-conflict'), sourceSha256: null}});
      result.unresolved.push({kind: 'target', targetIndex: index, targetKey, status: 'unresolved', reason,
        confidence: confidence(0, 'identity-conflict'), sourceSha256: null, analyzedSourceSha256: null,
        originalSourceSha256: null, ...(annotationId ? {annotationId} : {})});
      continue;
    }
    target.blocks ||= {};
    target.comments ||= {};
    const signatures = collectProcedureSignatures(targetData, index);
    const decodedProcedures = new Map();
    // Records are created up front in the bundle's own order, so the report lists procedures exactly as it
    // always did, whatever order they end up being decoded in.
    const procedureRecords = new Map();
    for (const [variant, procedureData] of Object.entries(targetData.procedures || {})) {
      const record = {targetIndex: index, variant, status: 'unresolved', confidence: confidence(0, 'unsupported-procedure-template'),
        sourceSha256: procedureData.analyzedSourceSha256 || digest(procedureData.factorySource),
        analyzedSourceSha256: procedureData.analyzedSourceSha256 || digest(procedureData.factorySource),
        originalSourceSha256: procedureData.originalSourceSha256 || procedureData.deobfuscation?.originalSha256 || null,
        deobfuscation: procedureData.deobfuscation || null};
      procedureRecords.set(variant, record);
      result.procedures.push(record);
    }
    /** Decode one procedure and add its definition. Throws, leaving the project untouched, when it cannot. */
    const recoverProcedure = (variant, procedureData, record) => {
      const signature = signatures.get(variant.slice(1));
      if (sourceBlocks[index]) fail('源角色仍有积木，过程保持原图');
      if (!signature) fail('缺失参数签名的过程暂保留原代码');
      if (decodedProcedures.has(signature.code)) fail('已有过程重构定义，额外W/Z变体的调度对应尚未验证');
      if (variant[0] === 'W' && !signature.warp) fail('同时存在W/Z变体，先恢复非warp定义，保留warp调用差异');
      const decoded = decodeFactory(procedureData.factorySource, project, index, {key: `p:${index}:${variant}`, procedure: signature, signatures: new Map([...decodedProcedures, [signature.code, signature]])});
      vetted(`p:${index}:${variant}`, decoded);
      const {definitionId, ids} = addProcedureDefinition({target, targetIndex: index, signature});
      const beautified = shapeOperations(decoded.operations, beautify, `p:${index}:${variant}`);
      const emitted = [];
      try {
        buildRecoveredStack({target, operations: beautified.operations, parentId: definitionId,
          idFor: position => newId(index, variant, position), recordBlock: block => emitted.push(block)});
      } catch (error) {
        for (const id of ids) delete target.blocks[id];
        throw error;
      }
      record.status = 'reconstructed-unverified';
      record.confidence = confidence(0.75, 'procedure-body-with-synthetic-positional-parameter-metadata');
      record.definitionId = definitionId;
      if (decoded.assumptions?.length) record.assumptions = decoded.assumptions;
      if (decoded.preferences?.length) { record.preferences = decoded.preferences; record.preferenceKinds = decoded.preferenceKinds; }
      if (beautified.stats) record.beautify = beautified.stats;
      if (beautified.coercions) record.coercions = beautified.coercions;
      record.syntheticMetadata = {argumentNames: true, argumentIds: true, defaults: true, originalWarpDeclarationUnknown: true, chosenWarp: !!signature.warp};
      record.parameters = signature.names.map((name, i) => ({name, id: signature.ids[i], type: signature.types[i]}));
      for (const block of emitted) result.blocks.push({targetIndex: index, ...block, source: 'compiled-procedure-template',
        confidence: record.confidence, originalStructure: confidence(0, 'original-procedure-metadata-stripped')});
      decodedProcedures.set(signature.code, {...signature, variants: signature.variants.filter(entry => entry.variant === variant)});
      procedureBodies.add(bodyKey(decoded.operations));
      target.comments[newId(index, variant, 'confidence')] = {blockId: definitionId, x: 860, y: 80, width: 360, height: 150, minimized: false,
        text: `还原工厂：过程重构尚未验证；参数名、ID、默认值为合成。原warp声明未知。\n代码置信度0.75（证据分）。\n证据：*.fidelity-report.json / ${variant}`};
    };
    // A call only decodes when the definition it names has already been recovered, so callees are attempted
    // before their callers. Whatever still fails is retried while a pass keeps recovering something new (a
    // callee that needed a later pass unblocks its callers). Only the final failures are reported, in bundle
    // order, so a procedure that succeeds on a retry leaves no trace of the earlier attempt.
    const procedureFailures = new Map();
    let pendingProcedures = orderProcedureVariants(targetData.procedures);
    // The compiler also emits each procedure definition as a script of its own, with the same body and no hat. A
    // stack whose decoded body equals a recovered procedure's is that copy and is not a stack the author left lying
    // around, so it must not come back as one. Bodies are compared as decoded IR, without source positions.
    const procedureBodies = new Set();
    const bodyKey = operations => JSON.stringify(operations, (name, value) => name === 'span' ? undefined : value);
    while (pendingProcedures.length) {
      const stillFailing = [];
      for (const variant of pendingProcedures) {
        try {
          recoverProcedure(variant, targetData.procedures[variant], procedureRecords.get(variant));
          procedureFailures.delete(variant);
        } catch (error) {
          procedureFailures.set(variant, error);
          stillFailing.push(variant);
        }
      }
      // A pass that recovered nothing cannot be helped by another pass. Mutual recursion ends up here.
      if (stillFailing.length === pendingProcedures.length) break;
      pendingProcedures = stillFailing;
    }
    for (const [variant, record] of procedureRecords) {
      const error = procedureFailures.get(variant);
      if (!error) continue;
      record.reason = error.message;
      const annotationId = uncertaintyComment({target, targetIndex: index, key: variant, label: '过程存在歧义，未恢复', reason: error.message, record});
      result.unresolved.push(unresolvedEntry(record, error.message, {annotationId}));
    }
    const hats = targetData.hats || [];
    const entries = Object.entries(targetData.scripts || {});
    for (const hat of hats) {
      if (!entries.some(([id]) => id === hat.topBlockId)) entries.push([hat.topBlockId, {}]);
    }
    for (const [scriptId, scriptData] of entries) {
      const record = {targetIndex: index, scriptId, source: 'compiled-project', status: 'unresolved',
        body: {status: 'unresolved', confidence: confidence(0, 'no-supported-body')},
        originalStructure: confidence(0, 'original-block-graph-stripped'),
        sourceSha256: digest(scriptData.factorySource),
        analyzedSourceSha256: scriptData.analyzedSourceSha256 || digest(scriptData.factorySource),
        originalSourceSha256: scriptData.originalSourceSha256 || scriptData.deobfuscation?.originalSha256 || null,
        deobfuscation: scriptData.deobfuscation || null};
      result.scripts.push(record);
      if (sourceBlocks[index] > 0) {
        record.reason = '源角色仍有积木，保持原图；无法据此确认编译脚本已全部对应';
        const annotationId = uncertaintyComment({target, targetIndex: index, key: scriptId, label: '脚本存在歧义，保留原图', reason: record.reason, record});
        result.unresolved.push(unresolvedEntry(record, record.reason, {annotationId}));
        continue;
      }
      const scriptHats = hats.filter(hat => hat.topBlockId === scriptId);
      if (!scriptHats.length && !scriptData.executableHat) {
        const anchorId = newId(index, scriptId, 'inert-anchor');
        let createdAnchor = false;
        try {
          if (target.blocks[anchorId]) fail('非事件脚本ID冲突');
          if (definitionCopies.has(`s:${index}:${scriptId}`)) {
            // The recompilation oracle has shown that this is the script the compiler generates for the
            // definition of a recovered procedure (parameters replaced by constants), not a loose stack.
            record.status = 'procedure-body-copy';
            record.body = {status: 'procedure-body-copy', confidence: confidence(0.75, 'definition-script-of-recovered-procedure')};
            continue;
          }
          const decoded = decodeFactory(scriptData.factorySource, project, index, {key: `s:${index}:${scriptId}`, signatures: decodedProcedures});
          if (decoded.operations.length && procedureBodies.has(bodyKey(decoded.operations))) {
            // The definition's own script, not a loose stack. Checked before the oracle's allow-list, which
            // never lists scripts without an event: the copy needs no verdict of its own.
            record.status = 'procedure-body-copy';
            record.body = {status: 'procedure-body-copy', confidence: confidence(0.75, 'duplicate-exported-procedure-body')};
            continue;
          }
          vetted(`s:${index}:${scriptId}`, decoded);
          target.blocks[anchorId] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, topLevel: false, shadow: false};
          createdAnchor = true;
          const beautified = shapeOperations(decoded.operations, beautify, `s:${index}:${scriptId}`);
          const emitted = [];
          const graph = buildRecoveredStack({target, operations: beautified.operations, parentId: anchorId,
            idFor: position => newId(index, scriptId, position), recordBlock: block => emitted.push(block)});
          const layout = beautify ? beautifyLayout(index, result.scripts.length - 1, entries.length) : null;
          if (graph.firstId) Object.assign(target.blocks[graph.firstId], {parent: null, topLevel: true,
            x: layout ? layout.x : 600, y: layout ? layout.y : 240 + result.scripts.length * 24});
          // The recompiled project knows this stack by the ID of its first block, not by the shipped script ID.
          record.stackTopId = graph.firstId;
          record.status = 'reconstructed-unverified';
          record.body = {status: 'inert-stack-reconstructed', confidence: confidence(0.65, 'compiled-top-stack-with-no-event-metadata'), operations: decoded.operations.length};
          if (decoded.assumptions?.length) record.assumptions = decoded.assumptions;
          if (decoded.preferences?.length) { record.preferences = decoded.preferences; record.preferenceKinds = decoded.preferenceKinds; }
          if (beautified.stats) record.beautify = beautified.stats;
          if (beautified.coercions) record.coercions = beautified.coercions;
          record.event = {kind: 'none', reason: '编译包未列事件帽子；保留为不自动执行的独立积木栈'};
          for (const block of emitted) result.blocks.push({targetIndex: index, ...block, source: 'compiled-inert-stack',
            confidence: record.body.confidence, originalStructure: confidence(0, 'non-event-top-block-metadata-stripped')});
        } catch (error) {
          record.reason = error.message;
          const annotationId = uncertaintyComment({target, targetIndex: index, key: scriptId, label: '独立积木栈存在歧义，未恢复', reason: error.message, record});
          result.unresolved.push(unresolvedEntry(record, error.message, {annotationId}));
        } finally { if (createdAnchor) delete target.blocks[anchorId]; }
        continue;
      }
      let hatData;
      let preparedDecoded;
      try {
        const metadata = hats.filter(hat => hat.topBlockId === scriptId);
        if (metadata.length === 0 && result.procedures.some(procedure => procedure.status === 'reconstructed-unverified' &&
            digest(targetData.scripts[scriptId]?.factorySource) === procedure.sourceSha256)) {
          record.status = 'procedure-body-copy';
          record.body = {status: 'procedure-body-copy', confidence: confidence(0.75, 'duplicate-exported-procedure-body')};
          continue;
        }
        if (metadata.length !== 1) fail('缺少唯一 hat metadata，不能猜测事件类型');
        if (scriptData.executableHat) {
          preparedDecoded = decodeFactory(scriptData.factorySource, project, index, {key: `s:${index}:${scriptId}`, signatures: decodedProcedures,
            executableHat: {opcode: metadata[0].opcode, scriptId}});
          if (!preparedDecoded.hat || preparedDecoded.hat.opcode !== metadata[0].opcode) fail('可执行帽子未完整解析');
          vetted(`s:${index}:${scriptId}`, preparedDecoded);
          hatData = {...preparedDecoded.hat, score: 0.85};
        } else hatData = decodeHat(project, metadata[0], index);
        if (target.blocks[scriptId]) fail('顶层积木 ID 冲突');
      } catch (error) {
        record.reason = error.message;
        const annotationId = uncertaintyComment({target, targetIndex: index, key: scriptId, label: '事件脚本存在歧义，未恢复', reason: error.message, record});
        result.unresolved.push(unresolvedEntry(record, error.message, {annotationId}));
        continue;
      }
      const {opcode, fields, score: hatScore} = hatData;
      const layout = beautify ? beautifyLayout(index, result.scripts.length - 1, entries.length) : null;
      const hat = {opcode, next: null, parent: null, inputs: {}, fields, shadow: false, topLevel: true,
        x: layout ? layout.x : 48 + result.scripts.length * 24, y: layout ? layout.y : 48 + result.scripts.length * 32};
      target.blocks[scriptId] = hat;
      const blockRecord = {targetIndex: index, blockId: scriptId, opcode, source: 'hat-metadata',
        confidence: confidence(hatScore, 'original-event-metadata-and-id-resolved-definition'),
        originalStructure: confidence(0.5, 'hat-opcode-preserved-layout-regenerated')};
      result.blocks.push(blockRecord);
      try {
        const decoded = preparedDecoded || decodeFactory(scriptData.factorySource, project, index, {key: `s:${index}:${scriptId}`, signatures: decodedProcedures});
        vetted(`s:${index}:${scriptId}`, decoded);
        const beautified = shapeOperations(decoded.operations, beautify, `s:${index}:${scriptId}`);
        const emitted = [];
        if (decoded.hat) {
          const anchorId = newId(index, scriptId, 'hat-anchor');
          if (Object.hasOwn(target.blocks, anchorId)) fail('事件输入临时锚点ID冲突');
          const generated = {...decoded.hat};
          target.blocks[anchorId] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, topLevel: false, shadow: false};
          const retained = target.blocks[scriptId];
          delete target.blocks[scriptId];
          try {
            buildRecoveredStack({target, operations: [generated], parentId: anchorId,
              idFor: key => key === 0 ? scriptId : newId(index, scriptId, `hat/${key}`), recordBlock: block => { if (block.blockId !== scriptId) emitted.push(block); }});
            Object.assign(target.blocks[scriptId], {parent: null, topLevel: true, x: retained.x, y: retained.y});
          } catch (error) { target.blocks[scriptId] = retained; throw error; }
          finally { delete target.blocks[anchorId]; }
        }
        const graph = buildRecoveredStack({target, operations: beautified.operations, parentId: scriptId,
          idFor: position => newId(index, scriptId, position), recordBlock: block => emitted.push(block)});
        for (const block of emitted) result.blocks.push({targetIndex: index, ...block, source: 'compiled-ast-template',
          confidence: confidence(Math.min(CODE_CONFIDENCE.template, hatScore), 'resolved-symbols-and-closed-recursive-compiler-template'),
          originalStructure: confidence(0.4, 'semantic-reconstruction-not-original-block-graph')});
        record.body = {status: 'template-reconstructed', confidence: confidence(Math.min(CODE_CONFIDENCE.template, hatScore), 'closed-ast-template-no-roundtrip-verification'),
          operations: decoded.operations.length, recoveredBlocks: graph.blockCount, grammar: decoded.grammar, analysisSteps: decoded.analysisSteps,
          syntheticMenuDefaults: decoded.syntheticMenuDefaults};
        if (beautified.stats) record.beautify = beautified.stats;
        if (beautified.coercions) record.coercions = beautified.coercions;
        record.status = 'reconstructed-unverified';
        if (decoded.assumptions?.length) record.assumptions = decoded.assumptions;
        if (decoded.preferences?.length) { record.preferences = decoded.preferences; record.preferenceKinds = decoded.preferenceKinds; }
        record.originalStructure = confidence(0.4, 'compiler-optimizations-and-original-internal-ids-not-reversible');
      } catch (error) {
        record.reason = error.message;
        const annotationId = uncertaintyComment({target, targetIndex: index, key: scriptId, anchorId: scriptId, label: '脚本体存在歧义，未恢复', reason: error.message, record});
        result.unresolved.push(unresolvedEntry(record, error.message, {annotationId}));
      }
      if (record.status === 'unresolved') {
        if (!target.comments[newId(index, scriptId, 'uncertainty')]) {
          uncertaintyComment({target, targetIndex: index, key: scriptId, anchorId: scriptId, label: '脚本存在歧义，未恢复', reason: record.reason || '未知恢复失败', record});
        }
      } else {
        const commentId = newId(index, scriptId, 'confidence');
        const score = record.body.confidence.score;
        target.comments[commentId] = {blockId: scriptId, x: hat.x + 260, y: hat.y, width: 360, height: 130, minimized: false,
          text: `还原工厂：模板重构，尚未重编译验证。\n代码置信度 ${score}（规则证据分，非概率）。\n${record.reason || '内部积木 ID 与布局为重新生成；不能视为原始结构完全一致。'}\n证据：*.fidelity-report.json / target ${index} / script ${scriptId}`};
      }
      if (hatData) record.hat = {blockId: scriptId, opcode, confidence: blockRecord.confidence};
    }
  }
  return result;
}
