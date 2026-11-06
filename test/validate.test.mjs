import test from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import { validateSb3 } from '../src/sb3-validate.mjs';

const block = (opcode, extra = {}) => ({
  opcode, next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false, ...extra
});
const target = (name, isStage) => ({
  name, isStage, variables: {}, lists: {}, broadcasts: {}, blocks: {},
  costumes: [], sounds: [], comments: {}
});
const emptyProject = () => ({
  targets: [target('Stage', true)], extensions: [], monitors: [], meta: { semver: '3.0.0' }
});
const pack = async (project, files = {}, projectPath = 'project.json') => {
  const zip = new JSZip();
  if (projectPath !== null) zip.file(projectPath, JSON.stringify(project));
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
};
const validate = async (project, files) => validateSb3(await pack(project, files));
const expectError = async (project, pattern, files) => {
  const result = await validate(project, files);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => pattern.test(error)), JSON.stringify(result));
  assert.deepEqual(result.issues, [...result.errors, ...result.warnings]);
  return result;
};
const asset = (bytes, format) => {
  const assetId = createHash('md5').update(bytes).digest('hex');
  return { name: `test-${format}`, assetId, dataFormat: format, md5ext: `${assetId}.${format}` };
};

// 不依赖 helpers 的旧 VARIABLE fixture，且所有 ZIP 都只在内存构造。
test('空合法项目：零积木仅 warning，兼容 summary 和新增计数', async () => {
  const result = await validate(emptyProject());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /积木数为 0/);
  assert.deepEqual(result.issues, result.warnings);
  assert.deepEqual(result.summary, {
    projectType: 'sb3',
    targets: [{ name: 'Stage', isStage: true, blocks: 0, scripts: 0, costumes: 0, sounds: 0 }],
    extensions: [], variables: 0, monitors: 0, broadcasts: 0, lists: 0, blocks: 0, scripts: 0
  });
});

test('有效广播：保留大小写不同的定义、接收 fields 和发送菜单 primitive 11', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  const sprite = target('Sprite', false);
  project.targets.push(sprite);
  stage.broadcasts = { bStart: 'StartGame', bReady: 'Ready', bLower: 'ready', bChinese: '启动' };
  stage.blocks.flag = block('event_whenflagclicked', { next: 'send', topLevel: true });
  stage.blocks.send = block('event_broadcast', {
    parent: 'flag', next: 'wait', inputs: { BROADCAST_INPUT: [1, [11, 'StartGame', 'bStart']] }
  });
  stage.blocks.wait = block('event_broadcastandwait', {
    parent: 'send', inputs: { BROADCAST_INPUT: [1, [11, 'Ready', 'bReady']] }
  });
  for (const [id, name] of Object.entries(stage.broadcasts)) {
    sprite.blocks[id] = block('event_whenbroadcastreceived', {
      fields: { BROADCAST_OPTION: [name, id] }, topLevel: true
    });
  }
  const original = structuredClone(project);
  const result = await validate(project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.broadcasts, 4);
  assert.equal(result.summary.blocks, 7);
  assert.equal(result.summary.scripts, 5);
  assert.deepEqual(project, original, '不得修改或合并定义');
});

test('同名局部/全局变量、其他角色同名变量、同名列表：按本地→舞台 ID 和类型解析', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  const a = target('A', false);
  const b = target('B', false);
  project.targets.push(a, b);
  stage.variables = { global: ['score', 0], cloud: ['☁ score', 1, true] };
  stage.lists = { globalList: ['score', []] };
  a.variables = { aLocal: ['score', 2] };
  a.lists = { aList: ['score', ['a', 2, true]] };
  b.variables = { bLocal: ['score', 3] };
  a.blocks.global = block('data_setvariableto', { fields: { VARIABLE: ['score', 'global'] } });
  a.blocks.local = block('data_setvariableto', { fields: { VARIABLE: ['score', 'aLocal'] } });
  a.blocks.list = block('data_addtolist', { fields: { LIST: ['score', 'aList'] } });
  a.blocks.globalList = block('data_lengthoflist', { fields: { LIST: ['score', 'globalList'] } });
  b.blocks.local = block('data_setvariableto', { fields: { VARIABLE: ['score', 'bLocal'] } });
  const result = await validate(project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.variables, 4);
  assert.equal(result.summary.lists, 2);
});

test('本地同 ID 优先于舞台，不因名称匹配而改用舞台定义', async () => {
  const project = emptyProject();
  const sprite = target('Sprite', false);
  project.targets.push(sprite);
  project.targets[0].variables.sameId = ['global', 0];
  sprite.variables.sameId = ['local', 0];
  sprite.blocks.set = block('data_setvariableto', { fields: { VARIABLE: ['local', 'sameId'] } });
  assert.equal((await validate(project)).ok, true);
  sprite.blocks.set.fields.VARIABLE[0] = 'global';
  await expectError(project, /名称与 ID 定义不一致/);
});

test('未知变量/列表/广播 ID：不按同名定义回退', async () => {
  for (const [field, kind, definition] of [
    ['VARIABLE', 'variables', ['known', 0]],
    ['LIST', 'lists', ['known', []]],
    ['BROADCAST_OPTION', 'broadcasts', 'known']
  ]) {
    const project = emptyProject();
    project.targets[0][kind].knownId = definition;
    project.targets[0].blocks.ref = block('test_extension', { fields: { [field]: ['known', 'unknownId'] } });
    await expectError(project, /未知 ID "unknownId"/);
  }
});

test('变量 ID 不允许跨其他 sprite 查找', async () => {
  const project = emptyProject();
  const a = target('A', false);
  const b = target('B', false);
  project.targets.push(a, b);
  b.variables.bOnly = ['score', 0];
  a.blocks.ref = block('data_variable', { fields: { VARIABLE: ['score', 'bOnly'] } });
  await expectError(project, /未知 ID "bOnly"/);
});

test('名称与 ID 定义不一致：字段和广播缓存大写均报 error，不静默修正', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.variables.v = ['score', 0];
  stage.lists.l = ['items', []];
  stage.broadcasts.b = 'StartGame';
  stage.blocks.ref = block('test_extension', {
    fields: { VARIABLE: ['v', 'v'], LIST: ['wrong', 'l'], BROADCAST_OPTION: ['STARTGAME', 'b'] }
  });
  const result = await expectError(project, /名称与 ID 定义不一致/);
  assert.equal(result.errors.filter((error) => /名称与 ID 定义不一致/.test(error)).length, 3);
});

test('引用类型错误、null ID、颠倒的 [ID, null] 都报 error', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.variables.v = ['score', 0];
  stage.blocks.ref = block('data_addtolist', { fields: { LIST: ['score', 'v'] } });
  await expectError(project, /类型不一致/);
  stage.blocks.ref.fields = { VARIABLE: ['v', null] };
  await expectError(project, /非空 ID/);
});

test('定义格式与跨种类重复 ID 校验', async () => {
  const project = emptyProject();
  project.targets[0].variables = { bad: ['score'], dup: ['score', 0] };
  project.targets[0].lists = { dup: ['items', []], badList: ['items', 'not-array'] };
  project.targets[0].broadcasts = { badBroadcast: ['message'] };
  const result = await expectError(project, /定义格式/);
  assert.ok(result.errors.some((error) => /定义 ID.*重复/.test(error)));
  assert.equal(result.errors.filter((error) => /定义格式/.test(error)).length, 3);
});

test('云变量只能定义在舞台', async () => {
  const project = emptyProject();
  const sprite = target('Sprite', false);
  sprite.variables.cloud = ['☁ score', 0, true];
  project.targets.push(sprite);
  await expectError(project, /云变量只能定义在舞台/);
});

test('顶层和内嵌变量/列表 primitive，literal 4..10，复合输入 1/2/3', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.variables.v = ['score', 0];
  stage.lists.l = ['items', []];
  stage.broadcasts.b = 'StartGame';
  stage.blocks.vTop = [12, 'score', 'v', 10, -20];
  stage.blocks.lTop = [13, 'items', 'l', 30, 40];
  stage.blocks.vBare = [12, 'score', 'v'];
  stage.blocks.expression = block('operator_join', { parent: 'send' });
  stage.blocks.send = block('event_broadcast', {
    topLevel: true,
    inputs: {
      BROADCAST_INPUT: [3, 'expression', [11, 'StartGame', 'b']],
      VARIABLE: [3, [12, 'score', 'v'], [10, 'default']],
      LIST: [2, [13, 'items', 'l']],
      EMPTY: [2, null],
      COLOR: [1, [9, '#Aa00fF']], TEXT: [1, [10, 'literal']], NUMERIC_TEXT: [1, [10, 5]],
      ...Object.fromEntries([4, 5, 6, 7, 8].map((type) => [`NUM${type}`, [1, [type, '10']]]))
    }
  });
  const result = await validate(project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.blocks, 5);
  assert.equal(result.summary.scripts, 3, '带坐标的顶层 primitive 应计入 scripts');
});

test('广播独立 menu shadow 对象与字符串 input 引用合法', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.broadcasts.b = 'StartGame';
  stage.blocks.send = block('event_broadcast', { inputs: { BROADCAST_INPUT: [1, 'menu'] }, topLevel: true });
  stage.blocks.menu = block('event_broadcast_menu', {
    parent: 'send', shadow: true, fields: { BROADCAST_OPTION: ['StartGame', 'b'] }
  });
  assert.deepEqual((await validate(project)).issues, []);
});

test('primitive 中未知 ID 和错误名称不能回退', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.variables.v = ['score', 0];
  stage.lists.l = ['items', []];
  stage.broadcasts.b = 'StartGame';
  stage.blocks.vTop = [12, 'score', 'missing', 0, 0];
  stage.blocks.lTop = [13, 'wrong', 'l', 0, 0];
  stage.blocks.send = block('event_broadcast', { inputs: { BROADCAST_INPUT: [1, [11, 'STARTGAME', 'b']] } });
  const result = await expectError(project, /未知 ID/);
  assert.equal(result.errors.filter((error) => /名称与 ID 定义不一致/.test(error)).length, 2);
});

test('非法顶层 primitive 类型、残缺坐标、错误坐标类型', async () => {
  const project = emptyProject();
  project.targets[0].variables.v = ['score', 0];
  project.targets[0].blocks = {
    broadcast: [11, 'message', 'b'], text: [10, 'text'], partial: [12, 'score', 'v', 10],
    coordinate: [12, 'score', 'v', '10', 20]
  };
  const result = await expectError(project, /顶层 primitive/);
  assert.equal(result.errors.filter((error) => /顶层 primitive/.test(error)).length, 2);
  assert.equal(result.errors.filter((error) => /primitive 12 格式错误/.test(error)).length, 2);
});

test('非法 input 标签/长度/裸值、未知 primitive 和非法 literal', async () => {
  const project = emptyProject();
  project.targets[0].blocks.ref = block('test_extension', {
    inputs: {
      tag: [4, [10, 'x']], short: [3, [10, 'x']], long: [1, [10, 'x'], null],
      bare: [2, 42], unknown: [1, [99, 'x']], literal: [1, [4, {}]], color: [1, [9, 'red']]
    }
  });
  const result = await expectError(project, /input 必须/);
  assert.equal(result.errors.length, 7);
  assert.ok(result.errors.some((error) => /未知 primitive/.test(error)));
});

test('next/parent/input 的悬空引用全部检查，包括被遮盖 shadow', async () => {
  const project = emptyProject();
  project.targets[0].blocks.a = block('test_extension', {
    next: 'noNext', parent: 'noParent', inputs: { ONE: [2, 'noInput'], TWO: [3, null, 'noShadow'] }
  });
  const result = await expectError(project, /引用不存在的 block ID/);
  assert.equal(result.errors.length, 4);
});

test('next/parent/input self-link 和明显 next-cycle', async () => {
  const project = emptyProject();
  project.targets[0].blocks = {
    self: block('test_extension', { next: 'self', parent: 'self', inputs: { SELF: [2, 'self'] } }),
    a: block('test_extension', { next: 'b' }),
    b: block('test_extension', { next: 'c' }),
    c: block('test_extension', { next: 'a' })
  };
  const result = await expectError(project, /self-link/);
  assert.equal(result.errors.filter((error) => /self-link/.test(error)).length, 3);
  assert.equal(result.errors.filter((error) => /next-cycle/.test(error)).length, 1);
});

test('合法 next 链和正常 parent 回指不应误判为环', async () => {
  const project = emptyProject();
  project.targets[0].blocks = {
    a: block('event_whenflagclicked', { next: 'b', topLevel: true }),
    b: block('looks_say', { next: 'c', parent: 'a' }),
    c: block('looks_say', { parent: 'b', inputs: { MESSAGE: [1, [10, 'ok']] } })
  };
  assert.deepEqual((await validate(project)).issues, []);
});

test('缺少或多个舞台均报 error；舞台不在首位仍可解析全局 ID', async () => {
  const noStage = emptyProject();
  noStage.targets[0].isStage = false;
  await expectError(noStage, /实际 0 个/);
  const duplicate = emptyProject();
  duplicate.targets.push(target('Stage2', true));
  await expectError(duplicate, /实际 2 个/);
  const project = emptyProject();
  project.targets[0].variables.v = ['score', 0];
  const sprite = target('Sprite', false);
  sprite.blocks.ref = block('data_variable', { fields: { VARIABLE: ['score', 'v'] } });
  project.targets.unshift(sprite);
  assert.equal((await validate(project)).ok, true);
});

test('JSON 根值、targets 类型/空数组/非法 target 都给出错误而不抛出', async () => {
  for (const root of [null, [], 'text', {}, { targets: {} }, { targets: [] }]) {
    const result = await validate(root);
    assert.equal(result.ok, false, JSON.stringify(root));
    assert.ok(result.errors.length > 0);
  }
  const result = await expectError({ targets: [null] }, /targets\[0\] 必须是对象/);
  assert.ok(result.errors.some((error) => /isStage/.test(error)));
});

test('blocks 必须是字典；block 对象和 opcode 格式校验，不拒绝未知扩展 opcode', async () => {
  for (const blocks of [undefined, null, [], 'blocks']) {
    const project = emptyProject();
    project.targets[0].blocks = blocks;
    await expectError(project, /blocks 必须是字典/);
  }
  const project = emptyProject();
  project.targets[0].blocks = { null: null, empty: block('  '), number: block(3) };
  const result = await expectError(project, /必须是 block 对象/);
  assert.equal(result.errors.filter((error) => /opcode/.test(error)).length, 2);
  project.targets[0].blocks = { extension: block('unknownExtension_doSomething', { topLevel: true }) };
  project.extensions = ['unknownExtension'];
  assert.deepEqual((await validate(project)).issues, []);
});

test('字典、字段、inputs、布尔标志和连接的错误类型不导致崩溃', async () => {
  const project = emptyProject();
  const stage = project.targets[0];
  stage.variables = [];
  stage.lists = null;
  stage.broadcasts = 'bad';
  stage.costumes = {};
  stage.sounds = 'bad';
  stage.blocks.ref = block('test_extension', {
    fields: { VARIABLE: ['score'], MENU: ['value', 12] }, inputs: [], next: 4, shadow: 'false'
  });
  project.extensions = {};
  project.monitors = 'bad';
  const result = await expectError(project, /必须是字典/);
  assert.ok(result.errors.length >= 11);
});

test('特殊 ID __proto__/constructor/toString 按真实 own key 解析', async () => {
  const project = emptyProject();
  project.targets[0].variables = JSON.parse('{"__proto__":["score",0]}');
  project.targets[0].blocks = JSON.parse('{"constructor":[12,"score","__proto__",0,0]}');
  project.targets[0].blocks.toString = block('test_extension', { next: 'constructor' });
  assert.equal((await validate(project)).ok, true);
});

test('造型与音效资产存在、CRC32 与 MD5 正确；支持 assetId/dataFormat 文件名回退', async () => {
  const project = emptyProject();
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const soundBytes = Buffer.from('RIFF-test-sound');
  const costume = asset(svgBytes, 'svg');
  const sound = asset(soundBytes, 'wav');
  project.targets[0].costumes = [costume, { ...costume }];
  project.targets[0].sounds = [{ ...sound }];
  delete project.targets[0].costumes[1].md5ext;
  project.targets[0].blocks.a = block('event_whenflagclicked', { topLevel: true });
  const result = await validate(project, { [costume.md5ext]: svgBytes, [sound.md5ext]: soundBytes });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.targets[0].costumes, 2);
  assert.equal(result.summary.targets[0].sounds, 1);
});

test('缺失造型/音效是 error，子目录同名文件不能替代根资产', async () => {
  const project = emptyProject();
  const bytes = Buffer.from('asset');
  const costume = asset(bytes, 'svg');
  const sound = asset(bytes, 'wav');
  project.targets[0].costumes = [costume];
  project.targets[0].sounds = [sound];
  const result = await expectError(project, /缺少根目录造型资产/, {
    [`assets/${costume.md5ext}`]: bytes, [`sounds/${sound.md5ext}`]: bytes
  });
  assert.ok(result.errors.some((error) => /缺少根目录音效资产/.test(error)));
});

test('MD5 不匹配至少 warning，ok 仍只取 errors，issues 按 errors→warnings 排列', async () => {
  const project = emptyProject();
  const costume = asset(Buffer.from('original'), 'svg');
  project.targets[0].costumes = [costume];
  const result = await validate(project, { [costume.md5ext]: Buffer.from('changed') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => /MD5 不匹配/.test(warning)));
  assert.deepEqual(result.issues, result.warnings);
  project.targets[0].blocks.a = block('data_variable', { fields: { VARIABLE: ['score', 'missing'] } });
  const mixed = await validate(project, { [costume.md5ext]: Buffer.from('changed') });
  assert.equal(mixed.ok, false);
  assert.ok(mixed.errors.length > 0 && mixed.warnings.length > 0);
  assert.deepEqual(mixed.issues, [...mixed.errors, ...mixed.warnings]);
});

test('分别核验文件名 hash 和声音 assetId，声音 ZIP 查找仍按 md5ext', async () => {
  const project = emptyProject();
  const bytes = Buffer.from('actual');
  const sound = asset(bytes, 'wav');
  sound.assetId = '0'.repeat(32);
  project.targets[0].sounds = [sound];
  const result = await validate(project, { [sound.md5ext]: bytes });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /MD5 不匹配.*00000000/.test(warning)));
});

test('根 project.json 缺失、仅有子目录项目、路径清理后的项目均拒绝', async () => {
  for (const path of [null, 'sub/project.json', '../project.json', './project.json']) {
    const result = await validateSb3(await pack(emptyProject(), {}, path));
    assert.equal(result.ok, false, String(path));
    assert.match(result.errors[0], /根目录 project.json/);
  }
});

test('资产元数据不能指向子目录，../ 清理后的根资产也不能冒充完整 SB3', async () => {
  const project = emptyProject();
  const bytes = Buffer.from('asset');
  const costume = asset(bytes, 'svg');
  project.targets[0].costumes = [{ ...costume, md5ext: `assets/${costume.md5ext}` }];
  await expectError(project, /缺少根目录造型资产/, { [`assets/${costume.md5ext}`]: bytes });
  project.targets[0].costumes = [costume];
  await expectError(project, /缺少根目录造型资产/, { [`../${costume.md5ext}`]: bytes });
});

test('损坏 ZIP 和非法 JSON 返回 errors 而不抛出', async () => {
  const badZip = await validateSb3(Buffer.from('not a zip'));
  assert.equal(badZip.ok, false);
  assert.match(badZip.errors[0], /zip 无法打开/);
  const badJSON = await validateSb3(await pack(null, { 'project.json': '{' }));
  assert.equal(badJSON.ok, false);
  assert.match(badJSON.errors[0], /project.json 解析失败/);
});

test('CRC32：修改仍可解压的 STORE 资产内容必须报 error，而非仅 MD5 warning', async () => {
  const project = emptyProject();
  const content = Buffer.from('UNIQUE-CRC32-ASSET-PAYLOAD');
  const costume = asset(content, 'svg');
  project.targets[0].costumes = [costume];
  const bytes = Buffer.from(await pack(project, { [costume.md5ext]: content }));
  const offset = bytes.indexOf(content);
  assert.ok(offset >= 0);
  bytes[offset] ^= 1;
  const unchecked = await JSZip.loadAsync(bytes);
  assert.ok(unchecked.file(costume.md5ext), '损坏 fixture 仍应能未经 CRC 检查读取');
  const result = await validateSb3(bytes);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /CRC32/);
  assert.deepEqual(result.warnings, []);
});

test('CRC32 也检查 project.json 内容和未引用的额外 ZIP 条目', async () => {
  for (const entry of ['project.json', 'unused.bin']) {
    const project = emptyProject();
    const extra = Buffer.from('UNIQUE-UNUSED-CRC32-CONTENT');
    const bytes = Buffer.from(await pack(project, { 'unused.bin': extra }));
    const payload = entry === 'project.json' ? Buffer.from(JSON.stringify(project)) : extra;
    const offset = bytes.indexOf(payload);
    assert.ok(offset >= 0);
    bytes[offset + 1] ^= 1;
    const result = await validateSb3(bytes);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /CRC32/);
  }
});
