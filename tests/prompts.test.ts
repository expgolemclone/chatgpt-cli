import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptKinds } from '../src/prompts/catalog.ts';
import { generatePrompts, maxPrompts } from '../src/prompts/generate.ts';

const catalog = promptKinds.flatMap(kind => kind.prompts.map(prompt => ({
  id: `${kind.id}-${prompt.id}`, text: kind.prefix + prompt.text,
})));

test('each category contains ten independently written prompts rather than clause combinations', () => {
  assert.deepEqual(promptKinds.map(kind => kind.id), ['code-review', 'image', 'codex']);
  for (const kind of promptKinds) {
    assert.equal(kind.prompts.length, 10);
    assert.equal(new Set(kind.prompts.map(prompt => prompt.id)).size, 10);
    assert.equal(new Set(kind.prompts.map(prompt => prompt.text.split('\n')[0])).size, 10);
    for (const prompt of kind.prompts) {
      assert.match(prompt.id, /^[a-z]+(?:-[a-z0-9]+)*$/);
      assert.equal(prompt.text, prompt.text.trim());
      assert.ok(prompt.text.length > 80);
      const punctuation = prompt.text.replace(/\P{Punctuation}/gu, '');
      assert.doesNotMatch(punctuation, /[\u3000-\u303f\uff00-\uffef]/);
      assert.doesNotMatch(prompt.text, /コードレビューについて|開発するチーム向けに/);
    }
  }
  assert.equal(maxPrompts, 30);
  assert.equal(new Set(catalog.map(prompt => prompt.id)).size, maxPrompts);
  assert.equal(new Set(catalog.map(prompt => prompt.text)).size, maxPrompts);
});

test('selection preserves complete prompt bodies including code blocks and image commands', () => {
  const samples = generatePrompts('a'.repeat(32), 'test-seed', maxPrompts);
  assert.deepEqual([...samples].sort((a, b) => a.id.localeCompare(b.id)),
    [...catalog].sort((a, b) => a.id.localeCompare(b.id)));
  for (const prompt of samples) {
    assert.doesNotMatch(prompt.text, /undefined|[a-f0-9]{32}|test-seed/);
    if (prompt.id.startsWith('code-review-')) {
      assert.match(prompt.text, /```js\n/);
      assert.doesNotMatch(prompt.text, /@create image|^Codex/);
    } else if (prompt.id.startsWith('image-')) {
      assert.match(prompt.text, /^@create image\n/);
      assert.match(prompt.text, /文字や企業ロゴは入れないでください/);
      assert.doesNotMatch(prompt.text, /```|^Codex/);
    } else {
      assert.match(prompt.text, /^Codexを社内で導入検討している\./);
      assert.doesNotMatch(prompt.text, /@create image|```/);
    }
  }
});

test('every batch is duplicate-free and visits all categories before repeating one', () => {
  for (let seed = 0; seed < 50; seed++) {
    const samples = generatePrompts(`profile-${seed}`, `seed-${seed}`, maxPrompts);
    assert.equal(new Set(samples.map(prompt => prompt.id)).size, maxPrompts);
    assert.equal(new Set(samples.map(prompt => prompt.text)).size, maxPrompts);
    for (let start = 0; start < maxPrompts; start += promptKinds.length) {
      const round = samples.slice(start, start + promptKinds.length);
      for (const kind of promptKinds) {
        assert.equal(round.filter(prompt => prompt.id.startsWith(`${kind.id}-`)).length, 1);
      }
    }
    assert.equal(new Set(generatePrompts(`profile-${seed}`, `seed-${seed}`)
      .map(prompt => promptKinds.find(kind => prompt.id.startsWith(`${kind.id}-`))!.id)).size, 3);
  }
});

test('profile and seed change the order reproducibly without history or catalog mutation', () => {
  const before = structuredClone(promptKinds);
  const expected = generatePrompts('a', 'one');
  assert.equal(expected.length, 5);
  assert.notDeepEqual(expected, generatePrompts('b', 'one'));
  assert.notDeepEqual(expected, generatePrompts('a', 'two'));
  assert.deepEqual(generatePrompts('a', 'one'), expected);
  expected[0]!.text = 'Caller edit';
  assert.notEqual(generatePrompts('a', 'one')[0]!.text, 'Caller edit');
  assert.deepEqual(promptKinds, before);
});

test('every supported batch size retains the same reproducible prefix', () => {
  const expected = generatePrompts('a', 'batch', maxPrompts);
  for (let count = 1; count <= maxPrompts; count++) {
    assert.deepEqual(generatePrompts('a', 'batch', count), expected.slice(0, count));
  }
});

test('invalid counts fail instead of repeating prompts to fill a batch', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, -Infinity, maxPrompts + 1]) {
    assert.throws(() => generatePrompts('a', 'seed', count), {
      message: `Prompt count must be between 1 and ${maxPrompts}.`,
    });
  }
});
