import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { terminateProfiles } from '../../src/browser/processes.ts';
import type { Profile } from '../../src/browser/profiles.ts';

export const manualPreload = `
  import assert from 'node:assert/strict';
  import childProcess from 'node:child_process';
  import {appendFileSync,readFileSync} from 'node:fs';
  import {syncBuiltinESMExports} from 'node:module';
  import {join} from 'node:path';
  const spawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    assert.match(file, /Microsoft[\\\\/]Edge[\\\\/]Application[\\\\/]msedge.exe$/i);
    assert.equal(options.detached, true);
    assert.equal(options.stdio, 'ignore');
    assert.ok(!args.some(arg => /remote-debugging|enable-automation|headless|test-type|use-mock-keychain|password-store/.test(arg)));
    const directory = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    assert.ok(args.includes('--new-window'));
    const url = args.at(-1);
    const padding = globalThis.process.env.FIXTURE_PADDING ? ['--fixture-padding=' + 'x'.repeat(900)] : [];
    const process = spawn(file, [...padding, ...args.slice(0,-1), globalThis.process.env.FIXTURE_URL], options);
    process.once('spawn', () => appendFileSync(globalThis.process.env.FIXTURE_LAUNCHES,
      JSON.stringify({pid:process.pid,directory,url,args})+'\\n'));
    return process;
  };
  syncBuiltinESMExports();
`;

export async function closeWindow(pid: number): Promise<void> {
  try { process.kill(pid, 0); } catch { return; }
  // Gracefully close only the disposable window started by this test, so browser data is flushed.
  execFileSync('taskkill.exe', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await setTimeout(100);
  }
  throw new Error('Disposable ordinary Edge window did not close.');
}

/** A detached launcher's exit does not mean every process using the disposable profile has exited. */
export async function removeNativeFixture(temporary: string, profiles: Profile[]): Promise<void> {
  await terminateProfiles(profiles);
  await rm(temporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
