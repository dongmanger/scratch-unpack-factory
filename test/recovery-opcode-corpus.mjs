import {recursiveRealFixture} from './real-02-recursive.mjs';
import {makeMinimalSb3} from './helpers.mjs';

// Trusted SB3 templates only. These descriptors build Scratch block graphs;
// they are never passed to a reporter/IR decoder or evaluated as JavaScript.
const reporter = (opcode, inputs = {}, fields = {}) => ({opcode, inputs, fields});
const command = (opcode, inputs = {}, fields = {}, substacks = {}) => ({opcode, inputs, fields, substacks});
const variable = id => ({variableId: id});
const menu = (opcode, field, value) => ({opcode, inputs: {}, fields: {[field]: [value, null]}, shadow: true});
const set = (id, value) => command('data_setvariableto', {VALUE: value}, {VARIABLE: id});
const change = (id, value) => command('data_changevariableby', {VALUE: value}, {VARIABLE: id});
const binary = (opcode, a, b, names = ['NUM1', 'NUM2']) => reporter(opcode, {[names[0]]: a, [names[1]]: b});
const compare = (opcode, a, b) => binary(opcode, a, b, ['OPERAND1', 'OPERAND2']);
const math = (operator, id) => reporter('operator_mathop', {NUM: variable(id)}, {OPERATOR: [operator, null]});
const list = (opcode, id, inputs = {}) => command(opcode, inputs, {LIST: id});
const listReporter = (opcode, id, inputs = {}) => reporter(opcode, inputs, {LIST: id});

class ScratchGraph {
  constructor(project, targetIndex) {
    this.project = project;
    this.target = project.targets[targetIndex];
    this.prefix = `corpus-${targetIndex}`;
    this.serial = Object.keys(this.target.blocks).length;
  }
  definition(id, kind) {
    const entry = this.target[kind][id] || this.project.targets[0][kind][id];
    if (!entry) throw new Error(`Missing trusted ${kind} ID ${id}`);
    return [entry[0], id];
  }
  input(value, parent) {
    if (value && Object.hasOwn(value, 'variableId')) {
      const [name, id] = this.definition(value.variableId, 'variables');
      return [3, [12, name, id], [10, '']];
    }
    if (value && typeof value === 'object') {
      const id = this.emit(value, parent);
      return [value.shadow ? 1 : 2, id];
    }
    return [1, [typeof value === 'number' ? 4 : 10, String(value)]];
  }
  emit(spec, parent, id = `${this.prefix}-${this.serial++}`) {
    if (Object.hasOwn(this.target.blocks, id)) throw new Error(`Duplicate trusted block ID ${id}`);
    const block = {opcode: spec.opcode, next: null, parent, inputs: {}, fields: {},
      shadow: !!spec.shadow, topLevel: false};
    this.target.blocks[id] = block;
    for (const [name, value] of Object.entries(spec.fields || {})) {
      block.fields[name] = ['VARIABLE', 'LIST'].includes(name) && typeof value === 'string' ?
        this.definition(value, name === 'LIST' ? 'lists' : 'variables') : value;
    }
    for (const [name, value] of Object.entries(spec.inputs || {})) block.inputs[name] = this.input(value, id);
    for (const [name, commands] of Object.entries(spec.substacks || {})) block.inputs[name] = [2, this.stack(commands, id)];
    return id;
  }
  stack(commands, parent) {
    let first = null;
    let previous = parent;
    for (const spec of commands) {
      const id = this.emit(spec, previous);
      if (first === null) first = id;
      else this.target.blocks[previous].next = id;
      previous = id;
    }
    return first;
  }
  hat(commands, {id = `${this.prefix}-flag`, opcode = 'event_whenflagclicked', fields = {}} = {}) {
    if (Object.hasOwn(this.target.blocks, id)) throw new Error(`Duplicate trusted hat ID ${id}`);
    this.target.blocks[id] = {opcode, parent: null, next: null, inputs: {}, fields,
      shadow: false, topLevel: true, x: 20, y: 20};
    this.target.blocks[id].next = this.stack(commands, id);
    return id;
  }
}

async function base() {
  const fixture = await makeMinimalSb3();
  for (const target of fixture.project.targets) {
    target.blocks = {};
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
  }
  fixture.project.meta.agent = 'trusted-recovery-opcode-corpus';
  return fixture;
}
const declarations = (target, entries) => {
  for (const [id, value] of Object.entries(entries)) target.variables[id] = [id, value];
};
const outputs = (target, entries) => declarations(target, Object.fromEntries(entries.map(id => [id, 'not-run'])));
const expected = (targetIndex, variables, state = {}) => ({targetIndex, variables, state});
const scalarOps = ['event_whenflagclicked', 'data_setvariableto'];
const withExpected = (fixture, metadata) => ({...fixture, ...metadata});

async function recursive() {
  return withExpected(await recursiveRealFixture(), {
    expected: [expected(0, {varId1: '成功', limit: 3, items: [3, 5, 7]}),
      expected(1, {localScore: '成功'}, {x: 10, y: 0, direction: 105, size: 105})],
    requiredOpcodes: ['control_repeat', 'control_if_else', 'operator_gt', 'operator_add', 'data_addtolist',
      'event_broadcast', 'event_whenbroadcastreceived', 'motion_movesteps', 'motion_turnright', 'looks_changesizeby'],
    sourcePatterns: [/for\s*\(/, /startHats\(/, /\.value\.push\(/]
  });
}

async function controls() {
  const f = await base();
  const stage = f.project.targets[0];
  declarations(stage, {n: 0, sum: 0, cursor: 0, limit: 3, bound: 6, one: 1, flag: 'not-run', counter: -1});
  const v = variable;
  new ScratchGraph(f.project, 0).hat([
    command('control_clear_counter'),
    command('control_repeat_until', {CONDITION: compare('operator_equals', v('n'), v('limit'))}, {}, {
      SUBSTACK: [change('n', v('one')), command('control_incr_counter')]
    }),
    command('control_while', {CONDITION: compare('operator_lt', v('n'), v('bound'))}, {}, {SUBSTACK: [change('n', v('one'))]}),
    command('control_for_each', {VALUE: v('limit')}, {VARIABLE: 'cursor'}, {SUBSTACK: [change('sum', v('cursor'))]}),
    command('control_wait', {DURATION: 0}),
    command('control_wait_until', {CONDITION: compare('operator_equals', v('n'), v('bound'))}),
    command('control_if', {CONDITION: compare('operator_equals', v('sum'), v('bound'))}, {}, {SUBSTACK: [set('flag', 'bounded-ok')]}),
    set('counter', reporter('control_get_counter')),
    command('control_stop', {}, {STOP_OPTION: ['other scripts in stage', null]}),
    change('sum', v('one')),
    command('control_stop', {}, {STOP_OPTION: ['this script', null]})
  ]);
  return withExpected(f, {
    expected: [expected(0, {n: 6, sum: 7, cursor: 3, flag: 'bounded-ok', counter: 3})],
    requiredOpcodes: ['control_repeat_until', 'control_while', 'control_for_each', 'control_wait', 'control_wait_until',
      'control_if', 'control_clear_counter', 'control_incr_counter', 'control_get_counter', 'control_stop'],
    sourcePatterns: [/while\s*\(/, /runtime\.stopForTarget\(target,\s*thread\)/, /thread\.timer/]
  });
}

async function arithmetic() {
  const f = await base();
  const stage = f.project.targets[0];
  declarations(stage, {left: '7.5', right: 2, negative: -7, randomBound: 4});
  const specs = {
    add: binary('operator_add', variable('left'), variable('right')),
    subtract: binary('operator_subtract', variable('left'), variable('right')),
    multiply: binary('operator_multiply', variable('left'), variable('right')),
    divide: binary('operator_divide', variable('left'), variable('right')),
    modulo: binary('operator_mod', variable('negative'), variable('right')),
    rounded: reporter('operator_round', {NUM: variable('left')}),
    deterministicRandom: reporter('operator_random', {FROM: variable('randomBound'), TO: variable('randomBound')})
  };
  outputs(stage, Object.keys(specs));
  new ScratchGraph(f.project, 0).hat(Object.entries(specs).map(([id, input]) => set(id, input)));
  return withExpected(f, {
    expected: [expected(0, {add: 9.5, subtract: 5.5, multiply: 15, divide: 3.75, modulo: 1, rounded: 8, deterministicRandom: 4})],
    requiredOpcodes: [...scalarOps, 'operator_add', 'operator_subtract', 'operator_multiply', 'operator_divide', 'operator_mod', 'operator_round', 'operator_random'],
    sourcePatterns: [/mod\(/, /Math\.round\(/, /runtime\.ext_scratch3_operators\._random\(/, /\|\|\s*0/]
  });
}

async function mathematics() {
  const f = await base();
  const stage = f.project.targets[0];
  const cases = [
    ['abs', -3.25, 3.25], ['floor', 3.75, 3], ['ceiling', -3.75, -3], ['sqrt', 81, 9],
    ['sin', 30, 0.5], ['cos', 60, 0.5], ['tan', 45, 1], ['asin', 0.5, Math.asin(0.5) * 180 / Math.PI],
    ['acos', 0.5, Math.acos(0.5) * 180 / Math.PI], ['atan', 1, 45], ['ln', 10, Math.log(10)],
    ['log', 100, Math.log(100) / Math.LN10], ['e ^', 2, Math.exp(2)], ['10 ^', 2, 100]
  ];
  cases.forEach(([, value], i) => declarations(stage, {[`math-input-${i}`]: value}));
  outputs(stage, cases.map((_, i) => `math-output-${i}`));
  new ScratchGraph(f.project, 0).hat(cases.map(([op], i) => set(`math-output-${i}`, math(op, `math-input-${i}`))));
  return withExpected(f, {
    expected: [expected(0, Object.fromEntries(cases.map(([, , result], i) => [`math-output-${i}`, result])))],
    requiredOpcodes: [...scalarOps, 'operator_mathop'], requiredMathOperators: cases.map(([op]) => op),
    sourcePatterns: [/Math\.abs\(/, /Math\.floor\(/, /Math\.ceil\(/, /Math\.sqrt\(/, /Math\.sin\(/,
      /Math\.cos\(/, /tan\(/, /Math\.asin\(/, /Math\.acos\(/, /Math\.atan\(/, /Math\.LN10/, /Math\.exp\(/, /10\s*\*\*/]
  });
}

async function stringsAndLogic({includeLiteralIndex = true} = {}) {
  const f = await base();
  const stage = f.project.targets[0];
  declarations(stage, {text: 'HeLLo WORLD', suffix: '!', needle: 'world', a: '01', b: '1', c: 3, d: 2});
  const eq = () => compare('operator_equals', variable('a'), variable('b'));
  const lt = () => compare('operator_lt', variable('d'), variable('c'));
  const gt = () => compare('operator_gt', variable('c'), variable('d'));
  const specs = {
    joined: binary('operator_join', variable('text'), variable('suffix'), ['STRING1', 'STRING2']),
    length: reporter('operator_length', {STRING: variable('text')}),
    ...(includeLiteralIndex ? {letter: reporter('operator_letter_of', {LETTER: 2, STRING: variable('text')})} : {}),
    contains: binary('operator_contains', variable('text'), variable('needle'), ['STRING1', 'STRING2']),
    equal: eq(), less: lt(), greater: gt(),
    and: binary('operator_and', eq(), lt(), ['OPERAND1', 'OPERAND2']),
    or: binary('operator_or', reporter('operator_not', {OPERAND: eq()}), gt(), ['OPERAND1', 'OPERAND2']),
    not: reporter('operator_not', {OPERAND: eq()})
  };
  outputs(stage, Object.keys(specs));
  new ScratchGraph(f.project, 0).hat(Object.entries(specs).map(([id, input]) => set(id, input)));
  return withExpected(f, {
    expected: [expected(0, {joined: 'HeLLo WORLD!', length: 11, ...(includeLiteralIndex ? {letter: 'e'} : {}), contains: true,
      equal: true, less: true, greater: true, and: true, or: true, not: false})],
    requiredOpcodes: [...scalarOps, 'operator_join', 'operator_length', ...(includeLiteralIndex ? ['operator_letter_of'] : []), 'operator_contains',
      'operator_equals', 'operator_lt', 'operator_gt', 'operator_and', 'operator_or', 'operator_not'],
    sourcePatterns: [/compareEqual\(/, /compareLessThan\(/, /compareGreaterThan\(/, /\.toLowerCase\(\)\.indexOf\(/, /\.length/,
      ...(includeLiteralIndex ? [/\[2\s*-\s*1\]/] : [])]
  });
}

async function lists({includeLiteralIndex = true} = {}) {
  const f = await base();
  const [stage, sprite] = f.project.targets;
  stage.lists.globalItems = ['same list 项目', ['old']];
  sprite.lists.localItems = ['same list 项目', ['local-old']];
  stage.variables.globalScalar = ['same scalar 分数', 11];
  sprite.variables.localScalar = ['same scalar 分数', 7];
  declarations(sprite, {payload: 'B', replacement: 'C', needle: 'C'});
  outputs(sprite, [...(includeLiteralIndex ? ['first'] : []), 'last', 'count', 'has', 'globalRead']);
  new ScratchGraph(f.project, 1).hat([
    list('data_deletealloflist', 'globalItems'), list('data_deletealloflist', 'localItems'),
    list('data_addtolist', 'localItems', {ITEM: 'A'}), list('data_addtolist', 'localItems', {ITEM: variable('payload')}),
    list('data_insertatlist', 'localItems', {INDEX: 1, ITEM: 'head'}),
    list('data_insertatlist', 'localItems', {INDEX: 2, ITEM: 'middle'}),
    list('data_replaceitemoflist', 'localItems', {INDEX: 3, ITEM: variable('replacement')}),
    list('data_deleteoflist', 'localItems', {INDEX: 2}), list('data_deleteoflist', 'localItems', {INDEX: 'last'}),
    list('data_addtolist', 'globalItems', {ITEM: variable('globalScalar')}),
    list('data_addtolist', 'globalItems', {ITEM: variable('localScalar')}),
    change('globalScalar', 2), change('localScalar', 3), set('globalRead', variable('globalScalar')),
    ...(includeLiteralIndex ? [set('first', listReporter('data_itemoflist', 'localItems', {INDEX: 1}))] : []),
    set('last', listReporter('data_itemoflist', 'localItems', {INDEX: 'last'})),
    set('count', listReporter('data_lengthoflist', 'localItems')),
    set('has', listReporter('data_listcontainsitem', 'localItems', {ITEM: variable('needle')}))
  ]);
  return withExpected(f, {
    expected: [expected(0, {globalItems: [11, 7], globalScalar: 13}),
      expected(1, {localItems: ['head', 'C'], localScalar: 10, globalRead: 13,
        ...(includeLiteralIndex ? {first: 'head'} : {}), last: 'C', count: 2, has: true})],
    requiredOpcodes: ['data_deletealloflist', 'data_addtolist', 'data_insertatlist', 'data_replaceitemoflist',
      'data_deleteoflist', 'data_itemoflist', 'data_lengthoflist', 'data_listcontainsitem', 'operator_add'],
    sourcePatterns: [/listInsert\(/, /listReplace\(/, /\.value\.unshift\(/, /\.value\.pop\(/, /listContains\(/]
  });
}

async function motionAndVisibility() {
  const f = await base();
  const sprite = f.project.targets[1];
  declarations(sprite, {startX: -12, startY: 8, dx: 5, dy: -3, steps: 10, turn: 45, heading: 90, newSize: 70, grow: 8});
  outputs(sprite, ['readX', 'readY', 'readDirection', 'readSize', 'done']);
  new ScratchGraph(f.project, 1).hat([
    command('motion_gotoxy', {X: variable('startX'), Y: variable('startY')}),
    command('motion_changexby', {DX: variable('dx')}), command('motion_changeyby', {DY: variable('dy')}),
    command('motion_setx', {X: variable('startX')}), command('motion_sety', {Y: variable('startY')}),
    command('motion_pointindirection', {DIRECTION: variable('heading')}),
    command('motion_movesteps', {STEPS: variable('steps')}),
    command('motion_turnright', {DEGREES: variable('turn')}), command('motion_turnleft', {DEGREES: 15}),
    command('motion_setrotationstyle', {}, {STYLE: ['left-right', null]}),
    command('looks_setsizeto', {SIZE: variable('newSize')}), command('looks_changesizeby', {CHANGE: variable('grow')}),
    command('looks_hide'), command('looks_show'), command('looks_hide'),
    set('readX', reporter('motion_xposition')), set('readY', reporter('motion_yposition')),
    set('readDirection', reporter('motion_direction')), set('readSize', reporter('looks_size')), set('done', 'motion-ok')
  ]);
  return withExpected(f, {
    expected: [expected(1, {readX: -2, readY: 8, readDirection: 120, readSize: 78, done: 'motion-ok'},
      {x: -2, y: 8, direction: 120, size: 78, visible: false})],
    requiredOpcodes: ['motion_gotoxy', 'motion_changexby', 'motion_changeyby', 'motion_setx', 'motion_sety',
      'motion_pointindirection', 'motion_movesteps', 'motion_turnright', 'motion_turnleft', 'motion_setrotationstyle',
      'motion_xposition', 'motion_yposition', 'motion_direction', 'looks_setsizeto', 'looks_changesizeby', 'looks_size', 'looks_hide', 'looks_show'],
    sourcePatterns: [/limitPrecision\(target\.x\)/, /Math\.round\(target\.size\)/, /target\.setVisible\(false\)/],
    extendedState: true, expectedExtended: {Sprite1: {rotationStyle: 'left-right'}}
  });
}

async function appearance() {
  const f = await base();
  const [stage, sprite] = f.project.targets;
  for (const target of [stage, sprite]) target.costumes.push({...target.costumes[0], name: target.isStage ? 'backdrop2' : 'costume2'});
  declarations(sprite, {effect: 150, delta: -20});
  outputs(sprite, ['costumeNumber', 'costumeName', 'backdropNumber', 'backdropName', 'done']);
  new ScratchGraph(f.project, 1).hat([
    command('looks_switchcostumeto', {COSTUME: menu('looks_costume', 'COSTUME', 'costume2')}), command('looks_nextcostume'),
    command('looks_switchcostumeto', {COSTUME: menu('looks_costume', 'COSTUME', 'costume2')}),
    command('looks_switchbackdropto', {BACKDROP: menu('looks_backdrops', 'BACKDROP', 'backdrop2')}), command('looks_nextbackdrop'),
    command('looks_switchbackdropto', {BACKDROP: menu('looks_backdrops', 'BACKDROP', 'backdrop2')}),
    command('looks_seteffectto', {VALUE: 25}, {EFFECT: ['COLOR', null]}), command('looks_cleargraphiceffects'),
    command('looks_seteffectto', {VALUE: variable('effect')}, {EFFECT: ['GHOST', null]}),
    command('looks_changeeffectby', {CHANGE: variable('delta')}, {EFFECT: ['GHOST', null]}),
    command('looks_seteffectto', {VALUE: -150}, {EFFECT: ['BRIGHTNESS', null]}),
    command('looks_changeeffectby', {CHANGE: 35}, {EFFECT: ['BRIGHTNESS', null]}),
    set('costumeNumber', reporter('looks_costumenumbername', {}, {NUMBER_NAME: ['number', null]})),
    set('costumeName', reporter('looks_costumenumbername', {}, {NUMBER_NAME: ['name', null]})),
    set('backdropNumber', reporter('looks_backdropnumbername', {}, {NUMBER_NAME: ['number', null]})),
    set('backdropName', reporter('looks_backdropnumbername', {}, {NUMBER_NAME: ['name', null]})), set('done', 'appearance-ok')
  ]);
  // Renderer calls are recovered/recompiled under an inactive trusted key hat.
  // No layer order, pixels, collisions, or edge bounce behavior is claimed.
  new ScratchGraph(f.project, 1).hat([
    command('looks_gotofrontback', {}, {FRONT_BACK: ['front', null]}),
    command('looks_gotofrontback', {}, {FRONT_BACK: ['back', null]}),
    command('looks_goforwardbackwardlayers', {NUM: variable('delta')}, {FORWARD_BACKWARD: ['forward', null]}),
    command('looks_goforwardbackwardlayers', {NUM: 2}, {FORWARD_BACKWARD: ['backward', null]}),
    command('motion_ifonedgebounce'),
    set('done', reporter('sensing_touchingobject', {TOUCHINGOBJECTMENU: menu('sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', '_edge_')})),
    set('done', reporter('sensing_touchingcolor', {COLOR: '#ff0022'})),
    set('done', reporter('sensing_coloristouchingcolor', {COLOR: '#aabbcc', COLOR2: '#010203'}))
  ], {id: 'corpus-renderer-shapes', opcode: 'event_whenkeypressed', fields: {KEY_OPTION: ['space', null]}});
  return withExpected(f, {
    expected: [expected(1, {costumeNumber: 2, costumeName: 'costume2', backdropNumber: 2, backdropName: 'backdrop2', done: 'appearance-ok'})],
    requiredOpcodes: ['looks_switchcostumeto', 'looks_nextcostume', 'looks_switchbackdropto', 'looks_nextbackdrop',
      'looks_seteffectto', 'looks_changeeffectby', 'looks_cleargraphiceffects', 'looks_costumenumbername', 'looks_backdropnumbername',
      'looks_costume', 'looks_backdrops', 'looks_gotofrontback', 'looks_goforwardbackwardlayers', 'motion_ifonedgebounce',
      'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor'],
    sourcePatterns: [/clampEffect\(/, /target\.getCostumes\(\)/, /target\.goForwardLayers\(/, /target\.colorIsTouchingColor\(/],
    structuralOnly: ['looks_gotofrontback', 'looks_goforwardbackwardlayers', 'motion_ifonedgebounce',
      'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor'],
    extendedState: true, expectedExtended: {Stage: {currentCostume: 1}, Sprite1: {currentCostume: 1, effects: {
      color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: -65, ghost: 80
    }}}
  });
}

async function sensing() {
  const f = await base();
  const [stage, sprite] = f.project.targets;
  declarations(stage, {shared: 19});
  declarations(sprite, {key: 'space', objectName: 'Sprite1', sensedLocal: 19});
  sprite.x = 3; sprite.y = 4; sprite.direction = 120; sprite.size = 85;
  const of = (property, object = menu('sensing_of_object_menu', 'OBJECT', 'Sprite1')) => reporter('sensing_of', {OBJECT: object}, {PROPERTY: [property, null]});
  const specs = {
    keyDown: reporter('sensing_keypressed', {KEY_OPTION: variable('key')}),
    mouseX: reporter('sensing_mousex'), mouseY: reporter('sensing_mousey'), mouseDown: reporter('sensing_mousedown'),
    answer: reporter('sensing_answer'), username: reporter('sensing_username'),
    distance: reporter('sensing_distanceto', {DISTANCETOMENU: menu('sensing_distancetomenu', 'DISTANCETOMENU', '_mouse_')}),
    otherX: of('x position'), otherY: of('y position'), otherDirection: of('direction'), otherSize: of('size'),
    otherCostume: of('costume name'), otherVariable: of('sensedLocal'),
    stageVariable: of('shared', menu('sensing_of_object_menu', 'OBJECT', '_stage_')),
    dynamicSize: of('size', variable('objectName'))
  };
  const calendar = {year: 2026, month: 10, date: 11, dayofweek: 1, hour: 12, minute: 34, second: 56};
  for (const selector of Object.keys(calendar)) specs[selector] = reporter('sensing_current', {}, {CURRENTMENU: [selector, null]});
  outputs(sprite, Object.keys(specs));
  new ScratchGraph(f.project, 1).hat(Object.entries(specs).map(([id, value]) => set(id, value)));
  return withExpected(f, {
    expected: [expected(1, {keyDown: false, mouseX: 0, mouseY: 0, mouseDown: false, answer: '', username: '',
      distance: 5, otherX: 3, otherY: 4, otherDirection: 120, otherSize: 85, otherCostume: 'costume1', otherVariable: 19, stageVariable: 19, dynamicSize: 85, ...calendar})],
    requiredOpcodes: ['sensing_keypressed', 'sensing_mousex', 'sensing_mousey', 'sensing_mousedown', 'sensing_answer',
      'sensing_username', 'sensing_distanceto', 'sensing_of', 'sensing_of_object_menu', 'sensing_current'],
    sourcePatterns: [/keyboard\.getKeyIsDown\(/, /userData\.getUsername\(/, /distance\(/,
      /lookupVariableByNameAndType\(/, /ext_scratch3_sensing\.getAttributeOf\(/, /new Date\(\)/],
    calendarSelectors: Object.keys(calendar), frozenCalendar: true
  });
}

async function sound() {
  const f = await base();
  const stage = f.project.targets[0];
  declarations(stage, {volumeInput: 150, volumeDelta: -58, effectInput: 400, effectDelta: -40});
  outputs(stage, ['volumeRead', 'done']);
  new ScratchGraph(f.project, 0).hat([
    command('sound_setvolumeto', {VOLUME: variable('volumeInput')}),
    command('sound_changevolumeby', {VOLUME: variable('volumeDelta')}),
    command('sound_seteffectto', {VALUE: 15}, {EFFECT: ['PAN', null]}), command('sound_cleareffects'),
    command('sound_seteffectto', {VALUE: variable('effectInput')}, {EFFECT: ['PITCH', null]}),
    command('sound_changeeffectby', {VALUE: variable('effectDelta')}, {EFFECT: ['PITCH', null]}),
    command('sound_play', {SOUND_MENU: menu('sound_sounds_menu', 'SOUND_MENU', 'absent-trusted-sound')}),
    command('sound_playuntildone', {SOUND_MENU: menu('sound_sounds_menu', 'SOUND_MENU', 'absent-trusted-sound')}),
    command('sound_stopallsounds'), set('volumeRead', reporter('sound_volume')), set('done', 'promise-resumed')
  ]);
  return withExpected(f, {
    expected: [expected(0, {volumeRead: 42, done: 'promise-resumed'})],
    requiredOpcodes: ['sound_setvolumeto', 'sound_changevolumeby', 'sound_seteffectto', 'sound_changeeffectby',
      'sound_cleareffects', 'sound_play', 'sound_playuntildone', 'sound_stopallsounds', 'sound_volume', 'sound_sounds_menu'],
    sourcePatterns: [/executeInCompatibilityLayer\(/, /getOpcodeFunction\("sound_volume"\)/],
    extendedState: true, expectedExtended: {Stage: {volume: 42, soundEffects: {pitch: 320, pan: 0}}},
    limitations: ['Sound volume/effect promises and absent-sound completion only; no audio playback proof.']
  });
}

async function partialLists() {
  const f = await base();
  const stage = f.project.targets[0];
  stage.lists.items = ['items', [1, '1', 2]];
  declarations(stage, {needle: '1', contents: 'not-run', index: 'not-run'});
  const g = new ScratchGraph(f.project, 0);
  g.hat([set('contents', listReporter('data_listcontents', 'items'))], {id: 'partial-contents'});
  g.hat([set('index', listReporter('data_itemnumoflist', 'items', {ITEM: variable('needle')}))], {id: 'partial-index'});
  return withExpected(f, {
    partial: {'partial-contents': /02列表内容helper/, 'partial-index': /02列表索引helper/},
    sourcePatterns: [/listContents\(/, /listIndexOf\(/],
    limitations: ['Whole bodies remain unresolved; data_listcontents/data_itemnumoflist are not supported claims.']
  });
}

async function typedComparison() {
  const f = await base();
  const stage = f.project.targets[0];
  declarations(stage, {input: '7', result: 'not-run'});
  new ScratchGraph(f.project, 0).hat([set('result', compare('operator_lt',
    binary('operator_add', variable('input'), 1), 10))], {id: 'typed-compare'});
  return withExpected(f, {
    expected: [expected(0, {result: true})],
    requiredOpcodes: ['operator_add', 'operator_lt'],
    sourcePatterns: [/\+\s*1\)\s*<\s*10/],
    limitations: ['Numeric arithmetic type proof is accepted; non-NaN proof remains separately guarded.']
  });
}

// Twelve fixture families: ten behavioral scenarios and two explicit partial
// scopes. Additional subcases isolate text/logic and list mutation from the
// literal-index regressions; the complete fixtures keep their strict asserts.
export const supportedSubcases = [
  {id: 'variable-text-logic-comparisons-without-letter-index', build: () => stringsAndLogic({includeLiteralIndex: false})},
  {id: 'safe-list-mutations-and-scope-with-last-item', build: () => lists({includeLiteralIndex: false})}
];
export const corpusScenarios = [
  {id: 'recursive-control-broadcast', build: recursive},
  {id: 'bounded-control-flags-counter', build: controls},
  {id: 'variable-arithmetic', build: arithmetic},
  {id: 'variable-math-14-selectors', build: mathematics},
  {id: 'variable-text-logic-comparisons', build: stringsAndLogic},
  {id: 'safe-list-mutations-and-scope', build: lists},
  {id: 'motion-size-visibility', build: motionAndVisibility},
  {id: 'costume-backdrop-effects-renderer-shapes', build: appearance},
  {id: 'headless-sensing-state-and-helpers', build: sensing},
  {id: 'sound-promises-and-volume', build: sound},
  {id: 'partial-list-contents-index', build: partialLists},
  {id: 'typed-native-comparison', build: typedComparison}
];

