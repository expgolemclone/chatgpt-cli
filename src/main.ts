import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { NonFreeAccountError, runChat } from './chat.ts';
import { AccessBlockedError } from './browser/account.ts';
import { launchProfile, openProfile } from './browser/edge.ts';
import { inspectProfile } from './browser/inspect.ts';
import { assertProfileDirectory, createProfile, listProfiles, resolveProfiles } from './browser/profiles.ts';
import { generatePrompts } from './prompts/generate.ts';
import { syncUsage } from './usage/sync.ts';

const help = `chatgpt-cli
Usage: node src/main.ts <login|open|profiles|inspect|sync|send> [options]

  login              Open one dedicated Edge profile for manual ChatGPT login.
                     With --profile-root, create exactly one fresh marked profile.
  open               Open existing profiles at ChatGPT Usage without checking login.
  login/open use ordinary installed Edge directly, without Playwright or debugging.
  profiles           List owned direct profiles as JSON. Requires --profile-root.
  inspect            Confirm email and personal plan as JSON. Requires one --profile.
                     Never sends prompts or renames profiles.
  sync               Update an explicit ledger CSV and rename confirmed profiles.
                     Requires --ledger and --profile-root or exactly one --profile.
                     Keeps other ledger rows and never sends prompts.
  send               Send locally generated prompts to signed-in free accounts.

  --profile PATH     Absolute dedicated user-data directory. Repeat for open/send.
                     Default: %LOCALAPPDATA%/gpt-send-messages/profile
  --profile-root PATH  Explicit collection of marked profiles, excluding archive.
                       Cannot be combined with --profile.
  --ledger PATH      Existing private CSV with kind,value,state columns. Sync only.
  --questions N      Prompts per profile (default: 5). Send only.
  --seed TEXT        Reproducible prompt selection. Send only.
  --dry-run          Preview prompts without opening Edge or writing files. Send only.
  --help             Show this help.

Requires Windows, Node.js, and Microsoft Edge. No PowerShell 7 or other project
is needed. Existing browser windows are never terminated or unlocked. Close
windows using a selected profile before running. HTTP blocks, challenges, and
usage limits stop the batch. Uncertain submissions are never retried.
This tool does not create accounts or upgrade their plans.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', multiple: true }, 'profile-root': { type: 'string' },
    questions: { type: 'string' }, seed: { type: 'string' }, ledger: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['login', 'open', 'profiles', 'inspect', 'sync', 'send'].includes(command!)) {
    throw new Error('Choose login, open, profiles, inspect, sync, or send. Use --help for usage.');
  }
  if (values.ledger !== undefined && command !== 'sync') throw new Error('--ledger is only allowed for sync.');
  if (process.platform !== 'win32') throw new Error('This command requires Windows and Microsoft Edge.');
  const login = command === 'login';
  if (command !== 'send' && (values.questions !== undefined || values.seed !== undefined || values['dry-run'])) {
    throw new Error('Send options are not allowed for this command.');
  }
  const root = values['profile-root'];
  if (root !== undefined && values.profile !== undefined) throw new Error('Choose --profile-root or --profile, not both.');
  if (command === 'profiles' && root === undefined) throw new Error('profiles requires --profile-root.');
  if (command === 'inspect' && (root !== undefined || values.profile?.length !== 1)) {
    throw new Error('inspect requires exactly one --profile.');
  }
  if (command === 'sync') {
    if (!values.ledger || (root === undefined && values.profile?.length !== 1)) {
      throw new Error('sync requires --ledger and --profile-root or exactly one --profile.');
    }
    const results = await syncUsage(root === undefined ? { profile: values.profile![0]! } : { root }, values.ledger);
    console.log(JSON.stringify({ results }));
    return;
  }
  const profiles = root === undefined ? resolveProfiles(values.profile ?? []) : listProfiles(root);
  if (login && root === undefined && profiles.length !== 1) throw new Error('login accepts only one --profile directory.');
  if (command === 'profiles') {
    console.log(JSON.stringify({ root: resolve(root!), profiles }));
    return;
  }
  if (command === 'inspect') {
    console.log(JSON.stringify({ profile: profiles[0], ...await inspectProfile(profiles[0]!) }));
    return;
  }
  if (command === 'send' && profiles.length === 0) throw new Error('No owned profiles in this collection. Run login first.');
  const count = values.questions === undefined ? undefined : Number(values.questions);
  const seed = values.seed ?? randomUUID();
  const batches = profiles.map(profile => ({
    profile, prompts: command === 'send' ? generatePrompts(profile.path.toLowerCase(), seed, count) : [],
  }));
  if (values['dry-run']) {
    console.log(JSON.stringify({ seed, profiles: batches.map(({ profile, prompts }) => ({ name: profile.name, prompts })) }, null, 2));
    return;
  }
  if (login && root !== undefined) {
    batches.splice(0, batches.length, { profile: createProfile(root), prompts: [] });
  } else {
    for (const profile of profiles) assertProfileDirectory(profile.path, !login);
    if (login) mkdirSync(profiles[0]!.path, { recursive: true });
  }
  const logs = join(process.env.LOCALAPPDATA!, 'chatgpt-cli', 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`);
  const log = (event: string, details: Record<string, unknown> = {}) => {
    const record = { time: new Date().toISOString(), event, ...details };
    appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
  };
  log('started', { command, seed, profiles: batches.length, logFile });
  if (login || command === 'open') {
    for (const { profile } of batches) {
      await openProfile(profile, login ? 'https://chatgpt.com/' : 'https://chatgpt.com/#settings/Usage');
      log('profile-opened', { profile: profile.name });
    }
    log('finished', { success: true });
    return;
  }
  const stop = new AbortController();
  const results = await Promise.allSettled(batches.map(async ({ profile, prompts }) => {
    let edge: Awaited<ReturnType<typeof launchProfile>> | undefined;
    let lastSend = 0;
    try {
      stop.signal.throwIfAborted();
      edge = await launchProfile(profile);
      const page = edge.context.pages()[0];
      if (!page) throw new Error('Edge did not create its initial tab.');
      const session = await edge.context.newCDPSession(page);
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
      await edge?.close();
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
