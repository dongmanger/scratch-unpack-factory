import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {compiledFixture} from './compiled-fixtures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const root = fileURLToPath(new URL('../../research/02engine/scratch-vm/src/compiler/', import.meta.url));
const require = createRequire(import.meta.url);
const VariablePool = require(`${root}/variable-pool.js`);
const {InputOpcode, InputType, StackOpcode} = require(`${root}/enums.js`);

async function sourceGenerator() {
  const source = await fsp.readFile(`${root}/jsgen.js`, 'utf8');
  const module = {exports: {}};
  const dependencies = {
    '../util/log': {warn() {}, info() {}}, '../extension-support/block-type': {},
    './variable-pool': VariablePool, './jsexecute': {}, './environment': {},
    './enums.js': {InputOpcode, InputType, StackOpcode},
    './old-compiler-compatibility.js': {JSGeneratorStub: class {}}, './intermediate': {}
  };
  // Run the actual jsgen class; dependencies unused by the supported grammar are test doubles.
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {})
    (id => {if (!(id in dependencies)) throw new Error(`Unexpected dependency ${id}`); return dependencies[id];}, module, module.exports);
  return module.exports;
}
const literal = value => ({opcode: InputOpcode.CONSTANT, inputs: {value},
  isAlwaysType: type => type === (typeof value === 'number' ? InputType.NUMBER : InputType.STRING),
  isSometimesType: type => type === (typeof value === 'number' ? InputType.NUMBER : InputType.STRING)});

test('actual02 jsgen source emits variable/broadcast grammar accepted by recovery (IR/runtime doubles, not full compiler verification)', async () => {
  const JSGenerator = await sourceGenerator();
  const fixture = await compiledFixture();
  const script = {topBlockId: 'a', arguments: [], isWarp: false, isProcedure: false, warpTimer: false,
    procedureCode: '', yields: false, customCode: null,
    stack: {blocks: [
      {opcode: StackOpcode.VAR_SET, inputs: {variable: {scope: 'stage', id: 'varId1', name: '分数'}, value: literal('准备')}},
      {opcode: StackOpcode.EVENT_BROADCAST, inputs: {broadcast: literal('StartGame')}}
    ]}};
  const target = {isStage: true, runtime: {debug: false}, getName: () => 'Stage'};
  const source = new JSGenerator(script, {procedures: {}}, target).getSourceCode();
  fixture.bundle.compiledTargets[0].scripts.a.factorySource = source;
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.scripts[0].status, 'reconstructed-unverified');
  assert.deepEqual(Object.values(project.targets[0].blocks).map(b => b.opcode),
    ['event_whenflagclicked', 'data_setvariableto', 'event_broadcast']);
  assert.deepEqual(Object.values(project.targets[0].blocks)[1].fields.VARIABLE, ['分数', 'varId1']);
  assert.equal(result.scripts[0].body.confidence.score, 0.85);
});
