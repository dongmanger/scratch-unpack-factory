import test from 'node:test';
import assert from 'node:assert/strict';
import {compiledFixture} from './compiled-fixtures.mjs';
import {orderProcedureVariants} from '../src/recovery-procedures.mjs';
import {recoverCompiledCode} from '../src/recover-code.mjs';

const callSource = (name, spelling = 'plain') => spelling === 'plain' ? `thread.procedures["${name}"]()` :
  spelling === 'dotted' ? `thread.procedures.${name}()` : `thread.procedures [ "${name}" ] ()`;
const body = (...calls) => `(function f(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();return function*g(){${calls.map(c => `yield* ${c};`).join('')}return "";};})`;

test('callees are ordered before their callers, and independent procedures keep their order', () => {
  const procedures = {
    Wa: {factorySource: body(callSource('Wc'))},   // a calls c
    Wb: {factorySource: body()},                   // independent
    Wc: {factorySource: body(callSource('Wd'))},   // c calls d
    Wd: {factorySource: body()}
  };
  const order = orderProcedureVariants(procedures);
  assert.equal(order.length, 4);
  for (const [caller, callee] of [['Wa', 'Wc'], ['Wc', 'Wd']]) assert.ok(order.indexOf(callee) < order.indexOf(caller), `${callee} before ${caller}: ${order}`);
  assert.ok(order.indexOf('Wb') < order.indexOf('Wc') || order.indexOf('Wb') > order.indexOf('Wc'), 'Wb is anywhere');
  assert.deepEqual(orderProcedureVariants({Wx: {factorySource: body()}, Wy: {factorySource: body()}, Wz: {factorySource: body()}}), ['Wx', 'Wy', 'Wz']);
});

test('quoted, unquoted and escaped procedure names are all seen as calls', () => {
  const procedures = {
    Wouter: {factorySource: body(callSource('Wquoted'), callSource('Wdotted', 'dotted'), 'thread.procedures["Wsay \\"hi\\""]()')},
    Wquoted: {factorySource: body()}, Wdotted: {factorySource: body()}, 'Wsay "hi"': {factorySource: body()}
  };
  const order = orderProcedureVariants(procedures);
  for (const callee of ['Wquoted', 'Wdotted', 'Wsay "hi"']) assert.ok(order.indexOf(callee) < order.indexOf('Wouter'), `${callee} before Wouter: ${order}`);
});

test('recursion and cycles end the ordering instead of looping, and every procedure appears exactly once', () => {
  const procedures = {
    Wself: {factorySource: body(callSource('Wself'))},
    Wping: {factorySource: body(callSource('Wpong'))},
    Wpong: {factorySource: body(callSource('Wping'))},
    Wtail: {factorySource: body(callSource('Wself'))}
  };
  const order = orderProcedureVariants(procedures);
  assert.deepEqual([...order].sort(), ['Wping', 'Wpong', 'Wself', 'Wtail']);
  assert.ok(order.indexOf('Wself') < order.indexOf('Wtail'));
});

test('a very long call chain does not overflow the stack', () => {
  const n = 30000;
  const procedures = {};
  for (let i = 0; i < n; i++) procedures[`W${i}`] = {factorySource: body(i + 1 < n ? callSource(`W${i + 1}`) : '')};
  const order = orderProcedureVariants(procedures);
  assert.equal(order.length, n);
  assert.equal(order[0], `W${n - 1}`);
  assert.equal(order.at(-1), 'W0');
});

test('missing, non-string and unknown callee names are ignored', () => {
  assert.deepEqual(orderProcedureVariants({Wa: {factorySource: body(callSource('Wnowhere'))}, Wb: {}, Wc: {factorySource: 42}}), ['Wa', 'Wb', 'Wc']);
  assert.deepEqual(orderProcedureVariants(undefined), []);
});

// The ordering is only a hint. A call the hint cannot see must still be recovered, by retrying what failed.
test('a caller whose call the ordering cannot see is still recovered once its callee is', async () => {
  const fixture = await compiledFixture();
  const header = '(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();const b0=stage.variables["varId1"];return function* procbody(){';
  fixture.bundle.compiledTargets[0].procedures = {
    // Listed first, calls the second through spacing the regular expression of the hint does not match.
    'Wouter': {factorySource: `${header}${'yield* thread.procedures [ "Winner" ] ();'}return "";};})`},
    'Winner': {factorySource: `${header}b0.value = "inner";return "";};})`}
  };
  assert.deepEqual(orderProcedureVariants(fixture.bundle.compiledTargets[0].procedures), ['Wouter', 'Winner'], 'the hint cannot see this call');
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  const status = Object.fromEntries(result.procedures.map(p => [p.variant, p.status]));
  assert.deepEqual(status, {Wouter: 'reconstructed-unverified', Winner: 'reconstructed-unverified'}, JSON.stringify(result.unresolved.map(u => u.reason)));
  const blocks = Object.values(project.targets[0].blocks);
  assert.equal(blocks.filter(b => b.opcode === 'procedures_definition').length, 2);
  assert.equal(blocks.filter(b => b.opcode === 'procedures_call').length, 1);
  // Records keep the bundle's order whatever order they were decoded in.
  assert.deepEqual(result.procedures.map(p => p.variant), ['Wouter', 'Winner']);
});

test('a procedure that stays unrecoverable is reported once, with the reason from its last attempt', async () => {
  const fixture = await compiledFixture();
  const header = '(function proc(thread){const target=thread.target;const runtime=target.runtime;const stage=runtime.getTargetForStage();return function* procbody(){';
  fixture.bundle.compiledTargets[0].procedures = {
    Wcaller: {factorySource: `${header}yield* thread.procedures["Wbroken"]();return "";};})`},
    Wbroken: {factorySource: `${header}unknownStatement();return "";};})`}
  };
  const project = structuredClone(fixture.stripped);
  const result = recoverCompiledCode(project, fixture.bundle);
  assert.equal(result.unresolved.filter(u => u.kind === 'procedure').length, 2, 'one entry per failed procedure, however many passes ran');
  assert.deepEqual(result.procedures.map(p => p.status), ['unresolved', 'unresolved']);
  assert.ok(Object.values(project.targets[0].blocks).every(b => b.opcode !== 'procedures_definition'), 'nothing half-built is left behind');
});
