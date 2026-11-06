import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '@turbowarp/jszip';
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {decodeNativeCommand} from '../src/recovery-native-commands.mjs';
import {RECOVERY_OPCODE_SCHEMA} from '../src/recovery-opcode-schema.mjs';
import {decodeCompiledFactory} from '../src/compiled-factory.mjs';
import {buildRecoveredStack} from '../src/recovered-blocks.mjs';
import {validateSb3} from '../src/sb3-validate.mjs';
import {makeMinimalSb3} from './helpers.mjs';
import {actualVMClass, compileReal02} from './real-02-compiler.mjs';

const expressionOf = source => parse(`(${source})`, {ecmaVersion: 'latest'}).body[0].expression;
const identifier = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);
const propertyName = node => node?.type === 'MemberExpression' ?
  (node.computed ? node.property?.type === 'Literal' ? String(node.property.value) : null : node.property?.name) : null;
const member = (node, object, key) => node?.type === 'MemberExpression' && identifier(node.object, object) && propertyName(node) === key;
const chain = node => identifier(node) ? node.name : node?.type === 'MemberExpression' && propertyName(node) !== null ? `${chain(node.object)}.${propertyName(node)}` : null;
const literal = node => node?.type === 'Literal' ? node.value : undefined;
// Deliberately mirror the integration caller's type hint (including its NaN
// candidates), so hostile tests exercise the native decoder's extra proof.
const numeric = node => typeof literal(node) === 'number' ||
  node?.type === 'LogicalExpression' && node.operator === '||' && literal(node.right) === 0 && node.left?.type === 'UnaryExpression' && node.left.operator === '+' ||
  node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) ||
  ['target.x', 'target.y', 'target.direction', 'target.size', 'target.volume', 'stage.tempo'].includes(chain(node)) ||
  node?.type === 'CallExpression' && ['toNotNaN', 'Math.abs', 'Math.floor', 'Math.ceil', 'Math.round', 'Math.sqrt', 'Math.log', 'Math.exp', 'random', 'mod', 'listIndexOf'].includes(chain(node.callee)) ||
  node?.type === 'MemberExpression' && propertyName(node) === 'length';
const fail = message => { throw new Error(message); };
const projectFixture = () => ({targets: [
  {isStage: true, name: 'Stage', variables: {global: ['same name', 0]}, lists: {globalList: ['same list', []]}},
  {isStage: false, name: 'Sprite1', variables: {local: ['same name', 0]}, lists: {localList: ['same list', []]}},
  {isStage: false, name: 'Sprite2', variables: {other: ['same name', 0]}, lists: {otherList: ['same list', []]}}
], monitors: []});
const decodeLiteral = node => {
  if (node?.type === 'Literal' && ['number', 'string'].includes(typeof node.value) &&
      (typeof node.value !== 'number' || Number.isFinite(node.value) && !Object.is(node.value, -0))) return {literal: node.value};
  if (node?.type === 'UnaryExpression' && node.operator === '-' && typeof literal(node.argument) === 'number' &&
      Number.isFinite(-literal(node.argument)) && !Object.is(-literal(node.argument), -0)) return {literal: -literal(node.argument)};
  throw new Error('Test literal reporter rejected unsupported input');
};
const decode = (source, options = {}) => decodeNativeCommand(expressionOf(source), {
  project: projectFixture(), targetIndex: 1, reporter: decodeLiteral, chain, literal, identifier, member, numeric, fail, ...options
});
const op = (opcode, inputs = {}, fields = {}, shadowInputs) => ({opcode, inputs, fields, ...(shadowInputs ? {shadowInputs} : {})});
const menu = (opcode, input, value) => {
  const definition = RECOVERY_OPCODE_SCHEMA[opcode].shadowInputs[input];
  return {[input]: {opcode: definition.opcode, fields: {[definition.field]: [String(value), null]}}};
};

const positiveCases = [
  ['effect set with clamp', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", 150))', op('looks_seteffectto', {VALUE: {literal: 150}}, {EFFECT: ['GHOST', null]})],
  ['effect change exact delta-before-state', 'target.setEffect("brightness", runtime.ext_scratch3_looks.clampEffect("brightness", -15 + target.effects["brightness"]))', op('looks_changeeffectby', {CHANGE: {literal: -15}}, {EFFECT: ['BRIGHTNESS', null]})],
  ['pen clear', 'runtime.ext_pen.clear()', op('pen_clear')],
  ['pen stamp', 'runtime.ext_pen._stamp(target)', op('pen_stamp')],
  ['pen down', 'runtime.ext_pen._penDown(target)', op('pen_penDown')],
  ['pen up', 'runtime.ext_pen._penUp(target)', op('pen_penUp')],
  ['pen color', 'runtime.ext_pen._setPenColorToColor("#ff0088", target)', op('pen_setPenColorToColor', {COLOR: {literal: '#ff0088'}})],
  ['pen change color parameter', 'runtime.ext_pen._setOrChangeColorParam("transparency", 10, runtime.ext_pen._getPenState(target), true)', op('pen_changePenColorParamBy', {VALUE: {literal: 10}, COLOR_PARAM: {literal: 'transparency'}}, {}, menu('pen_changePenColorParamBy', 'COLOR_PARAM', 'transparency'))],
  ['pen set color parameter', 'runtime.ext_pen._setOrChangeColorParam("saturation", 25, runtime.ext_pen._getPenState(target), false)', op('pen_setPenColorParamTo', {VALUE: {literal: 25}, COLOR_PARAM: {literal: 'saturation'}}, {}, menu('pen_setPenColorParamTo', 'COLOR_PARAM', 'saturation'))],
  ['pen change size', 'runtime.ext_pen._changePenSizeBy(-2, target)', op('pen_changePenSizeBy', {SIZE: {literal: -2}})],
  ['pen set size', 'runtime.ext_pen._setPenSizeTo(4, target)', op('pen_setPenSizeTo', {SIZE: {literal: 4}})],
  ['pen change legacy hue', 'runtime.ext_pen._changePenHueBy(10, target)', op('pen_changePenHueBy', {HUE: {literal: 10}})],
  ['pen set legacy hue', 'runtime.ext_pen._setPenHueToNumber(60, target)', op('pen_setPenHueToNumber', {HUE: {literal: 60}})],
  ['pen change legacy shade', 'runtime.ext_pen._changePenShadeBy(-20, target)', op('pen_changePenShadeBy', {SHADE: {literal: -20}})],
  ['pen set legacy shade', 'runtime.ext_pen._setPenShadeToNumber(30, target)', op('pen_setPenShadeToNumber', {SHADE: {literal: 30}})],
  ['global scalar show', 'runtime.monitorBlocks.changeBlock({id: "global", element: "checkbox", value: true}, runtime)', op('data_showvariable', {}, {VARIABLE: ['same name', 'global']})],
  ['local scalar hide', 'runtime.monitorBlocks.changeBlock({value: false, "element": "checkbox", "id": "local"}, runtime)', op('data_hidevariable', {}, {VARIABLE: ['same name', 'local']})],
  ['global list show', 'runtime.monitorBlocks.changeBlock({id: "globalList", element: "checkbox", value: true}, runtime)', op('data_showlist', {}, {LIST: ['same list', 'globalList']})],
  ['local list hide', 'runtime.monitorBlocks.changeBlock({id: "localList", element: "checkbox", value: false}, runtime)', op('data_hidelist', {}, {LIST: ['same list', 'localList']})],
  ['create clone', 'runtime.ext_scratch3_control._createClone("_myself_", target)', op('control_create_clone_of', {CLONE_OPTION: {literal: '_myself_'}}, {}, menu('control_create_clone_of', 'CLONE_OPTION', '_myself_'))],
  ['clear counter', 'runtime.ext_scratch3_control._counter = 0', op('control_clear_counter')],
  ['increment counter', 'runtime.ext_scratch3_control._counter++', op('control_incr_counter')],
  ['stop others', 'runtime.stopForTarget(target, thread)', op('control_stop', {}, {STOP_OPTION: ['other scripts in sprite', null]})],
  ['next costume', 'target.setCostume(target.currentCostume + 1)', op('looks_nextcostume')],
  ['switch costume literal shadow', 'runtime.ext_scratch3_looks._setCostume(target, "costume2")', op('looks_switchcostumeto', {COSTUME: {literal: 'costume2'}}, {}, menu('looks_switchcostumeto', 'COSTUME', 'costume2'))],
  ['next backdrop', 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true)', op('looks_nextbackdrop')],
  ['switch backdrop literal shadow', 'runtime.ext_scratch3_looks._setBackdrop(stage, "backdrop2")', op('looks_switchbackdropto', {BACKDROP: {literal: 'backdrop2'}}, {}, menu('looks_switchbackdropto', 'BACKDROP', 'backdrop2'))]
];
for (const [label, source, expected] of positiveCases) {
  test(`native command shape: ${label}`, () => {
    const ast = expressionOf(source);
    const before = JSON.stringify(ast);
    assert.deepEqual(decodeNativeCommand(ast, {project: projectFixture(), targetIndex: 1, reporter: decodeLiteral, chain, literal, identifier, member, numeric, fail}), expected);
    assert.equal(JSON.stringify(ast), before, 'decoder does not mutate input AST');
    const schema = RECOVERY_OPCODE_SCHEMA[expected.opcode];
    assert.deepEqual(Object.keys(expected.inputs).sort(), [...schema.inputs].sort());
    assert.deepEqual(Object.keys(expected.fields).sort(), [...schema.fields].sort());
  });
}

test('native shape coverage includes all 13 pen commands and 27 operation opcodes', () => {
  const opcodes = new Set(positiveCases.map(([, , expected]) => expected.opcode));
  assert.equal([...opcodes].filter(opcode => opcode.startsWith('pen_')).length, 13);
  assert.equal(opcodes.size, 27);
});

test('all seven known lowercase effects and four pen parameters have exact field/menu names', () => {
  for (const effect of ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost']) {
    for (const change of [false, true]) {
      const value = change ? `5 + target.effects[${JSON.stringify(effect)}]` : '5';
      const result = decode(`target.setEffect(${JSON.stringify(effect)}, runtime.ext_scratch3_looks.clampEffect(${JSON.stringify(effect)}, ${value}))`);
      assert.equal(result.opcode, change ? 'looks_changeeffectby' : 'looks_seteffectto');
      assert.deepEqual(result.fields.EFFECT, [effect.toUpperCase(), null]);
    }
  }
  for (const param of ['color', 'saturation', 'brightness', 'transparency']) {
    for (const change of [false, true]) {
      const result = decode(`runtime.ext_pen._setOrChangeColorParam("${param}", 20, runtime.ext_pen._getPenState(target), ${change})`);
      assert.deepEqual(result.shadowInputs.COLOR_PARAM.fields, {colorParam: [param, null]});
    }
  }
});

test('stop-others field follows stage identity and preserves a continuing next block', () => {
  const operation = decode('runtime.stopForTarget(target, thread)', {targetIndex: 0});
  assert.deepEqual(operation.fields, {STOP_OPTION: ['other scripts in stage', null]});
  const target = {blocks: {hat: block('event_whenflagclicked', null, null, {}, {}, true)}};
  buildRecoveredStack({target, parentId: 'hat', operations: [operation, op('control_incr_counter')], idFor: key => `block-${key}`, recordBlock() {}});
  assert.equal(target.blocks['block-0'].next, 'block-1');
});

test('costume/backdrop menu numeric and numeric-string literals retain distinct input types', () => {
  for (const [helper, opcode, owner, input] of [
    ['_setCostume', 'looks_switchcostumeto', 'target', 'COSTUME'],
    ['_setBackdrop', 'looks_switchbackdropto', 'stage', 'BACKDROP']
  ]) {
    for (const value of [2, -2, '2', 'next costume', '', '中文\\name']) {
      const result = decode(`runtime.ext_scratch3_looks.${helper}(${owner}, ${JSON.stringify(value)})`);
      assert.deepEqual(result.inputs[input], {literal: value});
      assert.deepEqual(result.shadowInputs, menu(opcode, input, value));
      const target = {blocks: {hat: block('event_whenflagclicked', null, null, {}, {}, true)}};
      buildRecoveredStack({target, parentId: 'hat', operations: [result], idFor: key => `menu-${key}`, recordBlock() {}});
      const emitted = target.blocks['menu-0'].inputs[input];
      if (typeof value === 'number') {
        assert.deepEqual(emitted, [3, `menu-0/${input}`, `menu-0/${input}/shadow`]);
        assert.equal(target.blocks[emitted[1]].opcode, 'operator_add');
        assert.deepEqual(target.blocks[emitted[1]].inputs.NUM1, [1, [4, value]]);
      } else assert.deepEqual(emitted, [3, [10, value], `menu-0/${input}/shadow`]);
    }
  }
});

test('monitor resolution preserves IDs even with duplicate names and special object keys', () => {
  const project = projectFixture();
  project.targets[1].variables = JSON.parse('{"__proto__": ["same name", 0]}');
  assert.deepEqual(decode('runtime.monitorBlocks.changeBlock({id: "__proto__", element: "checkbox", value: true}, runtime)', {project}).fields,
    {VARIABLE: ['same name', '__proto__']});
  assert.equal(Object.prototype.polluted, undefined);
  const normal = projectFixture();
  normal.monitors = [{id: 'localList', opcode: 'data_listcontents', params: {LIST: 'same list'}, spriteName: 'Sprite1', visible: false}];
  assert.equal(decode('runtime.monitorBlocks.changeBlock({id: "localList", element: "checkbox", value: true}, runtime)', {project: normal}).opcode, 'data_showlist');
});

const malformed = [
  ['unclamped effect', 'target.setEffect("ghost", 20)'],
  ['wrong clamp effect', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("brightness", 20))'],
  ['unknown effect', 'target.setEffect("constructor", runtime.ext_scratch3_looks.clampEffect("constructor", 20))'],
  ['uppercase helper effect', 'target.setEffect("GHOST", runtime.ext_scratch3_looks.clampEffect("GHOST", 20))'],
  ['effect field expression', 'target.setEffect(effect, runtime.ext_scratch3_looks.clampEffect("ghost", 20))'],
  ['effect clamp extra argument', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", 20, sideEffect()))'],
  ['effect clamp spread', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", ...values))'],
  ['effect clamp optional', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect?.("ghost", 20))'],
  ['effect change reversed addition', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", target.effects.ghost + 20))'],
  ['effect change mismatched state', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", 20 + target.effects.brightness))'],
  ['effect change other target', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", 20 + stage.effects.ghost))'],
  ['effect change string concatenation', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", "20" + target.effects.ghost))'],
  ['effect NaN candidate', 'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("ghost", Math.sqrt(-1)))'],
  ['pen state wrong target', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState(stage), true)'],
  ['pen state wrong helper', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getState(target), true)'],
  ['pen state alias', 'runtime.ext_pen._setOrChangeColorParam("color", 10, state, true)'],
  ['pen state extra argument', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState(target, sideEffect()), true)'],
  ['pen state spread', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState(...targets), true)'],
  ['pen state optional', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState?.(target), true)'],
  ['pen numeric change flag', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState(target), 1)'],
  ['pen string change flag', 'runtime.ext_pen._setOrChangeColorParam("color", 10, runtime.ext_pen._getPenState(target), "false")'],
  ['pen unknown parameter', 'runtime.ext_pen._setOrChangeColorParam("hue", 10, runtime.ext_pen._getPenState(target), true)'],
  ['pen dynamic menu default lost', 'runtime.ext_pen._setOrChangeColorParam(param, 10, runtime.ext_pen._getPenState(target), true)'],
  ['pen string size', 'runtime.ext_pen._changePenSizeBy("10", target)'],
  ['pen raw scalar lacks numeric proof', 'runtime.ext_pen._setPenHueToNumber(v0.value, target)'],
  ['pen NaN unary cast', 'runtime.ext_pen._setPenSizeTo(+"not numeric", target)'],
  ['pen nonfinite literal', 'runtime.ext_pen._setPenSizeTo(1e999, target)'],
  ['pen negative zero', 'runtime.ext_pen._setPenSizeTo(-0, target)'],
  ['pen raw target state', 'runtime.ext_pen._setPenSizeTo(target, target)'],
  ['clone wrong target', 'runtime.ext_scratch3_control._createClone("_myself_", stage)'],
  ['clone uncast numeric option', 'runtime.ext_scratch3_control._createClone(2, target)'],
  ['clone boolean option', 'runtime.ext_scratch3_control._createClone(true, target)'],
  ['clone dynamic menu default lost', 'runtime.ext_scratch3_control._createClone("" + v0.value, target)'],
  ['stop no thread exception', 'runtime.stopForTarget(target)'],
  ['stop wrong thread exception', 'runtime.stopForTarget(target, otherThread)'],
  ['stop wrong target', 'runtime.stopForTarget(stage, thread)'],
  ['counter compound assignment', 'runtime.ext_scratch3_control._counter += 0'],
  ['counter nonzero assignment', 'runtime.ext_scratch3_control._counter = 1'],
  ['counter string zero', 'runtime.ext_scratch3_control._counter = "0"'],
  ['counter sequence side effect', 'runtime.ext_scratch3_control._counter = (sideEffect(), 0)'],
  ['counter prefix increment', '++runtime.ext_scratch3_control._counter'],
  ['counter decrement', 'runtime.ext_scratch3_control._counter--'],
  ['arbitrary costume index', 'target.setCostume(1)'],
  ['costume wrong companion', 'target.setCostume(stage.currentCostume + 1)'],
  ['costume wrong increment', 'target.setCostume(target.currentCostume + 2)'],
  ['costume dynamic default', 'runtime.ext_scratch3_looks._setCostume(target, v0.value)'],
  ['costume optional zero-index argument', 'runtime.ext_scratch3_looks._setCostume(target, 2, true)'],
  ['backdrop wrong target', 'runtime.ext_scratch3_looks._setBackdrop(target, "backdrop2")'],
  ['backdrop next missing flag', 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1)'],
  ['backdrop next false flag', 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, false)'],
  ['backdrop arbitrary third argument', 'runtime.ext_scratch3_looks._setBackdrop(stage, "backdrop2", true)'],
  ['backdrop dynamic default', 'runtime.ext_scratch3_looks._setBackdrop(stage, v0.value)'],
  ['menu regex value', 'runtime.ext_scratch3_looks._setCostume(target, /name/)'],
  ['menu bigint value', 'runtime.ext_scratch3_looks._setCostume(target, 2n)'],
  ['menu boolean value', 'runtime.ext_scratch3_looks._setCostume(target, false)'],
  ['menu nonfinite value', 'runtime.ext_scratch3_looks._setCostume(target, 1e999)']
];
for (const [label, source] of malformed) {
  test(`reject malformed native shape: ${label}`, () => assert.throws(() => decode(source)));
}

for (const [label, source] of positiveCases.filter(([, source]) => expressionOf(source).type === 'CallExpression')) {
  test(`native call validates arity and spread before reporter: ${label}`, () => {
    const ast = expressionOf(source);
    for (const args of [...(ast.arguments.length ? [ast.arguments.slice(0, -1),
      ast.arguments.map((arg, index) => index === 0 ? {type: 'SpreadElement', argument: arg} : arg)] : []),
      [...ast.arguments, expressionOf('sideEffect()')], [{type: 'SpreadElement', argument: expressionOf('sideEffect()')}]]) {
      let calls = 0;
      assert.throws(() => decodeNativeCommand({...ast, arguments: args}, {project: projectFixture(), targetIndex: 1,
        reporter() { calls++; throw new Error('reporter must not run'); }, chain, literal, identifier, member, numeric, fail}));
      assert.equal(calls, 0);
    }
  });
}

const badMonitorObjects = [
  '{id: "global", element: "field", value: true}',
  '{id: "global", element: "checkbox", value: 1}',
  '{id: 42, element: "checkbox", value: true}',
  '{id: "", element: "checkbox", value: true}',
  '{id: "global", element: "checkbox"}',
  '{id: "global", element: "checkbox", value: true, extra: sideEffect()}',
  '{id: "global", "id": "local", value: true}',
  '{["id"]: "global", element: "checkbox", value: true}',
  '{get id() { return "global"; }, element: "checkbox", value: true}',
  '{id() { return "global"; }, element: "checkbox", value: true}',
  '{...sideEffect(), element: "checkbox", value: true}',
  '{id, element: "checkbox", value: true}',
  '{id: sideEffect(), element: "checkbox", value: true}',
  '{__proto__: "global", element: "checkbox", value: true}'
];
for (const source of badMonitorObjects) {
  test(`reject monitor object before reporter: ${source}`, () => {
    let calls = 0;
    assert.throws(() => decode(`runtime.monitorBlocks.changeBlock(${source}, runtime)`, {reporter() { calls++; }}));
    assert.equal(calls, 0);
  });
}

test('monitor rejects unknown, foreign, kind-colliding, and scope-colliding IDs', () => {
  const projects = [
    [projectFixture(), 'missing'], [projectFixture(), 'other'], [projectFixture(), 'otherList'],
    [projectFixture(), 'toString']
  ];
  const localGlobalCollision = projectFixture();
  localGlobalCollision.targets[1].variables.global = ['different local', 0];
  projects.push([localGlobalCollision, 'global']);
  const kindCollision = projectFixture();
  kindCollision.targets[0].lists.global = ['same name', []];
  projects.push([kindCollision, 'global']);
  const foreignCollision = projectFixture();
  foreignCollision.targets[2].variables.local = ['same name', 0];
  projects.push([foreignCollision, 'local']);
  for (const [project, id] of projects) {
    assert.throws(() => decode(`runtime.monitorBlocks.changeBlock({id: ${JSON.stringify(id)}, element: "checkbox", value: true}, runtime)`, {project}));
  }
});

test('monitor validates existing runtime metadata against original ID, kind, name, and scope', () => {
  const source = 'runtime.monitorBlocks.changeBlock({id: "local", element: "checkbox", value: true}, runtime)';
  const original = {id: 'local', opcode: 'data_variable', params: {VARIABLE: 'same name'}, spriteName: 'Sprite1', visible: false};
  for (const changes of [{opcode: 'data_listcontents'}, {spriteName: 'Sprite2'}, {spriteName: null}, {params: {VARIABLE: 'renamed'}}, {params: {}}]) {
    const project = projectFixture();
    project.monitors = [{...original, ...changes}];
    assert.throws(() => decode(source, {project}));
  }
  const project = projectFixture();
  project.monitors = [original, {...original}];
  assert.throws(() => decode(source, {project}));
});

test('optional calls/access cannot impersonate unconditional helpers through permissive chain()', () => {
  const ordinary = expressionOf('runtime.ext_pen._penDown(target)');
  for (const node of [{...ordinary, optional: true},
    {...ordinary, callee: {...ordinary.callee, optional: true}},
    {...ordinary, callee: {...ordinary.callee, object: {...ordinary.callee.object, optional: true}}}]) {
    assert.throws(() => decodeNativeCommand(node, {project: projectFixture(), targetIndex: 1, reporter: decodeLiteral,
      chain, literal, identifier, member, numeric, fail}));
  }
  assert.deepEqual(decode('runtime["ext_pen"]["_penDown"](target)'), op('pen_penDown'));
});

test('unknown commands and multi-statement patterns return null without decoding any input', () => {
  for (const source of ['target.setXY(10, 20)', 'target.setSize(50)', 'target.setVisible(true)', 'target.clearEffects()',
    'runtime.disposeTarget(target)', 'runtime.stopAll()', 'retire()', 'runtime.ext_pen._getPenState(target)',
    'runtime.ext_pen.unknown(sideEffect())', 'target[sideEffect()](10)', 'runtime.ext_scratch3_control._counter',
    '(runtime.ext_scratch3_control._counter++, sideEffect())',
    '(() => { globalThis.__nativeCommandProbe = 1; })()']) {
    let calls = 0;
    assert.equal(decode(source, {reporter() { calls++; }}), null, source);
    assert.equal(calls, 0);
  }
  assert.equal(Object.hasOwn(globalThis, '__nativeCommandProbe'), false);
});

test('hostile reporter input remains AST and rejection propagates without executing source', () => {
  const source = 'runtime.ext_pen._setPenColorToColor((() => { globalThis.__nativeCommandProbe = 1; })(), target)';
  const ast = expressionOf(source);
  const error = new Error('unsupported reporter');
  assert.throws(() => decodeNativeCommand(ast, {project: projectFixture(), targetIndex: 1, reporter() { throw error; },
    chain, literal, identifier, member, numeric, fail}), actual => actual === error);
  let observed;
  const result = decode(source, {reporter(node) { observed = node; return {literal: '#ffffff'}; }});
  assert.equal(observed.type, 'CallExpression');
  assert.equal(result.opcode, 'pen_setPenColorToColor');
  assert.equal(Object.hasOwn(globalThis, '__nativeCommandProbe'), false);
});

test('validated helper structure precedes reporter callbacks', () => {
  for (const source of [
    'runtime.ext_pen._setPenColorToColor(sideEffect(), stage)',
    'runtime.ext_pen._setOrChangeColorParam("color", sideEffect(), state, true)',
    'runtime.ext_pen._setOrChangeColorParam("color", sideEffect(), runtime.ext_pen._getPenState(target), 1)',
    'target.setEffect("ghost", runtime.ext_scratch3_looks.clampEffect("brightness", sideEffect()))'
  ]) {
    let calls = 0;
    assert.throws(() => decode(source, {reporter() { calls++; }}));
    assert.equal(calls, 0);
  }
});

function block(opcode, parent, next, fields = {}, inputs = {}, topLevel = false) {
  return {opcode, parent, next, fields, inputs, shadow: false, topLevel, ...(topLevel ? {x: 20, y: 20} : {})};
}
function setStack(target, commands, hatId = 'native-hat', hatOpcode = 'event_whenflagclicked') {
  target.blocks = {[hatId]: block(hatOpcode, null, commands.length ? 'native-0' : null, {}, {}, true)};
  commands.forEach(([opcode, inputs = {}, fields = {}], index) => {
    const id = `native-${index}`;
    target.blocks[id] = block(opcode, index ? `native-${index - 1}` : hatId,
      index + 1 < commands.length ? `native-${index + 1}` : null, fields, inputs);
  });
}
const primitive = value => [1, [typeof value === 'number' ? 4 : 10, String(value)]];
const valueInput = (key, value) => ({[key]: primitive(value)});

// Use the real factory's reporter parser without changing or monkey-patching
// integration files. A tiny variable assignment exposes its reporter IR.
function factoryReporter(source, ast, project, targetIndex) {
  const prefix = source.slice(0, ast.body[0].expression.body.body.at(-1).start);
  return node => {
    const synthetic = `${prefix} const nativeSink = stage.variables["native-sink"]; return function () { nativeSink.value = ${source.slice(node.start, node.end)}; retire(); return; }; })`;
    return decodeCompiledFactory(synthetic, project, targetIndex).operations[0].inputs.VALUE;
  };
}
function recoverNativeFixture(bundle, project) {
  let count = 0;
  const sources = [];
  for (const [key, targetData] of Object.entries(bundle.compiledTargets)) {
    const targetIndex = targetData.targetIndex ?? Number(key);
    const target = project.targets[targetIndex];
    target.blocks = {};
    for (const [hatId, script] of Object.entries(targetData.scripts)) {
      const source = script.factorySource;
      sources.push(source);
      const ast = parse(source, {ecmaVersion: 'latest'});
      const body = ast.body[0].expression.body.body.at(-1).argument.body.body;
      assert.equal(chain(body.at(-2).expression.callee), 'retire');
      assert.equal(body.at(-1).type, 'ReturnStatement');
      const reporter = factoryReporter(source, ast, project, targetIndex);
      const operations = body.slice(0, -2).map(statement => {
        assert.equal(statement.type, 'ExpressionStatement');
        const result = decodeNativeCommand(statement.expression, {project, targetIndex, reporter,
          chain, literal, identifier, member, numeric, fail});
        assert.ok(result, `Native fixture has an unknown statement: ${source.slice(statement.start, statement.end)}`);
        result.span = [statement.start, statement.end];
        return result;
      });
      count += operations.length;
      const hat = targetData.hats.find(item => item.topBlockId === hatId);
      assert.ok(hat);
      target.blocks[hatId] = block(hat.opcode, null, null, {}, {}, true);
      buildRecoveredStack({target, parentId: hatId, operations, idFor: position => `${hatId}-${position}`, recordBlock() {}});
    }
  }
  return {count, sources};
}

async function runNativeState(fixture, bundle) {
  // Only trusted test-generated bundle sources are executed by the real VM.
  const VM = actualVMClass();
  const machine = new VM();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(fixture.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) archive.file(name, bytes);
  try {
    machine.setCompilerOptions({enabled: true, warpTimer: false});
    await machine.loadCompiledProject(structuredClone(bundle), archive);
    const runtime = machine.runtime;
    const calls = {stopOthers: 0};
    const realStop = runtime.stopForTarget.bind(runtime);
    runtime.stopForTarget = (target, thread) => {
      if (thread) calls.stopOthers++;
      return realStop(target, thread);
    };
    machine.greenFlag();
    for (let index = 0; index < 50 && runtime.threads.length; index++) runtime._step();
    const targets = runtime.targets.filter(target => target.isOriginal).map(target => ({
      name: target.getName(), effects: {...target.effects}, currentCostume: target.currentCostume,
      variables: Object.fromEntries(Object.entries(target.variables).map(([id, value]) => [id, structuredClone(value.value)])),
      penState: structuredClone(target.getCustomState('Scratch.pen') || null)
    }));
    const clones = runtime.targets.filter(target => !target.isOriginal).map(target => ({
      name: target.getName(), effects: {...target.effects}, currentCostume: target.currentCostume,
      penState: structuredClone(target.getCustomState('Scratch.pen') || null)
    }));
    const monitors = runtime.getMonitorState().valueSeq().toArray().map(value => value.toJS()).map(value => ({
      id: value.id, opcode: value.opcode, params: value.params, spriteName: value.spriteName, visible: value.visible
    })).sort((left, right) => left.id.localeCompare(right.id));
    return {targets, clones, monitors, counter: runtime.ext_scratch3_control._counter, calls,
      remainingThreads: runtime.threads.filter(thread => !thread.updateMonitor).length};
  } finally { machine.quit(); }
}

async function runAssetSelectionState(fixture, bundle = null) {
  const VM = actualVMClass();
  const machine = new VM();
  const archive = new JSZip();
  archive.file('project.json', JSON.stringify(fixture.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) archive.file(name, bytes);
  try {
    machine.setCompilerOptions({enabled: !!bundle, warpTimer: false});
    if (bundle) await machine.loadCompiledProject(structuredClone(bundle), archive);
    else await machine.loadProject(await archive.generateAsync({type: 'uint8array'}));
    const runtime = machine.runtime;
    const selections = [];
    // Observe the real selection helpers, not a replacement sound/menu model.
    for (const name of ['_setCostume', '_setBackdrop']) {
      const looks = runtime.ext_scratch3_looks;
      const original = looks[name].bind(looks);
      looks[name] = (target, value, ...args) => {
        const result = original(target, value, ...args);
        selections.push({helper: name, value, type: typeof value, index: target.currentCostume});
        return result;
      };
    }
    const sound = runtime.ext_scratch3_sound;
    const originalIndex = sound._getSoundIndex.bind(sound);
    sound._getSoundIndex = (value, util) => {
      const index = originalIndex(value, util);
      selections.push({helper: '_getSoundIndex', value, type: typeof value, index});
      return index;
    };
    machine.greenFlag();
    for (let i = 0; i < 100 && runtime.threads.length; i++) {
      runtime._step();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(runtime.threads.filter(thread => !thread.updateMonitor).length, 0);
    return selections;
  } finally { machine.quit(); }
}

for (const [opcode, input, helper] of [
  ['looks_switchcostumeto', 'COSTUME', '_setCostume'],
  ['looks_switchbackdropto', 'BACKDROP', '_setBackdrop'],
  ['looks_switchbackdroptoandwait', 'BACKDROP', '_setBackdrop'],
  ['sound_play', 'SOUND_MENU', '_getSoundIndex'],
  ['sound_playuntildone', 'SOUND_MENU', '_getSoundIndex']
]) {
  test(`actual compiler and interpreter preserve number vs numeric-name selection: ${opcode}`, async () => {
    const fixture = await makeMinimalSb3();
    for (const target of fixture.project.targets) {
      target.blocks = {};
      target.costumes = ['2', 'other'].map(name => ({...target.costumes[0], name}));
    }
    // A valid one-sample PCM WAV keeps this a real packaged asset. There is no
    // audio engine: assertions cover sound index resolution, not audible output.
    const wav = Buffer.alloc(46);
    wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(2, 40);
    const assetId = createHash('md5').update(wav).digest('hex');
    fixture.assets[`${assetId}.wav`] = wav;
    fixture.project.targets[1].sounds = ['2', 'other'].map(name => ({
      name, assetId, md5ext: `${assetId}.wav`, dataFormat: 'wav', rate: 8000, sampleCount: 1
    }));
    const values = [2, '2', -2, 2.5, '02'];
    setStack(fixture.project.targets[1], values.map(value => [opcode, {
      [input]: [1, [typeof value === 'number' ? 4 : 10, value]]
    }]));
    const sourceTarget = fixture.project.targets[1];
    values.forEach((value, index) => {
      if (typeof value !== 'number') return;
      const reporterId = `selector-number-${index}`;
      sourceTarget.blocks[`native-${index}`].inputs[input] = [2, reporterId];
      sourceTarget.blocks[reporterId] = block('operator_add', `native-${index}`, null, {}, {
        NUM1: [1, [4, value]], NUM2: [1, [4, 0]]
      });
    });
    const original = await compileReal02(fixture.project, fixture.assets);
    const recovered = structuredClone(fixture);
    recovered.project.targets = structuredClone(original.bundle.targets);
    for (const [key, data] of Object.entries(original.bundle.compiledTargets)) {
      const targetIndex = data.targetIndex ?? Number(key);
      const target = recovered.project.targets[targetIndex];
      target.blocks = {};
      for (const [hatId, script] of Object.entries(data.scripts)) {
        const decoded = decodeCompiledFactory(script.factorySource, recovered.project, targetIndex);
        const hat = data.hats.find(item => item.topBlockId === hatId);
        target.blocks[hatId] = block(hat.opcode, null, null, {}, {}, true);
        buildRecoveredStack({target, parentId: hatId, operations: decoded.operations,
          idFor: key => `${hatId}-${key}`, recordBlock() {}});
      }
    }
    const recoveredBlocks = recovered.project.targets[1].blocks;
    const actualInputs = Object.values(recoveredBlocks).filter(block => block.opcode === opcode).map(block => {
      const value = block.inputs[input][1];
      if (typeof value !== 'string') return value;
      assert.equal(recoveredBlocks[value].opcode, 'operator_add', 'only asset numeric literals acquire a numeric reporter');
      return recoveredBlocks[value].inputs.NUM1[1];
    });
    assert.deepEqual(actualInputs, values.map(value => [typeof value === 'number' ? 4 : 10, value]));
    const regenerated = await compileReal02(recovered.project, fixture.assets);
    const before = await runAssetSelectionState(fixture, original.bundle);
    assert.deepEqual(before.slice(0, 2), [
      {helper, value: 2, type: 'number', index: 1},
      {helper, value: '2', type: 'string', index: 0}
    ], 'numeric index 2 must not select the asset named "2"');
    assert.equal(before.length, values.length);
    assert.deepEqual(await runAssetSelectionState(fixture), before, 'original interpreter agrees');
    assert.deepEqual(await runAssetSelectionState(recovered, regenerated.bundle), before, 'recompiled recovery agrees');
    assert.deepEqual(await runAssetSelectionState(recovered), before, 'recovered interpreter agrees');
  });
}

async function nativeRealFixture() {
  const fixture = await makeMinimalSb3();
  const {project} = fixture;
  project.targets[0].variables = {'native-sink': ['native sink', 0], global: ['same name', 3]};
  project.targets[0].lists = {globalList: ['same list', [1, 'a']]};
  project.targets[1].variables = {local: ['same name', 7]};
  project.targets[1].lists = {localList: ['same list', [2, 'b']]};
  project.extensions = ['pen'];
  project.monitors = [
    {id: 'global', opcode: 'data_variable', params: {VARIABLE: 'same name'}, spriteName: null, visible: false, value: 3, mode: 'default'},
    {id: 'local', opcode: 'data_variable', params: {VARIABLE: 'same name'}, spriteName: 'Sprite1', visible: true, value: 7, mode: 'default'},
    {id: 'globalList', opcode: 'data_listcontents', params: {LIST: 'same list'}, spriteName: null, visible: false, value: [1, 'a'], mode: 'list'},
    {id: 'localList', opcode: 'data_listcontents', params: {LIST: 'same list'}, spriteName: 'Sprite1', visible: true, value: [2, 'b'], mode: 'list'}
  ];
  for (const target of project.targets) {
    target.costumes.push({...target.costumes[0], name: target.isStage ? 'backdrop2' : 'costume2'});
  }
  setStack(project.targets[0], [
    ['data_showvariable', {}, {VARIABLE: ['same name', 'global']}],
    ['data_showlist', {}, {LIST: ['same list', 'globalList']}]
  ], 'stage-hat');
  setStack(project.targets[1], [
    ['control_clear_counter'], ['control_incr_counter'], ['control_incr_counter'],
    ['looks_seteffectto', valueInput('VALUE', 150), {EFFECT: ['GHOST', null]}],
    ['looks_changeeffectby', valueInput('CHANGE', -20), {EFFECT: ['GHOST', null]}],
    ['looks_seteffectto', valueInput('VALUE', -150), {EFFECT: ['BRIGHTNESS', null]}],
    ['looks_changeeffectby', valueInput('CHANGE', 35), {EFFECT: ['BRIGHTNESS', null]}],
    ['pen_setPenColorToColor', {COLOR: [1, [9, '#ff0088']]}],
    ['pen_setPenColorParamTo', {COLOR_PARAM: primitive('saturation'), VALUE: primitive(75)}],
    ['pen_changePenColorParamBy', {COLOR_PARAM: primitive('brightness'), VALUE: primitive(-20)}],
    ['pen_setPenSizeTo', valueInput('SIZE', 4)],
    ['pen_changePenSizeBy', valueInput('SIZE', 2)],
    ['pen_setPenHueToNumber', valueInput('HUE', 60)],
    ['pen_changePenHueBy', valueInput('HUE', 10)],
    ['pen_setPenShadeToNumber', valueInput('SHADE', 30)],
    ['pen_changePenShadeBy', valueInput('SHADE', -20)],
    ['pen_penDown'], ['pen_penUp'],
    ['looks_switchcostumeto', valueInput('COSTUME', 'costume2')], ['looks_nextcostume'],
    ['looks_switchbackdropto', valueInput('BACKDROP', 'backdrop2')], ['looks_nextbackdrop'],
    ['data_hidevariable', {}, {VARIABLE: ['same name', 'local']}],
    ['data_hidelist', {}, {LIST: ['same list', 'localList']}],
    ['control_create_clone_of', valueInput('CLONE_OPTION', '_myself_')],
    ['control_stop', {}, {STOP_OPTION: ['other scripts in sprite', null]}],
    ['pen_setPenSizeTo', valueInput('SIZE', 9)],
    ['control_incr_counter']
  ], 'sprite-hat');
  return fixture;
}

test('actual 02 compile -> native decode -> SB3 -> recompile: state semantics without renderer', async () => {
  const fixture = await nativeRealFixture();
  const original = await compileReal02(fixture.project, fixture.assets);
  assert.equal(original.provenance.kind, 'actual-02engine-vm-compiler');
  assert.equal(original.provenance.adapters.renderer, false);
  const recovered = structuredClone(fixture);
  recovered.project.targets = structuredClone(original.bundle.targets);
  const decoded = recoverNativeFixture(original.bundle, recovered.project);
  assert.equal(decoded.count, 30);
  const opcodes = recovered.project.targets.flatMap(target => Object.values(target.blocks).map(value => value.opcode));
  for (const opcode of ['looks_seteffectto', 'looks_changeeffectby', 'pen_setPenColorParamTo', 'pen_changePenColorParamBy',
    'data_showvariable', 'data_hidevariable', 'data_showlist', 'data_hidelist', 'control_create_clone_of', 'control_stop']) assert.ok(opcodes.includes(opcode), opcode);
  assert.ok(opcodes.includes('looks_costume'));
  assert.ok(opcodes.includes('looks_backdrops'));
  assert.ok(opcodes.includes('pen_menu_colorParam'));
  assert.ok(opcodes.includes('control_create_clone_of_menu'));
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(recovered.project));
  for (const [name, bytes] of Object.entries(fixture.assets)) zip.file(name, bytes);
  const validation = await validateSb3(await zip.generateAsync({type: 'uint8array'}));
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const regenerated = await compileReal02(recovered.project, fixture.assets);
  const before = await runNativeState(fixture, original.bundle);
  const after = await runNativeState(recovered, regenerated.bundle);
  assert.deepEqual(after, before);
  assert.equal(before.targets[1].effects.ghost, 80, 'clamping is preserved before applying change');
  assert.equal(before.targets[1].effects.brightness, -65);
  assert.equal(before.targets[1].penState.penAttributes.diameter, 9, 'current script continues past stop others');
  assert.equal(before.clones[0].penState.penAttributes.diameter, 6, 'clone receives the state before the continuing command');
  assert.equal(before.targets[1].penState.penDown, false);
  assert.equal(before.targets[1].penState._shade, 10);
  assert.equal(before.targets[0].currentCostume, 0);
  assert.equal(before.targets[1].currentCostume, 0);
  assert.equal(before.counter, 3);
  assert.equal(before.clones.length, 1);
  assert.equal(before.calls.stopOthers, 1);
  assert.equal(before.remainingThreads, 0);
  assert.deepEqual(before.monitors.map(value => [value.id, value.visible]), [
    ['global', true], ['globalList', true], ['local', false], ['localList', false]
  ]);
  // Effects, pen attributes, costume indices, monitor flags, clone count, counter,
  // and stop calls are VM state observations. No pixels or renderer are tested.
});

test('actual compiler pen clear/stamp recovery: shape only, no renderer behavioral proof', async () => {
  const fixture = await makeMinimalSb3();
  fixture.project.extensions = ['pen'];
  fixture.project.targets[0].variables['native-sink'] = ['native sink', 0];
  fixture.project.targets[0].blocks = {};
  setStack(fixture.project.targets[1], [['pen_clear'], ['pen_stamp']]);
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const project = {...fixture.project, targets: structuredClone(compiled.bundle.targets)};
  const decoded = recoverNativeFixture(compiled.bundle, project);
  assert.equal(decoded.count, 2);
  assert.match(decoded.sources.join('\n'), /runtime\.ext_pen\.clear\(\)/);
  assert.match(decoded.sources.join('\n'), /runtime\.ext_pen\._stamp\(target\)/);
  assert.deepEqual(Object.values(project.targets[1].blocks).map(value => value.opcode), ['event_whenflagclicked', 'pen_clear', 'pen_stamp']);
});

test('actual compiler numeric casts in effect and pen inputs use the production reporter parser', async () => {
  const fixture = await makeMinimalSb3();
  fixture.project.extensions = ['pen'];
  fixture.project.targets[0].variables = {'native-sink': ['native sink', 0]};
  fixture.project.targets[0].blocks = {};
  fixture.project.targets[1].variables = {amount: ['amount', 'not numeric']};
  const input = [3, [12, 'amount', 'amount'], [4, '0']];
  setStack(fixture.project.targets[1], [
    ['looks_seteffectto', {VALUE: input}, {EFFECT: ['GHOST', null]}],
    ['pen_changePenSizeBy', {SIZE: input}]
  ]);
  const compiled = await compileReal02(fixture.project, fixture.assets);
  const recovered = structuredClone(fixture);
  recovered.project.targets = structuredClone(compiled.bundle.targets);
  const decoded = recoverNativeFixture(compiled.bundle, recovered.project);
  assert.equal(decoded.count, 2);
  assert.match(decoded.sources.join('\n'), /\|\| 0/);
  const regenerated = await compileReal02(recovered.project, fixture.assets);
  const before = await runNativeState(fixture, compiled.bundle);
  assert.deepEqual(await runNativeState(recovered, regenerated.bundle), before);
  assert.equal(before.targets[1].effects.ghost, 0);
  assert.equal(before.targets[1].penState.penAttributes.diameter, 1);
});
