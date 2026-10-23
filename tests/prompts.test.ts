import assert from 'node:assert/strict';
import { test } from 'node:test';
import { templates } from '../src/prompts/catalog.js';
import { generatePrompts, maxPrompts } from '../src/prompts/generate.js';

const allPrompts = () => generatePrompts('a'.repeat(32), 'test-seed', maxPrompts);

test('prompts are reproducible and cover the catalog without repeating templates', () => {
  const prompts = allPrompts();
  assert.deepEqual(prompts, allPrompts());
  assert.equal(maxPrompts, templates.length);
  assert.equal(prompts.length, maxPrompts);
  assert.equal(new Set(prompts.map(prompt => prompt.id)).size, maxPrompts);
  assert.deepEqual(new Set(prompts.map(prompt => prompt.id)), new Set(templates.map(template => template.id)));
  for (const prompt of prompts) {
    assert.match(prompt.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(prompt.text.trim().length > 0);
  }
});

test('existing code review templates retain their instructions and code blocks', () => {
  const prompts = allPrompts();
  for (const id of ['off-by-one', 'mutable-default', 'async-foreach', 'mutating-sort', 'late-binding', 'integer-division']) {
    const prompt = prompts.find(item => item.id === id);
    assert.ok(prompt, id);
    assert.match(prompt.text, /^次のコードをレビューしてください\./);
    assert.match(prompt.text, /```(?:typescript|python)\n[\s\S]+\n```$/);
  }
});

test('image templates retain the literal command prefix without code review instructions', () => {
  const prompts = allPrompts().filter(prompt => prompt.id.startsWith('image-'));
  assert.ok(prompts.length >= 3);
  assert.equal(new Set(prompts.map(prompt => prompt.text)).size, prompts.length);
  for (const prompt of prompts) {
    assert.match(prompt.text, /^@create image\n\S/);
    assert.doesNotMatch(prompt.text, /次のコードをレビュー|```/);
  }
});

test('Codex adoption templates cover pilot, security, and cost discussions', () => {
  const prompts = allPrompts();
  for (const [id, topic] of [
    ['codex-pilot', /PoC/],
    ['codex-security', /セキュリティ/],
    ['codex-cost-and-rollout', /費用対効果/],
  ] as const) {
    const prompt = prompts.find(item => item.id === id);
    assert.ok(prompt, id);
    assert.match(prompt.text, /^Codexを社内で導入検討している\./);
    assert.match(prompt.text, topic);
    assert.doesNotMatch(prompt.text, /次のコードをレビュー|```/);
  }
});

test('profile and seed affect locally generated prompts', () => {
  assert.notDeepEqual(generatePrompts('a', 'one'), generatePrompts('b', 'one'));
  assert.notDeepEqual(generatePrompts('a', 'one'), generatePrompts('a', 'two'));
});

test('the default batch contains exactly two prompts', () => {
  assert.equal(generatePrompts('a', 'one').length, 2);
});

test('every supported batch size works without consuming the catalog', () => {
  const expected = allPrompts();
  for (let count = 1; count <= maxPrompts; count++) {
    const prompts = generatePrompts('a'.repeat(32), 'test-seed', count);
    assert.deepEqual(prompts, expected.slice(0, count));
  }
  assert.deepEqual(allPrompts(), expected);
});

test('invalid counts fail instead of sending an unexpected batch', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, -Infinity, maxPrompts + 1]) {
    assert.throws(() => generatePrompts('a', 'seed', count), {
      message: `Prompt count must be between 1 and ${maxPrompts}.`,
    });
  }
});
