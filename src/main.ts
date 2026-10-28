import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { BrowserContext } from 'playwright';
import { AccessBlockedError, NonFreeAccountError, runChat } from './chat.ts';
import { assertProfileDirectory, resolveProfiles } from './profiles.ts';
import { generatePrompts } from './prompts/generate.ts';

const help = `Usage: node src/main.ts <login|send> [options]

  login              Open a dedicated Edge profile for manual ChatGPT login.
                     Close that Edge window when finished. No prompts are sent.
  send               Send locally generated prompts to signed-in free accounts.

  --profile PATH     Absolute dedicated user-data directory. Repeat for send.
                     Default: %LOCALAPPDATA%/gpt-send-messages/profile
  --questions N      Prompts per profile (default: 5).
  --seed TEXT        Reproducible prompt selection.
  --dry-run          Preview prompts without opening Edge or writing files.
  --help             Show this help.

Requires Windows, Node.js, and Microsoft Edge. No PowerShell 7 or other project
is needed. Existing browser windows are never terminated or unlocked. Close
windows using a selected profile before running. HTTP blocks, challenges, and
usage limits stop the batch. Uncertain submissions are never retried.
This tool does not create accounts or upgrade their plans.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', multiple: true }, questions: { type: 'string' },
    seed: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== 'login' && command !== 'send')) {
    throw new Error('Choose login or send. Use --help for usage.');
  }
  if (process.platform !== 'win32') throw new Error('This command requires Windows and Microsoft Edge.');
  const profiles = resolveProfiles(values.profile ?? []);
  const login = command === 'login';
  if (login && (profiles.length !== 1 || values.questions !== undefined || values.seed !== undefined || values['dry-run'])) {
    throw new Error('login accepts only one --profile directory; send options are not allowed.');
  }
  const count = values.questions === undefined ? undefined : Number(values.questions);
  const seed = values.seed ?? randomUUID();
  const batches = profiles.map(profile => ({
    profile, prompts: login ? [] : generatePrompts(profile.path.toLowerCase(), seed, count),
  }));
  if (values['dry-run']) {
    console.log(JSON.stringify({ seed, profiles: batches.map(({ profile, prompts }) => ({
      name: profile.name, prompts,
    })) }, null, 2));
    return;
  }
  for (const profile of profiles) assertProfileDirectory(profile.path, !login);
  const { chromium } = await import('playwright');
  if (login) mkdirSync(profiles[0]!.path, { recursive: true });
  const localAppData = process.env.LOCALAPPDATA!; // Validated by resolveProfiles.
  const logs = join(localAppData, 'gpt-send-messages', 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`);
  const log = (event: string, details: Record<string, unknown> = {}) => {
    const record = { time: new Date().toISOString(), event, ...details };
    appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
  };
  log('started', { command, seed, profiles: batches.length, logFile });
  const stop = new AbortController();
  const results = await Promise.allSettled(batches.map(async ({ profile, prompts }) => {
    let context: BrowserContext | undefined;
    let lastSend = 0;
    try {
      stop.signal.throwIfAborted();
      assertProfileDirectory(profile.path, true);
      // Chromium owns the profile lock. Never terminate another browser or remove its locks.
      context = await chromium.launchPersistentContext(profile.path, {
        channel: 'msedge', headless: false, viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-sync',
          '--disable-features=msImplicitSignin,msEnableWebToBrowserSignIn,msEnableAADWebToBrowserSignIn,msSeamlessWebToBrowserSignIn,msEdgeOnRampImport,msEdgeFRESpartanImportAllowed,msEdgeContinuousMigrationUser'],
      });
      const page = context.pages()[0];
      if (!page) throw new Error('Edge did not create its initial tab.');
      if (login) {
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
        console.error('Sign in to ChatGPT in this dedicated Edge window, then close it. Never paste credentials into the terminal.');
        await new Promise<void>(resolve => context!.once('close', () => resolve()));
        log('login-window-closed', { profile: profile.name });
        return;
      }
      const session = await context.newCDPSession(page);
      try {
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      } finally {
        await session.detach();
      }
      await runChat(page, prompts, {
        signal: stop.signal,
        beforeSend: async () => {
          const delay = Math.max(0, lastSend + 30_000 - Date.now());
          if (delay) await setTimeout(delay, undefined, { signal: stop.signal });
          stop.signal.throwIfAborted();
        },
        onEvent: (event, prompt) => {
          if (event === 'sending') lastSend = Date.now();
          log(event, { profile: profile.name, promptId: prompt.id, url: page.url() });
        },
      });
    } catch (error) {
      if (error instanceof AccessBlockedError && !stop.signal.aborted) {
        log('batch-stopped', { reason: 'Access blocked; stopping further submissions in every profile.' });
        stop.abort(new Error('Batch stopped because another profile encountered an access block.'));
      }
      throw error;
    } finally {
      // Close only a context successfully created by this run.
      await context?.close();
    }
  }));
  let failed = false;
  for (const [index, result] of results.entries()) {
    const profile = batches[index]!.profile.name;
    if (result.status === 'fulfilled') {
      log('profile-completed', { profile });
    } else if (result.reason instanceof NonFreeAccountError) {
      log('profile-skipped', { profile, reason: 'non-free-account' });
    } else {
      failed = true;
      log('profile-failed', { profile, error: String(result.reason) });
    }
  }
  log('finished', { success: !failed });
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && normalize(resolve(process.argv[1])).toLowerCase() ===
    normalize(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
