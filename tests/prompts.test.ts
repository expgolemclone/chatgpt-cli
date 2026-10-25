import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptKinds } from '../src/prompts/catalog.js';
import { generatePrompts, maxPrompts } from '../src/prompts/generate.js';

const samples = generatePrompts('a'.repeat(32), 'test-seed', 600);

test('each category has four sets of ten meaningful clauses and 10,000 distinct combinations', () => {
  assert.deepEqual(promptKinds.map(kind => kind.id), ['code-review', 'image', 'codex']);
  for (const kind of promptKinds) {
    assert.equal(kind.parts.length, 4);
    let combinations = [''];
    for (const parts of kind.parts) {
      assert.equal(parts.length, 10);
      assert.equal(new Set(parts).size, 10);
      for (const part of parts) {
        assert.equal(part, part.trim());
        assert.doesNotMatch(part, /[,\n\u3000-\u303f\uff00-\uffef]/);
        assert.ok(part.length > 0);
      }
      combinations = combinations.flatMap(prefix => parts.map(part => prefix ? `${prefix}, ${part}` : part));
    }
    assert.equal(combinations.length, 10_000);
    assert.equal(new Set(combinations).size, 10_000);
  }
  assert.equal(maxPrompts, 30_000);
});

test('generated text contains only the four selected clauses and the category instructions', () => {
  for (const prompt of samples) {
    const kind = promptKinds.find(kind => prompt.id.startsWith(`${kind.id}-`));
    assert.ok(kind);
    const indices = prompt.id.slice(kind.id.length + 1);
    assert.match(indices, /^[0-9]{4}$/);
    const parts = kind.parts.map((options, part) => options[Number(indices[part])]!);
    assert.equal(prompt.text, kind.prefix + parts.join(', ') + kind.ending);
    assert.equal(prompt.text.split(', ').length, 4);
    assert.doesNotMatch(prompt.text, /undefined|[a-f0-9]{32}|test-seed|code-review-[0-9]|image-[0-9]|codex-[0-9]/);
  }
  for (const kind of promptKinds) {
    const selected = samples.filter(prompt => prompt.id.startsWith(`${kind.id}-`));
    assert.ok(selected.length > 0);
    for (let part = 0; part < 4; part++) {
      assert.equal(new Set(selected.map(prompt => prompt.id.slice(-4)[part])).size, 10);
    }
  }
});

test('categories retain code review, literal image commands, and Codex adoption questions', () => {
  for (const prompt of samples) {
    if (prompt.id.startsWith('code-review-')) {
      assert.match(prompt.text, /コードレビューについて/);
      assert.doesNotMatch(prompt.text, /@create image|^Codex/);
    } else if (prompt.id.startsWith('image-')) {
      assert.match(prompt.text, /^@create image\n\S/);
      assert.match(prompt.text, /作成してください\. 文字や企業ロゴは入れないでください\.$/);
      assert.doesNotMatch(prompt.text, /```|^Codex/);
    } else {
      assert.match(prompt.text, /^Codexを社内で導入検討している\./);
      assert.doesNotMatch(prompt.text, /@create image|```/);
    }
  }
  const codex = promptKinds.find(kind => kind.id === 'codex')!;
  assert.ok(codex.parts[1].some(part => /PoC/.test(part)));
  assert.ok(codex.parts[1].some(part => /機密情報/.test(part)));
  assert.ok(codex.parts[1].some(part => /費用対効果/.test(part)));
});

test('profile and seed change the selection without keeping prompt history', () => {
  const before = structuredClone(promptKinds);
  const expected = generatePrompts('a', 'one');
  assert.notDeepEqual(expected, generatePrompts('b', 'one'));
  assert.notDeepEqual(expected, generatePrompts('a', 'two'));
  assert.deepEqual(generatePrompts('a', 'one'), expected);
  assert.deepEqual(promptKinds, before);
  assert.equal(expected.length, 2);
});

test('supported batch sizes retain a reproducible prefix', () => {
  const expected = generatePrompts('a', 'batch', maxPrompts);
  for (const count of [1, 2, 7, 13, 100]) {
    assert.deepEqual(generatePrompts('a', 'batch', count), expected.slice(0, count));
  }
  assert.equal(expected.length, maxPrompts);
});

test('invalid counts fail instead of sending an unexpected batch', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, -Infinity, maxPrompts + 1]) {
    assert.throws(() => generatePrompts('a', 'seed', count), {
      message: `Prompt count must be between 1 and ${maxPrompts}.`,
    });
  }
});
