import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const lock = new URL('../src/send-lock.ts', import.meta.url).href;
const preload = new URL('./fixtures/send-lock.mjs', import.meta.url).href;

test('send is exclusive across processes and recovers when its owner is killed', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-send-lock-');
  const localAppData = join(temporary, 'localappdata');
  const profile = join(temporary, 'profile');
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  const holder = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', `
    import { acquireSendLock } from ${JSON.stringify(lock)};
    acquireSendLock();
    console.log('locked');
    process.stdin.resume();
  `], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  holder.stderr.setEncoding('utf8');
  holder.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const result = await Promise.race([
      once(holder.stdout, 'data').then(([chunk]) => String(chunk).trim()),
      once(holder, 'exit').then(([code]) => { throw new Error(`Lock owner exited: ${code} ${stderr}`); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Lock owner did not start.')), 10_000);
        timer.unref();
      }),
    ]);
    assert.equal(result, 'locked');

    const send = spawnSync(process.execPath, ['--import', preload, cli, 'send', '--profile', profile], {
      encoding: 'utf8', timeout: 10_000, env,
    });
    assert.equal(send.status, 1, send.stdout + send.stderr);
    assert.match(send.stderr, /Another chatgpt-cli send is already running/);
    assert.equal(existsSync(localAppData), false, 'a rejected send creates no state');
    assert.equal(existsSync(profile), false, 'a rejected send does not touch profiles');

    const preview = spawnSync(process.execPath, ['--import', preload, cli, 'send', '--profile', profile, '--dry-run'], {
      encoding: 'utf8', timeout: 10_000, env,
    });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(existsSync(localAppData), false, 'preview remains read-only');

    assert.equal(holder.kill(), true);
    await once(holder, 'exit');
    const successor = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', `
      import { acquireSendLock } from ${JSON.stringify(lock)};
      const release = acquireSendLock();
      release();
    `], { encoding: 'utf8', timeout: 10_000, env });
    assert.equal(successor.status, 0, successor.stdout + successor.stderr);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill();
      await once(holder, 'exit');
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
