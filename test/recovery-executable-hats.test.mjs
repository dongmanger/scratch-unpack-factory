import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {decodeExecutableHat} from '../src/recovery-executable-hats.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';
import {RECOVERY_OPCODE_SCHEMA} from '../src/recovery-opcode-schema.mjs';
import {makeMinimalSb3, JSZip} from './helpers.mjs';
import {actualVMClass} from './real-02-compiler.mjs';

const statementsOf = source => parse(`function* script() {${source}}`, {ecmaVersion: 'latest'}).body[0].body.body;
const literalReporter = node => {
  if (node?.type === 'Literal' && ['string', 'number'].includes(typeof node.value) &&
      (typeof node.value !== 'number' || Number.isFinite(node.value) && !Object.is(node.value, -0))) return {literal: node.value};
  throw new Error('Test reporter rejected unsupported input');
};
const compatibility = (args = '{VALUE: 10, WHENGREATERTHANMENU: "timer"}', alias = 'bOpcode', id = 'ID') =>
  `(yield* executeInCompatibilityLayer(${args}, ${alias}, false, false, ${JSON.stringify(id)}, null))`;
const edge = (condition = compatibility(), id = 'ID') => `{
  const resolvedValue = ${condition};
  const id = ${JSON.stringify(id)};
  const hasOldEdgeValue = target.hasEdgeActivatedValue(id);
  const oldEdgeValue = target.updateEdgeActivatedValue(id, resolvedValue);
  const edgeWasActivated = hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue;
  if (!edgeWasActivated) {retire(); return;}
  yield;
}`;
const predicate = (condition = compatibility('{TOUCHINGOBJECTMENU: "_mouse_"}')) =>
  `if (!${condition}) {retire(); return;} yield;`;
const options = (source, hatOpcode = 'event_whengreaterthan', overrides = {}) => ({
  statements: statementsOf(source), opcodeAliases: new Map([['bOpcode', hatOpcode]]), hatOpcode,
  scriptId: 'ID', reporter: literalReporter, ...overrides
});
const decode = (source, opcode, overrides) => decodeExecutableHat(options(source, opcode, overrides));
const hat = (opcode, inputs = {}, fields = {}, shadowInputs = {}) => ({opcode, inputs, fields, shadowInputs});
const greaterThanHat = hat('event_whengreaterthan', {VALUE: {literal: 10}}, {WHENGREATERTHANMENU: ['timer', null]});
const touchingHat = value => hat('event_whentouchingobject', {TOUCHINGOBJECTMENU: {literal: value}}, {}, {
  TOUCHINGOBJECTMENU: {opcode: 'sensing_touchingobjectmenu', fields: {TOUCHINGOBJECTMENU: [value, null]}}
});

for (const wrapped of [false, true]) {
  test(`original compiler edge group (${wrapped ? 'ADVANCED boolean cast' : 'direct compatibility result'}) consumes one outer statement`, () => {
    const condition = wrapped ? `toBoolean(${compatibility()})` : compatibility();
    const input = options(`${edge(condition)} target.unknown(); retire(); return;`);
    const before = JSON.stringify(input.statements);
    assert.deepEqual(decodeExecutableHat(input), {consumed: 1, hat: greaterThanHat});
    assert.equal(JSON.stringify(input.statements), before, 'AST and trailing operations stay untouched');
  });
  test(`original compiler predicate group (${wrapped ? 'ADVANCED boolean cast' : 'direct compatibility result'}) consumes exactly if/yield`, () => {
    const condition = compatibility('{TOUCHINGOBJECTMENU: "_mouse_"}');
    const input = options(`${predicate(wrapped ? `toBoolean(${condition})` : condition)} target.unknown();`, 'event_whentouchingobject');
    const before = JSON.stringify(input.statements);
    assert.deepEqual(decodeExecutableHat(input), {consumed: 2, hat: touchingHat('_mouse_')});
    assert.equal(JSON.stringify(input.statements), before);
  });
}

test('video motion uses the static REFERENCE input schema and no invented fields', () => {
  assert.deepEqual(decode(edge(`toBoolean(${compatibility('{REFERENCE: 15}')})`), 'videoSensing_whenMotionGreaterThan'), {
    consumed: 1, hat: hat('videoSensing_whenMotionGreaterThan', {REFERENCE: {literal: 15}})
  });
});

test('touching menu descriptors are adapted into independent field-bearing shadows', () => {
  for (const value of ['_mouse_', '_edge_', 'Sprite2', '', '中文\\name']) {
    const args = `{TOUCHINGOBJECTMENU: ${JSON.stringify(value)}}`;
    const result = decode(edge(compatibility(args)), 'event_whentouchingobject');
    assert.deepEqual(result.hat, touchingHat(value));
    result.hat.shadowInputs.TOUCHINGOBJECTMENU.fields.TOUCHINGOBJECTMENU[0] = 'changed';
    assert.deepEqual(decode(edge(compatibility(args)), 'event_whentouchingobject').hat, touchingHat(value));
  }
  assert.deepEqual(RECOVERY_OPCODE_SCHEMA.event_whentouchingobject.shadowInputs, {
    TOUCHINGOBJECTMENU: {opcode: 'sensing_touchingobjectmenu', field: 'TOUCHINGOBJECTMENU'}
  });
});

const edgeSource = edge();
const corruptEdges = [
  ['missing resolved value', edgeSource.replace('const resolvedValue = ', 'resolvedValue = ')],
  ['mutable binding', edgeSource.replace('const id =', 'let id =')],
  ['wrong local name', edgeSource.replace('const oldEdgeValue =', 'const oldValue =')],
  ['extra declaration', edgeSource.replace('const id = "ID";', 'const id = "ID", extra = sideEffect();')],
  ['wrong const ID', edgeSource.replace('const id = "ID"', 'const id = "OTHER"')],
  ['dynamic const ID', edgeSource.replace('const id = "ID"', 'const id = otherId')],
  ['wrong has-edge target', edgeSource.replace('target.hasEdgeActivatedValue', 'stage.hasEdgeActivatedValue')],
  ['wrong has-edge helper', edgeSource.replace('hasEdgeActivatedValue(id)', 'updateEdgeActivatedValue(id)')],
  ['wrong has-edge ID', edgeSource.replace('hasEdgeActivatedValue(id)', 'hasEdgeActivatedValue("ID")')],
  ['extra has-edge arg', edgeSource.replace('hasEdgeActivatedValue(id)', 'hasEdgeActivatedValue(id, sideEffect())')],
  ['optional has-edge call', edgeSource.replace('hasEdgeActivatedValue(id)', 'hasEdgeActivatedValue?.(id)')],
  ['optional target access', edgeSource.replace('target.hasEdgeActivatedValue', 'target?.hasEdgeActivatedValue')],
  ['wrong update target', edgeSource.replace('target.updateEdgeActivatedValue', 'stage.updateEdgeActivatedValue')],
  ['reordered update args', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue(resolvedValue, id)')],
  ['wrong update ID', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue("ID", resolvedValue)')],
  ['missing update arg', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue(id)')],
  ['custom update value', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue(id, true)')],
  ['extra update arg', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue(id, resolvedValue, sideEffect())')],
  ['optional update', edgeSource.replace('updateEdgeActivatedValue(id, resolvedValue)', 'updateEdgeActivatedValue?.(id, resolvedValue)')],
  ['wrong activation condition', edgeSource.replace('= hasOldEdgeValue ?', '= oldEdgeValue ?')],
  ['activation OR', edgeSource.replace('!oldEdgeValue && resolvedValue', '!oldEdgeValue || resolvedValue')],
  ['activation reversed operands', edgeSource.replace('!oldEdgeValue && resolvedValue', 'resolvedValue && !oldEdgeValue')],
  ['activation missing negation', edgeSource.replace('!oldEdgeValue && resolvedValue', 'oldEdgeValue && resolvedValue')],
  ['activation wrong fallback', edgeSource.replace(': resolvedValue;', ': true;')],
  ['activation extra expression', edgeSource.replace(': resolvedValue;', ': (sideEffect(), resolvedValue);')],
  ['wrong guard', edgeSource.replace('if (!edgeWasActivated)', 'if (!resolvedValue)')],
  ['guard else branch', edgeSource.replace('retire(); return;}', 'retire(); return;} else {sideEffect();}')],
  ['guard extra operation', edgeSource.replace('retire(); return;', 'sideEffect(); retire(); return;')],
  ['retire extra arg', edgeSource.replace('retire();', 'retire(sideEffect());')],
  ['optional retire', edgeSource.replace('retire();', 'retire?.();')],
  ['custom return value', edgeSource.replace('return;', 'return resolvedValue;')],
  ['missing return', edgeSource.replace('return;', '')],
  ['missing retire', edgeSource.replace('retire();', '')],
  ['reordered retirement', edgeSource.replace('retire(); return;', 'return; retire();')],
  ['missing yield', edgeSource.replace('yield;', '')],
  ['yield value', edgeSource.replace('yield;', 'yield resolvedValue;')],
  ['delegated final yield', edgeSource.replace('yield;', 'yield* sideEffect();')],
  ['extra statement inside block', edgeSource.replace('yield;', 'yield; sideEffect();')],
  ['nested wrapper block', `{${edgeSource}}`],
  ['first condition is arbitrary', edge('target.isTouchingObject("_mouse_")')],
  ['earlier unrelated statement', `sideEffect(); ${edgeSource}`]
];
for (const [label, source] of corruptEdges) {
  test(`reject corrupt edge companion before reporter: ${label}`, () => {
    let calls = 0;
    assert.throws(() => decode(source, undefined, {reporter() { calls++; return {literal: 10}; }}));
    assert.equal(calls, 0);
  });
}

const predicateSource = predicate();
const corruptPredicates = [
  ['arbitrary condition', 'if (!target.isTouchingObject("_mouse_")) {retire(); return;} yield;'],
  ['unnegated condition', predicateSource.replace('if (!', 'if (')],
  ['double negation', predicateSource.replace('if (!', 'if (!!')],
  ['missing yield', predicateSource.replace('yield;', '')],
  ['custom yield value', predicateSource.replace('yield;', 'yield 1;')],
  ['conditional yield', predicateSource.replace('yield;', 'if (isStuck()) yield;')],
  ['missing retire', predicateSource.replace('retire();', '')],
  ['missing return', predicateSource.replace('return;', '')],
  ['custom return value', predicateSource.replace('return;', 'return false;')],
  ['optional retire', predicateSource.replace('retire();', 'retire?.();')],
  ['extra retire arg', predicateSource.replace('retire();', 'retire(1);')],
  ['else branch', predicateSource.replace('} yield;', '} else {sideEffect();} yield;')],
  ['extra guard statement', predicateSource.replace('return;', 'return; sideEffect();')],
  ['intervening statement', predicateSource.replace('} yield;', '} sideEffect(); yield;')],
  ['earlier unrelated guard', `if (true) {retire(); return;} yield; ${predicateSource}`],
  ['guard in wrapper block', `{${predicateSource}}`]
];
for (const [label, source] of corruptPredicates) {
  test(`reject corrupt predicate group before reporter: ${label}`, () => {
    let calls = 0;
    assert.throws(() => decode(source, 'event_whentouchingobject', {reporter() { calls++; }}));
    assert.equal(calls, 0);
  });
}

const invocation = compatibility();
const badConditions = [
  ['plain call', invocation.replace('yield* ', '')],
  ['nondelegated yield', invocation.replace('yield* ', 'yield ')],
  ['unknown helper', invocation.replace('executeInCompatibilityLayer', 'customCompatibility')],
  ['member helper', invocation.replace('executeInCompatibilityLayer', 'runtime.executeInCompatibilityLayer')],
  ['optional compatibility call', invocation.replace('executeInCompatibilityLayer(', 'executeInCompatibilityLayer?.(')],
  ['wrong alias', invocation.replace('bOpcode,', 'unknownOpcode,')],
  ['dynamic opcode lookup', invocation.replace('bOpcode,', 'runtime.getOpcodeFunction("event_whengreaterthan"),')],
  ['warp flag', invocation.replace('false, false,', 'true, false,')],
  ['set-flags flag', invocation.replace('false, false,', 'false, true,')],
  ['numeric flag', invocation.replace('false, false,', '0, false,')],
  ['wrong script ID', invocation.replace('"ID", null', '"OTHER", null')],
  ['numeric script ID', invocation.replace('"ID", null', '1, null')],
  ['dynamic script ID', invocation.replace('"ID", null', 'id, null')],
  ['nonnull branch frame', invocation.replace('"ID", null', '"ID", frame')],
  ['missing frame', invocation.replace(', null', '')],
  ['extra argument', invocation.replace(', null)', ', null, sideEffect())')],
  ['spread argument', invocation.replace('bOpcode,', '...bOpcode,')],
  ['nonobject arguments', compatibility('args')],
  ['custom boolean wrapper', `Boolean(${invocation})`],
  ['double boolean wrapper', `toBoolean(toBoolean(${invocation}))`],
  ['optional boolean wrapper', `toBoolean?.(${invocation})`],
  ['boolean wrapper wrong arity', `toBoolean(${invocation}, sideEffect())`],
  ['boolean wrapper spread', `toBoolean(...${invocation})`],
  ['condition side effect', `(sideEffect(), ${invocation})`]
];
for (const [label, condition] of badConditions) {
  test(`reject incompatible condition before reporter: ${label}`, () => {
    for (const source of [edge(condition), `if (!${condition}) {retire(); return;} yield;`]) {
      let calls = 0;
      assert.throws(() => decode(source, undefined, {reporter() { calls++; }}));
      assert.equal(calls, 0);
    }
  });
}

for (const args of [
  '{VALUE: 10}', '{WHENGREATERTHANMENU: "timer"}', '{VALUE: 10, WHENGREATERTHANMENU: "timer", EXTRA: sideEffect()}',
  '{VALUE: 10, VALUE: 20, WHENGREATERTHANMENU: "timer"}', '{["VALUE"]: 10, WHENGREATERTHANMENU: "timer"}',
  '{get VALUE() {return 10;}, WHENGREATERTHANMENU: "timer"}', '{VALUE() {return 10;}, WHENGREATERTHANMENU: "timer"}',
  '{...args, WHENGREATERTHANMENU: "timer"}', '{VALUE: 10, WHENGREATERTHANMENU: option}',
  '{VALUE: 10, WHENGREATERTHANMENU: toBoolean(true)}', '{VALUE: 10, WHENGREATERTHANMENU: false}'
]) {
  test(`static compatibility argument schema rejects before reporter: ${args}`, () => {
    let calls = 0;
    assert.throws(() => decode(edge(compatibility(args)), undefined, {reporter() { calls++; }}));
    assert.equal(calls, 0);
  });
}

test('edge local bindings cannot act as opcode aliases or input reporters, even with a permissive callback', () => {
  for (const name of ['resolvedValue', 'id', 'hasOldEdgeValue', 'oldEdgeValue', 'edgeWasActivated']) {
    let calls = 0;
    const reporter = () => { calls++; return {literal: 10}; };
    assert.throws(() => decode(edge(compatibility(`{VALUE: ${name}, WHENGREATERTHANMENU: "timer"}`)), undefined, {reporter}));
    assert.throws(() => decode(edge(compatibility(undefined, name)), undefined, {
      opcodeAliases: new Map([[name, 'event_whengreaterthan']]), reporter
    }));
    assert.throws(() => decode(edgeSource, undefined, {
      opcodeAliases: new Map([['bOpcode', 'event_whengreaterthan'], [name, 'motion_movesteps']]), reporter
    }));
    assert.equal(calls, 0);
  }
});

test('optional input calls/access cannot slip through a permissive reporter', () => {
  for (const value of ['target?.x', 'sideEffect?.()', 'target.variables?.value']) {
    let calls = 0;
    assert.throws(() => decode(edge(compatibility(`{VALUE: ${value}, WHENGREATERTHANMENU: "timer"}`)), undefined, {
      reporter() { calls++; return {literal: 10}; }
    }));
    assert.equal(calls, 0);
  }
});

test('opcode and script metadata are mandatory and matching; unknown/static nonexecutable opcodes fail closed', () => {
  for (const overrides of [
    {statements: []}, {statements: null}, {opcodeAliases: {}}, {reporter: null},
    {scriptId: ''}, {scriptId: 1}, {scriptId: 'OTHER'}, {hatOpcode: 'custom_when'},
    {hatOpcode: 'constructor'}, {hatOpcode: 'motion_movesteps'}, {hatOpcode: 'event_whenflagclicked'},
    {opcodeAliases: new Map()}, {opcodeAliases: new Map([['bOpcode', 'event_whentouchingobject']])}
  ]) assert.throws(() => decode(edgeSource, undefined, overrides));
});

test('menu input reporter values require recoverable literal shadows', () => {
  for (const result of [null, {}, {variable: {name: 'sprite', id: 'sprite'}},
    {opcode: 'operator_join', inputs: {}, fields: {}}, {literal: true}, {literal: Infinity}, {literal: -0}]) {
    assert.throws(() => decode(predicateSource, 'event_whentouchingobject', {reporter: () => result}));
  }
});

test('reporter input policy propagates errors and receives only input AST nodes, without executing source', () => {
  const source = edge(compatibility('{VALUE: (() => {globalThis.__hatProbe = true; return 10;})(), WHENGREATERTHANMENU: "timer"}'));
  const error = new Error('unsupported reporter');
  assert.throws(() => decode(source, undefined, {reporter() {throw error;}}), actual => actual === error);
  let observed;
  const recovered = decode(source, undefined, {reporter(node) {observed = node; return {literal: 10};}});
  assert.equal(observed.type, 'CallExpression');
  assert.deepEqual(recovered.hat, greaterThanHat);
  assert.equal(Object.hasOwn(globalThis, '__hatProbe'), false);
});

function compileView(source) {
  const factory = parse(source, {ecmaVersion: 'latest'}).body[0].expression;
  const returned = factory.body.body.at(-1);
  const opcodeAliases = new Map(factory.body.body.slice(0, -1).flatMap(statement => statement.declarations)
    .filter(declaration => declaration.init?.type === 'CallExpression' &&
      declaration.init.callee?.object?.name === 'runtime' && declaration.init.callee.property?.name === 'getOpcodeFunction')
    .map(declaration => [declaration.id.name, declaration.init.arguments[0].value]));
  return {factory, returned, statements: returned.argument.body.body, opcodeAliases};
}

// Reuse the production reporter policy by embedding the input AST's source in
// a supported assignment. The real setup is kept, including variable aliases;
// only trusted fixtures compiled by the actual VM generate these sources. No
// custom VM loader, behavior execution, or renderer/audio adapter is involved.
function productionReporter(source, view, project, targetIndex) {
  const prefix = source.slice(0, view.returned.start);
  return node => decodeCompiledFactory(`${prefix}const hatSink = stage.variables["hat-sink"];
    return function () {hatSink.value = ${source.slice(node.start, node.end)}; retire(); return;}; })`,
  project, targetIndex).operations[0].inputs.VALUE;
}

test('trusted actual VM compile-only shapes: greater-than, video motion, and touching are complete edge groups', async () => {
  const fixture = await makeMinimalSb3();
  fixture.project.extensions = ['videoSensing'];
  fixture.project.targets[0].variables['hat-sink'] = ['hat sink', 0];
  fixture.project.targets[0].blocks = {};
  const target = fixture.project.targets[1];
  target.variables = {threshold: ['threshold', 25]};
  const definitions = [
    ['greater', 'event_whengreaterthan', {VALUE: [1, [4, '10']]}, {WHENGREATERTHANMENU: ['timer', null]}],
    ['variable', 'event_whengreaterthan', {VALUE: [3, [12, 'threshold', 'threshold'], [4, '10']]}, {WHENGREATERTHANMENU: ['loudness', null]}],
    ['video', 'videoSensing_whenMotionGreaterThan', {REFERENCE: [1, [4, '15']]}, {}],
    ['touching', 'event_whentouchingobject', {TOUCHINGOBJECTMENU: [1, 'touch-menu']}, {}]
  ];
  target.blocks = Object.fromEntries(definitions.map(([id, opcode, inputs, fields]) => [id,
    {opcode, next: null, parent: null, inputs, fields, shadow: false, topLevel: true, x: 20, y: 20}]));
  target.blocks['touch-menu'] = {opcode: 'sensing_touchingobjectmenu', next: null, parent: 'touching', inputs: {},
    fields: {TOUCHINGOBJECTMENU: ['_mouse_', null]}, shadow: true, topLevel: false};
  const VM = actualVMClass();
  const machine = new VM();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(fixture.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) archive.file(name, bytes);
  let bundle;
  try {
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    bundle = await machine.compileProjectFromJSON(structuredClone(fixture.project), archive);
    assert.equal(Boolean(machine.runtime.renderer), false);
    assert.equal(Boolean(machine.runtime.audioEngine), false);
    assert.equal(Boolean(machine.runtime.storage), false);
  } finally {
    // The extension provides this testing shutdown hook; quit() stops only the
    // runtime frame loop and does not stop the video extension's polling timer.
    machine.runtime.ext_videoSensing?._stopLoop();
    machine.quit();
  }
  const project = {...fixture.project, targets: structuredClone(bundle.targets)};
  const data = Object.values(bundle.compiledTargets).find(item => item.targetIndex === 1);
  assert.ok(data);
  assert.equal(Object.keys(data.scripts).length, 4);
  for (const [id, script] of Object.entries(data.scripts)) {
    const metadata = data.hats.find(item => item.topBlockId === id);
    assert.equal(script.executableHat, true);
    const view = compileView(script.factorySource);
    assert.equal(view.statements[0].type, 'BlockStatement');
    assert.equal(view.statements[0].body.length, 7);
    assert.equal(view.statements[0].body[0].declarations[0].init.callee.name, 'toBoolean');
    const before = JSON.stringify(view.statements);
    const result = decodeExecutableHat({statements: view.statements, opcodeAliases: view.opcodeAliases,
      hatOpcode: metadata.opcode, scriptId: id, reporter: productionReporter(script.factorySource, view, project, 1)});
    assert.equal(result.consumed, 1);
    assert.equal(JSON.stringify(view.statements), before);
    assert.deepEqual(view.statements.slice(result.consumed).map(node => node.type), ['ExpressionStatement', 'ReturnStatement']);
    if (id === 'greater') assert.deepEqual(result.hat, greaterThanHat);
    else if (id === 'variable') assert.deepEqual(result.hat, hat('event_whengreaterthan', {
      VALUE: {variable: {name: 'threshold', id: 'threshold'}}
    }, {WHENGREATERTHANMENU: ['loudness', null]}));
    else if (id === 'video') assert.deepEqual(result.hat, hat('videoSensing_whenMotionGreaterThan', {REFERENCE: {literal: 15}}));
    else assert.deepEqual(result.hat, touchingHat('_mouse_'));
    for (const broken of [
      script.factorySource.replace('target.hasEdgeActivatedValue(id)', 'target.hasEdgeActivatedValue("foreign")'),
      script.factorySource.replace('!oldEdgeValue && resolvedValue', '!oldEdgeValue || resolvedValue'),
      script.factorySource.replace('yield;', 'yield 1;')
    ]) {
      const invalid = compileView(broken);
      let calls = 0;
      assert.throws(() => decodeExecutableHat({statements: invalid.statements, opcodeAliases: invalid.opcodeAliases,
        hatOpcode: metadata.opcode, scriptId: id, reporter() {calls++;}}));
      assert.equal(calls, 0);
    }
  }
});
