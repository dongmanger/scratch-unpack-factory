import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptSignature} from '../bench/score.mjs';

// `bench/score.mjs` decides whether a recovered script counts as found, so its signature has to compare
// programs, not spellings. These cases pin the one normalization it applies.

const block = (opcode, extra = {}) => ({opcode, next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false, ...extra});

test('an if_else with an empty else branch compares equal to a plain if', () => {
  // The compiler emits identical code for both (verified by recompiling each shape), and authors leave
  // empty else branches behind: 30 of them in the sample project. A decoder that returns `if` is right.
  const withEmptyElse = {
    head: block('control_if_else', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body'], SUBSTACK2: [1, null]}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto')
  };
  const plainIf = {
    head: block('control_if', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body']}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto')
  };
  assert.equal(scriptSignature(withEmptyElse, 'head'), scriptSignature(plainIf, 'head'));
});

test('an if_else with a real else branch stays distinct from if', () => {
  const withElse = {
    head: block('control_if_else', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body'], SUBSTACK2: [2, 'other']}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto'),
    other: block('data_addtolist')
  };
  const plainIf = {
    head: block('control_if', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body']}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto')
  };
  assert.notEqual(scriptSignature(withElse, 'head'), scriptSignature(plainIf, 'head'));
});

test('a dangling else reference is treated as empty rather than as a body', () => {
  // SUBSTACK2 pointing at an id that is not in the block map is the same as no else branch.
  const dangling = {
    head: block('control_if_else', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body'], SUBSTACK2: [2, 'gone']}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto')
  };
  const plainIf = {
    head: block('control_if', {inputs: {CONDITION: [2, 'cond'], SUBSTACK: [2, 'body']}, topLevel: true}),
    cond: block('operator_equals'),
    body: block('data_setvariableto')
  };
  assert.equal(scriptSignature(dangling, 'head'), scriptSignature(plainIf, 'head'));
});
