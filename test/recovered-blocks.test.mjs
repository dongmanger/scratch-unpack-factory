import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRecoveredStack } from '../src/recovered-blocks.mjs';
import { validateSb3 } from '../src/sb3-validate.mjs';
import { makeMinimalSb3, JSZip } from './helpers.mjs';

const block = (opcode, extra = {}) => ({
  opcode, next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false, ...extra
});
const makeTarget = () => ({
  name: 'Stage', isStage: true,
  variables: { scoreId: ['score', 0] }, lists: { itemsId: ['items', []] }, broadcasts: { readyId: 'Ready' },
  blocks: {
    hat: block('event_whenflagclicked', { topLevel: true, x: 10, y: 20 }),
    unrelated: block('event_whenkeypressed', { topLevel: true, fields: { KEY_OPTION: ['space', null] } })
  },
  costumes: [], sounds: [], comments: {}
});
const idFor = (key) => `recovered:${key}`;
const run = (target, operations, options = {}) => {
  const records = [];
  const result = buildRecoveredStack({target, operations, parentId: 'hat', idFor,
    recordBlock: (record) => records.push(record), ...options});
  return {result, records};
};
const nestedOperations = () => [
  {
    opcode: 'data_setvariableto', fields: { VARIABLE: ['score', 'scoreId'] }, span: [0, 20],
    inputs: { VALUE: {
      opcode: 'operator_add', inputs: {
        NUM1: { variable: { name: 'score', id: 'scoreId' } },
        NUM2: { opcode: 'operator_multiply', inputs: { NUM1: { literal: 2 }, NUM2: { literal: 3 } }, span: [8, 19] }
      }
    } }
  },
  {
    opcode: 'control_repeat', inputs: { TIMES: { literal: 3 } }, span: [21, 80],
    substacks: { SUBSTACK: [
      {
        opcode: 'control_if_else', inputs: { CONDITION: {
          opcode: 'operator_lt', inputs: {
            OPERAND1: { variable: { name: 'score', id: 'scoreId' } }, OPERAND2: { literal: 10 }
          }
        } },
        substacks: {
          SUBSTACK: [{ opcode: 'looks_say', inputs: { MESSAGE: {
            opcode: 'operator_join', inputs: { STRING1: { literal: 'item: ' }, STRING2: { list: { name: 'items', id: 'itemsId' } } }
          } } }],
          SUBSTACK2: [{ opcode: 'event_broadcast', inputs: { BROADCAST_INPUT: { broadcast: { name: 'Ready', id: 'readyId' } } } }]
        }
      },
      { opcode: 'motion_movesteps', inputs: { STEPS: { literal: 5 } } }
    ] }
  },
  { opcode: 'looks_say', inputs: { MESSAGE: { literal: 'done' } }, span: [81, 90] }
];

const assertGraph = (target, firstId) => {
  const reached = new Set();
  const visitBlock = (id, expectedParent) => {
    assert.ok(!reached.has(id), `block ${id} must not be linked twice`);
    reached.add(id);
    const current = target.blocks[id];
    assert.ok(current, `block ${id} must exist`);
    assert.equal(current.parent, expectedParent, `parent of ${id}`);
    assert.equal(current.topLevel, false);
    for (const input of Object.values(current.inputs)) {
      for (const descriptor of input.slice(1)) {
        if (typeof descriptor === 'string') visitBlock(descriptor, id);
      }
    }
    if (current.next !== null) visitBlock(current.next, id);
  };
  visitBlock(firstId, 'hat');
  assert.equal(reached.size, Object.keys(target.blocks).length - 2);
};
const assertRejectsTransaction = (operations, pattern, options = {}) => {
  const target = makeTarget();
  const before = structuredClone(target);
  const blocks = target.blocks;
  const parent = blocks.hat;
  const records = [];
  assert.throws(() => buildRecoveredStack({target, operations, parentId: 'hat', idFor,
    recordBlock: (record) => records.push(record), ...options}), pattern);
  assert.deepEqual(target, before, 'no prefix or parent changes may survive');
  assert.strictEqual(target.blocks, blocks);
  assert.strictEqual(target.blocks.hat, parent);
  assert.deepEqual(records, [], 'invalid IR must not produce records');
};

// Check topology directly: the SB3 validator checks references, but intentionally
// does not require next/parent reciprocity or know extension input semantics.
test('nested stacks and reporters form one graph with deterministic keys and source records', () => {
  const target = makeTarget();
  const operations = nestedOperations();
  const beforeOperations = structuredClone(operations);
  const blocks = target.blocks;
  const parent = blocks.hat;
  const unrelated = blocks.unrelated;
  const beforeUnrelated = structuredClone(unrelated);
  const keys = [];
  const {result, records} = run(target, operations, {idFor: (key) => { keys.push(key); return idFor(key); }});
  assert.deepEqual(result, {firstId: idFor(0), lastId: idFor(2), blockCount: 11});
  assert.deepEqual(keys, [
    0, '0/VALUE', '0/VALUE/NUM2', 1, '1/SUBSTACK/0', '1/SUBSTACK/0/CONDITION',
    '1/SUBSTACK/0/SUBSTACK/0', '1/SUBSTACK/0/SUBSTACK/0/MESSAGE',
    '1/SUBSTACK/0/SUBSTACK2/0', '1/SUBSTACK/1', 2
  ]);
  assert.strictEqual(target.blocks, blocks);
  assert.strictEqual(blocks.hat, parent);
  assert.strictEqual(blocks.unrelated, unrelated);
  assert.deepEqual(unrelated, beforeUnrelated);
  assert.deepEqual(operations, beforeOperations);
  assert.equal(parent.next, idFor(0));
  assert.equal(blocks[idFor(0)].next, idFor(1));
  assert.equal(blocks[idFor(1)].next, idFor(2));
  assert.equal(blocks[idFor(2)].next, null);
  assert.deepEqual(blocks[idFor(1)].inputs.SUBSTACK, [2, idFor('1/SUBSTACK/0')]);
  assert.equal(blocks[idFor('1/SUBSTACK/0')].next, idFor('1/SUBSTACK/1'));
  assert.equal(blocks[idFor('1/SUBSTACK/0/SUBSTACK/0')].next, null);
  assert.equal(blocks[idFor('1/SUBSTACK/0/SUBSTACK2/0')].next, null);
  assert.deepEqual(blocks[idFor('1/SUBSTACK/0')].inputs.CONDITION, [2, idFor('1/SUBSTACK/0/CONDITION')]);
  assert.deepEqual(blocks[idFor(0)].inputs.VALUE, [2, idFor('0/VALUE')]);
  assertGraph(target, result.firstId);
  assert.equal(records.length, result.blockCount);
  assert.deepEqual(records.map((record) => record.blockId), keys.map(idFor));
  for (const record of records) {
    assert.equal(record.opcode, blocks[record.blockId].opcode);
    assert.equal(record.kind, record.blockId.includes('VALUE') || record.blockId.endsWith('/CONDITION') ||
      record.blockId.endsWith('/MESSAGE') ? 'reporter' : 'stack');
  }
  assert.deepEqual(records[1].sourceSpan, [0, 20]);
  assert.deepEqual(records[2].sourceSpan, [8, 19]);
  assert.deepEqual(records[4].sourceSpan, [21, 80]);
  operations[0].fields.VARIABLE[0] = 'changed';
  operations[0].span[0] = 999;
  assert.deepEqual(blocks[idFor(0)].fields.VARIABLE, ['score', 'scoreId']);
  assert.deepEqual(records[0].sourceSpan, [0, 20]);
});

test('literal primitives preserve type and reference primitives preserve exact names and IDs', () => {
  const target = makeTarget();
  const {result} = run(target, [{ opcode: 'extension_inputs', inputs: {
    NUMBER: { literal: 1.25 }, ZERO: { literal: 0 }, TEXT: { literal: '10' }, EMPTY: { literal: '' },
    VARIABLE: { variable: { name: '同名', id: 'local-variable' } },
    LIST: { list: { name: '同名', id: 'global-list' } },
    BROADCAST: { broadcast: { name: 'READY', id: 'exact-broadcast' } }
  } }]);
  assert.equal(result.blockCount, 1, 'inline primitives are not emitted block objects');
  assert.deepEqual(target.blocks[idFor(0)].inputs, {
    NUMBER: [1, [4, 1.25]], ZERO: [1, [4, 0]], TEXT: [1, [10, '10']], EMPTY: [1, [10, '']],
    VARIABLE: [3, [12, '同名', 'local-variable'], [10, '']],
    LIST: [3, [13, '同名', 'global-list'], [10, '']], BROADCAST: [1, [11, 'READY', 'exact-broadcast']]
  });
});

test('explicit menu shadows attach to command and reporter inputs, with or without actual expressions', () => {
  const target = makeTarget();
  const {result, records} = run(target, [
    { opcode: 'motion_goto', span: [2, 15], inputs: { TO: { variable: { name: 'score', id: 'scoreId' } } },
      shadowInputs: { TO: { opcode: 'motion_goto_menu', fields: { TO: ['_random_', null] } } } },
    { opcode: 'motion_goto', shadowInputs: { TO: { opcode: 'motion_goto_menu', fields: { TO: ['_mouse_', null] } } } },
    { opcode: 'looks_say', inputs: { MESSAGE: {
      opcode: 'sensing_of', inputs: { OBJECT: { literal: 'Sprite1' } },
      shadowInputs: { OBJECT: { opcode: 'sensing_of_object_menu', fields: { OBJECT: ['_stage_', null] } } },
      fields: { PROPERTY: ['x position', null] }
    } } },
    { opcode: 'motion_goto', inputs: { TO: { opcode: 'operator_join', inputs: { STRING1: { literal: 'Sprite' }, STRING2: { literal: '1' } } } },
      shadowInputs: { TO: { opcode: 'motion_goto_menu', fields: { TO: ['_random_', null] } } } }
  ]);
  const blocks = target.blocks;
  assert.equal(result.blockCount, 10);
  assert.deepEqual(blocks[idFor(0)].inputs.TO, [3, [12, 'score', 'scoreId'], idFor('0/TO/shadow')]);
  assert.deepEqual(blocks[idFor(1)].inputs.TO, [1, idFor('1/TO/shadow')]);
  assert.deepEqual(blocks[idFor('2/MESSAGE')].inputs.OBJECT, [3, [10, 'Sprite1'], idFor('2/MESSAGE/OBJECT/shadow')]);
  assert.deepEqual(blocks[idFor(3)].inputs.TO, [3, idFor('3/TO'), idFor('3/TO/shadow')]);
  for (const [key, owner] of [['0/TO/shadow', 0], ['1/TO/shadow', 1], ['2/MESSAGE/OBJECT/shadow', '2/MESSAGE'], ['3/TO/shadow', 3]]) {
    assert.equal(blocks[idFor(key)].shadow, true);
    assert.equal(blocks[idFor(key)].parent, idFor(owner));
    assert.equal(blocks[idFor(key)].next, null);
    assert.equal(records.find((record) => record.blockId === idFor(key)).kind, 'shadow');
  }
  assert.deepEqual(records.find((record) => record.blockId === idFor('0/TO/shadow')).sourceSpan, [2, 15]);
  assertGraph(target, result.firstId);
});

test('reporters marked shadow use shadow input encoding and mutations are detached from IR', () => {
  const target = makeTarget();
  const mutation = { tagName: 'mutation', children: [], proccode: 'demo %s', argumentids: '["arg"]', warp: 'true' };
  const operations = [{ opcode: 'procedures_call', mutation, inputs: { arg: {
    opcode: 'argument_reporter_string_number', fields: { VALUE: ['argument', null] }, shadow: true,
    mutation: { tagName: 'mutation', children: [{ tagName: 'arg', value: 'first' }] }
  } } }];
  const {records} = run(target, operations);
  assert.deepEqual(target.blocks[idFor(0)].inputs.arg, [1, idFor('0/arg')]);
  assert.equal(target.blocks[idFor('0/arg')].shadow, true);
  assert.equal(records[1].kind, 'shadow');
  assert.deepEqual(target.blocks[idFor(0)].mutation, mutation);
  mutation.children.push({ tagName: 'changed' });
  operations[0].inputs.arg.mutation.children[0].value = 'changed';
  assert.deepEqual(target.blocks[idFor(0)].mutation.children, []);
  assert.equal(target.blocks[idFor('0/arg')].mutation.children[0].value, 'first');
});

test('empty substacks are omitted and do not consume IDs or records', () => {
  const target = makeTarget();
  const {result, records} = run(target, [{ opcode: 'control_if_else', inputs: { CONDITION: {
    opcode: 'operator_equals', inputs: { OPERAND1: { literal: 1 }, OPERAND2: { literal: 1 } }
  } }, substacks: { SUBSTACK: [], SUBSTACK2: [] } }]);
  assert.equal(result.blockCount, 2);
  assert.deepEqual(Object.keys(target.blocks[idFor(0)].inputs), ['CONDITION']);
  assert.equal(records.length, 2);
});

test('empty operations return null endpoints without changing parent or calling callbacks', () => {
  const target = makeTarget();
  target.blocks.hat.next = 'unrelated';
  const before = structuredClone(target);
  const {result, records} = run(target, [], {idFor: () => { throw new Error('unexpected ID allocation'); }});
  assert.deepEqual(result, {firstId: null, lastId: null, blockCount: 0});
  assert.deepEqual(records, []);
  assert.deepEqual(target, before);
});

test('identical IR emits identical graphs, records, and ID keys; shared reporter nodes are emitted per input', () => {
  const first = makeTarget();
  const second = makeTarget();
  assert.deepEqual(run(first, nestedOperations()), run(second, nestedOperations()));
  assert.deepEqual(first, second);
  const shared = { opcode: 'operator_add', inputs: { NUM1: { literal: 1 }, NUM2: { literal: 2 } } };
  const target = makeTarget();
  const {result} = run(target, [{ opcode: 'operator_test', inputs: { LEFT: shared, RIGHT: shared } }]);
  assert.equal(result.blockCount, 3);
  assert.equal(target.blocks[idFor('0/LEFT')].parent, idFor(0));
  assert.equal(target.blocks[idFor('0/RIGHT')].parent, idFor(0));
  assert.notStrictEqual(target.blocks[idFor('0/LEFT')], target.blocks[idFor('0/RIGHT')]);
});

test('unknown or ambiguous expressions reject a valid prefix transactionally', async (t) => {
  for (const [name, expression] of [
    ['missing tag', {}], ['unknown tag', { rawCode: 'arbitrary()' }], ['boolean literal', { literal: true }],
    ['null literal', { literal: null }], ['undefined literal', { literal: undefined }], ['bare input', 'text'],
    ['multiple tags', { literal: 2, variable: { name: 'score', id: 'scoreId' } }],
    ['unknown reporter property', { opcode: 'operator_add', rawCode: 'x + y' }],
    ['reference lacks ID', { variable: { name: 'score' } }], ['list lacks name', { list: { id: 'itemsId' } }],
    ['broadcast has null ID', { broadcast: { name: 'Ready', id: null } }]
  ]) {
    await t.test(name, () => assertRejectsTransaction([
      { opcode: 'looks_say', inputs: { MESSAGE: { literal: 'valid prefix' } } },
      { opcode: 'data_setvariableto', inputs: { VALUE: expression } }
    ], /unknown|ambiguous|literal|IR object|ID|name/));
  }
});

test('NaN, infinities, and negative zero reject inside deeply nested reporters', async (t) => {
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    await t.test(Object.is(value, -0) ? '-0' : String(value), () => assertRejectsTransaction([
      { opcode: 'looks_say', inputs: { MESSAGE: { literal: 'valid prefix' } } },
      { opcode: 'control_repeat', substacks: { SUBSTACK: [{ opcode: 'motion_movesteps', inputs: { STEPS: {
        opcode: 'operator_add', inputs: { NUM1: { literal: 1 }, NUM2: { literal: value } }
      } } }] } }
    ], /finite and not -0/));
  }
});

test('invalid opcodes in commands, reporters, or menu shadows reject the whole graph', async (t) => {
  for (const opcode of [undefined, null, 42, '', ' \t\n']) {
    for (const kind of ['stack', 'reporter', 'shadow']) {
      await t.test(`${kind}: ${JSON.stringify(opcode)}`, () => {
        const invalid = kind === 'stack' ? { opcode } : kind === 'reporter' ?
          { opcode: 'looks_say', inputs: { MESSAGE: { opcode } } } :
          { opcode: 'motion_goto', shadowInputs: { TO: { opcode } } };
        assertRejectsTransaction([{ opcode: 'looks_say' }, invalid], /opcode/);
      });
    }
  }
});

test('malformed fields, mutation, shadow flags, substacks, and cyclic IR reject transactionally', async (t) => {
  const cycle = { opcode: 'operator_add', inputs: {} };
  cycle.inputs.NUM1 = cycle;
  const stackCycle = { opcode: 'control_repeat', substacks: {} };
  stackCycle.substacks.SUBSTACK = [stackCycle];
  for (const [name, invalid, pattern] of [
    ['fields dictionary', { opcode: 'looks_say', fields: [] }, /dictionary/],
    ['reference field ID', { opcode: 'data_setvariableto', fields: { VARIABLE: ['score', null] } }, /reference field/],
    ['dropdown ID', { opcode: 'control_stop', fields: { STOP_OPTION: ['all', 5] } }, /ID/],
    ['unknown operation property', { opcode: 'looks_say', rawCode: 'x()' }, /unknown property/],
    ['substack array', { opcode: 'control_repeat', substacks: { SUBSTACK: {} } }, /substack must be an array/],
    ['input conflict', { opcode: 'control_if', inputs: { SUBSTACK: { literal: 'x' } }, substacks: { SUBSTACK: [] } }, /conflicts/],
    ['cyclic reporter', { opcode: 'looks_say', inputs: { MESSAGE: cycle } }, /cyclic IR/],
    ['cyclic stack', stackCycle, /cyclic IR/],
    ['mutation type', { opcode: 'procedures_call', mutation: [] }, /mutation.*dictionary/],
    ['nonfinite metadata', { opcode: 'procedures_call', mutation: { value: NaN } }, /finite/],
    ['invalid shadow flag', { opcode: 'looks_say', inputs: { MESSAGE: { opcode: 'operator_add', shadow: 'true' } } }, /shadow.*boolean/]
  ]) {
    await t.test(name, () => assertRejectsTransaction([{ opcode: 'looks_say' }, invalid], pattern));
  }
});

test('duplicate and preexisting command, reporter, and shadow IDs reject without recording a prefix', async (t) => {
  const operations = [{ opcode: 'looks_say' }, { opcode: 'motion_goto', inputs: { TO: { opcode: 'operator_join' } },
    shadowInputs: { TO: { opcode: 'motion_goto_menu', fields: { TO: ['_random_', null] } } } }];
  for (const key of [1, '1/TO', '1/TO/shadow']) {
    await t.test(`duplicate ${key}`, () => assertRejectsTransaction(operations, /collision/, {
      idFor: (current) => current === key ? idFor(0) : idFor(current)
    }));
    await t.test(`preexisting ${key}`, () => assertRejectsTransaction(operations, /collision/, {
      idFor: (current) => current === key ? 'unrelated' : idFor(current)
    }));
  }
  await t.test('parent ID', () => assertRejectsTransaction(operations, /collision/, {idFor: () => 'hat'}));
  for (const badId of ['', undefined, null, 42]) {
    await t.test(`invalid ID ${String(badId)}`, () => assertRejectsTransaction(operations, /nonempty string/, {
      idFor: (key) => key === '1/TO/shadow' ? badId : idFor(key)
    }));
  }
  await t.test('ID callback failure', () => assertRejectsTransaction(operations, /allocation failed/, {
    idFor: (key) => { if (key === '1/TO/shadow') throw new Error('allocation failed'); return idFor(key); }
  }));
});

test('an existing parent is required and an occupied next link is preserved', () => {
  const target = makeTarget();
  const before = structuredClone(target);
  assert.throws(() => run(target, [{ opcode: 'looks_say' }], {parentId: 'missing'}), /existing block/);
  assert.deepEqual(target, before);
  target.blocks.hat.next = 'unrelated';
  const occupied = structuredClone(target);
  assert.throws(() => run(target, [{ opcode: 'looks_say' }]), /already has a next block/);
  assert.deepEqual(target, occupied);
});

test('nonwritable parent or nonextensible block maps reject before graph insertion', () => {
  for (const freeze of [(target) => Object.freeze(target.blocks.hat), (target) => Object.preventExtensions(target.blocks)]) {
    const target = makeTarget();
    const before = structuredClone(target);
    freeze(target);
    assert.throws(() => run(target, [{ opcode: 'looks_say' }]), /writable|extensible/);
    assert.deepEqual(target, before);
  }
});

test('a synchronous record callback failure rolls back target insertions and parent linkage', () => {
  for (const omitNext of [false, true]) {
    const target = makeTarget();
    if (omitNext) delete target.blocks.hat.next;
    const before = structuredClone(target);
    const beforeDescriptor = Object.getOwnPropertyDescriptor(target.blocks.hat, 'next');
    let calls = 0;
    assert.throws(() => run(target, [{ opcode: 'looks_say' }, { opcode: 'motion_movesteps' }], {
      recordBlock: () => { if (++calls === 2) throw new Error('record failed'); }
    }), /record failed/);
    assert.deepEqual(target, before);
    assert.deepEqual(Object.getOwnPropertyDescriptor(target.blocks.hat, 'next'), beforeDescriptor);
  }
});

test('prototype-like block IDs and input keys are preserved as ordinary own properties', () => {
  const target = makeTarget();
  const inputs = Object.fromEntries([['__proto__', { literal: 'safe' }]]);
  const {result} = run(target, [{ opcode: 'extension_inputs', inputs }, { opcode: 'looks_say' }, { opcode: 'looks_say' }], {
    idFor: (key) => ['__proto__', 'constructor', 'toString'][key]
  });
  assert.deepEqual(result, {firstId: '__proto__', lastId: 'toString', blockCount: 3});
  assert.strictEqual(Object.getPrototypeOf(target.blocks), Object.prototype);
  assert.ok(Object.hasOwn(target.blocks, '__proto__'));
  assert.deepEqual(target.blocks.__proto__.inputs.__proto__, [1, [10, 'safe']]);
  assert.strictEqual(Object.getPrototypeOf(target.blocks.__proto__.inputs), Object.prototype);
  assert.equal(target.blocks.constructor.parent, '__proto__');
  assert.equal(target.blocks.constructor.next, 'toString');
});

test('nested stack/reporter graph and menu shadows pass the SB3 validator with a minimal fixture', async () => {
  const {project, assets} = await makeMinimalSb3();
  const stage = project.targets[0];
  stage.variables.scoreId = ['score', 0];
  stage.lists.itemsId = ['items', []];
  stage.broadcasts.readyId = 'Ready';
  const originalBlocks = stage.blocks;
  const originalSet = stage.blocks.b;
  const originalSprite = structuredClone(project.targets[1]);
  const {result} = run(stage, [
    ...nestedOperations(),
    { opcode: 'event_broadcast', shadowInputs: { BROADCAST_INPUT: {
      opcode: 'event_broadcast_menu', fields: { BROADCAST_OPTION: ['Ready', 'readyId'] }
    } } },
    { opcode: 'control_if', substacks: { SUBSTACK: [] }, inputs: { CONDITION: {
      opcode: 'operator_equals', inputs: { OPERAND1: { literal: 'x' }, OPERAND2: { literal: 'x' } }
    } } }
  ], {parentId: 'b'});
  assert.strictEqual(stage.blocks, originalBlocks);
  assert.strictEqual(stage.blocks.b, originalSet);
  assert.deepEqual(project.targets[1], originalSprite);
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project));
  for (const [name, bytes] of Object.entries(assets)) zip.file(name, bytes);
  const report = await validateSb3(await zip.generateAsync({type: 'uint8array', compression: 'STORE'}));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.issues, []);
  assert.equal(report.summary.blocks, 4 + result.blockCount);
});
