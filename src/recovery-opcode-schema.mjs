// Static argument names from research/02engine/scratch-vm/src/blocks,
// src/compiler/irgen.js, and src/extensions/scratch3_{pen,music,text2speech,video_sensing}/index.js.
// Core menu blocks are defined in scratch-gui/src/lib/{blocks,make-toolbox-xml}.js;
// extension menu opcode/field names follow scratch-vm/src/engine/runtime.js.
// These are compatibility-call arguments: SUBSTACK branches are passed separately
// by irgen.descendCompatLayerStack and are deliberately absent here.
const schema = (inputs = [], fields = [], shadowInputs) => Object.freeze({
  inputs: Object.freeze(inputs),
  fields: Object.freeze(fields),
  ...(shadowInputs ? {shadowInputs: Object.freeze(Object.fromEntries(
    Object.entries(shadowInputs).map(([name, definition]) => [name, Object.freeze(definition)])
  ))} : {})
});

export const RECOVERY_OPCODE_SCHEMA = Object.freeze({
  motion_movesteps: schema(['STEPS']),
  motion_turnright: schema(['DEGREES']),
  motion_turnleft: schema(['DEGREES']),
  motion_goto: schema(['TO'], [], {TO: {opcode: 'motion_goto_menu', field: 'TO'}}),
  motion_gotoxy: schema(['X', 'Y']),
  motion_glideto: schema(['SECS', 'TO'], [], {TO: {opcode: 'motion_glideto_menu', field: 'TO'}}),
  motion_glidesecstoxy: schema(['SECS', 'X', 'Y']),
  motion_pointindirection: schema(['DIRECTION']),
  motion_pointtowards: schema(['TOWARDS'], [], {
    TOWARDS: {opcode: 'motion_pointtowards_menu', field: 'TOWARDS'}
  }),
  motion_changexby: schema(['DX']),
  motion_setx: schema(['X']),
  motion_changeyby: schema(['DY']),
  motion_sety: schema(['Y']),
  motion_ifonedgebounce: schema(),
  motion_setrotationstyle: schema([], ['STYLE']),
  motion_xposition: schema(),
  motion_yposition: schema(),
  motion_direction: schema(),
  motion_goto_menu: schema([], ['TO']),
  motion_glideto_menu: schema([], ['TO']),
  motion_pointtowards_menu: schema([], ['TOWARDS']),

  looks_sayforsecs: schema(['MESSAGE', 'SECS']),
  looks_say: schema(['MESSAGE']),
  looks_thinkforsecs: schema(['MESSAGE', 'SECS']),
  looks_think: schema(['MESSAGE']),
  looks_switchcostumeto: schema(['COSTUME'], [], {COSTUME: {opcode: 'looks_costume', field: 'COSTUME'}}),
  looks_nextcostume: schema(),
  looks_switchbackdropto: schema(['BACKDROP'], [], {BACKDROP: {opcode: 'looks_backdrops', field: 'BACKDROP'}}),
  looks_switchbackdroptoandwait: schema(['BACKDROP'], [], {
    BACKDROP: {opcode: 'looks_backdrops', field: 'BACKDROP'}
  }),
  looks_nextbackdrop: schema(),
  looks_changesizeby: schema(['CHANGE']),
  looks_setsizeto: schema(['SIZE']),
  looks_changeeffectby: schema(['CHANGE'], ['EFFECT']),
  looks_seteffectto: schema(['VALUE'], ['EFFECT']),
  looks_cleargraphiceffects: schema(),
  looks_show: schema(),
  looks_hide: schema(),
  looks_gotofrontback: schema([], ['FRONT_BACK']),
  looks_goforwardbackwardlayers: schema(['NUM'], ['FORWARD_BACKWARD']),
  looks_costumenumbername: schema([], ['NUMBER_NAME']),
  looks_backdropnumbername: schema([], ['NUMBER_NAME']),
  looks_size: schema(),
  looks_costume: schema([], ['COSTUME']),
  looks_backdrops: schema([], ['BACKDROP']),

  sound_play: schema(['SOUND_MENU'], [], {SOUND_MENU: {opcode: 'sound_sounds_menu', field: 'SOUND_MENU'}}),
  sound_playuntildone: schema(['SOUND_MENU'], [], {
    SOUND_MENU: {opcode: 'sound_sounds_menu', field: 'SOUND_MENU'}
  }),
  sound_stopallsounds: schema(),
  sound_changeeffectby: schema(['VALUE'], ['EFFECT']),
  sound_seteffectto: schema(['VALUE'], ['EFFECT']),
  sound_cleareffects: schema(),
  sound_changevolumeby: schema(['VOLUME']),
  sound_setvolumeto: schema(['VOLUME']),
  sound_volume: schema(),
  sound_sounds_menu: schema([], ['SOUND_MENU']),
  motion_align_scene: schema([], ['ALIGNMENT']),
  motion_scroll_right: schema(['DISTANCE']),
  motion_scroll_up: schema(['DISTANCE']),
  motion_xscroll: schema(),
  motion_yscroll: schema(),
  looks_changestretchby: schema(['CHANGE']),
  looks_setstretchto: schema(['STRETCH']),
  looks_hideallsprites: schema(),
  sensing_loud: schema(),
  sensing_userid: schema(),
  sound_beats_menu: schema([], ['BEATS']),
  sound_effects_menu: schema([], ['EFFECT']),

  event_whenflagclicked: schema(),
  event_whenkeypressed: schema([], ['KEY_OPTION']),
  event_whenthisspriteclicked: schema(),
  event_whenstageclicked: schema(),
  event_whenbackdropswitchesto: schema([], ['BACKDROP']),
  event_whengreaterthan: schema(['VALUE'], ['WHENGREATERTHANMENU']),
  event_whentouchingobject: schema(['TOUCHINGOBJECTMENU'], [], {
    TOUCHINGOBJECTMENU: {opcode: 'sensing_touchingobjectmenu', field: 'TOUCHINGOBJECTMENU'}
  }),
  event_whenbroadcastreceived: schema([], ['BROADCAST_OPTION']),
  event_broadcast: schema(['BROADCAST_INPUT'], [], {
    BROADCAST_INPUT: {opcode: 'event_broadcast_menu', field: 'BROADCAST_OPTION'}
  }),
  event_broadcastandwait: schema(['BROADCAST_INPUT'], [], {
    BROADCAST_INPUT: {opcode: 'event_broadcast_menu', field: 'BROADCAST_OPTION'}
  }),
  event_broadcast_menu: schema([], ['BROADCAST_OPTION']),

  control_wait: schema(['DURATION']),
  control_repeat: schema(['TIMES']),
  control_forever: schema(),
  control_if: schema(['CONDITION']),
  control_if_else: schema(['CONDITION']),
  control_wait_until: schema(['CONDITION']),
  control_repeat_until: schema(['CONDITION']),
  control_while: schema(['CONDITION']),
  control_for_each: schema(['VALUE'], ['VARIABLE']),
  control_all_at_once: schema(),
  control_stop: schema([], ['STOP_OPTION']),
  control_start_as_clone: schema(),
  control_create_clone_of: schema(['CLONE_OPTION'], [], {
    CLONE_OPTION: {opcode: 'control_create_clone_of_menu', field: 'CLONE_OPTION'}
  }),
  control_create_clone_of_menu: schema([], ['CLONE_OPTION']),
  control_delete_this_clone: schema(),
  control_get_counter: schema(),
  control_incr_counter: schema(),
  control_clear_counter: schema(),

  sensing_touchingobject: schema(['TOUCHINGOBJECTMENU'], [], {
    TOUCHINGOBJECTMENU: {opcode: 'sensing_touchingobjectmenu', field: 'TOUCHINGOBJECTMENU'}
  }),
  sensing_touchingobjectmenu: schema([], ['TOUCHINGOBJECTMENU']),
  sensing_touchingcolor: schema(['COLOR']),
  sensing_coloristouchingcolor: schema(['COLOR', 'COLOR2']),
  sensing_distanceto: schema(['DISTANCETOMENU'], [], {
    DISTANCETOMENU: {opcode: 'sensing_distancetomenu', field: 'DISTANCETOMENU'}
  }),
  sensing_distancetomenu: schema([], ['DISTANCETOMENU']),
  sensing_askandwait: schema(['QUESTION']),
  sensing_answer: schema(),
  sensing_keypressed: schema(['KEY_OPTION'], [], {KEY_OPTION: {opcode: 'sensing_keyoptions', field: 'KEY_OPTION'}}),
  sensing_keyoptions: schema([], ['KEY_OPTION']),
  sensing_mousedown: schema(),
  sensing_mousex: schema(),
  sensing_mousey: schema(),
  sensing_setdragmode: schema([], ['DRAG_MODE']),
  sensing_loudness: schema(),
  sensing_loud: schema(),
  sensing_timer: schema(),
  sensing_resettimer: schema(),
  sensing_of: schema(['OBJECT'], ['PROPERTY'], {OBJECT: {opcode: 'sensing_of_object_menu', field: 'OBJECT'}}),
  sensing_of_object_menu: schema([], ['OBJECT']),
  sensing_current: schema([], ['CURRENTMENU']),
  sensing_dayssince2000: schema(),
  sensing_username: schema(),

  operator_add: schema(['NUM1', 'NUM2']),
  operator_subtract: schema(['NUM1', 'NUM2']),
  operator_multiply: schema(['NUM1', 'NUM2']),
  operator_divide: schema(['NUM1', 'NUM2']),
  operator_random: schema(['FROM', 'TO']),
  operator_gt: schema(['OPERAND1', 'OPERAND2']),
  operator_lt: schema(['OPERAND1', 'OPERAND2']),
  operator_equals: schema(['OPERAND1', 'OPERAND2']),
  operator_and: schema(['OPERAND1', 'OPERAND2']),
  operator_or: schema(['OPERAND1', 'OPERAND2']),
  operator_not: schema(['OPERAND']),
  operator_join: schema(['STRING1', 'STRING2']),
  operator_letter_of: schema(['LETTER', 'STRING']),
  operator_length: schema(['STRING']),
  operator_contains: schema(['STRING1', 'STRING2']),
  operator_mod: schema(['NUM1', 'NUM2']),
  operator_round: schema(['NUM']),
  operator_mathop: schema(['NUM'], ['OPERATOR']),

  // Names only: the main recovery layer must resolve variable/list/broadcast IDs.
  data_variable: schema([], ['VARIABLE']),
  data_setvariableto: schema(['VALUE'], ['VARIABLE']),
  data_changevariableby: schema(['VALUE'], ['VARIABLE']),
  data_showvariable: schema([], ['VARIABLE']),
  data_hidevariable: schema([], ['VARIABLE']),
  data_listcontents: schema([], ['LIST']),
  data_addtolist: schema(['ITEM'], ['LIST']),
  data_deleteoflist: schema(['INDEX'], ['LIST']),
  data_deletealloflist: schema([], ['LIST']),
  data_insertatlist: schema(['ITEM', 'INDEX'], ['LIST']),
  data_replaceitemoflist: schema(['INDEX', 'ITEM'], ['LIST']),
  data_itemoflist: schema(['INDEX'], ['LIST']),
  data_itemnumoflist: schema(['ITEM'], ['LIST']),
  data_lengthoflist: schema([], ['LIST']),
  data_listcontainsitem: schema(['ITEM'], ['LIST']),
  data_showlist: schema([], ['LIST']),
  data_hidelist: schema([], ['LIST']),

  pen_clear: schema(),
  pen_stamp: schema(),
  pen_penDown: schema(),
  pen_penUp: schema(),
  pen_setPenColorToColor: schema(['COLOR']),
  pen_changePenColorParamBy: schema(['COLOR_PARAM', 'VALUE'], [], {
    COLOR_PARAM: {opcode: 'pen_menu_colorParam', field: 'colorParam'}
  }),
  pen_setPenColorParamTo: schema(['COLOR_PARAM', 'VALUE'], [], {
    COLOR_PARAM: {opcode: 'pen_menu_colorParam', field: 'colorParam'}
  }),
  pen_changePenSizeBy: schema(['SIZE']),
  pen_setPenSizeTo: schema(['SIZE']),
  pen_setPenShadeToNumber: schema(['SHADE']),
  pen_changePenShadeBy: schema(['SHADE']),
  pen_setPenHueToNumber: schema(['HUE']),
  pen_changePenHueBy: schema(['HUE']),
  pen_menu_colorParam: schema([], ['colorParam']),

  music_playDrumForBeats: schema(['DRUM', 'BEATS'], [], {DRUM: {opcode: 'music_menu_DRUM', field: 'DRUM'}}),
  music_midiPlayDrumForBeats: schema(['DRUM', 'BEATS'], [], {
    DRUM: {opcode: 'music_menu_DRUM', field: 'DRUM'}
  }),
  music_restForBeats: schema(['BEATS']),
  music_playNoteForBeats: schema(['NOTE', 'BEATS']),
  music_setInstrument: schema(['INSTRUMENT'], [], {
    INSTRUMENT: {opcode: 'music_menu_INSTRUMENT', field: 'INSTRUMENT'}
  }),
  music_midiSetInstrument: schema(['INSTRUMENT']),
  music_setTempo: schema(['TEMPO']),
  music_changeTempo: schema(['TEMPO']),
  music_getTempo: schema(),
  music_menu_DRUM: schema([], ['DRUM']),
  music_menu_INSTRUMENT: schema([], ['INSTRUMENT']),

  text2speech_speakAndWait: schema(['WORDS']),
  text2speech_setVoice: schema(['VOICE'], [], {VOICE: {opcode: 'text2speech_menu_voices', field: 'voices'}}),
  text2speech_setLanguage: schema(['LANGUAGE'], [], {
    LANGUAGE: {opcode: 'text2speech_menu_languages', field: 'languages'}
  }),
  text2speech_menu_voices: schema([], ['voices']),
  text2speech_menu_languages: schema([], ['languages']),

  videoSensing_whenMotionGreaterThan: schema(['REFERENCE']),
  videoSensing_videoOn: schema(['ATTRIBUTE', 'SUBJECT'], [], {
    ATTRIBUTE: {opcode: 'videoSensing_menu_ATTRIBUTE', field: 'ATTRIBUTE'},
    SUBJECT: {opcode: 'videoSensing_menu_SUBJECT', field: 'SUBJECT'}
  }),
  videoSensing_videoToggle: schema(['VIDEO_STATE'], [], {
    VIDEO_STATE: {opcode: 'videoSensing_menu_VIDEO_STATE', field: 'VIDEO_STATE'}
  }),
  videoSensing_setVideoTransparency: schema(['TRANSPARENCY']),
  videoSensing_menu_ATTRIBUTE: schema([], ['ATTRIBUTE']),
  videoSensing_menu_SUBJECT: schema([], ['SUBJECT']),
  videoSensing_menu_VIDEO_STATE: schema([], ['VIDEO_STATE']),

  math_number: schema([], ['NUM']),
  math_integer: schema([], ['NUM']),
  math_whole_number: schema([], ['NUM']),
  math_positive_number: schema([], ['NUM']),
  math_angle: schema([], ['NUM']),
  colour_picker: schema([], ['COLOUR']),
  text: schema([], ['TEXT']),
  note: schema([], ['NOTE']),
  argument_reporter_string_number: schema([], ['VALUE']),
  argument_reporter_boolean: schema([], ['VALUE'])
});

/**
 * Decode an Acorn ObjectExpression's properties without evaluating source.
 * Fields must be string/number Literal nodes; expression policy for inputs is
 * delegated to decodeExpression. Validate the whole object before invoking it.
 * shadowInputs contains fixed {opcode, field} definitions, independent of the
 * values. The caller decides whether a literal uses a menu shadow or a reporter
 * stays connected as the actual input; no reporter is converted to a field here.
 */
export function decodeCompatibilityArguments(opcode, properties, decodeExpression) {
  if (typeof opcode !== 'string' || !Object.hasOwn(RECOVERY_OPCODE_SCHEMA, opcode)) {
    throw new Error(`Unknown compatibility opcode${typeof opcode === 'string' ? `: ${opcode}` : ''}`);
  }
  if (!Array.isArray(properties)) throw new Error(`${opcode}: expected an AST Property array`);
  if (typeof decodeExpression !== 'function') throw new Error(`${opcode}: decodeExpression must be a function`);

  const definition = RECOVERY_OPCODE_SCHEMA[opcode];
  const expected = new Set([...definition.inputs, ...definition.fields]);
  const values = new Map();
  for (const property of properties) {
    if (property?.type !== 'Property' || property.computed || property.kind !== 'init' || property.method) {
      throw new Error(`${opcode}: only non-computed data properties are allowed (no spreads, accessors, or methods)`);
    }
    const key = property.key;
    const name = key?.type === 'Identifier' ? key.name :
      key?.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
    if (typeof name !== 'string' || !expected.has(name)) {
      throw new Error(`${opcode}: unknown argument key${typeof name === 'string' ? `: ${name}` : ''}`);
    }
    if (values.has(name)) throw new Error(`${opcode}: duplicate argument key: ${name}`);
    if (!property.value || typeof property.value.type !== 'string') {
      throw new Error(`${opcode}: ${name} must have an AST value`);
    }
    values.set(name, property.value);
  }
  for (const name of expected) {
    if (!values.has(name)) throw new Error(`${opcode}: missing argument: ${name}`);
  }

  const fields = {};
  for (const name of definition.fields) {
    const node = values.get(name);
    if (node.type !== 'Literal' || (typeof node.value !== 'string' && typeof node.value !== 'number')) {
      throw new Error(`${opcode}: field ${name} must be a string or numeric Literal`);
    }
    fields[name] = [String(node.value), null];
  }
  const inputs = {};
  for (const name of definition.inputs) inputs[name] = decodeExpression(values.get(name));
  const shadowInputs = Object.fromEntries(Object.entries(definition.shadowInputs || {})
    .map(([name, descriptor]) => [name, {...descriptor}]));
  return {opcode, fields, inputs, shadowInputs};
}
