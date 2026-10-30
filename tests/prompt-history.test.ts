import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPromptHistory } from '../src/prompts/history.ts';

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
