import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchProfile, parseEndpoint } from '../src/browser/edge.ts';
import { createProfile } from '../src/browser/profiles.ts';

test('CDP endpoint metadata accepts only a loopback browser path and valid port', () => {
  assert.deepEqual(parseEndpoint('12345\n/devtools/browser/abc-123\n'),
    { port: 12345, endpoint: 'ws://127.0.0.1:12345/devtools/browser/abc-123' });
  for (const value of [
    '', '0\n/devtools/browser/id', '65536\n/devtools/browser/id', '1e3\n/devtools/browser/id',
    '12345\nhttps://outside.invalid/', '12345\n/devtools/browser/../outside',
    '12345\n/devtools/browser/id\nextra', '12345\n/devtools/browser/id?token=invalid',
  ]) assert.throws(() => parseEndpoint(value));
});

test('changed identities and linked CDP metadata cannot launch or redirect inspection', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-edge-boundary-');
  try {
    const profile = createProfile(join(temporary, 'profiles'));
    const identity = join(profile.path, '.gpt-usage-id');
    writeFileSync(identity, '0'.repeat(32));
    await assert.rejects(launchProfile(profile), /identity changed/);
    writeFileSync(identity, profile.id!);
    const outside = join(temporary, 'outside');
    writeFileSync(outside, 'untouched');
    const marker = join(profile.path, 'DevToolsActivePort');
    // A directory junction is also rejected as non-file metadata, without following it.
    symlinkSync(temporary, marker, 'junction');
    await assert.rejects(launchProfile(profile), /regular file/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    rmSync(marker);
    writeFileSync(marker, '12345\nhttps://outside.invalid/');
    await assert.rejects(launchProfile(profile), /Invalid Edge CDP endpoint/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('all browser entrypoints use installed Edge directly, never a Playwright browser launcher', () => {
  for (const path of ['src/main.ts','src/browser/edge.ts','src/browser/inspect.ts']) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /launchPersistentContext|chromium\.launch\s*\(/);
  }
});
