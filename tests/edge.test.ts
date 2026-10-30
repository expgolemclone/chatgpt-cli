import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chromium, type Browser } from 'playwright';
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

for (const exits of [true, false]) {
  test(`cleanup verifies the owned parent after taskkill reports a child failure: exits=${exits}`, async t => {
    const temporary = mkdtempSync('C:/dev/tmp/gpt-edge-cleanup-');
    const profile = createProfile(join(temporary, 'profiles'));
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 32123 });
    const terminationError = new Error('A child process has already exited.');
    let killed = false;
    let disconnected = false;
    let clock = 0;
    const browser = {
      isConnected: () => true,
      contexts: () => [{}],
      newBrowserCDPSession: async () => ({ send: async () => {} }),
      close: async () => { disconnected = true; },
    } as unknown as Browser;
    t.mock.method(Date, 'now', () => clock += 11_000);
    t.mock.method(childProcess, 'execFileSync', ((file: string, args: string[]) => {
      if (file === 'reg.exe') return 'REG_SZ C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
      if (file === 'netstat.exe') return child.exitCode === null ? 'TCP 127.0.0.1:12345 0.0.0.0:0 LISTENING 32123' : '';
      assert.equal(file, 'taskkill.exe');
      assert.deepEqual(args, ['/PID', '32123', '/T', '/F']);
      killed = true;
      if (exits) Object.defineProperty(child, 'exitCode', { value: 0 });
      throw terminationError;
    }) as typeof childProcess.execFileSync);
    t.mock.method(childProcess, 'spawn', (() => {
      writeFileSync(join(profile.path, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n');
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as typeof childProcess.spawn);
    t.mock.method(chromium, 'connectOverCDP', async () => browser);
    syncBuiltinESMExports();
    try {
      const edge = await launchProfile(profile);
      if (exits) await edge.close();
      else await assert.rejects(edge.close(), error => error instanceof Error &&
        error.message === 'Owned Edge process did not exit.' && error.cause === terminationError);
      assert.equal(killed, true);
      assert.equal(disconnected, exits);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('all browser entrypoints use installed Edge directly, never a Playwright browser launcher', () => {
  for (const path of ['src/main.ts','src/browser/edge.ts','src/browser/inspect.ts']) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /launchPersistentContext|chromium\.launch\s*\(/);
  }
});
