import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { AccessBlockedError, assertAccess, loginName, observeAccount, type Account } from './account.ts';
import { launchProfile } from './edge.ts';
import { assertProfileDirectory, type Profile } from './profiles.ts';
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
  return loginVisible ? result('logged_out', 'login_surface_without_authenticated_identity')
    : result('unknown', 'identity_response_missing');
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
export async function inspectProfile(profile: Profile, options: { url?: string; readyTimeoutMs?: number } = {}): Promise<Inspection> {
  let stage = 'browser_launch';
  let edge: Awaited<ReturnType<typeof launchProfile>> | undefined;
  let observation: ReturnType<typeof observeAccount> | undefined;
  try {
    claimAccess(profile.path);
    edge = await launchProfile(profile);
    const page = edge.context.pages()[0];
    if (!page) throw new InspectionError('initial_tab_missing');
    page.setDefaultTimeout(5000);
    const url = options.url ?? 'https://chatgpt.com/#settings/Account';
    const origin = new URL(url).origin;
    observation = observeAccount(page, origin);
    stage = 'profile';
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response) throw new InspectionError('navigation_http_none');
    if (response.status() !== 200) throw new InspectionError(`navigation_http_${response.status()}`);
    if (new URL(page.url()).origin !== origin) throw new InspectionError('navigation_origin_changed');
    const login = page.getByText(loginName).first();
    const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      await assertAccess(page, observation.account);
      if (await login.isVisible()) {
        await setTimeout(1500);
        if (await login.isVisible()) break;
      }
      if (observation.account.identity?.settled && observation.account.plan?.settled) break;
      await setTimeout(250);
    }
    await assertAccess(page, observation.account);
    return classifyProfile(observation.account, await login.isVisible());
  } catch (error) {
    const reason = error instanceof InspectionError ? error.message : error instanceof AccessBlockedError
      ? observation?.account.block ? `http_${observation.account.block.status}` : 'access_blocked'
      : error instanceof Error ? error.name : 'Error';
    if (/http_(403|429)|access_blocked/.test(reason)) writeAccessState(profile.path, Date.now() + 30 * 60_000);
    return result('unknown', `${stage}:${reason}`);
  } finally {
    observation?.dispose();
    await edge?.close();
  }
}
