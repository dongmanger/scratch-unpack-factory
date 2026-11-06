import test from 'node:test';
import assert from 'node:assert/strict';
import {planProcedureRecovery} from '../src/procedure-dependencies.mjs';

const source = body => `(function factory(thread){return function body(){${body}};})`;
const signatures = (...entries) => new Map(entries.map(([variant, body]) => [variant.slice(1), {
  code: variant.slice(1),
  types: [],
  ids: [],
  names: [],
  warp: variant[0] === 'W',
  variants: [{variant, entry: {factorySource: source(body)}, warp: variant[0] === 'W', yields: false}]
}]));
const componentVariants = plan => plan.components.map(component => component.variants);

 test('orders forward procedure dependencies before their callers', () => {
  const plan = planProcedureRecovery(signatures(
    ['Zcaller', 'thread.procedures["Zcallee"]();'],
    ['Zcallee', 'return;']
  ));
  assert.deepEqual(componentVariants(plan), [['Zcallee'], ['Zcaller']]);
  assert.deepEqual(plan.dependencies, {Zcallee: [], Zcaller: ['Zcallee']});
  assert.deepEqual(plan.unresolved, []);
});

test('orders a self-recursive procedure as one recursive component', () => {
  const plan = planProcedureRecovery(signatures(['Zself', 'thread.procedures["Zself"]();']));
  assert.deepEqual(componentVariants(plan), [['Zself']]);
  assert.equal(plan.components[0].recursive, true);
  assert.deepEqual(plan.components[0].dependencies, []);
});

test('keeps mutual recursion in one component and reports no outside dependency', () => {
  const plan = planProcedureRecovery(signatures(
    ['Zleft', 'thread.procedures["Zright"]();'],
    ['Zright', 'thread.procedures["Zleft"]();']
  ));
  assert.deepEqual(componentVariants(plan), [['Zleft', 'Zright']]);
  assert.equal(plan.components[0].recursive, true);
  assert.deepEqual(plan.components[0].dependencies, []);
});

test('keeps W and Z variants distinct and does not conflate same-code variants', () => {
  const plan = planProcedureRecovery(new Map([
    ['same', {code: 'same', types: [], ids: [], names: [], variants: [
      {variant: 'Wsame', entry: {factorySource: source('thread.procedures["Zcallee"]();')}, warp: true, yields: false},
      {variant: 'Zsame', entry: {factorySource: source('thread.procedures["Wcallee"]();')}, warp: false, yields: false}
    ]}],
    ['callee', {code: 'callee', types: [], ids: [], names: [], variants: [
      {variant: 'Wcallee', entry: {factorySource: source('return;')}, warp: true, yields: false},
      {variant: 'Zcallee', entry: {factorySource: source('return;')}, warp: false, yields: false}
    ]}]
  ]));
  assert.deepEqual(componentVariants(plan), [['Wcallee'], ['Zcallee'], ['Wsame'], ['Zsame']]);
  assert.deepEqual(plan.dependencies.Wsame, ['Zcallee']);
  assert.deepEqual(plan.dependencies.Zsame, ['Wcallee']);
});

test('recognizes static computed keys and yieldThenCall first arguments', () => {
  const plan = planProcedureRecovery(signatures(
    ['Zcaller', 'yieldThenCall(thread.procedures[`Zcallee`]);'],
    ['Zcallee', 'thread.procedures.Zleaf();'],
    ['Zleaf', 'return;']
  ));
  assert.deepEqual(componentVariants(plan), [['Zleaf'], ['Zcallee'], ['Zcaller']]);
});

test('reports dynamic keys, aliases, and unknown variants transparently', () => {
  const plan = planProcedureRecovery(new Map([
    ['caller', {code: 'caller', variants: [{variant: 'Zcaller', entry: {factorySource: source(`const key = "Zcallee"; thread.procedures[key](); const procedures = thread.procedures; procedures.Zother(); thread.procedures["Zmissing"]();`)}}]}],
    ['callee', {code: 'callee', variants: [{variant: 'Zcallee', entry: {factorySource: source('return;')}}]}]
  ]));
  assert.deepEqual(plan.dependencies.Zcaller, ['Zmissing']);
  assert.ok(plan.unresolved.some(item => item.variant === 'Zcaller' && item.reason.includes('dynamic')));
  assert.ok(plan.unresolved.some(item => item.variant === 'Zcaller' && item.reason.includes('alias')));
  assert.ok(plan.unresolved.some(item => item.variant === 'Zcaller' && item.reason.includes('unknown procedure variant dependency: Zmissing')));
  assert.deepEqual(componentVariants(plan), [['Zcallee'], ['Zcaller']]);
});

test('ignores thread.procedures calls when an inner function parameter shadows thread', () => {
  const plan = planProcedureRecovery(signatures(
    ['Zouter', '(function(thread){thread.procedures["Zignored"]();})(null); return;'],
    ['Zignored', 'return;']
  ));
  assert.deepEqual(plan.dependencies.Zouter, []);
  assert.deepEqual(plan.unresolved, []);
});
