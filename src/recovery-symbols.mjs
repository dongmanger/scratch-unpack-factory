export const failRecovery = reason => { throw new Error(reason); };

export const scopedDefinition = (project, targetIndex, scope, kind, id) => {
  const index = scope === 'stage' ? project.targets.findIndex(target => target.isStage) : targetIndex;
  const value = project.targets[index]?.[kind]?.[id];
  if (!Array.isArray(value)) failRecovery(`${scope} 作用域中没有 ${kind} ID ${id}`);
  if (scope === 'stage' && index !== targetIndex &&
      (Object.hasOwn(project.targets[targetIndex].variables || {}, id) || Object.hasOwn(project.targets[targetIndex].lists || {}, id))) {
    failRecovery(`全局 ID ${id} 与本地定义冲突，SB3 引用无法无歧义表达原作用域`);
  }
  return {targetIndex: index, id, name: value[0], kind};
};

export const broadcastByLiteral = (project, name) => {
  const matches = project.targets.flatMap(target => Object.entries(target.broadcasts || {})).filter(([, value]) => value === name);
  if (matches.length !== 1) failRecovery(`发送广播 ${name} 无唯一原始 ID`);
  return {id: matches[0][0], name: matches[0][1]};
};

const fieldHats = new Map([
  ['event_whenflagclicked', []],
  ['event_whenbroadcastreceived', ['BROADCAST_OPTION']],
  ['event_whenkeypressed', ['KEY_OPTION']],
  ['event_whenthisspriteclicked', []],
  ['event_whenstageclicked', []],
  ['event_whenbackdropswitchesto', ['BACKDROP']],
  ['control_start_as_clone', []]
]);

export function decodeHat(project, metadata, targetIndex) {
  const required = fieldHats.get(metadata.opcode);
  if (!required) failRecovery(`事件帽子 ${metadata.opcode} 尚未支持或输入元数据缺失`);
  const target = project.targets[targetIndex];
  if ((metadata.opcode === 'event_whenstageclicked' && !target.isStage) ||
      (['event_whenthisspriteclicked', 'control_start_as_clone'].includes(metadata.opcode) && target.isStage)) {
    failRecovery('事件帽子与舞台/角色身份不一致');
  }
  const fields = {};
  let score = 0.98;
  for (const fieldName of required) {
    const field = metadata.fieldsOfInputs?.[fieldName];
    if (fieldName === 'BROADCAST_OPTION') {
      const entries = project.targets.flatMap(item => Object.entries(item.broadcasts || {}).map(([id, name]) => ({id, name})));
      const matches = typeof field?.id === 'string' ? entries.filter(item => item.id === field.id) :
        typeof field?.value === 'string' ? entries.filter(item => item.name.toUpperCase() === field.value.toUpperCase()) : [];
      if (matches.length !== 1) failRecovery(`广播 ${field?.id || field?.value || ''} 缺失或不唯一，不能猜测 ID/大小写`);
      fields[fieldName] = [matches[0].name, matches[0].id];
      if (typeof field?.id !== 'string') score = 0.65;
    } else {
      if (typeof field?.value !== 'string') failRecovery(`事件帽子缺少 ${fieldName} 元数据`);
      let value = field.value;
      if (fieldName === 'BACKDROP') {
        const stage = project.targets.find(item => item.isStage);
        const matches = (stage.costumes || []).filter(costume => costume.name.toUpperCase() === value.toUpperCase());
        if (matches.length !== 1) failRecovery(`背景名称 ${value} 缺失或大小写对应不唯一`);
        value = matches[0].name;
      } else if (fieldName === 'KEY_OPTION') {
        const normalized = value.toLowerCase();
        if (!['space', 'up arrow', 'down arrow', 'left arrow', 'right arrow', 'any'].includes(normalized) &&
            !/^[a-z0-9]$/.test(normalized)) failRecovery(`按键 ${value} 不在支持的事件帽子模板内`);
        value = normalized;
      }
      fields[fieldName] = [value, null];
    }
  }
  return {opcode: metadata.opcode, fields, score};
}
