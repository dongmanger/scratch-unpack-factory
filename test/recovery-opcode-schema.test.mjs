import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {RECOVERY_OPCODE_SCHEMA, decodeCompatibilityArguments} from '../src/recovery-opcode-schema.mjs';

const propertiesOf = source => parse(`(${source})`, {ecmaVersion: 'latest'}).body[0].expression.properties;
const decodeLiteral = node => {
  assert.equal(node.type, 'Literal');
  return {kind: 'literal', value: node.value};
};
const decode = (opcode, source, expressionDecoder = decodeLiteral) =>
  decodeCompatibilityArguments(opcode, propertiesOf(source), expressionDecoder);

// Explicit command cases catch input/field name mistakes, including legacy pen/music blocks.
const commandCases = [
  ['motion_glidesecstoxy', '{SECS: 2, X: 30, Y: 40}', {SECS: 2, X: 30, Y: 40}],
  ['motion_glideto', '{SECS: 2, TO: "_mouse_"}', {SECS: 2, TO: '_mouse_'}],
  ['motion_goto', '{TO: "Sprite2"}', {TO: 'Sprite2'}],
  ['motion_pointtowards', '{TOWARDS: "_mouse_"}', {TOWARDS: '_mouse_'}],
  ['motion_setrotationstyle', '{STYLE: "left-right"}', {}, {STYLE: 'left-right'}],
  ['looks_sayforsecs', '{MESSAGE: "hello", SECS: 2}', {MESSAGE: 'hello', SECS: 2}],
  ['looks_thinkforsecs', '{MESSAGE: "hmm", SECS: 3}', {MESSAGE: 'hmm', SECS: 3}],
  ['looks_switchcostumeto', '{COSTUME: "costume2"}', {COSTUME: 'costume2'}],
  ['looks_switchbackdropto', '{BACKDROP: "backdrop2"}', {BACKDROP: 'backdrop2'}],
  ['looks_switchbackdroptoandwait', '{BACKDROP: 2}', {BACKDROP: 2}],
  ['sound_play', '{SOUND_MENU: "Meow"}', {SOUND_MENU: 'Meow'}],
  ['sound_playuntildone', '{SOUND_MENU: 1}', {SOUND_MENU: 1}],
  ['sound_stopallsounds', '{}', {}],
  ['sound_changeeffectby', '{EFFECT: "PITCH", VALUE: 10}', {VALUE: 10}, {EFFECT: 'PITCH'}],
  ['sound_seteffectto', '{VALUE: 100, EFFECT: "PAN"}', {VALUE: 100}, {EFFECT: 'PAN'}],
  ['sound_cleareffects', '{}', {}],
  ['sound_changevolumeby', '{VOLUME: 5}', {VOLUME: 5}],
  ['sound_setvolumeto', '{VOLUME: 80}', {VOLUME: 80}],
  ['sensing_askandwait', '{QUESTION: "Name?"}', {QUESTION: 'Name?'}],
  ['control_wait', '{DURATION: 0.5}', {DURATION: 0.5}],
  ['control_stop', '{STOP_OPTION: "other scripts in sprite"}', {}, {STOP_OPTION: 'other scripts in sprite'}],
  ['control_create_clone_of', '{CLONE_OPTION: "_myself_"}', {CLONE_OPTION: '_myself_'}],
  ['pen_clear', '{}', {}],
  ['pen_stamp', '{}', {}],
  ['pen_penDown', '{}', {}],
  ['pen_penUp', '{}', {}],
  ['pen_setPenColorToColor', '{COLOR: "#ff00ff"}', {COLOR: '#ff00ff'}],
  ['pen_changePenColorParamBy', '{COLOR_PARAM: "transparency", VALUE: 10}', {COLOR_PARAM: 'transparency', VALUE: 10}],
  ['pen_setPenColorParamTo', '{COLOR_PARAM: "saturation", VALUE: 50}', {COLOR_PARAM: 'saturation', VALUE: 50}],
  ['pen_changePenSizeBy', '{SIZE: 2}', {SIZE: 2}],
  ['pen_setPenSizeTo', '{SIZE: 4}', {SIZE: 4}],
  ['pen_setPenShadeToNumber', '{SHADE: 30}', {SHADE: 30}],
  ['pen_changePenShadeBy', '{SHADE: 10}', {SHADE: 10}],
  ['pen_setPenHueToNumber', '{HUE: 60}', {HUE: 60}],
  ['pen_changePenHueBy', '{HUE: 10}', {HUE: 10}],
  ['music_playDrumForBeats', '{DRUM: 1, BEATS: 0.25}', {DRUM: 1, BEATS: 0.25}],
  ['music_midiPlayDrumForBeats', '{DRUM: 35, BEATS: 1}', {DRUM: 35, BEATS: 1}],
  ['music_restForBeats', '{BEATS: 0.5}', {BEATS: 0.5}],
  ['music_playNoteForBeats', '{NOTE: 60, BEATS: 1}', {NOTE: 60, BEATS: 1}],
  ['music_setInstrument', '{INSTRUMENT: 2}', {INSTRUMENT: 2}],
  ['music_midiSetInstrument', '{INSTRUMENT: 24}', {INSTRUMENT: 24}],
  ['music_setTempo', '{TEMPO: 120}', {TEMPO: 120}],
  ['music_changeTempo', '{TEMPO: 20}', {TEMPO: 20}],
  ['music_getTempo', '{}', {}],
  ['text2speech_speakAndWait', '{WORDS: "hello"}', {WORDS: 'hello'}],
  ['text2speech_setVoice', '{VOICE: "ALTO"}', {VOICE: 'ALTO'}],
  ['text2speech_setLanguage', '{LANGUAGE: "en"}', {LANGUAGE: 'en'}],
  ['videoSensing_whenMotionGreaterThan', '{REFERENCE: 10}', {REFERENCE: 10}],
  ['videoSensing_videoOn', '{ATTRIBUTE: "motion", SUBJECT: "Stage"}', {ATTRIBUTE: 'motion', SUBJECT: 'Stage'}],
  ['videoSensing_videoToggle', '{VIDEO_STATE: "on-flipped"}', {VIDEO_STATE: 'on-flipped'}],
  ['videoSensing_setVideoTransparency', '{TRANSPARENCY: 50}', {TRANSPARENCY: 50}]
];
for (const [opcode, source, inputValues, fieldValues = {}] of commandCases) {
  test(`compatibility arguments: ${opcode}`, () => {
    const result = decode(opcode, source);
    assert.deepEqual(result, {
      opcode,
      fields: Object.fromEntries(Object.entries(fieldValues).map(([name, value]) => [name, [String(value), null]])),
      inputs: Object.fromEntries(Object.entries(inputValues).map(([name, value]) => [name, {kind: 'literal', value}])),
      shadowInputs: RECOVERY_OPCODE_SCHEMA[opcode].shadowInputs || {}
    });
  });
}

test('menu metadata is fixed for both literal and expression inputs, with exact shadow field names', () => {
  const menuCases = [
    ['motion_goto', 'TO', 'motion_goto_menu', 'TO', '{TO: spriteName}'],
    ['motion_glideto', 'TO', 'motion_glideto_menu', 'TO', '{SECS: duration, TO: spriteName}'],
    ['motion_pointtowards', 'TOWARDS', 'motion_pointtowards_menu', 'TOWARDS', '{TOWARDS: spriteName}'],
    ['sound_play', 'SOUND_MENU', 'sound_sounds_menu', 'SOUND_MENU', '{SOUND_MENU: soundName}'],
    ['pen_setPenColorParamTo', 'COLOR_PARAM', 'pen_menu_colorParam', 'colorParam', '{COLOR_PARAM: parameter, VALUE: value}'],
    ['music_setInstrument', 'INSTRUMENT', 'music_menu_INSTRUMENT', 'INSTRUMENT', '{INSTRUMENT: instrument}'],
    ['text2speech_setVoice', 'VOICE', 'text2speech_menu_voices', 'voices', '{VOICE: voice}'],
    ['text2speech_setLanguage', 'LANGUAGE', 'text2speech_menu_languages', 'languages', '{LANGUAGE: language}'],
    ['videoSensing_videoToggle', 'VIDEO_STATE', 'videoSensing_menu_VIDEO_STATE', 'VIDEO_STATE', '{VIDEO_STATE: state}']
  ];
  for (const [opcode, input, shadowOpcode, field, source] of menuCases) {
    const result = decode(opcode, source, node => ({kind: 'expression', node}));
    assert.deepEqual(result.fields, {});
    assert.equal(result.inputs[input].node.type, 'Identifier');
    assert.deepEqual(result.shadowInputs[input], {opcode: shadowOpcode, field});
    assert.deepEqual(RECOVERY_OPCODE_SCHEMA[shadowOpcode], {inputs: [], fields: [field]});
  }
  assert.equal(RECOVERY_OPCODE_SCHEMA.music_midiSetInstrument.shadowInputs, undefined);
});

test('core operators, list fields, direct blocks and branch-free control schemas are available', () => {
  const expected = {
    operator_add: {inputs: ['NUM1', 'NUM2'], fields: []},
    operator_mathop: {inputs: ['NUM'], fields: ['OPERATOR']},
    operator_letter_of: {inputs: ['LETTER', 'STRING'], fields: []},
    data_insertatlist: {inputs: ['ITEM', 'INDEX'], fields: ['LIST']},
    data_setvariableto: {inputs: ['VALUE'], fields: ['VARIABLE']},
    control_if_else: {inputs: ['CONDITION'], fields: []},
    control_repeat: {inputs: ['TIMES'], fields: []},
    control_for_each: {inputs: ['VALUE'], fields: ['VARIABLE']},
    control_forever: {inputs: [], fields: []},
    motion_movesteps: {inputs: ['STEPS'], fields: []},
    looks_changeeffectby: {inputs: ['CHANGE'], fields: ['EFFECT']}
  };
  for (const [opcode, definition] of Object.entries(expected)) assert.deepEqual(RECOVERY_OPCODE_SCHEMA[opcode], definition);
  assert.deepEqual(decode('data_addtolist', '{ITEM: "apple", LIST: "fruit"}').fields, {LIST: ['fruit', null]});
  assert.deepEqual(decode('operator_mathop', '{NUM: 9, OPERATOR: "sqrt"}').inputs, {NUM: {kind: 'literal', value: 9}});
  assert.deepEqual(decode('control_if_else', '{CONDITION: true}').inputs, {CONDITION: {kind: 'literal', value: true}});
});

test('all explicit schemas have distinct names, consistent menu definitions, and decode exact keys', () => {
  for (const [opcode, definition] of Object.entries(RECOVERY_OPCODE_SCHEMA)) {
    const names = [...definition.inputs, ...definition.fields];
    assert.equal(new Set(names).size, names.length, opcode);
    assert.ok(names.every(name => typeof name === 'string'), opcode);
    const source = `{${names.map(name => `${JSON.stringify(name)}: "value"`).join(',')}}`;
    const result = decode(opcode, source);
    assert.deepEqual(Object.keys(result.inputs), definition.inputs, opcode);
    assert.deepEqual(Object.keys(result.fields), definition.fields, opcode);
    for (const [name, shadow] of Object.entries(definition.shadowInputs || {})) {
      assert.ok(definition.inputs.includes(name), `${opcode}.${name}`);
      assert.deepEqual(RECOVERY_OPCODE_SCHEMA[shadow.opcode], {inputs: [], fields: [shadow.field]}, opcode);
    }
  }
});

test('string and numeric Literal fields are stringified, and quoted keys need no evaluation', () => {
  assert.deepEqual(decode('sound_seteffectto', '{"EFFECT": 7, "VALUE": 0}').fields, {EFFECT: ['7', null]});
  assert.deepEqual(decode('looks_costumenumbername', '{NUMBER_NAME: "number"}').fields, {NUMBER_NAME: ['number', null]});
  assert.deepEqual(decode('sound_seteffectto', '{"E\\u0046FECT": "pitch", VALUE: 0}').fields, {EFFECT: ['pitch', null]});
});

test('inputs are delegated unchanged, including shorthand, negative numbers, and nonliteral menus', () => {
  const properties = propertiesOf('{SECS: -2, TO}');
  const visited = [];
  const result = decodeCompatibilityArguments('motion_glideto', properties, node => {
    visited.push(node);
    return {node};
  });
  assert.strictEqual(visited[0], properties[0].value);
  assert.strictEqual(visited[1], properties[1].value);
  assert.equal(result.inputs.SECS.node.type, 'UnaryExpression');
  assert.equal(result.inputs.TO.node.type, 'Identifier');
  assert.deepEqual(result.fields, {});
  assert.deepEqual(result.shadowInputs, {TO: {opcode: 'motion_glideto_menu', field: 'TO'}});
});

const invalidObjects = [
  ['missing input', 'control_wait', '{}', /missing argument: DURATION/],
  ['missing field', 'sound_changeeffectby', '{VALUE: 10}', /missing argument: EFFECT/],
  ['missing second input', 'motion_glidesecstoxy', '{SECS: 1, X: 2}', /missing argument: Y/],
  ['extra key', 'control_wait', '{DURATION: 1, EXTRA: 2}', /unknown argument key: EXTRA/],
  ['wrong sound value name', 'sound_seteffectto', '{EFFECT: "pitch", CHANGE: 10}', /unknown argument key: CHANGE/],
  ['wrong volume name', 'sound_setvolumeto', '{VALUE: 10}', /unknown argument key: VALUE/],
  ['shadow field on parent pen block', 'pen_setPenColorParamTo', '{colorParam: "color", VALUE: 10}', /unknown argument key: colorParam/],
  ['shadow field on parent speech block', 'text2speech_setVoice', '{voices: "ALTO"}', /unknown argument key: voices/],
  ['duplicate identifier/string keys', 'control_wait', '{DURATION: 1, "DURATION": 2}', /duplicate argument key: DURATION/],
  ['duplicate escaped keys', 'control_wait', '{DURATION: 1, "DURA\\u0054ION": 2}', /duplicate argument key: DURATION/],
  ['spread', 'control_wait', '{DURATION: 1, ...sideEffect()}', /no spreads/],
  ['computed literal', 'control_wait', '{["DURATION"]: 1}', /non-computed/],
  ['computed expression', 'control_wait', '{[sideEffect()]: 1}', /non-computed/],
  ['getter', 'control_wait', '{get DURATION() { return sideEffect(); }}', /accessors/],
  ['setter', 'control_wait', '{set DURATION(value) { sideEffect(value); }}', /accessors/],
  ['method', 'control_wait', '{DURATION() { sideEffect(); }}', /methods/],
  ['numeric key', 'control_wait', '{0: 1}', /unknown argument key/],
  ['prototype key', 'control_wait', '{DURATION: 1, __proto__: {polluted: true}}', /unknown argument key: __proto__/],
  ['constructor key', 'control_wait', '{DURATION: 1, constructor: sideEffect()}', /unknown argument key: constructor/],
  ['substack is not a compatibility argument', 'control_repeat', '{TIMES: 10, SUBSTACK: branch}', /unknown argument key: SUBSTACK/],
  ['arguments forbidden on zero-input command', 'sound_stopallsounds', '{SOUND_MENU: "Meow"}', /unknown argument key/]
];
for (const [label, opcode, source, message] of invalidObjects) {
  test(`rejects ${label} before decoding expressions`, () => {
    let calls = 0;
    assert.throws(() => decode(opcode, source, () => { calls++; }), message);
    assert.equal(calls, 0);
    assert.equal(Object.prototype.polluted, undefined);
  });
}

for (const source of ['true', 'null', 'undefined', 'effect', '-1', '1 + 2', '`pitch`', '/pitch/', '7n', '[]', '{}',
  'sideEffect()', 'globalThis.__recoveryOpcodeProbe = 1']) {
  test(`rejects non-string/numeric Literal field: ${source}`, () => {
    let calls = 0;
    assert.throws(() => decode('sound_changeeffectby', `{VALUE: 10, EFFECT: ${source}}`, () => { calls++; }),
      /field EFFECT must be a string or numeric Literal/);
    assert.equal(calls, 0);
    assert.equal(Object.hasOwn(globalThis, '__recoveryOpcodeProbe'), false);
  });
}

for (const opcode of ['unknown_extension_command', 'pen_unknown', 'sound_playUntilDone', 'videoSensing_videotoggle',
  'looks_switchbackdropto_andwait', 'constructor', '__proto__', 'toString', '', null, 42]) {
  test(`rejects unknown exact opcode: ${opcode}`, () => {
    let calls = 0;
    assert.throws(() => decodeCompatibilityArguments(opcode, [], () => { calls++; }), /Unknown compatibility opcode/);
    assert.equal(calls, 0);
  });
}

test('requires a Property array, a decoding callback, and AST values', () => {
  for (const properties of [null, undefined, {}, 'DURATION: 1', parse('({DURATION: 1})', {ecmaVersion: 'latest'}).body[0].expression]) {
    assert.throws(() => decodeCompatibilityArguments('control_wait', properties, decodeLiteral), /AST Property array/);
  }
  assert.throws(() => decodeCompatibilityArguments('control_wait', propertiesOf('{DURATION: 1}'), null), /must be a function/);
  for (const properties of [[null], [{type: 'SpreadElement'}]]) {
    assert.throws(() => decodeCompatibilityArguments('control_wait', properties, decodeLiteral), /data properties/);
  }
  const properties = propertiesOf('{DURATION: 1}');
  properties[0].value = null;
  assert.throws(() => decodeCompatibilityArguments('control_wait', properties, decodeLiteral), /must have an AST value/);
});

test('validates every field before calling the input decoder regardless of property order', () => {
  const properties = propertiesOf('{VALUE: sideEffect(), EFFECT: effect}');
  let calls = 0;
  assert.throws(() => decodeCompatibilityArguments('sound_seteffectto', properties, () => { calls++; }), /field EFFECT/);
  assert.equal(calls, 0);
});

test('hostile input source stays AST and decoder rejection propagates without evaluation', () => {
  assert.equal(Object.hasOwn(globalThis, '__recoveryOpcodeProbe'), false);
  const properties = propertiesOf('{DURATION: (() => { globalThis.__recoveryOpcodeProbe = 1; })()}');
  const result = decodeCompatibilityArguments('control_wait', properties, node => ({node}));
  assert.strictEqual(result.inputs.DURATION.node, properties[0].value);
  assert.equal(result.inputs.DURATION.node.type, 'CallExpression');
  assert.equal(Object.hasOwn(globalThis, '__recoveryOpcodeProbe'), false);
  const error = new Error('unsupported input expression');
  assert.throws(() => decodeCompatibilityArguments('control_wait', properties, () => { throw error; }), actual => actual === error);
  assert.equal(Object.hasOwn(globalThis, '__recoveryOpcodeProbe'), false);
});

test('schemas are immutable and each result owns its output and shadow descriptor objects', () => {
  assert.ok(Object.isFrozen(RECOVERY_OPCODE_SCHEMA));
  for (const definition of Object.values(RECOVERY_OPCODE_SCHEMA)) {
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.inputs));
    assert.ok(Object.isFrozen(definition.fields));
    if (definition.shadowInputs) {
      assert.ok(Object.isFrozen(definition.shadowInputs));
      for (const shadow of Object.values(definition.shadowInputs)) assert.ok(Object.isFrozen(shadow));
    }
  }
  const first = decode('sound_play', '{SOUND_MENU: "Meow"}');
  first.shadowInputs.SOUND_MENU.opcode = 'changed';
  first.inputs.SOUND_MENU.value = 'changed';
  const second = decode('sound_play', '{SOUND_MENU: "Meow"}');
  assert.equal(second.shadowInputs.SOUND_MENU.opcode, 'sound_sounds_menu');
  assert.equal(second.inputs.SOUND_MENU.value, 'Meow');
});

// Parse checked-in trusted definitions as data; do not import/execute the VM or GUI.
const sourceAST = path => parse(readFileSync(new URL(`../../research/02engine/${path}`, import.meta.url), 'utf8'),
  {ecmaVersion: 'latest', sourceType: 'module'});
const propertyName = node => node.key.type === 'Identifier' ? node.key.name : node.key.value;
const propertyValue = (object, name) => object.properties.find(property => propertyName(property) === name)?.value;
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};

for (const [directory, extensionId] of [['pen', 'pen'], ['music', 'music'], ['text2speech', 'text2speech'], ['video_sensing', 'videoSensing']]) {
  test(`schemas match static Scratch VM ${extensionId} getInfo definitions`, () => {
    const ast = sourceAST(`scratch-vm/src/extensions/scratch3_${directory}/index.js`);
    const declaration = ast.body.find(node => node.type === 'ClassDeclaration');
    const method = declaration.body.body.find(node => node.key.name === 'getInfo');
    const info = method.value.body.body.find(node => node.type === 'ReturnStatement').argument;
    assert.equal(propertyValue(info, 'id').value, extensionId);
    const menus = propertyValue(info, 'menus');
    const declaredOpcodes = [];
    for (const block of propertyValue(info, 'blocks').elements) {
      const opcodeNode = propertyValue(block, 'opcode');
      if (!opcodeNode) continue;
      const opcode = `${extensionId}_${opcodeNode.value}`;
      declaredOpcodes.push(opcode);
      const argumentsNode = propertyValue(block, 'arguments');
      const inputs = [];
      const fields = [];
      const shadowInputs = {};
      for (const argument of argumentsNode?.properties || []) {
        const name = propertyName(argument);
        const menu = propertyValue(argument.value, 'menu');
        if (menu) {
          const menuInfo = propertyValue(menus, menu.value);
          if (propertyValue(menuInfo, 'acceptReporters')?.value === true) {
            inputs.push(name);
            shadowInputs[name] = {opcode: `${extensionId}_menu_${menu.value}`, field: menu.value};
          } else {
            fields.push(name);
          }
        } else {
          inputs.push(name);
        }
      }
      assert.deepEqual(RECOVERY_OPCODE_SCHEMA[opcode], {
        inputs, fields, ...(Object.keys(shadowInputs).length ? {shadowInputs} : {})
      }, opcode);
    }
    const schemaOpcodes = Object.keys(RECOVERY_OPCODE_SCHEMA).filter(opcode => opcode.startsWith(`${extensionId}_`) &&
      !opcode.startsWith(`${extensionId}_menu_`));
    assert.deepEqual(schemaOpcodes.sort(), declaredOpcodes.sort());
  });
}

test('core menu opcode and field names match checked-in GUI definitions', () => {
  const ast = sourceAST('scratch-gui/src/lib/blocks.js');
  const memberPath = node => node?.type === 'Identifier' ? node.name :
    node?.type === 'MemberExpression' && !node.computed ? `${memberPath(node.object)}.${node.property.name}` : '';
  const menuFields = new Map();
  walk(ast, node => {
    if (node.type !== 'AssignmentExpression' || !memberPath(node.left).startsWith('ScratchBlocks.Blocks.')) return;
    const opcode = memberPath(node.left).split('.')[2];
    walk(node.right, child => {
      if (child.type === 'CallExpression' && child.callee.name === 'jsonForMenuBlock') {
        menuFields.set(opcode, child.arguments[0].value);
      }
    });
  });
  for (const opcode of ['sound_sounds_menu', 'looks_costume', 'looks_backdrops', 'motion_goto_menu',
    'motion_glideto_menu', 'motion_pointtowards_menu', 'sensing_of_object_menu', 'sensing_distancetomenu',
    'sensing_touchingobjectmenu', 'control_create_clone_of_menu']) {
    assert.ok(menuFields.has(opcode), opcode);
    assert.deepEqual(RECOVERY_OPCODE_SCHEMA[opcode], {inputs: [], fields: [menuFields.get(opcode)]}, opcode);
  }
});
