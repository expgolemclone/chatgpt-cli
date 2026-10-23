import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrompts, maxQuestions } from '../src/prompts.js';

test('prompts are reproducible, contain code, and do not repeat templates', () => {
  const prompts = generatePrompts('a'.repeat(32), 'test-seed', maxQuestions);
  assert.deepEqual(prompts, generatePrompts('a'.repeat(32), 'test-seed', maxQuestions));
  assert.equal(new Set(prompts.map(prompt => prompt.id)).size, maxQuestions);
  for (const prompt of prompts) {
    assert.match(prompt.text, /```(?:typescript|python)\n[\s\S]+\n```/);
  }
});

test('profile and seed affect locally generated questions', () => {
  assert.notDeepEqual(generatePrompts('a', 'one'), generatePrompts('b', 'one'));
  assert.notDeepEqual(generatePrompts('a', 'one'), generatePrompts('a', 'two'));
});

test('the default batch contains exactly two programming questions', () => {
  assert.equal(generatePrompts('a', 'one').length, 2);
});

test('invalid counts fail instead of sending an unexpected batch', () => {
  for (const count of [0, -1, 1.5, NaN, maxQuestions + 1]) {
    assert.throws(() => generatePrompts('a', 'seed', count));
  }
});
