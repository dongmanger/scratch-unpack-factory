import {makeMinimalSb3} from './helpers.mjs';

export async function recursiveRealFixture() {
  const fixture = await makeMinimalSb3();
  const {project} = fixture;
  const stage = project.targets[0];
  const sprite = project.targets[1];
  stage.variables = {varId1: ['分数', 0], limit: ['次数', 3]};
  stage.lists = {items: ['项目', []]};
  stage.broadcasts = {ready: '开始游戏'};
  sprite.variables = {localScore: ['分数', 0]};
  const b = (opcode, parent, next, fields = {}, inputs = {}, topLevel = false) => ({opcode, parent, next, fields, inputs,
    shadow: false, topLevel, ...(topLevel ? {x: 20, y: 20} : {})});
  stage.blocks = {
    a: b('event_whenflagclicked', null, 'set', {}, {}, true),
    set: b('data_setvariableto', 'a', 'repeat', {VARIABLE: ['分数', 'varId1']}, {VALUE: [1, [4, '1']]}),
    repeat: b('control_repeat', 'set', 'condition', {}, {TIMES: [3, [12, '次数', 'limit'], [4, '3']], SUBSTACK: [2, 'change']}),
    change: b('data_changevariableby', 'repeat', 'append', {VARIABLE: ['分数', 'varId1']}, {VALUE: [1, [4, '2']]}),
    append: b('data_addtolist', 'change', null, {LIST: ['项目', 'items']}, {ITEM: [3, [12, '分数', 'varId1'], [10, '']]}),
    condition: b('control_if_else', 'repeat', 'send', {}, {CONDITION: [2, 'compare'], SUBSTACK: [2, 'success'], SUBSTACK2: [2, 'failure']}),
    compare: b('operator_gt', 'condition', null, {}, {OPERAND1: [3, [12, '分数', 'varId1'], [10, '']], OPERAND2: [1, [10, '5']]}),
    success: b('data_setvariableto', 'condition', null, {VARIABLE: ['分数', 'varId1']}, {VALUE: [1, [10, '成功']]}),
    failure: b('data_setvariableto', 'condition', null, {VARIABLE: ['分数', 'varId1']}, {VALUE: [1, [10, '失败']]}),
    send: b('event_broadcast', 'condition', null, {}, {BROADCAST_INPUT: [1, [11, '开始游戏', 'ready']]})
  };
  sprite.blocks = {
    c: b('event_whenbroadcastreceived', null, 'move', {BROADCAST_OPTION: ['开始游戏', 'ready']}, {}, true),
    move: b('motion_movesteps', 'c', 'turn', {}, {STEPS: [1, [4, '10']]}),
    turn: b('motion_turnright', 'move', 'size', {}, {DEGREES: [1, [4, '15']]}),
    size: b('looks_changesizeby', 'turn', 'copy', {}, {CHANGE: [1, [4, '5']]}),
    copy: b('data_setvariableto', 'size', null, {VARIABLE: ['分数', 'localScore']}, {VALUE: [3, [12, '分数', 'varId1'], [10, '']]})
  };
  return fixture;
}
