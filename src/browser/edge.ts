import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { Browser, BrowserContext } from 'playwright';
import { assertProfileDirectory, readProfileId, type Profile } from './profiles.ts';
import { readRegularFile } from '../storage/files.ts';

const edgeArguments = ['--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-features=msImplicitSignin,msEnableWebToBrowserSignIn,msEnableAADWebToBrowserSignIn,msSeamlessWebToBrowserSignIn,msEdgeOnRampImport,msEdgeFRESpartanImportAllowed,msEdgeContinuousMigrationUser'];

function edgeExecutable(): string {
  const value = execFileSync('reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', '/ve'],
    { encoding: 'utf8', windowsHide: true }).match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
  if (!value || !isAbsolute(value)) throw new Error('Installed Microsoft Edge App Path is missing.');
  return value;
}

function assertIdentity(profile: Profile): void {
  assertProfileDirectory(profile.path, true);
  if (profile.id !== undefined && readProfileId(profile.path) !== profile.id) {
    throw new Error('Profile identity changed before launch.');
  }
}

async function startEdge(profile: Profile, arguments_: string[], detached: boolean): Promise<ChildProcess> {
  assertIdentity(profile);
  const process = spawn(edgeExecutable(), [...edgeArguments, `--user-data-dir=${profile.path}`, ...arguments_],
    { stdio: 'ignore', detached, windowsHide: false });
  await once(process, 'spawn');
  return process;
}

/** Normal installed Edge, with no Playwright launch or remote-debugging flags. The user owns its lifetime. */
export async function openProfile(profile: Profile, url: string): Promise<void> {
  const process = await startEdge(profile, ['--new-window', url], true);
  process.unref();
}

export function parseEndpoint(value: string): { port: number; endpoint: string } {
  const lines = value.trimEnd().split(/\r?\n/);
  const port = Number(lines[0]);
  if (lines.length !== 2 || !/^[0-9]+$/.test(lines[0]!) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1]!)) throw new Error('Invalid Edge CDP endpoint.');
  return { port, endpoint: `ws://127.0.0.1:${port}${lines[1]}` };
}

function listeners(port: number): { address: string; pid: number }[] {
  return execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(fields => fields[0] === 'TCP' && fields[3] === 'LISTENING' && fields[1]?.endsWith(`:${port}`))
    .map(fields => ({ address: fields[1]!.slice(0, fields[1]!.lastIndexOf(':')), pid: Number(fields[4]) }));
}

const running = (process: ChildProcess) => process.exitCode === null && process.signalCode === null;
async function waitForExit(process: ChildProcess, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (running(process) && Date.now() < deadline) await setTimeout(50);
  return !running(process);
}

/** Directly start ordinary Edge, then attach only to the CDP listener owned by that new process. */
export async function launchProfile(profile: Profile): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  assertIdentity(profile);
  const marker = join(profile.path, 'DevToolsActivePort');
  const previous = readRegularFile(marker);
  if (previous !== undefined) {
    if (listeners(parseEndpoint(previous).port).length) throw new Error('Dedicated Edge profile is already in use.');
    unlinkSync(marker);
  }
  const process = await startEdge(profile,
    ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'], false);
  let browser: Browser | undefined;
  const close = async () => {
    try {
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      }
    } finally {
      if (!await waitForExit(process, 10_000)) {
        // Only the process created here can be terminated, never an existing Edge instance.
        execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        if (!await waitForExit(process, 10_000)) throw new Error('Owned Edge process did not exit.');
      }
      await browser?.close();
      const endpoint = readRegularFile(marker);
      if (endpoint !== undefined && listeners(parseEndpoint(endpoint).port).length === 0) unlinkSync(marker);
    }
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!running(process)) throw new Error('Edge exited before CDP; close any window using this profile.');
      const value = readRegularFile(marker);
      if (value !== undefined) {
        const { port, endpoint } = parseEndpoint(value);
        const owners = listeners(port);
        if (owners.length !== 1 || owners[0]!.address !== '127.0.0.1' || owners[0]!.pid !== process.pid) {
          throw new Error('Edge CDP endpoint is not an owned loopback listener.');
        }
        if (!running(process)) throw new Error('Edge exited before CDP attachment.');
        const { chromium } = await import('playwright');
        browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
        if (browser.contexts().length !== 1) throw new Error('Unexpected Edge browser context count.');
        return { context: browser.contexts()[0]!, close };
      }
      await setTimeout(100);
    }
    throw new Error('Edge CDP startup timed out.');
  } catch (error) {
    await close();
    throw error;
  }
}
