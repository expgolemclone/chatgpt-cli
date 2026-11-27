import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AccessBlockedError, assertAccess, isAllowedOrigin, isLoginSurface, observeAccount, type AccessOptions, type Account } from './account.ts';
import { launchProfile } from './edge.ts';
import { assertIdentity, assertProfileDirectory, type Profile } from './profiles.ts';
import { readRegularFile, replaceRegularFile } from '../storage/files.ts';

export interface Inspection {
  status: 'logged_in' | 'logged_out' | 'unknown';
  email_address: string | null;
  state: '無料' | 'plus' | '不明';
  reason: string;
}
class InspectionError extends Error {}

const result = (status: Inspection['status'], reason: string, email_address: string | null = null,
  state: Inspection['state'] = '不明'): Inspection => ({ status, email_address, state, reason });

export function classifyProfile(account: Account, loginVisible: boolean): Inspection {
  if (account.block) return result('unknown', `http_${account.block.status}`);
  const identity = account.identity;
  if (identity) {
    if (!identity.settled) return result('unknown', 'identity_response_unsettled');
    if (identity.status === 200 && identity.validJson) {
      if (!identity.email) return result('unknown', 'identity_email_missing');
      if (loginVisible) return result('unknown', 'conflicting_login_signals');
      if (!account.plan) return result('logged_in', 'plan_response_missing', identity.email);
      if (account.plan.status !== 200) return result('logged_in', `plan_http_${account.plan.status}`, identity.email);
      return result('logged_in', account.plan.personal === '不明' ? 'plan_unrecognized' : 'native_profile_confirmed',
        identity.email, account.plan.personal);
    }
    if (identity.status !== 401 || !loginVisible) {
      return result('unknown', identity.status === 200 ? 'identity_response_invalid' : `identity_http_${identity.status}`);
    }
  }
  if (!loginVisible) return result('unknown', 'identity_response_missing');
  if (account.plan?.status === 200 && account.plan.sending !== 'unknown') {
    return result('unknown', 'conflicting_login_signals');
  }
  return result('logged_out', 'login_surface_without_authenticated_identity');
}

function writeAccessState(path: string, nextAllowed: number): void {
  replaceRegularFile(join(path, '.gpt-usage-access.json'),
    JSON.stringify({ next_allowed_at: new Date(nextAllowed).toISOString() }));
}

export function claimAccess(path: string, now = Date.now()): void {
  assertProfileDirectory(path, true);
  const document = readRegularFile(join(path, '.gpt-usage-access.json'));
  if (document !== undefined) {
    let next: unknown;
    try { next = (JSON.parse(document) as { next_allowed_at?: unknown }).next_allowed_at; }
    catch { throw new InspectionError('access_state_invalid'); }
    if (typeof next !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(next) || !Number.isFinite(Date.parse(next))) {
      throw new InspectionError('access_state_invalid');
    }
    if (now < Date.parse(next)) throw new InspectionError('access_cooldown_until_' + next);
  }
  writeAccessState(path, now + 5 * 60_000);
}

/** Inspect one profile without submitting messages or issuing private API requests. */
export async function inspectProfile(profile: Profile, options: AccessOptions & { url?: string; readyTimeoutMs?: number } = {}): Promise<Inspection> {
  let stage = 'browser_launch';
  let edge: Awaited<ReturnType<typeof launchProfile>> | undefined;
  let observation: ReturnType<typeof observeAccount> | undefined;
  try {
    assertIdentity(profile);
    claimAccess(profile.path);
    edge = await launchProfile(profile);
    const page = edge.context.pages()[0];
    if (!page) throw new InspectionError('initial_tab_missing');
    page.setDefaultTimeout(5000);
    const url = options.url ?? 'https://chatgpt.com/#settings/Account';
    const origin = new URL(url).origin;
    observation = observeAccount(page, origin, options.onChallenge);
    stage = 'profile';
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response) throw new InspectionError('navigation_http_none');
    const { account } = observation;
    let loginSince: number | undefined;
    let deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
    for (;;) {
      const waited = await assertAccess(page, account, options);
      deadline += waited;
      let visible: boolean;
      try {
        visible = await isLoginSurface(page, origin);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Execution context was destroyed') && Date.now() < deadline) {
          await setTimeout(250);
          continue;
        }
        throw error;
      }
      // A restriction can arrive while reading the login control.
      if (account.block || account.challengeLimit || account.challenges?.size) continue;
      const now = Date.now();
      loginSince = visible ? (waited ? now : loginSince ?? now) : undefined;
      const redirecting = account.navigationStatus !== undefined &&
        account.navigationStatus >= 300 && account.navigationStatus < 400;
      if (account.navigationStatus !== 200 && (!redirecting || now >= deadline)) {
        throw new InspectionError(`navigation_http_${account.navigationStatus}`);
      }
      if (!isAllowedOrigin(page.url(), origin)) throw new InspectionError('navigation_origin_changed');
      // A signed-out surface can appear briefly while authentication is still loading.
      if (now >= deadline || (account.identity?.status === 200 && account.identity.settled && account.plan?.settled)) {
        const inspection = classifyProfile(account, visible);
        return inspection.status === 'logged_out' && (loginSince === undefined || now - loginSince < 1500)
          ? result('unknown', 'login_surface_not_stable') : inspection;
      }
      await setTimeout(250);
    }
  } catch (error) {
    const reason = observation?.account.block ? `http_${observation.account.block.status}`
      : observation?.account.challenges?.size || error instanceof AccessBlockedError ? 'access_blocked'
      : error instanceof InspectionError ? error.message : error instanceof Error ? error.name : 'Error';
    if (/http_(403|429)|access_blocked/.test(reason)) writeAccessState(profile.path, Date.now() + 30 * 60_000);
    return result('unknown', `${stage}:${reason}`);
  } finally {
    observation?.dispose();
    await edge?.close();
  }
}

/** Visit marked profiles serially and stop the collection on access restrictions. */
export async function* inspectProfiles(profiles: Profile[], inspect: (profile: Profile) => Promise<Inspection> = inspectProfile) {
  let finished: number | undefined;
  for (const profile of profiles) {
    if (finished !== undefined) await setTimeout(Math.max(0, 30_000 - (Date.now() - finished)));
    assertIdentity(profile);
    const inspection = await inspect(profile);
    finished = Date.now();
    if (!['logged_in', 'logged_out', 'unknown'].includes(inspection.status) ||
        !['無料', 'plus', '不明'].includes(inspection.state)) throw new Error('Invalid profile inspection.');
    if (/http_(403|429)|access_cooldown|access_blocked/.test(inspection.reason)) {
      throw new Error('Access rejected or cooling down. Remaining profiles were not contacted. ' + inspection.reason);
    }
    yield { profile, inspection };
  }
}
