import {recoverCompiledCode} from './recover-code.mjs';
import {compileProject, comparableFactory} from './recompile-oracle.mjs';
import {PREFERENCE_KINDS} from './compiled-factory.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
/** Evidence score for an item whose recovered blocks the real compiler turned back into the shipped factory. */
export const RECOMPILED_SCORE = 0.95;

/**
 * Oracle-judged relaxed recovery.
 *
 * Strict recovery refuses a construct unless its JavaScript semantics provably match a Scratch block.
 * Relaxed recovery decodes the most likely block instead and records what it assumed. Those blocks are
 * only a hypothesis, so each recovered script and procedure is compiled by the real 02 compiler and kept
 * if, and only if, the compiler reproduces the shipped factory (up to identifier names, literal
 * folding and block IDs; see canonicalizeFactory). A kept item therefore compiles to the very program
 * that was packaged, which is a stronger guarantee than a local template proof.
 *
 * Rejecting an item can invalidate others (a script calls a procedure that was rejected), so the pass
 * repeats with an allow-list until the set of accepted items stops changing. Items that needed no
 * assumption (the strict result) are never put to the vote and never removed.
 *
 * @param {object} strippedProject container project.json with every target's blocks emptied
 * @param {object} compiledProject deobfuscated compiled bundle (the thing the blocks must compile back to)
 * @param {object} options
 * @param {JSZip} [options.archive] project archive, so the compiler can resolve assets
 * @returns {Promise<{project:object,result:object,oracle:object}>}
 */
export async function recoverWithOracle(strippedProject, compiledProject, {archive = null, maxRounds = 16, onRound, unwrap = true, compile = compileProject} = {}) {
  // Every item starts with all the spellings authors prefer (PREFERENCE_KINDS): the casts the compiler inserts
  // itself are dropped (`x + 0` -> `x`), `change v by x` instead of `set v to (v + x)`, and so on. Where the
  // compiler does not reproduce the shipped factory, the item gives up ONE preference per round, the kind most
  // often responsible first, and tries again. Giving them up one at a time matters: an item with five
  // preferences of which one is wrong should lose that one, not all five. An item that has given up every
  // preference is the plain (strict) spelling, and one that still fails is dropped if it rests on an
  // assumption. Judging them in this order matters as well: judged the other way round, a plain spelling that
  // compiles to extra casts is rejected before its preferred form ever gets a chance.
  //
  //   allowed   items that rest on an assumption and are still in the running
  //   off       per item, the preference kinds given up so far. A preference is never a reason to lose an item.
  let allowed = null;
  const off = new Map();
  const kindsUsed = record => {
    const kinds = new Set(record.preferenceKinds ?? []);
    if ((record.coercions?.plus ?? 0) > 0) kinds.add('unwrap-plus');
    if ((record.coercions?.times ?? 0) > 0) kinds.add('unwrap-times');
    return kinds;
  };
  const activeKinds = (record, key) => PREFERENCE_KINDS.filter(kind => kindsUsed(record).has(kind) && !off.get(key)?.has(kind));
  const usedPreferred = (record, key) => unwrap && activeKinds(record, key).length > 0;
  /** Give up the item's next preference. Returns false when it has none left to give up. */
  const giveUpOne = (record, key) => {
    const [kind] = activeKinds(record, key);
    if (!kind) return false;
    if (!off.has(key)) off.set(key, new Set());
    off.get(key).add(kind);
    return true;
  };
  // Shipped scripts that are the compiler's copy of a recovered procedure's definition. They are found by
  // recompiling, so each round learns them for the next one and the stack they would have become is left out.
  let definitionCopies = new Set();
  const decodeOptions = allowedSet => ({beautify: false, relaxed: true, relaxedAllow: allowedSet, definitionCopies,
    ...(unwrap ? {unwrapCoercions: true, preferencesOff: off} : {preferences: false})});
  const history = [];
  for (let round = 1; round <= maxRounds; round++) {
    const project = clone(strippedProject);
    const result = recoverCompiledCode(project, compiledProject, decodeOptions(allowed));
    const subjects = collectSubjects(result);
    const {verdicts, definitionCopies: copiesNow} = await judge(project, compiledProject, archive, subjects, compile);
    const copiesChanged = !sameSet(definitionCopies, copiesNow);
    definitionCopies = copiesNow;

    const accepted = new Set();
    let demoted = 0;
    for (const subject of subjects) {
      const matched = verdicts.get(subject.key)?.status === 'match';
      if (matched) { if (subject.assumptions.length) accepted.add(subject.key); continue; }
      // Not reproduced. If it rests on a preferred spelling, give one up and let it try again.
      if (usedPreferred(subject.record, subject.key)) { giveUpOne(subject.record, subject.key); demoted++; if (subject.assumptions.length) accepted.add(subject.key); }
    }
    const roundSummary = {round, relaxedItems: subjects.filter(s => s.assumptions.length).length, accepted: accepted.size,
      demotedToFaithful: demoted,
      mismatched: [...verdicts.values()].filter(v => v.status === 'mismatch').length,
      uncompiled: [...verdicts.values()].filter(v => v.status === 'missing').length};
    history.push(roundSummary);
    onRound?.(roundSummary);
    if (allowed && sameSet(allowed, accepted) && demoted === 0 && !copiesChanged) break;
    allowed = accepted;
  }
  // Final pass, enforced rather than merely reported. The project that is returned must be exactly the one
  // that was judged, and every item in it that rests on an assumption must have matched. If the final
  // recompilation disagrees with an earlier round for any item (two accepted items can interact), the item
  // first gives up one more preference, and once it has none left it is dropped from the allow-list; the
  // pass is then repeated. The sets of given-up kinds and dropped keys only ever grow, so this terminates;
  // `maxPrune` is a backstop (every kind once, plus the drop, with room for the interactions).
  let finalProject, finalResult, finalSubjects, finalVerdicts;
  let allowedFinal = new Set(allowed ?? []);
  let pruneRounds = 0, pruned = 0, settled = false;
  for (const maxPrune = 2 * PREFERENCE_KINDS.length + 2; pruneRounds <= maxPrune; pruneRounds++) {
    finalProject = clone(strippedProject);
    finalResult = recoverCompiledCode(finalProject, compiledProject, decodeOptions(allowedFinal));
    finalSubjects = collectSubjects(finalResult);
    const judged = await judge(finalProject, compiledProject, archive, finalSubjects, compile);
    finalVerdicts = judged.verdicts;
    const copiesChanged = !sameSet(definitionCopies, judged.definitionCopies);
    definitionCopies = judged.definitionCopies;
    const failing = finalSubjects.filter(s => finalVerdicts.get(s.key)?.status !== 'match');
    // A failing item that still holds a preferred spelling gives one up; a failing one that has none and
    // rests on an assumption is dropped. A failing strict item (no assumption) needs no action: it is the
    // strict result, which is kept as it always was, and its status is reported as it is.
    const toDemote = failing.filter(s => usedPreferred(s.record, s.key));
    const toDrop = failing.filter(s => !usedPreferred(s.record, s.key) && s.assumptions.length);
    // The returned project must be the one that was judged: if the copies learned from this compilation differ
    // from the ones it was built with, build it again with them.
    if (!toDemote.length && !toDrop.length && !copiesChanged) { settled = true; break; }
    for (const s of toDemote) giveUpOne(s.record, s.key);
    for (const s of toDrop) { allowedFinal.delete(s.key); pruned++; }
  }
  if (!settled) {
    // Not expected. Refuse to return anything resting on an unverified assumption: fall back to the strict
    // result, which needs no verdict because it contains no assumption.
    finalProject = clone(strippedProject);
    finalResult = recoverCompiledCode(finalProject, compiledProject, {beautify: false, relaxed: true, relaxedAllow: new Set(), preferences: false});
    finalSubjects = collectSubjects(finalResult);
    finalVerdicts = (await judge(finalProject, compiledProject, archive, finalSubjects, compile)).verdicts;
  }
  // Which preferences each returned item actually kept, and which it had to give up to be reproduced.
  const keptKinds = new Map(finalSubjects.map(s => [s.key, settled ? activeKinds(s.record, s.key) : []]));
  const gaveUp = {};
  for (const subject of finalSubjects) for (const kind of off.get(subject.key) ?? []) gaveUp[kind] = (gaveUp[kind] || 0) + 1;
  for (const subject of finalSubjects) {
    const verdict = finalVerdicts.get(subject.key);
    const record = subject.record;
    record.recompilation = {status: verdict?.status ?? 'not-compared', oracle: 'real-02-compiler-alpha-equivalence',
      relaxedAssumptions: subject.assumptions.length, coercionsUnwrapped: keptKinds.get(subject.key).some(kind => kind.startsWith('unwrap')),
      preferencesKept: keptKinds.get(subject.key), preferencesGivenUp: [...(off.get(subject.key) ?? [])]};
    // A match means the real compiler turns these blocks back into the shipped factory. That is a stronger
    // statement than the local-template evidence (0.85), but it still says nothing about the author's
    // original block graph, so only the code score moves; originalStructure keeps its own, lower score.
    if (verdict?.status === 'match') {
      const raised = {score: RECOMPILED_SCORE, basis: 'real-02-compiler-reproduces-shipped-factory', calibratedProbability: false};
      // Only the script/procedure record is raised. Per-block records carry no owner, so raising them by
      // ID pattern could lift blocks of unverified scripts in the same target; they keep the template score.
      if (record.body) record.body.confidence = raised; else record.confidence = raised;
    }
  }
  return {project: finalProject, result: finalResult, oracle: {rounds: history,
    // True only when the final recompilation agreed with every assumption-bearing item without any
    // further pruning needed to get there.
    converged: settled && pruned === 0,
    prunedInFinalPass: pruned, finalPassSettled: settled,
    // How many returned items had to give up each kind of preferred spelling to be reproduced.
    preferencesGivenUp: gaveUp,
    verified: finalSubjects.filter(s => s.assumptions.length && finalVerdicts.get(s.key)?.status === 'match').length,
    strictOnly: finalSubjects.filter(s => !s.assumptions.length).length,
    unverifiedAfterFinal: finalSubjects.filter(s => s.assumptions.length && finalVerdicts.get(s.key)?.status !== 'match').length}};
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/** Every recovered script/procedure that produced blocks, with the key the compiled bundle uses for it. */
function collectSubjects(result) {
  const subjects = [];
  for (const record of result.procedures) {
    if (record.status !== 'reconstructed-unverified') continue;
    subjects.push({key: `p:${record.targetIndex}:${record.variant}`, kind: 'procedures', targetIndex: record.targetIndex,
      id: record.variant, assumptions: record.assumptions || [], record});
  }
  for (const record of result.scripts) {
    if (record.status !== 'reconstructed-unverified' || record.event?.kind === 'none') continue;
    subjects.push({key: `s:${record.targetIndex}:${record.scriptId}`, kind: 'scripts', targetIndex: record.targetIndex,
      id: record.scriptId, assumptions: record.assumptions || [], record});
  }
  return subjects;
}

/**
 * The compiler emits a procedure variant only when something calls it. A procedure whose callers were
 * not recovered (or that nothing in the project calls) would therefore look "missing" rather than
 * wrong. To judge it anyway, add one throw-away green-flag script per target that calls every
 * recovered procedure once. The probe exists only in the copy handed to the compiler; it is never part
 * of the returned project, and its own factories are never compared.
 */
function withProbeCalls(project, subjects) {
  const probed = clone(project);
  const byTarget = new Map();
  for (const subject of subjects) {
    if (subject.kind !== 'procedures') continue;
    (byTarget.get(subject.targetIndex) || byTarget.set(subject.targetIndex, []).get(subject.targetIndex)).push(subject);
  }
  for (const [targetIndex, procs] of byTarget) {
    const target = probed.targets[targetIndex];
    if (!target) continue;
    const prototypes = Object.values(target.blocks).filter(block => block.opcode === 'procedures_prototype' && block.mutation);
    const hatId = `probe_hat_${targetIndex}`;
    target.blocks[hatId] = {opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
    let previous = hatId;
    procs.forEach((subject, order) => {
      const proccode = subject.id.slice(1);
      const prototype = prototypes.find(block => block.mutation.proccode === proccode);
      if (!prototype) return;
      const argumentIds = JSON.parse(prototype.mutation.argumentids || '[]');
      const defaults = JSON.parse(prototype.mutation.argumentdefaults || '[]');
      const id = `probe_call_${targetIndex}_${order}`;
      target.blocks[id] = {opcode: 'procedures_call', next: null, parent: previous,
        // A boolean slot takes no shadow; every other slot gets a literal 0, which any %n/%s accepts.
        inputs: Object.fromEntries(argumentIds.filter((_, i) => defaults[i] !== 'false').map(argId => [argId, [1, [4, '0']]])),
        fields: {}, shadow: false, topLevel: false,
        mutation: {tagName: 'mutation', children: [], proccode, argumentids: prototype.mutation.argumentids, warp: prototype.mutation.warp}};
      target.blocks[previous].next = id;
      previous = id;
    });
  }
  return probed;
}

/**
 * Recompile the recovered project and compare every subject with the shipped factory.
 * A compiler exception aborts the whole project, so on failure each target is compiled alone; a target
 * that still fails has every one of its subjects marked as not compiled.
 *
 * @returns {Promise<{verdicts: Map<string, object>, definitionCopies: Set<string>}>} `definitionCopies` lists the
 *   shipped scripts (as `s:<target>:<id>`) that are the compiler's own copy of a recovered procedure's definition.
 */
async function judge(project, compiledProject, archive, subjects, compile = compileProject) {
  const verdicts = new Map();
  const definitionCopies = new Set();
  project = withProbeCalls(project, subjects);
  // The compiler also emits the definition hat of every procedure as a script of its own, with no event. A shipped
  // script without a hat whose canonical text equals the script the compiler now makes from a recovered definition
  // is that copy. Matching the recompiled text is exact where comparing decoded bodies is not: in the definition's
  // own script the parameters are replaced by constants, so the decoded blocks differ from the procedure's.
  const findDefinitionCopies = (bundle, only = null) => {
    for (const [targetKey, shippedTarget] of Object.entries(compiledProject.compiledTargets)) {
      const targetIndex = Number.isInteger(shippedTarget.targetIndex) ? shippedTarget.targetIndex : Number(targetKey);
      if (only !== null && targetIndex !== only) continue;
      const rebuiltScripts = bundle.compiledTargets[targetIndex]?.scripts;
      if (!rebuiltScripts) continue;
      const definitions = new Set();
      for (const [blockId, block] of Object.entries(project.targets[targetIndex]?.blocks ?? {})) {
        if (block.opcode !== 'procedures_definition' || !block.topLevel || !rebuiltScripts[blockId]) continue;
        try { definitions.add(comparableFactory(rebuiltScripts[blockId].factorySource)); } catch { /* not comparable: not a copy */ }
      }
      if (!definitions.size) continue;
      const hatIds = new Set((shippedTarget.hats || []).map(hat => hat.topBlockId));
      for (const [scriptId, script] of Object.entries(shippedTarget.scripts || {})) {
        if (hatIds.has(scriptId) || script.executableHat) continue;
        try { if (definitions.has(comparableFactory(script.factorySource))) definitionCopies.add(`s:${targetIndex}:${scriptId}`); } catch { /* ignore */ }
      }
    }
  };
  const compare = (bundle, only = null) => {
    findDefinitionCopies(bundle, only);
    for (const subject of subjects) {
      if (only !== null && subject.targetIndex !== only) continue;
      const shipped = compiledProject.compiledTargets[subjectTargetKey(compiledProject, subject.targetIndex)]?.[subject.kind]?.[subject.id];
      const rebuilt = bundle.compiledTargets[subject.targetIndex]?.[subject.kind]?.[subject.id];
      if (!shipped || !rebuilt) { verdicts.set(subject.key, {status: 'missing'}); continue; }
      try {
        verdicts.set(subject.key, {status: comparableFactory(shipped.factorySource) === comparableFactory(rebuilt.factorySource) ? 'match' : 'mismatch'});
      } catch (error) {
        verdicts.set(subject.key, {status: 'incomparable', error: error.message});
      }
    }
  };
  try {
    const {bundle} = await compile(project, archive);
    compare(bundle);
  } catch {
    for (const targetIndex of new Set(subjects.map(s => s.targetIndex))) {
      const isolated = clone(project);
      isolated.targets.forEach((target, index) => { if (index !== targetIndex) { target.blocks = {}; target.comments = {}; } });
      try {
        const {bundle} = await compile(isolated, archive);
        compare(bundle, targetIndex);
      } catch (error) {
        for (const subject of subjects.filter(s => s.targetIndex === targetIndex)) verdicts.set(subject.key, {status: 'uncompilable', error: error.message});
      }
    }
  }
  return {verdicts, definitionCopies};
}

const subjectTargetKey = (compiledProject, targetIndex) => {
  for (const [key, entry] of Object.entries(compiledProject.compiledTargets)) {
    if ((Number.isInteger(entry.targetIndex) ? entry.targetIndex : Number(key)) === targetIndex) return key;
  }
  return String(targetIndex);
};
