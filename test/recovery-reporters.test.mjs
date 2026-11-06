import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {decodeAdditionalReporter} from '../src/recovery-reporters.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';

// Provenance: generated expressions below come directly from the checked-in
// 02Engine JSGenerator and IntermediateInput.toType, without a source rewrite.
const require = createRequire(import.meta.url);
const vmRoot = new URL('../../research/02engine/scratch-vm/', import.meta.url);
const trustedModule = file => require(fileURLToPath(new URL(`src/${file}`, vmRoot)));
const JSGenerator = trustedModule('compiler/jsgen.js');
const {IntermediateInput} = trustedModule('compiler/intermediate.js');
const {InputOpcode, InputType} = trustedModule('compiler/enums.js');
const execute = trustedModule('compiler/jsexecute.js');
const Operators = trustedModule('blocks/scratch3_operators.js');
const Sensing = trustedModule('blocks/scratch3_sensing.js');
const Looks = trustedModule('blocks/scratch3_looks.js');
const Cast = trustedModule('util/cast.js');
const generator = new JSGenerator({}, {procedures: {}}, {runtime: {debug: false}});
const input = (opcode, type = InputType.ANY, inputs = {}) => new IntermediateInput(InputOpcode[opcode], type, inputs);
const text = value => input('CONSTANT', InputType.STRING, {value});
const number = value => input('CONSTANT', IntermediateInput.getNumberInputType(value), {value});
const generated = node => generator.descendInput(node);

const expressionOf = source => parse(`(${source})`, {ecmaVersion: 'latest'}).body[0].expression;
const identifier = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);
const propertyName = node => node?.type === 'MemberExpression' ?
  (node.computed ? node.property?.type === 'Literal' ? String(node.property.value) : null : node.property?.name) : null;
const member = (node, object, key) => node?.type === 'MemberExpression' && identifier(node.object, object) && propertyName(node) === key;
const chain = node => identifier(node) ? node.name : node?.type === 'MemberExpression' && propertyName(node) !== null ? `${chain(node.object)}.${propertyName(node)}` : null;
const literal = node => node?.type === 'Literal' ? node.value : undefined;
const numeric = node => typeof literal(node) === 'number' ||
  node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) ||
  ['target.x', 'target.y', 'target.direction', 'target.size'].includes(chain(node)) ||
  node?.type === 'CallExpression' && ['Math.abs', 'Math.floor', 'Math.ceil', 'Math.round', 'Math.sqrt', 'Math.log', 'Math.exp'].includes(chain(node.callee));
const nonNaN = node => typeof literal(node) === 'number' && Number.isFinite(literal(node)) && !Object.is(literal(node), -0) ||
  node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && nonNaN(node.argument) ||
  ['target.x', 'target.y', 'target.direction', 'target.size'].includes(chain(node));
const project = {targets: [{isStage: true}, {isStage: false}]};
const decode = (source, options = {}) => {
  const calls = [];
  const fail = message => { throw new Error(message); };
  const reporter = (node, context = 'value') => {
    calls.push({source: source.slice(node.start, node.end), context});
    if (node.type === 'Literal' && ['number', 'string'].includes(typeof literal(node))) return {literal: literal(node)};
    if (node.type === 'Identifier' && node.name === 'value') return {variable: {name: 'value', id: 'value-id'}};
    throw new Error(`unsupported nested reporter: ${source.slice(node.start, node.end)}`);
  };
  const result = decodeAdditionalReporter(expressionOf(source), {
    project, targetIndex: 1, reporter, chain, literal, identifier, member, numeric, nonNaN, fail, ...options
  });
  return {result, calls};
};

test('decodes exact date selectors and current-menu fields', () => {
  for (const [source, menu] of [
    ['new Date().getFullYear()', 'year'], ['new Date().getMonth() + 1', 'month'],
    ['new Date().getDate()', 'date'], ['new Date().getDay() + 1', 'dayofweek'],
    ['new Date().getHours()', 'hour'], ['new Date().getMinutes()', 'minute'], ['new Date().getSeconds()', 'second']
  ]) {
    assert.deepEqual(decode(source).result, {opcode: 'sensing_current', inputs: {}, fields: {CURRENTMENU: [menu, null]}});
  }
  assert.throws(() => decode('new Date(2000).getDate()'), /constructor arguments/);
  assert.throws(() => decode('new Date(sideEffect()).getDate()'));
  for (const source of ['new Date().getMonth()', 'new Date().getDay()', 'new Date().getUTCDate()',
    'new Date().getTime()', 'new Date().constructor()', 'new Date().toString()']) assert.equal(decode(source).result, null, source);
});

test('decodes costume and backdrop number/name selectors', () => {
  assert.deepEqual(decode('target.getCostumes()[target.currentCostume].name').result,
    {opcode: 'looks_costumenumbername', inputs: {}, fields: {NUMBER_NAME: ['name', null]}});
  assert.deepEqual(decode('stage.getCostumes()[stage.currentCostume].name').result,
    {opcode: 'looks_backdropnumbername', inputs: {}, fields: {NUMBER_NAME: ['name', null]}});
  assert.deepEqual(decode('target.currentCostume + 1').result,
    {opcode: 'looks_costumenumbername', inputs: {}, fields: {NUMBER_NAME: ['number', null]}});
  assert.deepEqual(decode('stage.currentCostume + 1').result,
    {opcode: 'looks_backdropnumbername', inputs: {}, fields: {NUMBER_NAME: ['number', null]}});
  assert.equal(decode('stage.getCostumes()[target.currentCostume].name').result, null);
});

test('decodes case-insensitive contains only with symmetric explicit string casts', () => {
  const result = decode('"Hello ".toLowerCase().indexOf("WORLD".toLowerCase()) !== -1').result;
  assert.deepEqual(result, {opcode: 'operator_contains', inputs: {STRING1: {literal: 'Hello '}, STRING2: {literal: 'WORLD'}} , fields: {}});
  assert.throws(() => decode('value.toLowerCase().indexOf("x".toLowerCase()) !== -1'));
  assert.equal(decode('"x".toLowerCase().indexOf("y".toLowerCase()) !== 0').result, null);
});

test('decodes letterOf only for finite integer indices in the compiler-safe bound', () => {
  assert.deepEqual(decode('"abc"[2 - 1] || ""').result,
    {opcode: 'operator_letter_of', inputs: {LETTER: {literal: 2}, STRING: {literal: 'abc'}}, fields: {}});
  assert.deepEqual(decode('"abc"[(2 | 0) - 1] || ""').result.inputs.LETTER, {literal: 2});
  for (const source of ['"abc"[1.5 - 1] || ""', '"abc"[Infinity - 1] || ""', '"abc"[-1 - 1] || ""', '"abc"[2147483648 - 1] || ""',
    '"abc"[value - 1] || ""', '"abc"[2.2 - 1] || ""']) assert.throws(() => decode(source), source);
});

test('decodes logarithms and degree trig forms with a proven non-NaN numeric input', () => {
  for (const [source, opcode] of [
    ['Math.log(10) / Math.LN10', 'log'],
    ['((Math.acos(1) * 180) / Math.PI)', 'acos'], ['((Math.asin(0) * 180) / Math.PI)', 'asin'],
    ['((Math.atan(1) * 180) / Math.PI)', 'atan'],
    ['(Math.round(Math.cos((Math.PI * 60) / 180) * 1e10) / 1e10)', 'cos'],
    ['(Math.round(Math.sin((Math.PI * 30) / 180) * 1e10) / 1e10)', 'sin']
  ]) {
    const result = decode(source).result;
    assert.equal(result.opcode, 'operator_mathop', source);
    assert.equal(result.fields.OPERATOR[0], opcode, source);
  }
  assert.throws(() => decode('Math.log("not a number") / Math.LN10'));
  assert.equal(decode('Math.log(10)').result, null, 'basic ln remains owned by compiled-factory');
  assert.equal(decode('Math.tan(45)').result, null, 'existing tan helper remains owned by compiled-factory');
});

test('decodes key, username, distance and daysSince2000 helpers with exact arity', () => {
  assert.deepEqual(decode('runtime.ioDevices.keyboard.getKeyIsDown("space")').result,
    {opcode: 'sensing_keypressed', inputs: {KEY_OPTION: {literal: 'space'}}, fields: {}});
  assert.deepEqual(decode('runtime.ioDevices.userData.getUsername()').result,
    {opcode: 'sensing_username', inputs: {}, fields: {}});
  assert.deepEqual(decode('distance("_mouse_")').result,
    {opcode: 'sensing_distanceto', inputs: {DISTANCETOMENU: {literal: '_mouse_'}}, fields: {}});
  assert.deepEqual(decode('daysSince2000()').result,
    {opcode: 'sensing_dayssince2000', inputs: {}, fields: {}});
  for (const source of ['daysSince2000(1)', 'distance(value, sideEffect())', 'runtime.ioDevices.userData.getUsername(1)',
    'runtime.ioDevices.keyboard.getKeyIsDown()']) assert.throws(() => decode(source), source);
});

test('decodes only strict literal color inputs and preserves target/mask argument order', () => {
  assert.deepEqual(decode('target.isTouchingColor(colorToList("#0f08aa"))').result,
    {opcode: 'sensing_touchingcolor', inputs: {COLOR: {literal: '#0f08aa'}}, fields: {}});
  assert.deepEqual(decode('target.colorIsTouchingColor(colorToList("#010203"), colorToList("#aabbcc"))').result,
    {opcode: 'sensing_coloristouchingcolor', inputs: {COLOR: {literal: '#aabbcc'}, COLOR2: {literal: '#010203'}}, fields: {}});
  assert.deepEqual(decode('target.isTouchingColor([1, 2, 255])').result,
    {opcode: 'sensing_touchingcolor', inputs: {COLOR: {literal: '#0102ff'}}, fields: {}});
  for (const source of ['target.isTouchingColor(colorToList(value))', 'target.isTouchingColor(colorToList({r: 1, g: 2, b: 3}))',
    'target.isTouchingColor(colorToList("#12"))', 'target.isTouchingColor([1, 2.5, 3])',
    'target.colorIsTouchingColor(colorToList("#ffffff"), value)']) assert.throws(() => decode(source), source);
});

test('returns null for unknown reporters without invoking recursive decoding', () => {
  let calls = 0;
  const result = decodeAdditionalReporter(expressionOf('customReporter(value)'), {
    project, targetIndex: 1, reporter() { calls++; throw new Error('must not decode'); }, chain, literal, identifier, member, numeric, nonNaN,
    fail(message) { throw new Error(message); }
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

const recoveryProject = {targets: [
  {isStage: true, variables: {sink: ['sink', 0]}, lists: {}},
  {isStage: false, name: 'Sprite1', variables: {}, lists: {}}
]};
const factoryFor = source => `(function reporterFactory(thread) {
  const target = thread.target; const runtime = target.runtime; const stage = runtime.getTargetForStage();
  const sink = stage.variables["sink"]; return function () { sink.value = (${source}); retire(); return; };
})`;
const recoverExpression = source => decodeCompiledFactory(factoryFor(source), recoveryProject, 1).operations[0].inputs.VALUE;
const operators = new Operators({});
const stage = {isStage: true, currentCostume: 1, getCostumes: () => [{name: 'scene one'}, {name: 'scene TWO'}]};
const runtime = {on() {}, getTargetForStage: () => stage, getSpriteTargetByName: name => name === 'Sprite2' ? {x: 13, y: 24} : null,
  ioDevices: {keyboard: {getKeyIsDown: key => key === 'space'}, mouse: {getScratchX: () => 3, getScratchY: () => 4},
    userData: {getUsername: () => 'Test User'}}};
const sensing = new Sensing(runtime);
const looks = new Looks(runtime);
runtime.ext_scratch3_sensing = sensing;
const target = {isStage: false, runtime, x: 0, y: 0, currentCostume: 0,
  getCostumes: () => [{name: 'costume one'}, {name: 'costume TWO'}],
  isTouchingObject: object => object === '_mouse_',
  isTouchingColor: color => color.join(',') === '255,0,34',
  colorIsTouchingColor: (color, mask) => `${color.join(',')}/${mask.join(',')}`};
const util = {target, ioQuery: (device, method, args = []) => runtime.ioDevices[device][method](...args)};
const primitiveValue = ir => {
  if (Object.hasOwn(ir, 'literal')) return ir.literal;
  const args = Object.fromEntries(Object.entries(ir.inputs || {}).map(([key, value]) => [key, primitiveValue(value)]));
  for (const [key, [value]] of Object.entries(ir.fields || {})) args[key] = value;
  for (const blocks of [operators, sensing, looks]) {
    const primitive = blocks.getPrimitives()[ir.opcode];
    if (primitive) return primitive.call(blocks, args, util);
  }
  throw new Error(`Unimplemented test primitive ${ir.opcode}`);
};
// Only accept IntermediateInput instances built in this test. No synthetic or
// caller-supplied source is executed by this helper or by recovery.
const generatedValue = node => {
  assert.ok(node instanceof IntermediateInput);
  const evaluate = execute.scopedEval(`(function(target, runtime, stage) { return ${generated(node)}; })`);
  execute.saveGlobalState();
  try {
    let value;
    execute({target, generator: {next() { value = evaluate(target, runtime, stage); }}});
    return value;
  } finally { execute.restoreGlobalState(); }
};
const assertGeneratedEquivalent = node => {
  const source = generated(node);
  const ir = recoverExpression(source);
  assert.deepEqual(primitiveValue(ir), generatedValue(node), source);
  return ir;
};

test('actual jsgen contains casts preserve case-insensitive Scratch behavior and numeric-string distinctions', () => {
  for (const value of [123, 'HeLLo WORLD', false, '', 'İ', 'NaN']) {
    sensing._answer = value;
    const node = input('OP_CONTAINS', InputType.BOOLEAN, {
      string: input('SENSING_ANSWER', InputType.ANY).toType(InputType.STRING), contains: text('L')
    });
    assert.equal(assertGeneratedEquivalent(node).opcode, 'operator_contains');
  }
  assert.equal(operators.contains({STRING1: '01', STRING2: '1'}), true);
  assert.equal('1'.toLowerCase() === '01'.toLowerCase(), false);
  assert.equal(operators.equals({OPERAND1: '1', OPERAND2: '01'}), true);
  assert.throws(() => recoverExpression('"1".toLowerCase() === "01".toLowerCase()'));
});

test('actual jsgen letter literals match Scratch at safe boundaries; fractional and wrapped indices are preserved', () => {
  for (const index of [0, 1, 2, 4, 2147483647]) {
    const node = input('OP_LETTER_OF', InputType.STRING, {letter: number(index).toType(InputType.NUMBER_INDEX), string: text('abc')});
    assert.equal(assertGeneratedEquivalent(node).opcode, 'operator_letter_of');
  }
  assert.equal(operators.letterOf({LETTER: 1.5, STRING: 'abc'}), 'a');
  assert.equal('abc'[1.5 - 1] || '', '');
  const wrapped = input('OP_LETTER_OF', InputType.STRING, {
    letter: input('SENSING_ANSWER', InputType.ANY).toType(InputType.NUMBER_INDEX), string: text('abc')
  });
  sensing._answer = 4294967297;
  assert.equal(generatedValue(wrapped), 'a');
  assert.equal(operators.letterOf({LETTER: sensing._answer, STRING: 'abc'}), '');
  assert.throws(() => recoverExpression(generated(wrapped)));
});

test('actual jsgen math log and rounded degree trig match trusted primitives including NaN results', () => {
  for (const [opcode, operator, values] of [
    ['OP_LOG_10', 'log', [-1, 0, 1, 10, 'abc', 100]],
    ['OP_ASIN', 'asin', [-2, -1, 0, 1, 2, 'abc']], ['OP_ACOS', 'acos', [-2, -1, 0, 1, 2]],
    ['OP_ATAN', 'atan', [-10, 0, 1, 10, 'abc']],
    ['OP_SIN', 'sin', [-90, 0, 30, 90, 360, 'abc']], ['OP_COS', 'cos', [-90, 0, 60, 90, 360]]
  ]) {
    for (const value of values) {
      sensing._answer = value;
      const node = input(opcode, InputType.NUMBER_OR_NAN, {value: input('SENSING_ANSWER', InputType.ANY).toType(InputType.NUMBER)});
      const ir = assertGeneratedEquivalent(node);
      assert.deepEqual(ir.fields.OPERATOR, [operator, null]);
    }
  }
  sensing._answer = -1;
  const nan = input('OP_SQRT', InputType.NUMBER_OR_NAN, {value: input('SENSING_ANSWER', InputType.ANY).toType(InputType.NUMBER)});
  const cast = input('OP_LOG_10', InputType.NUMBER_OR_NAN, {value: nan.toType(InputType.NUMBER)});
  assert.equal(primitiveValue(recoverExpression(generated(cast))), -Infinity);
  assert.equal(generatedValue(cast), -Infinity);
  assert.throws(() => recoverExpression('Math.log(Math.sqrt(-1)) / Math.LN10'));
  assert.throws(() => recoverExpression('Math.round(Math.sin((Math.PI * Math.sqrt(-1)) / 180) * 1e10) / 1e10'));
  assert.equal(operators.mathop({OPERATOR: 'log', NUM: NaN}), -Infinity);
  assert.equal(Number.isNaN(Math.log(NaN) / Math.LN10), true);
});

test('actual jsgen date selectors and daysSince2000 match Scratch under a frozen clock', () => {
  const RealDate = globalThis.Date;
  const instant = RealDate.UTC(2026, 9, 11, 12, 34, 56);
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  try {
    for (const opcode of ['SENSING_TIME_YEAR', 'SENSING_TIME_MONTH', 'SENSING_TIME_DATE', 'SENSING_TIME_WEEKDAY',
      'SENSING_TIME_HOUR', 'SENSING_TIME_MINUTE', 'SENSING_TIME_SECOND', 'SENSING_TIME_DAYS_SINCE_2000']) {
      assertGeneratedEquivalent(input(opcode, InputType.NUMBER));
    }
  } finally { globalThis.Date = RealDate; }
});

test('actual jsgen key, username, distance and appearance reporters match trusted primitives', () => {
  for (const node of [input('SENSING_KEY_DOWN', InputType.BOOLEAN, {key: text('space')}),
    input('SENSING_USERNAME', InputType.STRING), input('SENSING_DISTANCE', InputType.NUMBER, {target: text('_mouse_')}),
    input('SENSING_DISTANCE', InputType.NUMBER, {target: text('Sprite2')}),
    input('SENSING_DISTANCE', InputType.NUMBER, {target: text('absent')}),
    ...['LOOKS_COSTUME_NUMBER', 'LOOKS_COSTUME_NAME', 'LOOKS_BACKDROP_NUMBER', 'LOOKS_BACKDROP_NAME'].map(opcode => input(opcode)),
    input('SENSING_TOUCHING_OBJECT', InputType.BOOLEAN, {object: text('_mouse_')})]) assertGeneratedEquivalent(node);
});

test('actual jsgen RGB constants and colorToList literal casts preserve renderer RGB and mask order', () => {
  const first = text('#ff0022').toType(InputType.COLOR);
  const mask = text('#123456').toType(InputType.COLOR);
  const touching = input('SENSING_TOUCHING_COLOR', InputType.BOOLEAN, {color: first});
  const twoColors = input('SENSING_COLOR_TOUCHING_COLOR', InputType.BOOLEAN, {target: first, mask});
  assertGeneratedEquivalent(touching);
  assertGeneratedEquivalent(twoColors);
  assert.deepEqual(recoverExpression(generated(twoColors)).inputs, {COLOR: {literal: '#123456'}, COLOR2: {literal: '#ff0022'}});
  const runtimeCast = input('CAST_COLOR', InputType.COLOR, {target: text('#ff0022')});
  assertGeneratedEquivalent(input('SENSING_TOUCHING_COLOR', InputType.BOOLEAN, {color: runtimeCast}));
  assert.deepEqual(Cast.toRgbColorList([255, 0, 34]), [0, 0, 0]);
  assert.throws(() => decode('target.isTouchingColor(colorToList([255, 0, 34]))'));
});

test('exact arity is checked before recursive callbacks in known reporter templates', () => {
  for (const source of ['daysSince2000(1)', 'daysSince2000(...values)', 'distance()', 'distance("x", sideEffect())',
    'runtime.ioDevices.keyboard.getKeyIsDown(...values)', 'runtime.ioDevices.userData.getUsername(1)',
    'target.isTouchingObject("x", sideEffect())', 'target.isTouchingColor([1,2,3], sideEffect())',
    'target.colorIsTouchingColor([1,2,3])', 'new Date().getDate(1)', 'target.getCostumes(1)[target.currentCostume].name',
    'Math.log(10, sideEffect()) / Math.LN10', '(Math.asin(1, sideEffect()) * 180) / Math.PI',
    'Math.round(Math.sin((Math.PI * 1) / 180, sideEffect()) * 1e10) / 1e10',
    '"x".toLowerCase(1).indexOf("x".toLowerCase()) !== -1',
    '"x".toLowerCase().indexOf("x".toLowerCase(), 1) !== -1']) {
    let calls = 0;
    assert.throws(() => decode(source, {reporter() { calls++; throw new Error('callback must not run'); }}), source);
    assert.equal(calls, 0, source);
  }
});

test('optional AST calls and members cannot impersonate unconditional compiler helpers', () => {
  // Synthetic AST provenance: variants of parsed ordinary calls intentionally
  // retain permissive caller chain() output while changing optional flags.
  const ast = expressionOf('runtime.ioDevices.userData.getUsername()');
  for (const node of [{...ast, optional: true}, {...ast, callee: {...ast.callee, optional: true}},
    {...ast, callee: {...ast.callee, object: {...ast.callee.object, optional: true}}}]) {
    let calls = 0;
    const result = decodeAdditionalReporter(node, {project, targetIndex: 1, chain, literal, identifier, member, numeric, nonNaN,
      reporter() { calls++; }, fail(message) { throw new Error(message); }});
    assert.equal(result, null);
    assert.equal(calls, 0);
  }
});

test('raw scalar math, size and sensing_of target aliases remain owned or preserved', () => {
  for (const source of ['Math.abs(1)', 'Math.log(10)', 'Math.round(target.size)', 'target.size',
    'Math.sin(1)', 'Math.asin(1)', 'Math.tan(1)', '10 ** 2',
    'Math.log(10) / Math.LN2', 'Math.round(Math.sin((Math.PI * 1) / 180) * 1e9) / 1e9',
    '(otherTarget ? otherTarget.size : 0)', '(otherTarget ? otherTarget.currentCostume + 1 : 0)',
    'runtime.ext_scratch3_sensing.getAttributeOf({OBJECT: value, PROPERTY: "size"})',
    'colorToList("#ffffff")', '[1, 2, 3]']) assert.equal(decode(source).result, null, source);
  assert.throws(() => recoverExpression('target.size'));
  assert.throws(() => recoverExpression('Math.sqrt(-1) + 1'));
});

test('color byte validation rejects holes, spreads, coercions, objects and out-of-range channels', () => {
  for (const color of ['[]', '[0,0]', '[0,0,0,0]', '[0,,0]', '[0,...value]', '[0,"2",0]', '[0,true,0]',
    '[0,0,-1]', '[0,0,256]', '[0,0,1.5]', '[0,0,1e999]', '[0,0,-0]', '{r:0,g:0,b:0}', 'value',
    'colorToList({r:1,g:2,b:3})', 'colorToList([1,2,3])', 'colorToList("#ffgg00")', 'colorToList(-1)',
    'colorToList(16777216)', 'colorToList(1.5)', 'colorToList(...value)']) {
    assert.throws(() => decode(`target.isTouchingColor(${color})`), color);
  }
  for (const [color, hex] of [['colorToList("#Fa3")', '#ffaa33'], ['colorToList(0)', '#000000'],
    ['colorToList(16777215)', '#ffffff'], ['[0,255,1]', '#00ff01']]) {
    const result = decode(`target.isTouchingColor(${color})`).result;
    assert.deepEqual(result.inputs.COLOR, {literal: hex});
  }
});

test('recursive inputs are reinvoked with the correct context and preserve AST provenance', () => {
  for (const [source, contexts] of [
    ['runtime.ioDevices.keyboard.getKeyIsDown(value)', ['value']], ['target.isTouchingObject(value)', ['value']],
    ['distance("" + value)', ['string']],
    ['("" + value).toLowerCase().indexOf("x".toLowerCase()) !== -1', ['string', 'string']],
    ['Math.log(10) / Math.LN10', ['number']], ['"abc"[2 - 1] || ""', ['string']]
  ]) {
    const ast = expressionOf(source);
    const before = JSON.stringify(ast);
    const seen = [];
    const result = decodeAdditionalReporter(ast, {project, targetIndex: 1, chain, literal, identifier, member, numeric, nonNaN,
      reporter(child, context) { seen.push({child, context}); return {literal: 0}; }, fail(message) { throw new Error(message); }});
    assert.ok(result, source);
    assert.deepEqual(seen.map(item => item.context), contexts, source);
    assert.ok(seen.every(item => typeof item.child.start === 'number'), 'original AST node retains location');
    assert.equal(JSON.stringify(ast), before);
  }
});

test('hostile unknown input is never executed, and callback rejection propagates', () => {
  const source = 'runtime.ioDevices.keyboard.getKeyIsDown((() => { globalThis.__reporterProbe = 1; })())';
  const rejection = new Error('unsupported nested AST');
  assert.throws(() => decode(source, {reporter() { throw rejection; }}), actual => actual === rejection);
  assert.equal(Object.hasOwn(globalThis, '__reporterProbe'), false);
});

