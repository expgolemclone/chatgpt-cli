import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { failureCooldownMs, readPromptHistory } from '../src/prompts/history.ts';

const line = (event: string, time: string, promptId?: string) => JSON.stringify({ event, time, promptId });

test('history uses latest attempted sends, including failures and uncertain outcomes', () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-prompt-history-');
  try {
    const logs = join(temporary, 'logs');
    assert.deepEqual([...readPromptHistory(logs)], []);
    mkdirSync(logs);
    const first = [
      line('started', '2026-01-01T00:00:00.000Z'),
      line('sending', '2026-01-01T00:00:01.000Z', 'image-first'),
      line('sent', '2026-01-01T00:00:02.000Z', 'image-first'),
      line('sending', '2026-01-01T00:00:03.000Z', 'codex-uncertain'),
      line('profile-failed', '2026-01-01T00:00:04.000Z'),
      line('sent', '2026-01-01T00:00:05.000Z', 'sent-without-attempt'),
      line('planned', '2026-01-01T00:00:06.000Z', 'planned-only'),
    ].join('\n') + '\n';
    const second = [
      line('sending', '2026-01-02T00:00:01.000Z', 'image-first'),
      line('sending', '2025-12-31T00:00:01.000Z', 'image-first'),
    ].join('\n') + '\n';
    writeFileSync(join(logs, 'a.jsonl'), first);
    writeFileSync(join(logs, 'b.jsonl'), second);
    writeFileSync(join(logs, 'ignored.txt'), 'not JSON');
    assert.deepEqual(readPromptHistory(logs), new Map([
      ['image-first', Date.parse('2026-01-02T00:00:01.000Z')],
      ['codex-uncertain', Date.parse('2026-01-01T00:00:03.000Z')],
    ]));
    assert.equal(readFileSync(join(logs, 'a.jsonl'), 'utf8'), first);
    assert.equal(readFileSync(join(logs, 'b.jsonl'), 'utf8'), second);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('incomplete or failed sends enforce a cooldown that expires and cannot be cleared by non-send logs', () => {
  const directory = mkdtempSync('C:/dev/tmp/chatgpt-partial-send-');
  try {
    const previous = join(directory, 'z.jsonl');
    const startedAt = Date.parse('2026-01-01T00:00:01.000Z');
    const attempted = line('sending', '2026-01-01T00:00:01.000Z', 'first');
    const success = JSON.stringify({ event: 'finished', success: true });
    const failure = JSON.stringify({ event: 'finished', success: false, time: '2026-01-01T00:00:03.000Z' });
    writeFileSync(previous, attempted); // Interrupted before completion.
    assert.throws(() => readPromptHistory(directory, failureCooldownMs, startedAt + 5 * 60_000), /cooling down until/);
    assert.equal(readPromptHistory(directory, failureCooldownMs, startedAt + failureCooldownMs).size, 1);

    writeFileSync(previous, [attempted, line('sent', '2026-01-01T00:00:02.000Z', 'first'), failure].join('\n'));
    writeFileSync(join(directory, 'open.jsonl'), [
      JSON.stringify({ event: 'started', command: 'open', time: '2026-01-01T00:05:00.000Z' }),
      JSON.stringify({ event: 'finished', success: true, time: '2026-01-01T00:05:01.000Z' }),
    ].join('\n'));
    const failedAt = Date.parse('2026-01-01T00:00:03.000Z');
    assert.throws(() => readPromptHistory(directory, failureCooldownMs, failedAt + 29 * 60_000), /cooling down until/);
    assert.equal(readPromptHistory(directory).size, 1); // Preview remains available.
    assert.equal(readPromptHistory(directory, failureCooldownMs, failedAt + failureCooldownMs).size, 1);

    // A send run that fails before any submission (e.g. Cloudflare on profile 1) also cools down.
    const blocked = join(directory, 'blocked.jsonl');
    const blockedAt = Date.parse('2026-01-01T02:00:05.000Z');
    writeFileSync(blocked, [
      JSON.stringify({ event: 'started', command: 'send', time: '2026-01-01T02:00:00.000Z' }),
      JSON.stringify({ event: 'finished', success: false, time: '2026-01-01T02:00:05.000Z' }),
    ].join('\n'));
    assert.throws(() => readPromptHistory(directory, failureCooldownMs, blockedAt + 5 * 60_000), /cooling down until/);
    assert.equal(readPromptHistory(directory, failureCooldownMs, blockedAt + failureCooldownMs).size, 1);

    // Equal timestamps fail closed during cooldown, and a newer completed send clears it immediately.
    const next = join(directory, 'a.jsonl');
    writeFileSync(next, [line('sending', '2026-01-01T02:00:05.000Z', 'tied'), success].join('\n'));
    assert.throws(() => readPromptHistory(directory, failureCooldownMs, blockedAt + 5 * 60_000), /cooling down until/);
    writeFileSync(next, [line('sending', '2026-01-01T02:01:00.000Z', 'second'), success].join('\n'));
    assert.equal(readPromptHistory(directory, failureCooldownMs, Date.parse('2026-01-01T02:02:00.000Z')).size, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('malformed logs and invalid sending events fail instead of silently losing history', () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-prompt-history-invalid-');
  try {
    const file = join(temporary, 'broken.jsonl');
    for (const contents of ['{', line('sending', 'bad time', 'id'),
      line('sending', '2026-01-01T00:00:00.000Z'), line('sending', '2026-01-01T00:00:00.000Z', '')]) {
      writeFileSync(file, contents);
      assert.throws(() => readPromptHistory(temporary), /Invalid (prompt log|sending event)/);
      assert.equal(readFileSync(file, 'utf8'), contents);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
