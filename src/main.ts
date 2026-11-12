import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { NonFreeAccountError, runChat } from './chat.ts';
import { AccessBlockedError, ChallengeLimitError } from './browser/account.ts';
import { launchProfile, openProfile } from './browser/edge.ts';
import { inspectProfile } from './browser/inspect.ts';
import { assertProfileDirectory, createProfile, listProfiles, resolveProfiles } from './browser/profiles.ts';
import { generateBatches } from './prompts/generate.ts';
import { readPromptHistory } from './prompts/history.ts';
import { syncUsage } from './usage/sync.ts';

const sessionCount = 5;
const roundsPerSession = 5;

const help = `chatgpt-cli
Usage: node src/main.ts <login|open|profiles|inspect|sync|send> [options]

  login              Open one dedicated Edge profile for manual ChatGPT login.
                     Without --profile, create exactly one fresh marked profile.
  open               Open existing profiles at ChatGPT Usage without checking login.
  login/open use ordinary installed Edge directly, without Playwright or debugging.
  profiles           List owned direct profiles as JSON.
  inspect            Confirm email and personal plan as JSON. Requires one --profile.
                     Never sends prompts or renames profiles.
  sync               Update an explicit ledger CSV and rename confirmed profiles.
                     Requires --ledger. Uses the selected profile or collection.
                     Keeps other ledger rows and never sends prompts.
  send               Terminate selected profiles' running Edge processes, then visit
                     signed-in free accounts in order for 5 loops. Each visit starts
                     one fresh conversation with 5 prompt/answer rounds (25 per account).
                     Only one profile is open at a time, with at least 30 seconds
                     between submissions, including account and loop boundaries.

  --profile PATH     Absolute dedicated user-data directory. Repeat for open/send.
  --profile-root PATH  Collection of marked profiles, excluding archive.
                       Default: %LOCALAPPDATA%/chatgpt-cli/profiles
                       Cannot be combined with --profile.
  --ledger PATH      Existing private CSV with kind,value,state columns. Sync only.
  --seed TEXT        Reproduce a selection with unchanged profiles and prompt logs.
  --dry-run          Preview prompts without opening Edge or writing files. Send only.
  --help             Show this help.

Requires Windows, Node.js, and Microsoft Edge. No PowerShell 7 or other project
is needed. Send force-closes only selected dedicated Edge profiles; unsaved drafts
may be lost. Other commands never terminate existing browser windows. Cloudflare
challenges try a visible verification checkbox once and wait up to 2 minutes.
Five consecutive Cloudflare challenge responses skip that account for this run;
the count resets when access clears. HTTP blocks, usage limits, and other unresolved
challenges stop the batch. Uncertain submissions are never retried.
Prompt selection reads previous sending events from the local logs. Simultaneous
send commands are rejected, and removing logs removes their prompt history.
This tool does not create accounts or upgrade their plans.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', multiple: true }, 'profile-root': { type: 'string' },
    seed: { type: 'string' }, ledger: { type: 'string' },
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
  if (command !== 'send' && (values.seed !== undefined || values['dry-run'])) {
    throw new Error('Send options are not allowed for this command.');
  }
  if (values['profile-root'] !== undefined && values.profile !== undefined) {
    throw new Error('Choose --profile-root or --profile, not both.');
  }
  if (command === 'profiles' && values.profile !== undefined) {
    throw new Error('profiles does not accept --profile; use --profile-root.');
  }
  if (command === 'inspect' && (values['profile-root'] !== undefined || values.profile?.length !== 1)) {
    throw new Error('inspect requires exactly one --profile.');
  }
  if (command === 'send' && !values['dry-run']) {
    const { acquireSendLock } = await import('./send-lock.ts');
    process.once('exit', acquireSendLock());
  }
  const root = values.profile === undefined
    ? values['profile-root'] ?? join(process.env.LOCALAPPDATA!, 'chatgpt-cli', 'profiles') : undefined;
  if (command === 'sync') {
    if (!values.ledger || (root === undefined && values.profile?.length !== 1)) {
      throw new Error('sync requires --ledger and accepts at most one --profile.');
    }
    const results = await syncUsage(root === undefined ? { profile: values.profile![0]! } : { root }, values.ledger);
    console.log(JSON.stringify({ results }));
    return;
  }
  const profiles = root === undefined ? resolveProfiles(values.profile!) : listProfiles(root);
  if (login && root === undefined && profiles.length !== 1) throw new Error('login accepts only one --profile directory.');
  if (command === 'profiles') {
    console.log(JSON.stringify({ root: resolve(root!), profiles }));
    return;
  }
  if (command === 'inspect') {
    console.log(JSON.stringify({ profile: profiles[0], ...await inspectProfile(profiles[0]!) }));
    return;
  }
  if (command === 'send' && profiles.length === 0) throw new Error('No owned profiles in this collection. Run npm run login first.');
  const seed = values.seed ?? randomUUID();
  const logs = join(process.env.LOCALAPPDATA!, 'chatgpt-cli', 'logs');
  const promptBatches = command === 'send'
    ? generateBatches(profiles.map(profile => profile.path.toLowerCase()), seed,
      sessionCount * roundsPerSession, readPromptHistory(logs)) : [];
  const batches = profiles.map((profile, index) => ({
    profile,
    sessions: Array.from({ length: command === 'send' ? sessionCount : 0 }, (_, session) =>
      promptBatches[index]!.slice(session * roundsPerSession, (session + 1) * roundsPerSession)),
  }));
  if (values['dry-run']) {
    console.log(JSON.stringify({ seed, profiles: batches.map(({ profile, sessions }) => ({ name: profile.name, sessions })) }, null, 2));
    return;
  }
  if (login && root !== undefined) {
    batches.splice(0, batches.length, { profile: createProfile(root), sessions: [] });
  } else {
    for (const profile of profiles) assertProfileDirectory(profile.path, !login);
    if (login) mkdirSync(profiles[0]!.path, { recursive: true });
  }
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
  const { terminateProfiles } = await import('./browser/processes.ts');
  for (const { profile, pid } of await terminateProfiles(profiles)) {
    log('profile-terminated', { profile: profile.name, pid });
  }
  let failed = false;
  let lastSend = 0;
  sending: for (let session = 0; session < sessionCount; session++) {
    for (const batch of [...batches]) {
      const { profile, sessions } = batch;
      const prompts = sessions[session]!;
      const details = { profile: profile.name, session: session + 1 };
      let stopBatch = true;
      log('session-started', details);
      try {
        const edge = await launchProfile(profile);
        stopBatch = false;
        try {
          const page = edge.context.pages()[0];
          if (!page) throw new Error('Edge did not create its initial tab.');
          const windowSession = await edge.context.newCDPSession(page);
          try {
            const { windowId } = await windowSession.send('Browser.getWindowForTarget');
            await windowSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
          } finally {
            await windowSession.detach();
          }
          await runChat(page, prompts, {
            beforeSend: async () => {
              const delay = Math.max(0, lastSend + 30_000 - Date.now());
              if (delay) await setTimeout(delay);
            },
            onEvent: (event, prompt) => {
              if (event === 'sending') lastSend = Date.now();
              log(event, { ...details, round: prompts.indexOf(prompt) + 1, promptId: prompt.id, url: page.url() });
            },
            onChallenge: event => log('challenge', { ...details, ...event }),
          });
        } catch (error) {
          if (error instanceof AccessBlockedError && !(error instanceof ChallengeLimitError)) stopBatch = true;
          throw error;
        } finally {
          try {
            await edge.close();
          } catch (error) {
            stopBatch = true;
            throw error;
          }
        }
        log('session-completed', details);
        if (session === sessionCount - 1) log('profile-completed', details);
      } catch (error) {
        batches.splice(batches.indexOf(batch), 1);
        if (!stopBatch && (error instanceof NonFreeAccountError || error instanceof ChallengeLimitError)) {
          log('profile-skipped', { ...details, reason: error instanceof ChallengeLimitError
            ? 'cloudflare-challenge-limit' : 'non-free-account' });
        } else {
          failed = true;
          if (stopBatch) {
            log('batch-stopped', { ...details, reason: error instanceof AccessBlockedError
              ? 'Access blocked; stopping further submissions in every profile.'
              : 'The browser could not be started or closed safely; stopping further profiles.' });
          }
          log('profile-failed', { ...details, error: String(error) });
          if (stopBatch) break sending;
        }
      }
    }
  }
  log('finished', { success: !failed });
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && normalize(resolve(process.argv[1])).toLowerCase() ===
    normalize(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
