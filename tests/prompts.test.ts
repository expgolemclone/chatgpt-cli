import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptKinds } from '../src/prompts/catalog.ts';
import { generateBatches, maxPrompts } from '../src/prompts/generate.ts';

const catalog = promptKinds.flatMap(kind => kind.prompts.map(prompt => ({
  id: `${kind.id}-${prompt.id}`, text: kind.prefix + prompt.text,
})));
const categoryOf = (id: string) => promptKinds.find(kind => id.startsWith(`${kind.id}-`))!.id;

test('catalog contains complete independent prompts across varied subjects and media', () => {
  assert.deepEqual(promptKinds.map(kind => kind.id), ['code-review', 'image', 'codex']);
  for (const kind of promptKinds) {
    assert.equal(kind.prompts.length, 50);
    assert.equal(new Set(kind.prompts.map(prompt => prompt.id)).size, 50);
    assert.equal(new Set(kind.prompts.map(prompt => prompt.text.split('\n')[0])).size, 50);
    for (const prompt of kind.prompts) {
      assert.match(prompt.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      assert.equal(prompt.text, prompt.text.trim());
      assert.ok(prompt.text.length > 80, prompt.id);
      assert.doesNotMatch(prompt.text.replace(/\P{Punctuation}/gu, ''), /[\u3000-\u303f\uff00-\uffef]/);
      assert.doesNotMatch(prompt.text, /コードレビューについて|開発するチーム向けに/);
    }
  }
  assert.equal(maxPrompts, 150);
  assert.equal(new Set(catalog.map(prompt => prompt.id)).size, maxPrompts);
  assert.equal(new Set(catalog.map(prompt => prompt.text)).size, maxPrompts);
  const languages = new Set(promptKinds[0].prompts.map(prompt => prompt.text.match(/```(\w+)\n/)?.[1]));
  assert.ok(languages.size >= 8, JSON.stringify([...languages]));
});

test('selection preserves complete prompt bodies, code blocks, image commands, and Codex context', () => {
  const samples = generateBatches(['profile'], 'test-seed', maxPrompts)[0]!;
  assert.deepEqual([...samples].sort((a, b) => a.id.localeCompare(b.id)),
    [...catalog].sort((a, b) => a.id.localeCompare(b.id)));
  for (const prompt of samples) {
    assert.doesNotMatch(prompt.text, /test-seed/);
    if (prompt.id.startsWith('code-review-')) {
      assert.match(prompt.text, /```\w+\n/);
      assert.doesNotMatch(prompt.text, /@create image/);
    } else if (prompt.id.startsWith('image-')) {
      assert.match(prompt.text, /^@create image\n文字や企業ロゴは入れないでください\.\n/);
      assert.doesNotMatch(prompt.text, /```/);
    } else {
      assert.match(prompt.text, /Codex/);
      assert.doesNotMatch(prompt.text, /@create image|```/);
    }
  }
});

test('profile batches are distinct and globally balanced before the catalog is exhausted', () => {
  const profiles = ['a', 'b', 'c', 'd', 'e'];
  for (let seed = 0; seed < 30; seed++) {
    for (const count of [1, 2, 3, 5, 13, 30]) {
      const batches = generateBatches(profiles, `seed-${seed}`, count);
      assert.equal(batches.length, profiles.length);
      const ids = batches.flat().map(prompt => prompt.id);
      assert.equal(new Set(ids).size, ids.length, `${seed}, ${count}`);
      for (const batch of batches) {
        assert.equal(batch.length, count);
        for (let start = 0; start + 3 <= count; start += 3) {
          assert.equal(new Set(batch.slice(start, start + 3).map(prompt => categoryOf(prompt.id))).size, 3);
        }
      }
      const totals = promptKinds.map(kind => ids.filter(id => id.startsWith(`${kind.id}-`)).length);
      assert.ok(Math.max(...totals) - Math.min(...totals) <= 1, JSON.stringify(totals));
    }
  }
});

test('when the catalog is exhausted, each profile still receives no duplicates', () => {
  const batches = generateBatches(['first', 'second'], 'exhausted', maxPrompts);
  for (const batch of batches) {
    assert.equal(batch.length, maxPrompts);
    assert.equal(new Set(batch.map(prompt => prompt.id)).size, maxPrompts);
  }
  assert.equal(new Set(batches.flat().map(prompt => prompt.id)).size, maxPrompts);
});

test('unchanged seed, profiles, and history reproduce the same plan without mutation', () => {
  const before = structuredClone(promptKinds);
  const history = new Map([[catalog[0]!.id, 100]]);
  const expected = generateBatches(['a', 'b'], 'one', 5, history);
  assert.deepEqual(generateBatches(['a', 'b'], 'one', 5, history), expected);
  assert.notDeepEqual(generateBatches(['a', 'b'], 'two', 5, history), expected);
  assert.notDeepEqual(generateBatches(['a', 'c'], 'one', 5, history), expected);
  expected[0]![0]!.text = 'Caller edit';
  assert.notEqual(generateBatches(['a', 'b'], 'one', 5, history)[0]![0]!.text, 'Caller edit');
  assert.deepEqual([...history], [[catalog[0]!.id, 100]]);
  assert.deepEqual(promptKinds, before);
});

test('unused prompts are preferred, then the least recently attempted in each category', () => {
  const history = new Map(catalog.map((prompt, index) => [prompt.id, index + 1]));
  const unused = promptKinds.map(kind => `${kind.id}-${kind.prompts[25]!.id}`);
  for (const id of unused) history.delete(id);
  assert.deepEqual(new Set(generateBatches(['profile'], 'fresh', 3, history)[0]!.map(prompt => prompt.id)),
    new Set(unused));
  for (const id of unused) history.set(id, 1000);
  const oldest = promptKinds.map(kind => `${kind.id}-${kind.prompts[0]!.id}`);
  assert.deepEqual(new Set(generateBatches(['profile'], 'oldest', 3, history)[0]!.map(prompt => prompt.id)),
    new Set(oldest));
});

test('after exhaustion, category allocation also prefers the oldest available prompts', () => {
  const history = new Map(catalog.map(prompt => [prompt.id, 1000]));
  const code = promptKinds[0];
  const image = promptKinds[1];
  const codex = promptKinds[2];
  history.set(`${code.id}-${code.prompts[0]!.id}`, 1);
  history.set(`${codex.id}-${codex.prompts[0]!.id}`, 2);
  history.set(`${image.id}-${image.prompts[0]!.id}`, 20);
  history.set(`${image.id}-${image.prompts[1]!.id}`, 21);
  for (let seed = 0; seed < 10; seed++) {
    const single = generateBatches(['a'], `single-${seed}`, 1, history)[0]!;
    assert.equal(single[0]!.id, `${code.id}-${code.prompts[0]!.id}`);
    const four = generateBatches(['a'], `four-${seed}`, 4, history)[0]!;
    assert.deepEqual(new Set(four.map(prompt => prompt.id)), new Set([
      `${code.id}-${code.prompts[0]!.id}`, `${codex.id}-${codex.prompts[0]!.id}`,
      `${image.id}-${image.prompts[0]!.id}`, `${image.id}-${image.prompts[1]!.id}`,
    ]));
  }
});

test('four full five-profile runs do not repeat the original catalog or each other', () => {
  const history = new Map<string, number>();
  for (const kind of promptKinds) {
    for (const prompt of kind.prompts.slice(0, 10)) history.set(`${kind.id}-${prompt.id}`, 1);
  }
  for (let run = 0; run < 4; run++) {
    const batches = generateBatches(['a', 'b', 'c', 'd', 'e'], `run-${run}`, 5, history);
    const ids = batches.flat().map(prompt => prompt.id);
    assert.equal(new Set(ids).size, 25);
    for (const id of ids) {
      assert.equal(history.has(id), false, `${run}: ${id}`);
      history.set(id, run + 2);
    }
  }
  assert.equal(history.size, 130);
});

test('invalid counts fail instead of repeating prompts to fill a profile', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, -Infinity, maxPrompts + 1]) {
    assert.throws(() => generateBatches(['profile'], 'seed', count), {
      message: `Prompt count must be between 1 and ${maxPrompts}.`,
    });
  }
});
