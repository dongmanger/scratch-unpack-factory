const menuDefaults = {
  motion_goto_menu: '_random_', motion_glideto_menu: '_random_', motion_pointtowards_menu: '_mouse_',
  sensing_touchingobjectmenu: '_mouse_', sensing_distancetomenu: '_mouse_', sensing_keyoptions: 'space',
  sensing_of_object_menu: '_stage_', control_create_clone_of_menu: '_myself_',
  pen_menu_colorParam: 'color', music_menu_DRUM: '1', music_menu_INSTRUMENT: '1',
  text2speech_menu_voices: 'ALTO', text2speech_menu_languages: 'en',
  videoSensing_menu_ATTRIBUTE: 'motion', videoSensing_menu_SUBJECT: 'this sprite', videoSensing_menu_VIDEO_STATE: 'on'
};

/** A connected reporter determines runtime behavior; its missing inactive menu default is synthetic metadata. */
export function populateRecoveredMenus(operation, project, targetIndex, recordSynthetic = () => {}) {
  const target = project.targets[targetIndex];
  const stage = project.targets.find(item => item.isStage);
  for (const [inputName, menu] of Object.entries(operation.shadowInputs || {})) {
    if (menu.fields) continue;
    const input = operation.inputs[inputName];
    if (!input || !menu.field || !menu.opcode) throw new Error(`菜单 ${inputName} 结构不完整`);
    let value;
    if (Object.hasOwn(input, 'literal')) value = String(input.literal);
    else {
      value = menu.opcode === 'looks_costume' ? target.costumes?.[0]?.name || '' :
        menu.opcode === 'looks_backdrops' ? stage.costumes?.[0]?.name || '' :
        menu.opcode === 'sound_sounds_menu' ? target.sounds?.[0]?.name || '' : menuDefaults[menu.opcode];
      if (value === undefined) throw new Error(`菜单 ${menu.opcode} 尚无已知合成默认值`);
      recordSynthetic({inputName, opcode: menu.opcode, field: menu.field, value,
        reason: 'original-inactive-menu-shadow-not-exported'});
    }
    menu.fields = {[menu.field]: [value, null]};
    delete menu.field;
  }
  return operation;
}
