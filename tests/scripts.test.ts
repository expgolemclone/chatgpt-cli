import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { maxPrompts } from '../src/prompts/generate.ts';

test('PowerShell adapter runs current sources without builds, browsers, or task side effects', () => {
  assert.equal(process.platform, 'win32', 'This project requires Windows.');
  const script = fileURLToPath(new URL('./scripts.test.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-MaxPrompts', String(maxPrompts)], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
