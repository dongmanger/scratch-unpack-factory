# Recovery coverage source audit — honest1.0

**semanticCoverageVerified: false · goalComplete: false · behavior tests run: 0**

This generated inventory is not acceptance evidence or a substitute for actual behavior tests. Schema entries do not count as decoder implementations. Test names and opcode mentions include schema, shape and rejection tests; none are reported as passed by this audit.

Original graph unique: **false**. Compilation folds constants, erases branches, unrolls loops and discards IDs/layout/metadata. Multiple original block graphs can yield the same factory source.

## Programmatic counts

| Metric | Count |
| --- | ---: |
| directIRInputDistinctScratchOpcodes | 57 |
| directIRStackDistinctScratchOpcodes | 70 |
| directIRUnionDistinctScratchOpcodes | 126 |
| directIRInputStackOverlap | 1 |
| compatibilityInputEntries | 6 |
| compatibilityStackEntries | 25 |
| compatibilityDistinctScratchOpcodes | 31 |
| compatibilityDirectIROverlap | 2 |
| schemaEntries | 199 |
| decoderSourceMentionedDistinctScratchOpcodes | 131 |
| metadataSourceMentionedDistinctScratchOpcodes | 11 |
| schemaAndDecoderSourceMentioned | 126 |
| schemaWithoutDecoderStringMention | 73 |
| schemaOnlyNoDecoderOrMetadataStringMention | 67 |
| directIRWithoutDecoderStringMention | 10 |
| compatibilityWithoutSchema | 0 |
| testInventoryFiles | 18 |
| testSourceMentionedDistinctScratchOpcodes | 132 |
| unrecognizedTestOpcodeShapedStrings | 9 |
| testCallDeclarations | 124 |
| inputIREnumEntries | 90 |
| stackIREnumEntries | 75 |
| jsgenInputEnumDispatchCases | 90 |
| jsgenStackEnumDispatchCases | 75 |
| behaviorTestsRunByAudit | 0 |
| semanticVerifiedOpcodeCount | 0 |

## Extraction rules

- **scope**: Only the explicit source manifest and immediate recovery test filenames; no recursive project scan.
- **compiler**: AST cases of the outer block.opcode switches in irgen.descendInput/descendStackedBlock. Nested selector cases are excluded; menu/constants and procedures are included.
- **compatibility**: Literal arrays from compat-blocks.js; entries overlapping direct cases do not imply the fallback is used.
- **decoder**: Exact opcode string Literal values from the explicitly listed decoder files only. No schema keys/comments/embedded code strings, metadata helpers or enum names count toward this total.
- **schema**: Imported RECOVERY_OPCODE_SCHEMA is argument metadata only. Schema-only entries never count as decoder implementation.
- **tests**: Static test names/name templates and exact opcode literal mentions are inventory evidence only, including negative/shape/schema tests. Counts of known opcodes exclude opcode-shaped strings absent from the compiler/schema/decoder union. Generated families are not expanded or counted as executed tests.
- **verification**: Source-mentioned, test-source-mentioned and behavior-tested are distinct. tested:null means no run result; no implementation or semantic coverage percentage is inferred.

## Distinct opcode lists

### Direct IR input Scratch opcodes (57)

`argument_reporter_boolean`, `argument_reporter_string_number`, `colour_picker`, `control_get_counter`, `data_itemnumoflist`, `data_itemoflist`, `data_lengthoflist`, `data_listcontainsitem`, `data_listcontents`, `data_variable`, `event_broadcast_menu`, `looks_backdropnumbername`, `looks_costumenumbername`, `looks_size`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `motion_direction`, `motion_xposition`, `motion_yposition`, `operator_add`, `operator_and`, `operator_contains`, `operator_divide`, `operator_equals`, `operator_gt`, `operator_join`, `operator_length`, `operator_letter_of`, `operator_lt`, `operator_mathop`, `operator_mod`, `operator_multiply`, `operator_not`, `operator_or`, `operator_random`, `operator_round`, `operator_subtract`, `procedures_call`, `sensing_answer`, `sensing_coloristouchingcolor`, `sensing_current`, `sensing_dayssince2000`, `sensing_distanceto`, `sensing_keypressed`, `sensing_mousedown`, `sensing_mousex`, `sensing_mousey`, `sensing_of`, `sensing_timer`, `sensing_touchingcolor`, `sensing_touchingobject`, `sensing_username`, `sound_sounds_menu`, `tw_getLastKeyPressed`

### Direct IR stack Scratch opcodes (70)

`control_all_at_once`, `control_clear_counter`, `control_create_clone_of`, `control_delete_this_clone`, `control_for_each`, `control_forever`, `control_if`, `control_if_else`, `control_incr_counter`, `control_repeat`, `control_repeat_until`, `control_stop`, `control_wait`, `control_wait_until`, `control_while`, `data_addtolist`, `data_changevariableby`, `data_deletealloflist`, `data_deleteoflist`, `data_hidelist`, `data_hidevariable`, `data_insertatlist`, `data_replaceitemoflist`, `data_setvariableto`, `data_showlist`, `data_showvariable`, `event_broadcast`, `event_broadcastandwait`, `looks_changeeffectby`, `looks_changesizeby`, `looks_cleargraphiceffects`, `looks_goforwardbackwardlayers`, `looks_gotofrontback`, `looks_hide`, `looks_nextbackdrop`, `looks_nextcostume`, `looks_say`, `looks_seteffectto`, `looks_setsizeto`, `looks_show`, `looks_switchbackdropto`, `looks_switchcostumeto`, `looks_think`, `motion_changexby`, `motion_changeyby`, `motion_gotoxy`, `motion_ifonedgebounce`, `motion_movesteps`, `motion_pointindirection`, `motion_setrotationstyle`, `motion_setx`, `motion_sety`, `motion_turnleft`, `motion_turnright`, `pen_changePenColorParamBy`, `pen_changePenHueBy`, `pen_changePenShadeBy`, `pen_changePenSizeBy`, `pen_clear`, `pen_penDown`, `pen_penUp`, `pen_setPenColorParamTo`, `pen_setPenColorToColor`, `pen_setPenHueToNumber`, `pen_setPenShadeToNumber`, `pen_setPenSizeTo`, `pen_stamp`, `procedures_call`, `procedures_return`, `sensing_resettimer`

### Direct IR union (126)

`argument_reporter_boolean`, `argument_reporter_string_number`, `colour_picker`, `control_all_at_once`, `control_clear_counter`, `control_create_clone_of`, `control_delete_this_clone`, `control_for_each`, `control_forever`, `control_get_counter`, `control_if`, `control_if_else`, `control_incr_counter`, `control_repeat`, `control_repeat_until`, `control_stop`, `control_wait`, `control_wait_until`, `control_while`, `data_addtolist`, `data_changevariableby`, `data_deletealloflist`, `data_deleteoflist`, `data_hidelist`, `data_hidevariable`, `data_insertatlist`, `data_itemnumoflist`, `data_itemoflist`, `data_lengthoflist`, `data_listcontainsitem`, `data_listcontents`, `data_replaceitemoflist`, `data_setvariableto`, `data_showlist`, `data_showvariable`, `data_variable`, `event_broadcast`, `event_broadcast_menu`, `event_broadcastandwait`, `looks_backdropnumbername`, `looks_changeeffectby`, `looks_changesizeby`, `looks_cleargraphiceffects`, `looks_costumenumbername`, `looks_goforwardbackwardlayers`, `looks_gotofrontback`, `looks_hide`, `looks_nextbackdrop`, `looks_nextcostume`, `looks_say`, `looks_seteffectto`, `looks_setsizeto`, `looks_show`, `looks_size`, `looks_switchbackdropto`, `looks_switchcostumeto`, `looks_think`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `motion_changexby`, `motion_changeyby`, `motion_direction`, `motion_gotoxy`, `motion_ifonedgebounce`, `motion_movesteps`, `motion_pointindirection`, `motion_setrotationstyle`, `motion_setx`, `motion_sety`, `motion_turnleft`, `motion_turnright`, `motion_xposition`, `motion_yposition`, `operator_add`, `operator_and`, `operator_contains`, `operator_divide`, `operator_equals`, `operator_gt`, `operator_join`, `operator_length`, `operator_letter_of`, `operator_lt`, `operator_mathop`, `operator_mod`, `operator_multiply`, `operator_not`, `operator_or`, `operator_random`, `operator_round`, `operator_subtract`, `pen_changePenColorParamBy`, `pen_changePenHueBy`, `pen_changePenShadeBy`, `pen_changePenSizeBy`, `pen_clear`, `pen_penDown`, `pen_penUp`, `pen_setPenColorParamTo`, `pen_setPenColorToColor`, `pen_setPenHueToNumber`, `pen_setPenShadeToNumber`, `pen_setPenSizeTo`, `pen_stamp`, `procedures_call`, `procedures_return`, `sensing_answer`, `sensing_coloristouchingcolor`, `sensing_current`, `sensing_dayssince2000`, `sensing_distanceto`, `sensing_keypressed`, `sensing_mousedown`, `sensing_mousex`, `sensing_mousey`, `sensing_of`, `sensing_resettimer`, `sensing_timer`, `sensing_touchingcolor`, `sensing_touchingobject`, `sensing_username`, `sound_sounds_menu`, `tw_getLastKeyPressed`

### Compatibility input entries (6)

`motion_xscroll`, `motion_yscroll`, `sensing_loud`, `sensing_loudness`, `sensing_userid`, `sound_volume`

### Compatibility stack entries (25)

`looks_changestretchby`, `looks_hideallsprites`, `looks_say`, `looks_sayforsecs`, `looks_setstretchto`, `looks_switchbackdroptoandwait`, `looks_think`, `looks_thinkforsecs`, `motion_align_scene`, `motion_glidesecstoxy`, `motion_glideto`, `motion_goto`, `motion_pointtowards`, `motion_scroll_right`, `motion_scroll_up`, `sensing_askandwait`, `sensing_setdragmode`, `sound_changeeffectby`, `sound_changevolumeby`, `sound_cleareffects`, `sound_play`, `sound_playuntildone`, `sound_seteffectto`, `sound_setvolumeto`, `sound_stopallsounds`

### Compatibility/direct overlap (2)

`looks_say`, `looks_think`

### Explicit decoder source mentions (131)

`argument_reporter_boolean`, `argument_reporter_string_number`, `control_clear_counter`, `control_create_clone_of`, `control_delete_this_clone`, `control_for_each`, `control_forever`, `control_get_counter`, `control_if`, `control_if_else`, `control_incr_counter`, `control_repeat`, `control_repeat_until`, `control_stop`, `control_wait`, `control_wait_until`, `control_while`, `data_addtolist`, `data_deletealloflist`, `data_deleteoflist`, `data_hidelist`, `data_hidevariable`, `data_insertatlist`, `data_itemnumoflist`, `data_itemoflist`, `data_lengthoflist`, `data_listcontainsitem`, `data_listcontents`, `data_replaceitemoflist`, `data_setvariableto`, `data_showlist`, `data_showvariable`, `data_variable`, `event_broadcast`, `event_broadcastandwait`, `event_whenbroadcastreceived`, `event_whengreaterthan`, `event_whentouchingobject`, `looks_backdropnumbername`, `looks_changeeffectby`, `looks_changesizeby`, `looks_cleargraphiceffects`, `looks_costumenumbername`, `looks_goforwardbackwardlayers`, `looks_gotofrontback`, `looks_hide`, `looks_nextbackdrop`, `looks_nextcostume`, `looks_say`, `looks_seteffectto`, `looks_setsizeto`, `looks_show`, `looks_size`, `looks_switchbackdropto`, `looks_switchcostumeto`, `looks_think`, `motion_changexby`, `motion_changeyby`, `motion_direction`, `motion_gotoxy`, `motion_ifonedgebounce`, `motion_movesteps`, `motion_pointindirection`, `motion_setrotationstyle`, `motion_setx`, `motion_sety`, `motion_turnleft`, `motion_turnright`, `motion_xposition`, `motion_xscroll`, `motion_yposition`, `motion_yscroll`, `music_getTempo`, `operator_add`, `operator_and`, `operator_contains`, `operator_divide`, `operator_equals`, `operator_gt`, `operator_join`, `operator_length`, `operator_letter_of`, `operator_lt`, `operator_mathop`, `operator_mod`, `operator_multiply`, `operator_not`, `operator_or`, `operator_random`, `operator_round`, `operator_subtract`, `pen_changePenColorParamBy`, `pen_changePenHueBy`, `pen_changePenShadeBy`, `pen_changePenSizeBy`, `pen_clear`, `pen_penDown`, `pen_penUp`, `pen_setPenColorParamTo`, `pen_setPenColorToColor`, `pen_setPenHueToNumber`, `pen_setPenShadeToNumber`, `pen_setPenSizeTo`, `pen_stamp`, `procedures_call`, `procedures_return`, `sensing_answer`, `sensing_coloristouchingcolor`, `sensing_current`, `sensing_dayssince2000`, `sensing_distanceto`, `sensing_keypressed`, `sensing_loud`, `sensing_loudness`, `sensing_mousedown`, `sensing_mousex`, `sensing_mousey`, `sensing_of`, `sensing_of_object_menu`, `sensing_resettimer`, `sensing_timer`, `sensing_touchingcolor`, `sensing_touchingobject`, `sensing_userid`, `sensing_username`, `sound_volume`, `translate_getTranslate`, `translate_getViewerLanguage`, `tw_getLastKeyPressed`, `videoSensing_videoOn`, `videoSensing_whenMotionGreaterThan`

### Metadata/procedure helper source mentions (separate) (11)

`argument_reporter_boolean`, `argument_reporter_string_number`, `control_start_as_clone`, `event_whenbackdropswitchesto`, `event_whenbroadcastreceived`, `event_whenflagclicked`, `event_whenkeypressed`, `event_whenstageclicked`, `event_whenthisspriteclicked`, `procedures_definition`, `procedures_prototype`

### Imported schema entries (199)

`argument_reporter_boolean`, `argument_reporter_string_number`, `colour_picker`, `control_all_at_once`, `control_clear_counter`, `control_create_clone_of`, `control_create_clone_of_menu`, `control_delete_this_clone`, `control_for_each`, `control_forever`, `control_get_counter`, `control_if`, `control_if_else`, `control_incr_counter`, `control_repeat`, `control_repeat_until`, `control_start_as_clone`, `control_stop`, `control_wait`, `control_wait_until`, `control_while`, `data_addtolist`, `data_changevariableby`, `data_deletealloflist`, `data_deleteoflist`, `data_hidelist`, `data_hidevariable`, `data_insertatlist`, `data_itemnumoflist`, `data_itemoflist`, `data_lengthoflist`, `data_listcontainsitem`, `data_listcontents`, `data_replaceitemoflist`, `data_setvariableto`, `data_showlist`, `data_showvariable`, `data_variable`, `event_broadcast`, `event_broadcast_menu`, `event_broadcastandwait`, `event_whenbackdropswitchesto`, `event_whenbroadcastreceived`, `event_whenflagclicked`, `event_whengreaterthan`, `event_whenkeypressed`, `event_whenstageclicked`, `event_whenthisspriteclicked`, `event_whentouchingobject`, `looks_backdropnumbername`, `looks_backdrops`, `looks_changeeffectby`, `looks_changesizeby`, `looks_changestretchby`, `looks_cleargraphiceffects`, `looks_costume`, `looks_costumenumbername`, `looks_goforwardbackwardlayers`, `looks_gotofrontback`, `looks_hide`, `looks_hideallsprites`, `looks_nextbackdrop`, `looks_nextcostume`, `looks_say`, `looks_sayforsecs`, `looks_seteffectto`, `looks_setsizeto`, `looks_setstretchto`, `looks_show`, `looks_size`, `looks_switchbackdropto`, `looks_switchbackdroptoandwait`, `looks_switchcostumeto`, `looks_think`, `looks_thinkforsecs`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `motion_align_scene`, `motion_changexby`, `motion_changeyby`, `motion_direction`, `motion_glidesecstoxy`, `motion_glideto`, `motion_glideto_menu`, `motion_goto`, `motion_goto_menu`, `motion_gotoxy`, `motion_ifonedgebounce`, `motion_movesteps`, `motion_pointindirection`, `motion_pointtowards`, `motion_pointtowards_menu`, `motion_scroll_right`, `motion_scroll_up`, `motion_setrotationstyle`, `motion_setx`, `motion_sety`, `motion_turnleft`, `motion_turnright`, `motion_xposition`, `motion_xscroll`, `motion_yposition`, `motion_yscroll`, `music_changeTempo`, `music_getTempo`, `music_menu_DRUM`, `music_menu_INSTRUMENT`, `music_midiPlayDrumForBeats`, `music_midiSetInstrument`, `music_playDrumForBeats`, `music_playNoteForBeats`, `music_restForBeats`, `music_setInstrument`, `music_setTempo`, `note`, `operator_add`, `operator_and`, `operator_contains`, `operator_divide`, `operator_equals`, `operator_gt`, `operator_join`, `operator_length`, `operator_letter_of`, `operator_lt`, `operator_mathop`, `operator_mod`, `operator_multiply`, `operator_not`, `operator_or`, `operator_random`, `operator_round`, `operator_subtract`, `pen_changePenColorParamBy`, `pen_changePenHueBy`, `pen_changePenShadeBy`, `pen_changePenSizeBy`, `pen_clear`, `pen_menu_colorParam`, `pen_penDown`, `pen_penUp`, `pen_setPenColorParamTo`, `pen_setPenColorToColor`, `pen_setPenHueToNumber`, `pen_setPenShadeToNumber`, `pen_setPenSizeTo`, `pen_stamp`, `sensing_answer`, `sensing_askandwait`, `sensing_coloristouchingcolor`, `sensing_current`, `sensing_dayssince2000`, `sensing_distanceto`, `sensing_distancetomenu`, `sensing_keyoptions`, `sensing_keypressed`, `sensing_loud`, `sensing_loudness`, `sensing_mousedown`, `sensing_mousex`, `sensing_mousey`, `sensing_of`, `sensing_of_object_menu`, `sensing_resettimer`, `sensing_setdragmode`, `sensing_timer`, `sensing_touchingcolor`, `sensing_touchingobject`, `sensing_touchingobjectmenu`, `sensing_userid`, `sensing_username`, `sound_beats_menu`, `sound_changeeffectby`, `sound_changevolumeby`, `sound_cleareffects`, `sound_effects_menu`, `sound_play`, `sound_playuntildone`, `sound_seteffectto`, `sound_setvolumeto`, `sound_sounds_menu`, `sound_stopallsounds`, `sound_volume`, `text`, `text2speech_menu_languages`, `text2speech_menu_voices`, `text2speech_setLanguage`, `text2speech_setVoice`, `text2speech_speakAndWait`, `videoSensing_menu_ATTRIBUTE`, `videoSensing_menu_SUBJECT`, `videoSensing_menu_VIDEO_STATE`, `videoSensing_setVideoTransparency`, `videoSensing_videoOn`, `videoSensing_videoToggle`, `videoSensing_whenMotionGreaterThan`

### Schema entries without decoder string mention (73)

`colour_picker`, `control_all_at_once`, `control_create_clone_of_menu`, `control_start_as_clone`, `data_changevariableby`, `event_broadcast_menu`, `event_whenbackdropswitchesto`, `event_whenflagclicked`, `event_whenkeypressed`, `event_whenstageclicked`, `event_whenthisspriteclicked`, `looks_backdrops`, `looks_changestretchby`, `looks_costume`, `looks_hideallsprites`, `looks_sayforsecs`, `looks_setstretchto`, `looks_switchbackdroptoandwait`, `looks_thinkforsecs`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `motion_align_scene`, `motion_glidesecstoxy`, `motion_glideto`, `motion_glideto_menu`, `motion_goto`, `motion_goto_menu`, `motion_pointtowards`, `motion_pointtowards_menu`, `motion_scroll_right`, `motion_scroll_up`, `music_changeTempo`, `music_menu_DRUM`, `music_menu_INSTRUMENT`, `music_midiPlayDrumForBeats`, `music_midiSetInstrument`, `music_playDrumForBeats`, `music_playNoteForBeats`, `music_restForBeats`, `music_setInstrument`, `music_setTempo`, `note`, `pen_menu_colorParam`, `sensing_askandwait`, `sensing_distancetomenu`, `sensing_keyoptions`, `sensing_setdragmode`, `sensing_touchingobjectmenu`, `sound_beats_menu`, `sound_changeeffectby`, `sound_changevolumeby`, `sound_cleareffects`, `sound_effects_menu`, `sound_play`, `sound_playuntildone`, `sound_seteffectto`, `sound_setvolumeto`, `sound_sounds_menu`, `sound_stopallsounds`, `text`, `text2speech_menu_languages`, `text2speech_menu_voices`, `text2speech_setLanguage`, `text2speech_setVoice`, `text2speech_speakAndWait`, `videoSensing_menu_ATTRIBUTE`, `videoSensing_menu_SUBJECT`, `videoSensing_menu_VIDEO_STATE`, `videoSensing_setVideoTransparency`, `videoSensing_videoToggle`

### Schema-only entries without decoder or metadata string mention (67)

`colour_picker`, `control_all_at_once`, `control_create_clone_of_menu`, `data_changevariableby`, `event_broadcast_menu`, `looks_backdrops`, `looks_changestretchby`, `looks_costume`, `looks_hideallsprites`, `looks_sayforsecs`, `looks_setstretchto`, `looks_switchbackdroptoandwait`, `looks_thinkforsecs`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `motion_align_scene`, `motion_glidesecstoxy`, `motion_glideto`, `motion_glideto_menu`, `motion_goto`, `motion_goto_menu`, `motion_pointtowards`, `motion_pointtowards_menu`, `motion_scroll_right`, `motion_scroll_up`, `music_changeTempo`, `music_menu_DRUM`, `music_menu_INSTRUMENT`, `music_midiPlayDrumForBeats`, `music_midiSetInstrument`, `music_playDrumForBeats`, `music_playNoteForBeats`, `music_restForBeats`, `music_setInstrument`, `music_setTempo`, `note`, `pen_menu_colorParam`, `sensing_askandwait`, `sensing_distancetomenu`, `sensing_keyoptions`, `sensing_setdragmode`, `sensing_touchingobjectmenu`, `sound_beats_menu`, `sound_changeeffectby`, `sound_changevolumeby`, `sound_cleareffects`, `sound_effects_menu`, `sound_play`, `sound_playuntildone`, `sound_seteffectto`, `sound_setvolumeto`, `sound_sounds_menu`, `sound_stopallsounds`, `text`, `text2speech_menu_languages`, `text2speech_menu_voices`, `text2speech_setLanguage`, `text2speech_setVoice`, `text2speech_speakAndWait`, `videoSensing_menu_ATTRIBUTE`, `videoSensing_menu_SUBJECT`, `videoSensing_menu_VIDEO_STATE`, `videoSensing_setVideoTransparency`, `videoSensing_videoToggle`

### Direct IR without decoder string mention (inventory gap, not an unsupported verdict) (10)

`colour_picker`, `control_all_at_once`, `data_changevariableby`, `event_broadcast_menu`, `math_angle`, `math_integer`, `math_number`, `math_positive_number`, `math_whole_number`, `sound_sounds_menu`

### Compatibility entries without schema (0)

(none)

### Decoder mentions without explicit test-source mention (51)

`argument_reporter_boolean`, `data_deletealloflist`, `data_deleteoflist`, `data_insertatlist`, `data_itemnumoflist`, `data_itemoflist`, `data_lengthoflist`, `data_replaceitemoflist`, `event_broadcastandwait`, `event_whenbroadcastreceived`, `looks_cleargraphiceffects`, `looks_goforwardbackwardlayers`, `looks_gotofrontback`, `looks_hide`, `looks_setsizeto`, `looks_size`, `looks_think`, `motion_changexby`, `motion_changeyby`, `motion_direction`, `motion_gotoxy`, `motion_ifonedgebounce`, `motion_pointindirection`, `motion_sety`, `motion_turnleft`, `motion_xposition`, `motion_xscroll`, `motion_yposition`, `motion_yscroll`, `operator_and`, `operator_divide`, `operator_length`, `operator_mod`, `operator_not`, `operator_or`, `operator_random`, `operator_round`, `operator_subtract`, `sensing_answer`, `sensing_loud`, `sensing_loudness`, `sensing_mousedown`, `sensing_mousex`, `sensing_mousey`, `sensing_resettimer`, `sensing_timer`, `sensing_touchingobject`, `sensing_userid`, `translate_getTranslate`, `translate_getViewerLanguage`, `tw_getLastKeyPressed`

## Procedures, warp, edge and runtime sources and gaps

### procedures

Source evidence: research/02engine/scratch-vm/src/compiler/irgen.js:1037 (getProcedureInfo (block)); research/02engine/scratch-vm/src/compiler/irgen.js:1548 (analyzeRecursion ()); research/02engine/scratch-vm/src/compiler/jsgen.js:734 (case InputOpcode.PROCEDURE_CALL:); research/02engine/scratch-vm/src/compiler/jsgen.js:1278 (case StackOpcode.PROCEDURE_RETURN:); factory/src/recovery-procedures.mjs:6 (collectProcedureSignatures); factory/src/recovery-procedures.mjs:31 (addProcedureDefinition); factory/src/recover-code.mjs:37 (额外W/Z变体的调度对应尚未验证)

- Argument names, IDs, defaults and original warp declaration are synthesized or unknown.
- Mixed W/Z variants and general recursion/scheduling equivalence are not verified.

### warp and scheduling

Source evidence: research/02engine/scratch-vm/src/compiler/irgen.js:1318 (analyzeLoop ()); research/02engine/scratch-vm/src/compiler/jsgen.js:982 (MAX_UNROLL_ITERATIONS); research/02engine/scratch-vm/src/compiler/jsgen.js:1412 (yieldLoop ()); research/02engine/scratch-vm/src/compiler/jsgen.js:1433 (yieldStuckOrNotWarp ()); factory/src/compiled-factory.mjs:380 (warp循环出现非warp调度); factory/src/compiled-factory.mjs:412 (warp等待调度尚未验证)

- Warp timers, unrolling, yielding, promises and timing need behavior tests per template and mode.
- The source inventories do not verify scheduler equivalence.

### edge and predicate hats

Source evidence: research/02engine/scratch-vm/src/compiler/irgen.js:1383 (walkHat (hatBlock)); research/02engine/scratch-vm/src/compiler/irgen.js:1401 (hatInfo.edgeActivated); research/02engine/scratch-vm/src/compiler/jsgen.js:891 (case StackOpcode.HAT_EDGE:); research/02engine/scratch-vm/src/compiler/jsgen.js:909 (case StackOpcode.HAT_PREDICATE:); factory/src/recovery-executable-hats.mjs:61 (export function decodeExecutableHat); factory/src/recovery-executable-hats.mjs:86 (edge state, activation, retirement, or yield); factory/src/recover-code.mjs:78 (executableHat)

- Executable-hat source/test inventory evidence does not verify production integration or runtime edge behavior.
- Metadata hat reconstruction and compile-only shape tests do not prove edge-state behavior.

### runtime and compatibility

Source evidence: research/02engine/scratch-vm/src/compiler/irgen.js:1259 (descendCompatLayerInput (block)); research/02engine/scratch-vm/src/compiler/irgen.js:1282 (descendCompatLayerStack (block)); research/02engine/scratch-vm/src/compiler/jsgen.js:1463 (generateCompatibilityLayerCall (node, setFlags, frameName = null)); research/02engine/scratch-vm/src/compiler/jsexecute.js:150 (const executeInCompatibilityLayer = function*); research/02engine/scratch-vm/src/engine/runtime.js:2245 (getOpcodeFunction (opcode)); research/02engine/scratch-vm/src/engine/runtime.js:2599 (startHats (requestedHatOpcode); research/02engine/scratch-vm/src/engine/runtime.js:2915 (_step ()); research/02engine/scratch-vm/src/engine/sequencer.js:71 (stepThreads ()); research/02engine/scratch-vm/src/engine/sequencer.js:190 (stepThread (thread))

- Extension dispatch is dynamic and this finite opcode inventory cannot enumerate it.
- Schemas describe arguments, not native decoder implementations or verified runtime behavior.
- Compatibility reporters/branch frames and dynamic menu defaults lack general recovery support.
- Renderer, audio, pen raster output, cloud services and external devices require separate behavioral evidence.

### reporter and index boundaries

Source evidence: factory/src/compiled-factory.mjs:332 (02列表内容helper与解释器数字项拼接语义不同); factory/src/compiled-factory.mjs:333 (02列表索引helper与解释器混合数字/字符串相等语义不同); factory/src/compiled-factory.mjs:366 (动态列表索引的int32转换与解释器floor差异尚未证明); factory/src/compiled-factory.mjs:235 (列表折叠索引缺少有限非负整数证明); factory/src/recovery-reporters.mjs:162 (Letter index requires a finite literal integer); factory/src/recovery-reporters.mjs:118 (Touching-color recovery requires a literal)

- A source-mentioned opcode may still be rejected for some or all argument/template variants.
- General list contents/index equality, dynamic indices, SENSING_OF aliases and dynamic colors are not proved.

## Test inventory (not executed)

Names below are read from the current test files. Template names denote generated families, not individual executed cases. Compiler/runtime helper call presence is a syntactic clue, not a verified result; helpers or other runtime APIs may also be used.

### factory/test/compiled-recursive-safety.test.mjs

sourceSha256: `6b5cc54e90f896d4719628659f9ea240a0c1620f27094c978dae6813472c2283`

- Line 32: `${label}不冒充可编辑等价恢复` (generated name template)
- Line 44: 布尔值赋值可用真实布尔reporter表达，保持类型而非数字shadow

### factory/test/compiled-recursive.test.mjs

sourceSha256: `8b00301b99564b7a9c7ef0017d998a48082bde10a5a20fe771108603590ce754`

- Line 24: 嵌套条件与repeat恢复为连接完整的C形积木并保留变量作用域
- Line 36: repeat-until及列表内联修改恢复，monitor语句不变成假积木
- Line 45: 等待条件与运动外观原语恢复，显示后bubble同步必须成对
- Line 53: 含未知嵌套语句时事务性拒绝整段，不能生成已知前缀
- Line 60: 非法循环跳转和孤立yield不能被当作调度语句丢弃
- Line 68: 额外事件帽子从元数据恢复，背景拼写来自原定义

### factory/test/compiler-source.test.mjs

sourceSha256: `d4db0982f2206184d6029a40712102b42e774fc21c8ae6d7e5151b0989163436`

- Line 33: actual02 jsgen source emits variable/broadcast grammar accepted by recovery (IR/runtime doubles, not full compiler verification)

### factory/test/fidelity-boundaries.test.mjs

sourceSha256: `1f3e96e2e73a3a5c924557c0aadc1514f190aebe6fe1613a5ba766ab24073caa`

- Line 10: 编译包漏角色、重复对应和残缺清单不能声明完整恢复
- Line 26: 无ID唯一广播名称回退的低分必须传递到脚本体和生成积木
- Line 36: stage变量ID与本地定义冲突时，不用同名变量偷换全局引用
- Line 44: 负零不通过当前常数模板假称精确保真

### factory/test/real-02-recovery.test.mjs

sourceSha256: `16e944134268a43b99220774e71c0b81b114b08a9ee93debc718024979ddb016`

- Line 11: 真实02嵌套循环/条件/列表/广播恢复后重编译，预编译执行状态一致
- Line 39: 真实02 VM编译导出、预编译重载和执行状态可复现
- Line 55: 真实02编译bundle进入静态恢复，变量引用和运动积木结构有效

### factory/test/recovered-blocks.test.mjs

sourceSha256: `46c72bb7028a38eef4b0720c2a871e67b37f3d717774924c2f33f49987ba22ee`

- Line 93: nested stacks and reporters form one graph with deterministic keys and source records
- Line 141: literal primitives preserve type and reference primitives preserve exact names and IDs
- Line 157: explicit menu shadows attach to command and reporter inputs, with or without actual expressions
- Line 187: reporters marked shadow use shadow input encoding and mutations are detached from IR
- Line 205: empty substacks are omitted and do not consume IDs or records
- Line 215: empty operations return null endpoints without changing parent or calling callbacks
- Line 225: identical IR emits identical graphs, records, and ID keys; shared reporter nodes are emitted per input
- Line 239: unknown or ambiguous expressions reject a valid prefix transactionally
- Line 255: NaN, infinities, and negative zero reject inside deeply nested reporters
- Line 266: invalid opcodes in commands, reporters, or menu shadows reject the whole graph
- Line 279: malformed fields, mutation, shadow flags, substacks, and cyclic IR reject transactionally
- Line 301: duplicate and preexisting command, reporter, and shadow IDs reject without recording a prefix
- Line 323: an existing parent is required and an occupied next link is preserved
- Line 334: nonwritable parent or nonextensible block maps reject before graph insertion
- Line 344: a synchronous record callback failure rolls back target insertions and parent linkage
- Line 359: prototype-like block IDs and input keys are preserved as ordinary own properties
- Line 374: nested stack/reporter graph and menu shadows pass the SB3 validator with a minimal fixture

### factory/test/recovery-compatibility-integration.test.mjs

sourceSha256: `3ce99fac50d32487a57893fac976960ca8fb37b56c4457db7bec7613583b318b`

- Line 12: 动态兼容菜单保留变量连接，缺失shadow默认值明确标为合成
- Line 24: 声音兼容指令与reporter经真实VM编译恢复再编译，volume状态一致

### factory/test/recovery-control-extra.test.mjs

sourceSha256: `e12c54dc399d1146a922654af7e928a426e8debe55ec60f9b01be08c76e30b54`

- Line 17: `${name}严格原生组恢复并由真实VM重新编译` (generated name template)
- Line 30: 真实02 while迭代恢复后重编译，最终变量值保持

### factory/test/recovery-executable-hats.test.mjs

sourceSha256: `927d56478a8b753c8f0b10ad3fa00ca50532d6a6d8a07785d20aba26dc5096a4`

- Line 41: `original compiler edge group (${wrapped ? 'ADVANCED boolean cast' : 'direct compatibility result'}) consumes one outer statement` (generated name template)
- Line 48: `original compiler predicate group (${wrapped ? 'ADVANCED boolean cast' : 'direct compatibility result'}) consumes exactly if/yield` (generated name template)
- Line 57: video motion uses the static REFERENCE input schema and no invented fields
- Line 63: touching menu descriptors are adapted into independent field-bearing shadows
- Line 121: `reject corrupt edge companion before reporter: ${label}` (generated name template)
- Line 148: `reject corrupt predicate group before reporter: ${label}` (generated name template)
- Line 183: `reject incompatible condition before reporter: ${label}` (generated name template)
- Line 199: `static compatibility argument schema rejects before reporter: ${args}` (generated name template)
- Line 206: edge local bindings cannot act as opcode aliases or input reporters, even with a permissive callback
- Line 221: optional input calls/access cannot slip through a permissive reporter
- Line 231: opcode and script metadata are mandatory and matching; unknown/static nonexecutable opcodes fail closed
- Line 240: menu input reporter values require recoverable literal shadows
- Line 247: reporter input policy propagates errors and receives only input AST nodes, without executing source
- Line 279: trusted actual VM compile-only shapes: greater-than, video motion, and touching are complete edge groups

### factory/test/recovery-integrated-safety.test.mjs

sourceSha256: `b05bfd2bff51a819da73bd42d0a0ecb51325def5e728b0c3ea36d4061cc39c9d`

- Line 11: 嵌套空字符串过程返回不丢弃，恢复后真实VM执行不进入后续赋值
- Line 22: 具名函数p00不能冒充实际参数p0，整过程保留未恢复原因
- Line 30: 被拒绝的W变体不能通过已恢复Z签名继续被调用
- Line 41: 非事件锚点碰撞不删除之前已恢复的真实事件帽子

### factory/test/recovery-native-commands.test.mjs

sourceSha256: `20dae1c6ea4014db57ba9a68120e094e2bf581b5d2a18899061b8ba45b32dbf4`

- Line 80: `native command shape: ${label}` (generated name template)
- Line 91: native shape coverage includes all 13 pen commands and 27 operation opcodes
- Line 97: all seven known lowercase effects and four pen parameters have exact field/menu names
- Line 114: stop-others field follows stage identity and preserves a continuing next block
- Line 122: costume/backdrop menu numeric and numeric-string literals retain distinct input types
- Line 135: monitor resolution preserves IDs even with duplicate names and special object keys
- Line 205: `reject malformed native shape: ${label}` (generated name template)
- Line 209: `native call validates arity and spread before reporter: ${label}` (generated name template)
- Line 239: `reject monitor object before reporter: ${source}` (generated name template)
- Line 246: monitor rejects unknown, foreign, kind-colliding, and scope-colliding IDs
- Line 265: monitor validates existing runtime metadata against original ID, kind, name, and scope
- Line 278: optional calls/access cannot impersonate unconditional helpers through permissive chain()
- Line 289: unknown commands and multi-statement patterns return null without decoding any input
- Line 302: hostile reporter input remains AST and rejection propagates without executing source
- Line 315: validated helper structure precedes reporter callbacks
- Line 469: actual 02 compile -> native decode -> SB3 -> recompile: state semantics without renderer
- Line 513: actual compiler pen clear/stamp recovery: shape only, no renderer behavioral proof
- Line 528: actual compiler numeric casts in effect and pen inputs use the production reporter parser

### factory/test/recovery-opcode-corpus.test.mjs

sourceSha256: `6bee2bb392a647146befcf4fd05f3953cffb9d1cdcb9595b0042937f60811596`

- Line 137: `actual opcode corpus / ${scenario.id} / compiler → deobfuscate → recovery evidence` (generated name template)
- Line 172: `actual opcode corpus / ${scenario.id} / ${scenario.id.startsWith('partial-') ? 'partial bodies stay absent and unexecuted' : 'real VM recompile → expected final state'}` (generated name template)
- Line 222: `actual opcode corpus / independent subcase / ${scenario.id}` (generated name template)
- Line 243: opcode corpus scope is ten behavioral fixtures plus two conservative partial fixtures
- Line 253: real corpus helper builds explicit bounded SB3 graphs with reciprocal parents and scope IDs

### factory/test/recovery-opcode-schema.test.mjs

sourceSha256: `39455fb5ab7040f5992f2c44422ae5234a9c19e5cf0278788fe756092f5686e4`

- Line 70: `compatibility arguments: ${opcode}` (generated name template)
- Line 81: menu metadata is fixed for both literal and expression inputs, with exact shadow field names
- Line 103: core operators, list fields, direct blocks and branch-free control schemas are available
- Line 123: all explicit schemas have distinct names, consistent menu definitions, and decode exact keys
- Line 139: string and numeric Literal fields are stringified, and quoted keys need no evaluation
- Line 145: inputs are delegated unchanged, including shorthand, negative numbers, and nonliteral menus
- Line 184: `rejects ${label} before decoding expressions` (generated name template)
- Line 194: `rejects non-string/numeric Literal field: ${source}` (generated name template)
- Line 205: `rejects unknown exact opcode: ${opcode}` (generated name template)
- Line 212: requires a Property array, a decoding callback, and AST values
- Line 225: validates every field before calling the input decoder regardless of property order
- Line 232: hostile input source stays AST and decoder rejection propagates without evaluation
- Line 244: schemas are immutable and each result owns its output and shadow descriptor objects
- Line 278: `schemas match static Scratch VM ${extensionId} getInfo definitions` (generated name template)
- Line 320: core menu opcode and field names match checked-in GUI definitions

### factory/test/recovery-procedures.test.mjs

sourceSha256: `572c1d104acd74ba8a63444e45487c5d1070b85406ce633cba5fe6ecca5f63fa`

- Line 11: 过程体和调用重建，原参数元数据丢失必须明确标为合成
- Line 26: reporter过程返回与调用恢复后由真实VM编译验证
- Line 43: warp-only过程重构保留执行模式，但原warp声明仍标为未知
- Line 54: 合成过程工程经过真实02编译，恢复后过程再编译与执行一致

### factory/test/recovery-reporters.test.mjs

sourceSha256: `de753e73990d9d224142059b27bde3087126588e6b22d74bce2cd33e01c81af3`

- Line 58: decodes exact date selectors and current-menu fields
- Line 72: decodes costume and backdrop number/name selectors
- Line 84: decodes case-insensitive contains only with symmetric explicit string casts
- Line 91: decodes letterOf only for finite integer indices in the compiler-safe bound
- Line 99: decodes logarithms and degree trig forms with a proven non-NaN numeric input
- Line 116: decodes key, username, distance and daysSince2000 helpers with exact arity
- Line 129: decodes only strict literal color inputs and preserves target/mask argument order
- Line 141: returns null for unknown reporters without invoking recursive decoding
- Line 203: actual jsgen contains casts preserve case-insensitive Scratch behavior and numeric-string distinctions
- Line 217: actual jsgen letter literals match Scratch at safe boundaries; fractional and wrapped indices are preserved
- Line 233: actual jsgen math log and rounded degree trig match trusted primitives including NaN results
- Line 258: actual jsgen date selectors and daysSince2000 match Scratch under a frozen clock
- Line 273: actual jsgen key, username, distance and appearance reporters match trusted primitives
- Line 282: actual jsgen RGB constants and colorToList literal casts preserve renderer RGB and mask order
- Line 296: exact arity is checked before recursive callbacks in known reporter templates
- Line 311: optional AST calls and members cannot impersonate unconditional compiler helpers
- Line 325: raw scalar math, size and sensing_of target aliases remain owned or preserved
- Line 336: color byte validation rejects holes, spreads, coercions, objects and out-of-range channels
- Line 350: recursive inputs are reinvoked with the correct context and preserve AST provenance
- Line 369: hostile unknown input is never executed, and callback rejection propagates

### factory/test/recovery-sensing-of.test.mjs

sourceSha256: `6896ee8ebc26f206d808d88a9c19c94ec328ed0970aa38cb8287e0cb9c6d5465`

- Line 9: `真实02 sensing_of ${property}静态目标恢复，重编译运行结果一致` (generated name template)

### factory/test/recovery-wait.test.mjs

sourceSha256: `55f137452762467c0525a0acad38304f39d75b58d925265e68e446f8b13f5566`

- Line 11: 等待完整计时组恢复为一块，不误识别成repeat-until
- Line 20: 等待计时组任意缺失副作用或调度拒绝整段
- Line 31: 真实02等待0秒含至少一次yield，恢复重编译后变量最终状态一致

### factory/test/runtime-hook.test.mjs

sourceSha256: `f324400e5d61cadeda646a0215fdd6e15a72e9262324c470dfe806d0ca2de1d7`

- Line 17: PROJECT_LOADED同步保存初态，禁止autoplay修改变量和广播
- Line 38: fallback资产未settle不可ready；私有上下文无vm也不可ready
- Line 51: 序列化异常只记录错误，不能制造有效snapshot

## Per-opcode inventory

IR I/S = direct input/stack cases. Compat I/S = declared compatibility input/stack entries. Decoder/metadata/test flags indicate source mentions only. Semantic verification remains false for every row.

| Opcode | IR I/S | Compat I/S | Schema | Decoder mention | Metadata mention | Test source mention | Tested |
| --- | --- | --- | --- | --- | --- | --- | --- |
| argument_reporter_boolean | 1/0 | 0/0 | true | true | true | false | unknown |
| argument_reporter_string_number | 1/0 | 0/0 | true | true | true | true | unknown |
| colour_picker | 1/0 | 0/0 | true | false | false | false | unknown |
| control_all_at_once | 0/1 | 0/0 | true | false | false | false | unknown |
| control_clear_counter | 0/1 | 0/0 | true | true | false | true | unknown |
| control_create_clone_of | 0/1 | 0/0 | true | true | false | true | unknown |
| control_create_clone_of_menu | 0/0 | 0/0 | true | false | false | true | unknown |
| control_delete_this_clone | 0/1 | 0/0 | true | true | false | true | unknown |
| control_for_each | 0/1 | 0/0 | true | true | false | true | unknown |
| control_forever | 0/1 | 0/0 | true | true | false | true | unknown |
| control_get_counter | 1/0 | 0/0 | true | true | false | true | unknown |
| control_if | 0/1 | 0/0 | true | true | false | true | unknown |
| control_if_else | 0/1 | 0/0 | true | true | false | true | unknown |
| control_incr_counter | 0/1 | 0/0 | true | true | false | true | unknown |
| control_repeat | 0/1 | 0/0 | true | true | false | true | unknown |
| control_repeat_until | 0/1 | 0/0 | true | true | false | true | unknown |
| control_start_as_clone | 0/0 | 0/0 | true | false | true | true | unknown |
| control_stop | 0/1 | 0/0 | true | true | false | true | unknown |
| control_wait | 0/1 | 0/0 | true | true | false | true | unknown |
| control_wait_until | 0/1 | 0/0 | true | true | false | true | unknown |
| control_while | 0/1 | 0/0 | true | true | false | true | unknown |
| data_addtolist | 0/1 | 0/0 | true | true | false | true | unknown |
| data_changevariableby | 0/1 | 0/0 | true | false | false | true | unknown |
| data_deletealloflist | 0/1 | 0/0 | true | true | false | false | unknown |
| data_deleteoflist | 0/1 | 0/0 | true | true | false | false | unknown |
| data_hidelist | 0/1 | 0/0 | true | true | false | true | unknown |
| data_hidevariable | 0/1 | 0/0 | true | true | false | true | unknown |
| data_insertatlist | 0/1 | 0/0 | true | true | false | false | unknown |
| data_itemnumoflist | 1/0 | 0/0 | true | true | false | false | unknown |
| data_itemoflist | 1/0 | 0/0 | true | true | false | false | unknown |
| data_lengthoflist | 1/0 | 0/0 | true | true | false | false | unknown |
| data_listcontainsitem | 1/0 | 0/0 | true | true | false | true | unknown |
| data_listcontents | 1/0 | 0/0 | true | true | false | true | unknown |
| data_replaceitemoflist | 0/1 | 0/0 | true | true | false | false | unknown |
| data_setvariableto | 0/1 | 0/0 | true | true | false | true | unknown |
| data_showlist | 0/1 | 0/0 | true | true | false | true | unknown |
| data_showvariable | 0/1 | 0/0 | true | true | false | true | unknown |
| data_variable | 1/0 | 0/0 | true | true | false | true | unknown |
| event_broadcast | 0/1 | 0/0 | true | true | false | true | unknown |
| event_broadcast_menu | 1/0 | 0/0 | true | false | false | true | unknown |
| event_broadcastandwait | 0/1 | 0/0 | true | true | false | false | unknown |
| event_whenbackdropswitchesto | 0/0 | 0/0 | true | false | true | true | unknown |
| event_whenbroadcastreceived | 0/0 | 0/0 | true | true | true | false | unknown |
| event_whenflagclicked | 0/0 | 0/0 | true | false | true | true | unknown |
| event_whengreaterthan | 0/0 | 0/0 | true | true | false | true | unknown |
| event_whenkeypressed | 0/0 | 0/0 | true | false | true | true | unknown |
| event_whenstageclicked | 0/0 | 0/0 | true | false | true | false | unknown |
| event_whenthisspriteclicked | 0/0 | 0/0 | true | false | true | true | unknown |
| event_whentouchingobject | 0/0 | 0/0 | true | true | false | true | unknown |
| looks_backdropnumbername | 1/0 | 0/0 | true | true | false | true | unknown |
| looks_backdrops | 0/0 | 0/0 | true | false | false | true | unknown |
| looks_changeeffectby | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_changesizeby | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_changestretchby | 0/0 | 0/1 | true | false | false | false | unknown |
| looks_cleargraphiceffects | 0/1 | 0/0 | true | true | false | false | unknown |
| looks_costume | 0/0 | 0/0 | true | false | false | true | unknown |
| looks_costumenumbername | 1/0 | 0/0 | true | true | false | true | unknown |
| looks_goforwardbackwardlayers | 0/1 | 0/0 | true | true | false | false | unknown |
| looks_gotofrontback | 0/1 | 0/0 | true | true | false | false | unknown |
| looks_hide | 0/1 | 0/0 | true | true | false | false | unknown |
| looks_hideallsprites | 0/0 | 0/1 | true | false | false | false | unknown |
| looks_nextbackdrop | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_nextcostume | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_say | 0/1 | 0/1 | true | true | false | true | unknown |
| looks_sayforsecs | 0/0 | 0/1 | true | false | false | true | unknown |
| looks_seteffectto | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_setsizeto | 0/1 | 0/0 | true | true | false | false | unknown |
| looks_setstretchto | 0/0 | 0/1 | true | false | false | false | unknown |
| looks_show | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_size | 1/0 | 0/0 | true | true | false | false | unknown |
| looks_switchbackdropto | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_switchbackdroptoandwait | 0/0 | 0/1 | true | false | false | true | unknown |
| looks_switchcostumeto | 0/1 | 0/0 | true | true | false | true | unknown |
| looks_think | 0/1 | 0/1 | true | true | false | false | unknown |
| looks_thinkforsecs | 0/0 | 0/1 | true | false | false | true | unknown |
| math_angle | 1/0 | 0/0 | true | false | false | false | unknown |
| math_integer | 1/0 | 0/0 | true | false | false | false | unknown |
| math_number | 1/0 | 0/0 | true | false | false | false | unknown |
| math_positive_number | 1/0 | 0/0 | true | false | false | false | unknown |
| math_whole_number | 1/0 | 0/0 | true | false | false | false | unknown |
| motion_align_scene | 0/0 | 0/1 | true | false | false | false | unknown |
| motion_changexby | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_changeyby | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_direction | 1/0 | 0/0 | true | true | false | false | unknown |
| motion_glidesecstoxy | 0/0 | 0/1 | true | false | false | true | unknown |
| motion_glideto | 0/0 | 0/1 | true | false | false | true | unknown |
| motion_glideto_menu | 0/0 | 0/0 | true | false | false | true | unknown |
| motion_goto | 0/0 | 0/1 | true | false | false | true | unknown |
| motion_goto_menu | 0/0 | 0/0 | true | false | false | true | unknown |
| motion_gotoxy | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_ifonedgebounce | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_movesteps | 0/1 | 0/0 | true | true | false | true | unknown |
| motion_pointindirection | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_pointtowards | 0/0 | 0/1 | true | false | false | true | unknown |
| motion_pointtowards_menu | 0/0 | 0/0 | true | false | false | true | unknown |
| motion_scroll_right | 0/0 | 0/1 | true | false | false | false | unknown |
| motion_scroll_up | 0/0 | 0/1 | true | false | false | false | unknown |
| motion_setrotationstyle | 0/1 | 0/0 | true | true | false | true | unknown |
| motion_setx | 0/1 | 0/0 | true | true | false | true | unknown |
| motion_sety | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_turnleft | 0/1 | 0/0 | true | true | false | false | unknown |
| motion_turnright | 0/1 | 0/0 | true | true | false | true | unknown |
| motion_xposition | 1/0 | 0/0 | true | true | false | false | unknown |
| motion_xscroll | 0/0 | 1/0 | true | true | false | false | unknown |
| motion_yposition | 1/0 | 0/0 | true | true | false | false | unknown |
| motion_yscroll | 0/0 | 1/0 | true | true | false | false | unknown |
| music_changeTempo | 0/0 | 0/0 | true | false | false | true | unknown |
| music_getTempo | 0/0 | 0/0 | true | true | false | true | unknown |
| music_menu_DRUM | 0/0 | 0/0 | true | false | false | false | unknown |
| music_menu_INSTRUMENT | 0/0 | 0/0 | true | false | false | true | unknown |
| music_midiPlayDrumForBeats | 0/0 | 0/0 | true | false | false | true | unknown |
| music_midiSetInstrument | 0/0 | 0/0 | true | false | false | true | unknown |
| music_playDrumForBeats | 0/0 | 0/0 | true | false | false | true | unknown |
| music_playNoteForBeats | 0/0 | 0/0 | true | false | false | true | unknown |
| music_restForBeats | 0/0 | 0/0 | true | false | false | true | unknown |
| music_setInstrument | 0/0 | 0/0 | true | false | false | true | unknown |
| music_setTempo | 0/0 | 0/0 | true | false | false | true | unknown |
| note | 0/0 | 0/0 | true | false | false | false | unknown |
| operator_add | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_and | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_contains | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_divide | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_equals | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_gt | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_join | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_length | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_letter_of | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_lt | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_mathop | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_mod | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_multiply | 1/0 | 0/0 | true | true | false | true | unknown |
| operator_not | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_or | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_random | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_round | 1/0 | 0/0 | true | true | false | false | unknown |
| operator_subtract | 1/0 | 0/0 | true | true | false | false | unknown |
| pen_changePenColorParamBy | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_changePenHueBy | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_changePenShadeBy | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_changePenSizeBy | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_clear | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_menu_colorParam | 0/0 | 0/0 | true | false | false | true | unknown |
| pen_penDown | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_penUp | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_setPenColorParamTo | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_setPenColorToColor | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_setPenHueToNumber | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_setPenShadeToNumber | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_setPenSizeTo | 0/1 | 0/0 | true | true | false | true | unknown |
| pen_stamp | 0/1 | 0/0 | true | true | false | true | unknown |
| procedures_call | 1/1 | 0/0 | false | true | false | true | unknown |
| procedures_definition | 0/0 | 0/0 | false | false | true | true | unknown |
| procedures_prototype | 0/0 | 0/0 | false | false | true | true | unknown |
| procedures_return | 0/1 | 0/0 | false | true | false | true | unknown |
| sensing_answer | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_askandwait | 0/0 | 0/1 | true | false | false | true | unknown |
| sensing_coloristouchingcolor | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_current | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_dayssince2000 | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_distanceto | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_distancetomenu | 0/0 | 0/0 | true | false | false | true | unknown |
| sensing_keyoptions | 0/0 | 0/0 | true | false | false | false | unknown |
| sensing_keypressed | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_loud | 0/0 | 1/0 | true | true | false | false | unknown |
| sensing_loudness | 0/0 | 1/0 | true | true | false | false | unknown |
| sensing_mousedown | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_mousex | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_mousey | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_of | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_of_object_menu | 0/0 | 0/0 | true | true | false | true | unknown |
| sensing_resettimer | 0/1 | 0/0 | true | true | false | false | unknown |
| sensing_setdragmode | 0/0 | 0/1 | true | false | false | false | unknown |
| sensing_timer | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_touchingcolor | 1/0 | 0/0 | true | true | false | true | unknown |
| sensing_touchingobject | 1/0 | 0/0 | true | true | false | false | unknown |
| sensing_touchingobjectmenu | 0/0 | 0/0 | true | false | false | true | unknown |
| sensing_userid | 0/0 | 1/0 | true | true | false | false | unknown |
| sensing_username | 1/0 | 0/0 | true | true | false | true | unknown |
| sound_beats_menu | 0/0 | 0/0 | true | false | false | false | unknown |
| sound_changeeffectby | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_changevolumeby | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_cleareffects | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_effects_menu | 0/0 | 0/0 | true | false | false | false | unknown |
| sound_play | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_playuntildone | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_seteffectto | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_setvolumeto | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_sounds_menu | 1/0 | 0/0 | true | false | false | true | unknown |
| sound_stopallsounds | 0/0 | 0/1 | true | false | false | true | unknown |
| sound_volume | 0/0 | 1/0 | true | true | false | true | unknown |
| text | 0/0 | 0/0 | true | false | false | false | unknown |
| text2speech_menu_languages | 0/0 | 0/0 | true | false | false | true | unknown |
| text2speech_menu_voices | 0/0 | 0/0 | true | false | false | true | unknown |
| text2speech_setLanguage | 0/0 | 0/0 | true | false | false | true | unknown |
| text2speech_setVoice | 0/0 | 0/0 | true | false | false | true | unknown |
| text2speech_speakAndWait | 0/0 | 0/0 | true | false | false | true | unknown |
| translate_getTranslate | 0/0 | 0/0 | false | true | false | false | unknown |
| translate_getViewerLanguage | 0/0 | 0/0 | false | true | false | false | unknown |
| tw_getLastKeyPressed | 1/0 | 0/0 | false | true | false | false | unknown |
| videoSensing_menu_ATTRIBUTE | 0/0 | 0/0 | true | false | false | false | unknown |
| videoSensing_menu_SUBJECT | 0/0 | 0/0 | true | false | false | false | unknown |
| videoSensing_menu_VIDEO_STATE | 0/0 | 0/0 | true | false | false | true | unknown |
| videoSensing_setVideoTransparency | 0/0 | 0/0 | true | false | false | true | unknown |
| videoSensing_videoOn | 0/0 | 0/0 | true | true | false | true | unknown |
| videoSensing_videoToggle | 0/0 | 0/0 | true | false | false | true | unknown |
| videoSensing_whenMotionGreaterThan | 0/0 | 0/0 | true | true | false | true | unknown |

Exact line evidence, IR enums/generator dispatch cases and full schema definitions are in coverage.json.

## Source provenance

| Source | SHA-256 |
| --- | --- |
| factory/src/compiled-factory.mjs | d45b2cda01604034bacd21005a41d9d7933853480f62bdc5a36b7cab5df52366 |
| factory/src/recover-code.mjs | a51ea1a9ad41e8e4696734f910876c6880395e56ec27ea8e26b21399c25790aa |
| factory/src/recovered-blocks.mjs | 6ecd277252eacb76bb9a5e6302b3892488f99799d8a6f8dc2e7ff0a561d783e2 |
| factory/src/recovery-executable-hats.mjs | c7440fdfac557d7b356141575f0fbcbdf1dcf37e0a89c76a66f1d95e1c6a696a |
| factory/src/recovery-native-commands.mjs | 0ed068a977c419e552b73b494f9bc06735e0130eee68b8302d3d14d59097772b |
| factory/src/recovery-opcode-schema.mjs | df07709170a043dcd4e9cb76c04552dffc48b8e3b4c880a5775eefb2c705f812 |
| factory/src/recovery-procedures.mjs | cca3ea08b188a76c5ac4ba275719bd946f16645292a3f2f3d5b796452d39cd02 |
| factory/src/recovery-reporters.mjs | c09d45c87405f51fef691314814bac0a083887b694931f2332c03196821ab102 |
| factory/src/recovery-symbols.mjs | 6050e10feb1748a9bb2e48563c0213c1bf8e68a3904636decc15c476aafdc9ae |
| factory/src/runtime-hook.mjs | 12081371ace519f198731e559c230053f791120ef3449e52e42ed504c0a4b129 |
| factory/test/audit-recovery-coverage.mjs | f210fa837155baab6e39d2d669e1dd8b34f4f5e8720ca6169c0d295f025cf620 |
| factory/test/compiled-fixtures.mjs | b1130bbd9233f2911a1d0befb8e2a86e904232d4eca55f31780cddbc7823735e |
| factory/test/compiled-recursive-safety.test.mjs | 6b5cc54e90f896d4719628659f9ea240a0c1620f27094c978dae6813472c2283 |
| factory/test/compiled-recursive.test.mjs | 8b00301b99564b7a9c7ef0017d998a48082bde10a5a20fe771108603590ce754 |
| factory/test/compiler-source.test.mjs | d4db0982f2206184d6029a40712102b42e774fc21c8ae6d7e5151b0989163436 |
| factory/test/fidelity-boundaries.test.mjs | 1f3e96e2e73a3a5c924557c0aadc1514f190aebe6fe1613a5ba766ab24073caa |
| factory/test/helpers.mjs | 6643cae5e055b23006925f939936e5d707a386449b1a1bde3772802ba897bdfc |
| factory/test/real-02-compiler.mjs | ff0531ba6c3c35693263cba88f3b7a6c0bdeb9ba6ad34421a4ab644f65b6063b |
| factory/test/real-02-recovery.test.mjs | 16e944134268a43b99220774e71c0b81b114b08a9ee93debc718024979ddb016 |
| factory/test/real-02-recursive.mjs | 891ae4a5e1ed880b8557bb9dd76f49764df2df1f47e66d4aecc1e69e531d6748 |
| factory/test/recovered-blocks.test.mjs | 46c72bb7028a38eef4b0720c2a871e67b37f3d717774924c2f33f49987ba22ee |
| factory/test/recovery-compatibility-integration.test.mjs | 3ce99fac50d32487a57893fac976960ca8fb37b56c4457db7bec7613583b318b |
| factory/test/recovery-control-extra.test.mjs | e12c54dc399d1146a922654af7e928a426e8debe55ec60f9b01be08c76e30b54 |
| factory/test/recovery-executable-hats.test.mjs | 927d56478a8b753c8f0b10ad3fa00ca50532d6a6d8a07785d20aba26dc5096a4 |
| factory/test/recovery-integrated-safety.test.mjs | b05bfd2bff51a819da73bd42d0a0ecb51325def5e728b0c3ea36d4061cc39c9d |
| factory/test/recovery-native-commands.test.mjs | 20dae1c6ea4014db57ba9a68120e094e2bf581b5d2a18899061b8ba45b32dbf4 |
| factory/test/recovery-opcode-corpus.test.mjs | 6bee2bb392a647146befcf4fd05f3953cffb9d1cdcb9595b0042937f60811596 |
| factory/test/recovery-opcode-schema.test.mjs | 39455fb5ab7040f5992f2c44422ae5234a9c19e5cf0278788fe756092f5686e4 |
| factory/test/recovery-procedures.test.mjs | 572c1d104acd74ba8a63444e45487c5d1070b85406ce633cba5fe6ecca5f63fa |
| factory/test/recovery-reporters.test.mjs | de753e73990d9d224142059b27bde3087126588e6b22d74bce2cd33e01c81af3 |
| factory/test/recovery-sensing-of.test.mjs | 6896ee8ebc26f206d808d88a9c19c94ec328ed0970aa38cb8287e0cb9c6d5465 |
| factory/test/recovery-wait.test.mjs | 55f137452762467c0525a0acad38304f39d75b58d925265e68e446f8b13f5566 |
| factory/test/runtime-hook.test.mjs | f324400e5d61cadeda646a0215fdd6e15a72e9262324c470dfe806d0ca2de1d7 |
| research/02engine/scratch-vm/src/compiler/compat-blocks.js | 0c3f41742adaee4b74ec56d0ab2450986b68fe1c992999c176dd3b15686737ec |
| research/02engine/scratch-vm/src/compiler/enums.js | 90f14fff8dda54d7d81b04da3d1ae9068ae31a178f031cdcbacbc95e46ef3458 |
| research/02engine/scratch-vm/src/compiler/irgen.js | 465c68bde3f83d75b1c53ae8bacaf3a751218e38153a410f63dd7e6db534eaa9 |
| research/02engine/scratch-vm/src/compiler/jsexecute.js | ee523267332d3d27a7061f0f7c5a54a055f0301ffceda417c0d02bf27d51518c |
| research/02engine/scratch-vm/src/compiler/jsgen.js | bd8c64fd4d28250e88666c73ca18eb7470292cdd7ce4e19138e6ef48c2369813 |
| research/02engine/scratch-vm/src/engine/runtime.js | 1c37ee3d12305575fe1247807e2828822b38b21c97244f8dc3d7b281f2ad06a3 |
| research/02engine/scratch-vm/src/engine/sequencer.js | 81aadce9b30dbe9bc1bf1e54324cd12dcba1f45b56f06577871dbacda54b58b3 |

