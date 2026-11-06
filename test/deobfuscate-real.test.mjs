import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import {deobfuscate} from '../src/deobfuscate.mjs';
import {
  CORPUS_SEEDS, OBFUSCATION_LEVELS, OBFUSCATOR_VERSION,
  getTrustedFixtures, obfuscateTrustedFixture
} from './obfuscation-corpus.mjs';

const traverse = traverseModule.default ?? traverseModule;
const VM_TIMEOUT = 1500;

// Only called with sources owned by this test: our fixtures, their locally
// generated obfuscations, and the deobfuscation results of those same inputs.
// No project/user supplied input is evaluated here. Factory binding, generator
// draining, and all runtime callbacks execute inside the timed VM as well.
function observeTrustedFactory(source, fixture, initial = {stageValue: 7, localValue: 11}) {
  const context = vm.createContext({
    __initial: {...initial}, __targetIndex: fixture.targetIndex
  }, {codeGeneration: {strings: false, wasm: false}});
  new vm.Script(`
    const __broadcasts = [], __waits = [], __yielded = [];
    let __retired = 0;
    const __stage = {variables: {varId1: {value: __initial.stageValue}}};
    const __sprite = {variables: {localScore: {value: __initial.localValue}}};
    const __runtime = {getTargetForStage() { return __stage; }};
    __stage.runtime = __runtime;
    __sprite.runtime = __runtime;
    const __thread = {target: __targetIndex === 0 ? __stage : __sprite};
    function startHats(opcode, fields) {
      __broadcasts.push([opcode, fields.BROADCAST_OPTION]);
      return ['hat-' + __broadcasts.length];
    }
    function* waitThreads(threads) {
      __waits.push([...threads]);
      for (const thread of threads) yield 'wait:' + thread;
    }
    function retire() { __retired++; }
  `, {filename: 'trusted-runtime.mjs'}).runInContext(context, {timeout: VM_TIMEOUT});
  const factory = new vm.Script(source, {filename: `${fixture.id}.mjs`})
    .runInContext(context, {timeout: VM_TIMEOUT});
  assert.equal(typeof factory, 'function', `${fixture.id}: source must return a factory`);
  context.__factory = factory;
  const observation = new vm.Script(`
    const __body = __factory(__thread);
    if (typeof __body !== 'function') throw new Error('Factory did not bind a body');
    let __result = __body();
    if (__result && typeof __result.next === 'function') {
      const __iterator = __result;
      let __steps = 0;
      while (true) {
        if (++__steps > 32) throw new Error('Fixture generator exceeded its step limit');
        const step = __iterator.next();
        if (step.done) { __result = step.value; break; }
        __yielded.push(step.value);
      }
    }
    JSON.stringify({
      stageValue: __stage.variables.varId1.value,
      localValue: __sprite.variables.localScore.value,
      broadcasts: __broadcasts, waits: __waits, retired: __retired,
      yielded: __yielded,
      returned: __result === undefined ? {type: 'undefined'} : {type: typeof __result, value: __result}
    });
  `, {filename: 'trusted-execution.mjs'}).runInContext(context, {timeout: VM_TIMEOUT});
  return JSON.parse(observation);
}

function functionBinding(path) {
  if (path.node.id?.name) return path.scope.getBinding(path.node.id.name);
  const parent = path.parentPath;
  if (parent.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return parent.scope.getBinding(parent.node.id.name);
  }
  if (parent.isAssignmentExpression() && parent.node.left.type === 'Identifier') {
    return parent.scope.getBinding(parent.node.left.name);
  }
  return undefined;
}

function identifierBinding(path) {
  return path?.isIdentifier() ? path.scope.getBinding(path.node.name) : undefined;
}

function staticNumber(node) {
  if (node?.type === 'NumericLiteral') return node.value;
  if (node?.type === 'UnaryExpression' && node.operator === '-') return -staticNumber(node.argument);
  if (node?.type !== 'BinaryExpression') return NaN;
  const left = staticNumber(node.left), right = staticNumber(node.right);
  if (node.operator === '+') return left + right;
  if (node.operator === '-') return left - right;
  if (node.operator === '*') return left * right;
  return NaN;
}

// Binding-aware table/decoder/alias analysis, plus structural codec detection.
// This does not depend on generated _0x names, whitespace, or source length.
// The raw-corpus assertions below verify that these checks actually recognize
// the light, base64, and RC4 machinery before testing recovered output.
function inspectDecoderMachinery(source) {
  const ast = parse(source, {sourceType: 'script'});
  const tables = new Set(), decoders = new Set();
  let rc4Bootstraps = 0, base64Bootstraps = 0, evalCalls = 0;
  traverse(ast, {
    Function(path) {
      const binding = functionBinding(path);
      const arrays = new Set();
      let returnsTable = false;
      const methods = new Set();
      let xor = false, modulo256 = false;
      path.traverse({
        Function(inner) { inner.skip(); },
        VariableDeclarator(inner) {
          const {id, init} = inner.node;
          if (id.type === 'Identifier' && init?.type === 'ArrayExpression' &&
              init.elements.length >= 3 && init.elements.every(item => item?.type === 'StringLiteral')) {
            arrays.add(inner.scope.getBinding(id.name));
          }
        },
        ReturnStatement(inner) {
          const value = inner.get('argument');
          if (value.isIdentifier() && arrays.has(identifierBinding(value))) returnsTable = true;
          if (value.isCallExpression() && binding && identifierBinding(value.get('callee')) === binding) {
            returnsTable = true;
          }
        }
      });
      if (binding && path.node.params.length === 0 && arrays.size && returnsTable) tables.add(binding);
      path.traverse({
        MemberExpression(inner) {
          const property = inner.node.property;
          if (!inner.node.computed && property.type === 'Identifier') methods.add(property.name);
          if (property.type === 'StringLiteral') methods.add(property.value);
        },
        BinaryExpression(inner) {
          if (inner.node.operator === '^') xor = true;
          if (inner.node.operator === '%' && staticNumber(inner.node.right) === 256) modulo256 = true;
        }
      });
      if (xor && modulo256 && methods.has('charCodeAt') && methods.has('fromCharCode')) rc4Bootstraps++;
      if (methods.has('charAt') && methods.has('indexOf') && methods.has('fromCharCode')) base64Bootstraps++;
    },
    CallExpression(path) {
      if (path.get('callee').isIdentifier({name: 'eval'})) evalCalls++;
    }
  });
  traverse(ast, {
    Function(path) {
      const binding = functionBinding(path);
      if (!binding || path.node.params.length === 0) return;
      let readsTable = false;
      path.traverse({
        Function(inner) { inner.skip(); },
        CallExpression(inner) {
          if (tables.has(identifierBinding(inner.get('callee')))) readsTable = true;
        }
      });
      if (readsTable) decoders.add(binding);
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    const addDecoder = binding => {
      if (binding && !decoders.has(binding)) { decoders.add(binding); changed = true; }
    };
    traverse(ast, {
      VariableDeclarator(path) {
        if (path.node.id.type === 'Identifier' && decoders.has(identifierBinding(path.get('init')))) {
          addDecoder(path.scope.getBinding(path.node.id.name));
        }
      },
      AssignmentExpression(path) {
        if (path.node.operator === '=' && path.node.left.type === 'Identifier' &&
            decoders.has(identifierBinding(path.get('right')))) {
          addDecoder(path.scope.getBinding(path.node.left.name));
        }
      },
      Function(path) {
        const body = path.node.body;
        if (body.type !== 'BlockStatement' || body.body.length !== 1 ||
            body.body[0].type !== 'ReturnStatement') return;
        const returned = path.get('body.body.0.argument');
        if (returned.isCallExpression() && decoders.has(identifierBinding(returned.get('callee')))) {
          addDecoder(functionBinding(path));
        }
      }
    });
  }
  let decoderCalls = 0;
  traverse(ast, {
    CallExpression(path) {
      if (decoders.has(identifierBinding(path.get('callee')))) decoderCalls++;
    }
  });
  return {decoderCalls, rc4Bootstraps, base64Bootstraps, evalCalls};
}

function assertRecoveredResult(result, id) {
  assert.ok(result && typeof result === 'object', `${id}: deobfuscate result`);
  assert.equal(typeof result.code, 'string', `${id}: code`);
  assert.ok(result.report && typeof result.report === 'object', `${id}: report`);
  for (const key of ['status', 'transforms', 'warnings', 'residuals']) {
    assert.ok(Object.hasOwn(result.report, key), `${id}: missing report.${key}`);
  }
  assert.equal(typeof result.report.status, 'string', `${id}: status`);
  assert.ok(!/^(?:failed|error|unsupported|budget-exceeded|budget_exceeded)$/i.test(result.report.status),
    `${id}: ${JSON.stringify(result.report)}`);
  assert.deepEqual(inspectDecoderMachinery(result.code), {
    decoderCalls: 0, rc4Bootstraps: 0, base64Bootstraps: 0, evalCalls: 0
  }, `${id}: live decoder calls or codec/eval bootstrap remain; report=${JSON.stringify(result.report)}`);
}

const initialStates = [
  {stageValue: 7, localValue: 11},
  {stageValue: -4, localValue: 23}
];

// Real javascript-obfuscator generation with 02 options; not a full 02packager run.
test('trusted plaintext factories preserve variable changes, broadcasts, yields and returns', async t => {
  assert.equal(OBFUSCATOR_VERSION, '4.1.1');
  for (const fixture of await getTrustedFixtures()) {
    await t.test(fixture.id, async () => {
      assert.deepEqual(observeTrustedFactory(fixture.factorySource, fixture), fixture.expected);
      const result = await deobfuscate(fixture.factorySource, {maxRounds: 12, maxSteps: 300000});
      assertRecoveredResult(result, fixture.id);
      for (const initial of initialStates) {
        assert.deepEqual(observeTrustedFactory(result.code, fixture, initial),
          observeTrustedFactory(fixture.factorySource, fixture, initial));
      }
    });
  }
});

for (const level of OBFUSCATION_LEVELS) {
  for (const seed of CORPUS_SEEDS) {
    test(`real obfuscator 4.1.1 / official 02 ${level} / seed ${seed}`, {timeout: 120000}, async t => {
      for (const fixture of await getTrustedFixtures()) {
        const item = obfuscateTrustedFixture(fixture, {level, seed});
        const raw = inspectDecoderMachinery(item.obfuscatedSource);
        assert.ok(raw.decoderCalls > 0, `${item.id}: generated fixture must contain actual decoder calls`);
        if (level === 'balanced') assert.ok(raw.base64Bootstraps > 0, `${item.id}: expected base64 bootstrap`);
        if (level === 'strong') assert.ok(raw.rc4Bootstraps > 0, `${item.id}: expected RC4 bootstrap`);
        // Preserve exact generated source for selfDefending. Reformatting it
        // before execution would test a different program and can hang it.
        for (const initial of initialStates) {
          assert.deepEqual(observeTrustedFactory(item.obfuscatedSource, fixture, initial),
            observeTrustedFactory(fixture.factorySource, fixture, initial), `${item.id}: generated semantics`);
        }
        for (const [shape, source] of [['plain', item.obfuscatedSource], ['eval-shell', item.evalSource]]) {
          await t.test(`${fixture.id} / ${shape}`, async () => {
            const result = await deobfuscate(source, {maxRounds: 12, maxSteps: 300000});
            assertRecoveredResult(result, `${item.id}/${shape}`);
            for (const initial of initialStates) {
              assert.deepEqual(observeTrustedFactory(result.code, fixture, initial),
                observeTrustedFactory(fixture.factorySource, fixture, initial),
                `${item.id}/${shape}: recovered semantics`);
            }
          });
        }
      }
    });
  }
}
