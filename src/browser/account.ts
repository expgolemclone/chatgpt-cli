import { setTimeout } from 'node:timers/promises';
import type { Page, Response } from 'playwright';

export class AccessBlockedError extends Error {}
export const loginName = /^(Log in(?: or sign up)?|Sign in|ログイン(?:または新規登録)?)$/i;
export const emailPattern = /^[^@\s]+@[^@\s]+$/;
const blockedText = /you(?:(?:'|’)?ve| have) (?:reached|hit).{0,80}(?:limit|maximum)|too many requests|usage limit|利用制限に達|上限に達|リクエストが多すぎ/i;
const challengeText = /verify (?:that )?you are human|verifying (?:that )?you are human|checking your browser|performing security verification|人間であることを確認/i;
const accessText = new RegExp(`${blockedText.source}|${challengeText.source}`, 'i');
const conversationContent = '[data-talvt-turn-state], [data-message-author-role], [data-user-message-bubble], [role="textbox"], nav, aside';

export interface ChallengeResponse {
  request: 'document' | 'identity' | 'plan' | 'conversation' | 'sentinel';
  status: number;
}
type ChallengeIndicator = 'response' | 'text' | 'title' | 'iframe' | 'page-unavailable';
export type ChallengeEvent = (
  | { phase: 'response'; response: ChallengeResponse }
  | { phase: 'waiting' | 'cleared' | 'timed-out'; indicators: ChallengeIndicator[];
      responses: ChallengeResponse[]; elapsedMs: number }
) & { stage?: 'navigation' | 'readiness' | 'submission' | 'answer' };

export interface AccessOptions {
  challengeTimeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onChallenge?: (event: ChallengeEvent) => void;
}

export interface Identity {
  status: number; settled: boolean; validJson: boolean; email: string | null;
}
export interface Plan {
  status: number; settled: boolean;
  personal: '無料' | 'plus' | '不明';
  sending: 'unknown' | 'free' | 'non-free';
}
export interface Account {
  identity?: Identity; plan?: Plan;
  navigationStatus?: number;
  challenges?: Map<string, ChallengeResponse>;
  block?: { status: number; path: string };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseIdentity(value: unknown): Pick<Identity, 'validJson' | 'email'> {
  return { validJson: record(value), email: record(value) && typeof value.email === 'string' &&
    emailPattern.test(value.email) ? value.email : null };
}

export function parsePlan(value: unknown): Pick<Plan, 'personal' | 'sending'> {
  const result: Pick<Plan, 'personal' | 'sending'> = { personal: '不明', sending: 'unknown' };
  if (!record(value) || !record(value.accounts)) return result;
  const accounts = Object.values(value.accounts).map(entry => record(entry) && record(entry.account) ? entry.account : {});
  const plans = accounts.map(account => account.plan_type);
  if (plans.some(plan => typeof plan === 'string' && plan.length > 0 && plan !== 'free')) {
    result.sending = 'non-free';
  } else if (plans.length > 0 && plans.every(plan => plan === 'free')) {
    result.sending = 'free';
  }
  const entry = value.accounts.default;
  if (record(entry) && record(entry.account) && entry.account.structure === 'personal' &&
      entry.account.is_deactivated === false) {
    result.personal = entry.account.plan_type === 'free' ? '無料' : entry.account.plan_type === 'plus' ? 'plus' : '不明';
  }
  return result;
}

/** Observe only normal application responses. Keep neither bodies nor credentials. */
export function observeAccount(page: Page, origin: string, onChallenge?: AccessOptions['onChallenge']): { account: Account; dispose: () => void } {
  const account: Account = {};
  let identityRevision = 0;
  let planRevision = 0;
  const onResponse = (response: Response) => {
    const target = new URL(response.url());
    if (target.origin !== origin) return;
    const identityRequest = target.pathname === '/backend-api/me';
    const planRequest = target.pathname.startsWith('/backend-api/accounts/check/');
    const chatRequest = /^\/backend-api\/(?:f\/conversation|sentinel)(?:\/|$)/.test(target.pathname);
    const mainDocument = response.request().isNavigationRequest() && response.frame() === page.mainFrame();
    const status = response.status();
    if (mainDocument) {
      account.navigationStatus = status;
      identityRevision++;
      planRevision++;
      delete account.identity;
      delete account.plan;
    }
    if (mainDocument || identityRequest || planRequest || chatRequest) {
      if (response.headers()['cf-mitigated'] === 'challenge') {
        const request: ChallengeResponse['request'] = mainDocument ? 'document' : identityRequest ? 'identity'
          : planRequest ? 'plan' : target.pathname.startsWith('/backend-api/f/conversation') ? 'conversation' : 'sentinel';
        const challenge = { request, status };
        (account.challenges ??= new Map()).set(target.pathname, challenge);
        onChallenge?.({ phase: 'response', response: challenge });
      } else {
        if (status === 403 || status === 429) account.block = { status, path: target.pathname };
        if (response.ok()) {
          if (mainDocument) account.challenges?.clear();
          else account.challenges?.delete(target.pathname);
        }
      }
    }
    if (identityRequest) {
      const revision = ++identityRevision;
      const identity: Identity = { status, settled: status !== 200, validJson: false, email: null };
      account.identity = identity;
      if (status === 200) void response.json().then((value: unknown) => {
        if (identityRevision === revision) Object.assign(identity, parseIdentity(value));
      }).catch(() => {}).finally(() => { identity.settled = true; });
    }
    if (planRequest) {
      const revision = ++planRevision;
      const plan: Plan = { status, settled: status !== 200, personal: '不明', sending: 'unknown' };
      account.plan = plan;
      if (status === 200) void response.json().then((value: unknown) => {
        if (planRevision === revision) Object.assign(plan, parsePlan(value));
      }).catch(() => {}).finally(() => { plan.settled = true; });
    }
  };
  page.on('response', onResponse);
  return { account, dispose: () => {
    identityRevision++;
    planRevision++;
    page.off('response', onResponse);
  } };
}

export async function assertAccess(page: Page, account: Account, options: AccessOptions = {}): Promise<number> {
  let waitingSince: number | undefined;
  let lastSnapshot: string | undefined;
  const timeout = options.challengeTimeoutMs ?? 120_000;
  for (;;) {
    options.signal?.throwIfAborted();
    if (page.isClosed()) throw new Error('Automation tab was closed. No retry will be attempted.');
    if (account.block) throw new AccessBlockedError(`HTTP ${account.block.status} ${account.block.path}`);
    let snapshot: { indicators: ChallengeIndicator[]; responses: ChallengeResponse[] } | undefined;
    try {
      const notices = await page.getByText(accessText).or(page.locator('body')).filter({ visible: true }).evaluateAll((elements, excluded) =>
        elements.map(element => {
          if (element.closest(excluded)) return '';
          if (!element.querySelector(excluded)) return element instanceof HTMLElement ? element.innerText : element.textContent ?? '';
          // The body itself may contain a warning as a direct text node alongside the conversation.
          return Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent).join(' ');
        }), conversationContent);
      if (notices.some(text => blockedText.test(text))) throw new AccessBlockedError('Usage limit detected. Stopping the batch.');
      const indicators: ChallengeIndicator[] = [];
      const responses = [...(account.challenges?.values() ?? [])];
      if (responses.length) indicators.push('response');
      if (notices.some(text => challengeText.test(text))) indicators.push('text');
      if (/^(?:just a moment\.{0,3}|attention required!?(?:\s*\|.*)?)$/i.test((await page.title()).trim())) indicators.push('title');
      if (await page.locator('iframe[src*="challenges.cloudflare.com"]').first().isVisible()) indicators.push('iframe');
      snapshot = { indicators, responses };
    } catch (error) {
      // A challenge can navigate during these reads. Only repeat the reads, never a submission.
      if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
      const responses = [...(account.challenges?.values() ?? [])];
      if (responses.length) snapshot = { indicators: ['response', 'page-unavailable'], responses };
    }
    if (snapshot) {
      if (!snapshot.indicators.length) {
        const elapsedMs = waitingSince === undefined ? 0 : Date.now() - waitingSince;
        if (lastSnapshot !== undefined) options.onChallenge?.({ phase: 'cleared', ...snapshot, elapsedMs });
        return elapsedMs;
      }
      waitingSince ??= Date.now();
      const signature = JSON.stringify(snapshot);
      if (signature !== lastSnapshot) {
        options.onChallenge?.({ phase: 'waiting', ...snapshot, elapsedMs: Date.now() - waitingSince });
        lastSnapshot = signature;
      }
    }
    waitingSince ??= Date.now();
    const remaining = waitingSince + timeout - Date.now();
    if (remaining <= 0) {
      if (!snapshot) throw new Error('Page navigation did not settle. No retry will be attempted.');
      options.onChallenge?.({ phase: 'timed-out', ...snapshot, elapsedMs: Date.now() - waitingSince });
      throw new AccessBlockedError('Cloudflare challenge timed out. Stopping the batch.');
    }
    await setTimeout(Math.min(options.pollMs ?? 500, remaining), undefined, options.signal ? { signal: options.signal } : {});
  }
}
