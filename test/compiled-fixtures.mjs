import {makeMinimalSb3, JSZip, buildO2Html} from './helpers.mjs';

const block = (opcode, parent, next, fields = {}, inputs = {}, topLevel = false) =>
  ({opcode, parent, next, fields, inputs, topLevel, shadow: false, ...(topLevel ? {x: 48, y: 64} : {})});

/** Schema-shaped synthetic factories, not artifacts from the actual 02 compiler/obfuscator. */
export async function compiledFixture({obfuscated = false} = {}) {
  const {project, assets} = await makeMinimalSb3();
  const stage = project.targets[0];
  const sprite = project.targets[1];
  stage.variables.varId1 = ['分数', 7];
  stage.lists = {globalList: ['项目', ['开始', '结束']]};
  stage.broadcasts = {bStart: 'StartGame', bReady: 'Ready', bready: 'ready', bChinese: '开始游戏'};
  sprite.variables = {localScore: ['分数', 11]};
  sprite.lists = {localList: ['项目', []]};
  stage.blocks = {
    a: block('event_whenflagclicked', null, 'b', {}, {}, true),
    b: block('data_setvariableto', 'a', 'c', {VARIABLE: ['分数', 'varId1']}, {VALUE: [1, [10, '准备']]}),
    c: block('event_broadcast', 'b', null, {}, {BROADCAST_INPUT: [1, [11, 'StartGame', 'bStart']]})
  };
  sprite.blocks = {
    r: block('event_whenbroadcastreceived', null, 's', {BROADCAST_OPTION: ['StartGame', 'bStart']}, {}, true),
    s: block('data_setvariableto', 'r', 't', {VARIABLE: ['分数', 'localScore']}, {VALUE: [3, [12, '分数', 'varId1'], [10, '']]}),
    t: block('event_broadcastandwait', 's', null, {}, {BROADCAST_INPUT: [1, [11, '开始游戏', 'bChinese']]})
  };
  stage.comments = {ordinary: {blockId: 'a', x: 5, y: 9, width: 200, height: 100, minimized: false, text: '原始注释不会出现在编译包'}};
  const stripped = structuredClone(project);
  for (const target of stripped.targets) { target.blocks = {}; target.comments = {}; }
  const factories = [
    '(function gen0(thread) { const target = thread.target; const runtime = target.runtime; const stage = runtime.getTargetForStage(); const a0 = stage.variables["varId1"]; return function body0() { a0.value = "准备"; startHats("event_whenbroadcastreceived", {BROADCAST_OPTION: "StartGame"}); retire(); return; }; })',
    '(function gen1(thread) { const target = thread.target; const runtime = target.runtime; const stage = runtime.getTargetForStage(); const a0 = target.variables["localScore"]; const a1 = stage.variables["varId1"]; return function* body1() { a0.value = a1.value; yield* waitThreads(startHats("event_whenbroadcastreceived", {BROADCAST_OPTION: "开始游戏"})); retire(); return; }; })'
  ];
  const bundle = {
    format: '02engine-compiled-project', version: 1, projectVersion: 3,
    targets: stripped.targets, monitors: [], extensions: [], extensionURLs: {}, meta: stripped.meta,
    compiledTargets: {
      0: {targetIndex: 0, name: 'Stage', isStage: true, scripts: {a: {factorySource: factories[0], executableHat: false}}, procedures: {},
        hats: [{topBlockId: 'a', opcode: 'event_whenflagclicked', fieldsOfInputs: {}}]},
      1: {targetIndex: 1, name: 'Sprite1', isStage: false, scripts: {r: {factorySource: factories[1], executableHat: false}}, procedures: {},
        hats: [{topBlockId: 'r', opcode: 'event_whenbroadcastreceived', fieldsOfInputs: {BROADCAST_OPTION: {value: 'STARTGAME', id: 'bStart'}}}]}
    }
  };
  if (obfuscated) {
    // A hostile eval-shaped input must never be executed by conservative AST recovery.
    for (const target of Object.values(bundle.compiledTargets)) {
      for (const script of Object.values(target.scripts)) script.factorySource = 'eval("globalThis.__factory_should_not_execute = true")';
    }
    bundle.obfuscation = {mode: 'javascript-obfuscator', version: 2, level: 'strong'};
  }
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(stripped));
  for (const [name, bytes] of Object.entries(assets)) zip.file(name, bytes);
  const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
  const compiledProject = JSON.stringify(bundle);
  const html = buildO2Html(bytes, {precompile: true, compiledProject});
  return {project, stripped, bundle, bytes, compiledProject, html, assets};
}
