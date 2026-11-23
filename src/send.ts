import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { LoginRequiredError, NonFreeAccountError, runChat } from './chat.ts';
import { AccessBlockedError } from './browser/account.ts';
import { assertStandardUser, launchProfile } from './browser/edge.ts';
import { listProfiles } from './browser/profiles.ts';
import { generateBatches } from './prompts/generate.ts';
import { failureCooldownMs, readPromptHistory } from './prompts/history.ts';

const sessionCount = 5;
const roundsPerSession = 5;
const minVisitGapMs = 30_000;
const minSendGapMs = 30_000;
const pacingJitterMs = 15_000;

export async function send(root: string, profileName?: string, seed: string = randomUUID(), dryRun = false): Promise<void> {
  const profiles = listProfiles(root, profileName);
  if (!profiles.length) throw new Error('No dedicated profiles. Run chatgpt-cli login to create one.');
  const logs = join(dirname(root), 'logs');
  if (!dryRun) await assertStandardUser();
  const release = dryRun ? undefined : (await import('./send-lock.ts')).acquireSendLock();
  try {
    const cooldownMs = !dryRun && (!process.stdin.isTTY || profileName === undefined) ? failureCooldownMs : 0;
    const history = readPromptHistory(logs, cooldownMs);
    const promptBatches = generateBatches(profiles.map(profile => profile.path.toLowerCase()), seed,
      sessionCount * roundsPerSession, history);
    const batches = profiles.map((profile, index) => ({
      profile,
      sessions: Array.from({ length: sessionCount }, (_, session) =>
        promptBatches[index]!.slice(session * roundsPerSession, (session + 1) * roundsPerSession)),
    }));
    if (dryRun) {
      console.log(JSON.stringify({ seed, profiles: batches.map(({ profile, sessions }) => ({ name: profile.name, sessions })) }, null, 2));
      return;
    }
    console.error('Warning: send closes open Edge windows in the selected dedicated profiles. Unsaved drafts may be lost.');
    const { terminateProfiles } = await import('./browser/processes.ts');
    const terminated = await terminateProfiles(profiles);
    mkdirSync(logs, { recursive: true });
    const logFile = join(logs, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`);
    const log = (event: string, details: Record<string, unknown> = {}) => {
      appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n', 'utf8');
    };
    log('started', { command: 'send', seed, profiles: batches.length, logFile });
    for (const { profile, pid } of terminated) {
      log('profile-terminated', { profile: profile.name, pid });
    }

    let failed = false;
    let lastVisitEnd = 0;
    let lastSend = 0;
    const pace = async (since: number, minimumMs: number) => {
      if (!since) return;
      const delay = Math.max(0, since + minimumMs + randomInt(pacingJitterMs + 1) - Date.now());
      if (delay) await setTimeout(delay);
    };
    sending: for (let session = 0; session < sessionCount; session++) {
      for (const batch of [...batches]) {
        const { profile, sessions } = batch;
        const prompts = sessions[session]!;
        const details = { profile: profile.name, session: session + 1 };
        await pace(lastVisitEnd, minVisitGapMs);
        log('session-started', details);
        console.error(`${profile.name}: session ${session + 1}/${sessionCount}.`);
        let sentInSession = false;
        try {
          for (const { pid } of await terminateProfiles([profile])) {
            log('profile-terminated', { profile: profile.name, pid });
          }
          const edge = await launchProfile(profile);
          try {
            const page = edge.context.pages()[0];
            if (!page) throw new Error('Edge did not create its initial tab.');
            const windowSession = await edge.context.newCDPSession(page);
            try {
              const { windowId } = await windowSession.send('Browser.getWindowForTarget');
              await windowSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
            } finally { await windowSession.detach(); }
            await runChat(page, prompts, {
              beforeSend: () => pace(lastSend, minSendGapMs),
              onEvent: (event, prompt) => {
                if (event === 'sending') {
                  sentInSession = true;
                  lastSend = Date.now();
                }
                log(event, { ...details, round: prompts.indexOf(prompt) + 1, promptId: prompt.id, url: page.url() });
              },
              onChallenge: event => log('challenge', { ...details, ...event }),
            });
          } finally {
            await edge.close();
            lastVisitEnd = Date.now();
          }
          log('session-completed', details);
          if (session === sessionCount - 1) log('profile-completed', details);
        } catch (error) {
          if (error instanceof NonFreeAccountError) {
            batches.splice(batches.indexOf(batch), 1);
            log('profile-skipped', { ...details, reason: 'non-free-account' });
            console.error(`${profile.name}: skipped because the account is not Free.`);
            continue;
          }
          if (error instanceof LoginRequiredError && profileName === undefined && session === 0 && !sentInSession) {
            batches.splice(batches.indexOf(batch), 1);
            log('profile-skipped', { ...details, reason: 'login-required' });
            console.error(`${profile.name}: skipped because login is required. Sign in with chatgpt-cli login --profile "${profile.name}" or remove with chatgpt-cli profiles prune --apply.`);
            continue;
          }
          failed = true;
          log('profile-failed', { ...details, error: String(error) });
          const reason = error instanceof AccessBlockedError
            ? 'Access blocked; stopping further submissions in every profile.'
            : 'The session failed; review its result before sending again.';
          log('batch-stopped', { ...details, reason });
          const next = error instanceof LoginRequiredError
            ? `Sign in with chatgpt-cli login --profile "${profile.name}". ` : '';
          console.error(`${profile.name}: ${reason} ${next}(${error instanceof Error ? error.message : String(error)}) Log: ${logFile}`);
          break sending;
        }
      }
    }
    log('finished', { success: !failed });
    if (failed) process.exitCode = 1;
    else console.log(`Send complete. Log: ${logFile}`);
  } finally { release?.(); }
}
