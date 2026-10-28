import { setTimeout } from 'node:timers/promises';
import type { Locator, Page, Response } from 'playwright';
import type { Prompt } from './prompts/generate.ts';

export class AccessBlockedError extends Error {}
export class ProfileNotReadyError extends Error {}
export class NonFreeAccountError extends Error {}

export interface ChatOptions {
  url?: string;
  readyTimeoutMs?: number;
  answerTimeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
  onEvent?: (event: 'sending' | 'sent' | 'completed', prompt: Prompt) => void;
}

const stopName = /^(Stop generating|Stop streaming|生成を停止する|生成を停止|停止)$/i;
const loginName = /^(Log in|Sign in|ログイン)$/i;
const blockedText = /you(?:(?:'|’)?ve| have) (?:reached|hit).{0,80}(?:limit|maximum)|too many requests|usage limit|利用制限に達|上限に達|リクエストが多すぎ|verify you are human|人間であることを確認/i;

async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate(element =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent ?? '');
}

/** One conversation per profile. Submit each prompt once and wait for its completed answer. */
export async function runChat(page: Page, prompts: Prompt[], options: ChatOptions = {}): Promise<void> {
  const url = options.url ?? 'https://chatgpt.com/';
  const origin = new URL(url).origin;
  const pollMs = options.pollMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const answerTimeoutMs = options.answerTimeoutMs ?? 600_000;
  const cancellation = options.signal ? { signal: options.signal } : {};
  const actionOptions = { timeout: readyTimeoutMs, ...cancellation };
  let httpBlock: string | undefined;
  let nativeIdentity = false;
  let identityRevision = 0;
  let accountPlan: 'unknown' | 'free' | 'non-free' = 'unknown';
  let planRevision = 0;
  const hasFreePlan = () => accountPlan === 'free';
  const onResponse = (response: Response) => {
    const target = new URL(response.url());
    const request = response.request();
    const mainDocument = request.isNavigationRequest() && response.frame() === page.mainFrame();
    if (target.origin !== origin) return;
    const identityRequest = target.pathname === '/backend-api/me';
    const planRequest = target.pathname.startsWith('/backend-api/accounts/check/');
    const chatRequest = /^\/backend-api\/(?:f\/conversation|sentinel)(?:\/|$)/.test(target.pathname);
    // Feature-specific failures do not establish a chat-wide access block.
    if ((mainDocument || identityRequest || planRequest || chatRequest) &&
        (response.status() === 403 || response.status() === 429)) {
      httpBlock = `HTTP ${response.status()} ${target.pathname}`;
    }
    if (identityRequest) {
      nativeIdentity = false;
      const observedRevision = ++identityRevision;
      // Observe only the app's normal request. Never request credentials or log its body.
      if (response.status() === 200) {
        void response.json().then((value: unknown) => {
          if (identityRevision !== observedRevision) return;
          nativeIdentity = value !== null && typeof value === 'object' &&
            'email' in value && typeof value.email === 'string' && /^[^@\s]+@[^@\s]+$/.test(value.email);
        }).catch(() => {}); // Missing/invalid identity remains unconfirmed and cannot send.
      }
    }
    if (planRequest) {
      accountPlan = 'unknown';
      const observedRevision = ++planRevision;
      if (response.status() === 200) {
        void response.json().then((value: unknown) => {
          if (planRevision !== observedRevision || value === null || typeof value !== 'object' ||
              !('accounts' in value) || value.accounts === null || typeof value.accounts !== 'object' ||
              Array.isArray(value.accounts)) return;
          const plans = Object.values(value.accounts).map((entry: unknown) =>
            entry !== null && typeof entry === 'object' && 'account' in entry &&
            entry.account !== null && typeof entry.account === 'object' && 'plan_type' in entry.account
              ? entry.account.plan_type : undefined);
          // Require positive free evidence for every available account/workspace.
          if (plans.some(plan => typeof plan === 'string' && plan.length > 0 && plan !== 'free')) {
            accountPlan = 'non-free';
          } else if (plans.length > 0 && plans.every(plan => plan === 'free')) {
            accountPlan = 'free';
          }
        }).catch(() => {});
      }
    }
  };
  page.on('response', onResponse);
  const stopped = page.getByTestId('stop-button').or(page.getByRole('button', { name: stopName })).first();
  const turns = page.locator('[data-talvt-turn-state]');
  const guard = async () => {
    options.signal?.throwIfAborted();
    if (page.isClosed()) throw new Error('Automation tab was closed. No retry will be attempted.');
    if (httpBlock) throw new AccessBlockedError(httpBlock);
    const title = await page.title();
    const text = await page.locator('body').innerText();
    if (/just a moment|attention required/i.test(title) || blockedText.test(text) ||
        await page.locator('iframe[src*="challenges.cloudflare.com"]').first().isVisible()) {
      throw new AccessBlockedError('Challenge or usage limit detected. Stopping the batch.');
    }
    if (accountPlan === 'non-free') throw new NonFreeAccountError('Non-free account detected; this profile will be skipped.');
    if (await page.getByRole('button', { name: loginName }).or(
      page.getByRole('link', { name: loginName })).first().isVisible()) {
      throw new ProfileNotReadyError('Login required; manual login is needed.');
    }
  };
  const waitUntil = async (condition: () => Promise<boolean>, timeout: number, label: string) => {
    const deadline = Date.now() + timeout;
    do {
      await guard();
      if (await condition()) return;
      await setTimeout(pollMs, undefined, cancellation);
    } while (Date.now() < deadline);
    throw new Error(`${label} timed out. No automatic resend will be attempted.`);
  };

  try {
    options.signal?.throwIfAborted();
    await page.goto(url, { waitUntil: 'domcontentloaded', ...actionOptions });
    const composer = page.getByRole('textbox', {
      name: /ChatGPT に聞く|Ask anything|Ask ChatGPT|Message ChatGPT/i,
    }).filter({ visible: true }).first();
    for (const prompt of prompts) {
      const readiness = { signedIn: false, freePlan: false, composerVisible: false, composerEditable: false, generating: false };
      try {
        await waitUntil(async () => {
          readiness.signedIn = nativeIdentity;
          readiness.freePlan = hasFreePlan();
          readiness.composerVisible = await composer.isVisible();
          readiness.composerEditable = readiness.composerVisible && await composer.isEditable();
          readiness.generating = await stopped.isVisible();
          return readiness.signedIn && readiness.freePlan && readiness.composerEditable && !readiness.generating;
        }, readyTimeoutMs, 'Signed-in composer');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Signed-in composer timed out')) {
          throw new ProfileNotReadyError(`${error.message} Readiness: ${JSON.stringify(readiness)}`);
        }
        throw error;
      }
      const previousTurns = await turns.count();
      await composer.fill(prompt.text, actionOptions); // Replace any existing draft instead of appending to it.
      // The rich-text editor normalizes paragraphs/blank lines during fill. Compare its
      // post-fill state, not the original plain text, to detect later manual edits.
      const filledText = await composerText(composer);
      if (!filledText.trim()) throw new ProfileNotReadyError('Composer is empty after filling.');
      const send = page.getByRole('button', { name: /^(Send|Send message|Send prompt|送信)$/i })
        .filter({ visible: true }).first();
      await waitUntil(async () => await send.isVisible() && await send.isEnabled(), readyTimeoutMs, 'Send control');
      await options.beforeSend?.();
      await guard();
      if ((await composerText(composer)).replaceAll('\r\n', '\n') !== filledText.replaceAll('\r\n', '\n')) {
        throw new ProfileNotReadyError('Composer changed before sending; no message will be sent.');
      }
      if (!nativeIdentity) throw new ProfileNotReadyError('Native login identity is no longer confirmed; no message will be sent.');
      if (!hasFreePlan()) throw new ProfileNotReadyError('Free account plan is no longer confirmed; no message will be sent.');
      options.onEvent?.('sending', prompt);
      let acknowledgement: Response;
      try {
        // UI updates are optimistic. Confirm server acceptance separately from answer completion.
        [acknowledgement] = await Promise.all([
          page.waitForResponse(response => {
            const target = new URL(response.url());
            return target.origin === origin && target.pathname === '/backend-api/f/conversation' &&
              response.request().method() === 'POST';
          }, actionOptions),
          send.click(actionOptions), // Never retry an uncertain submission.
        ]);
      } catch (error) {
        await guard();
        throw new Error(`Submission acknowledgement failed. No automatic resend will be attempted. ${String(error)}`);
      }
      await guard();
      if (!acknowledgement.ok()) {
        throw new Error(`Submission rejected: HTTP ${acknowledgement.status()}. No automatic resend will be attempted.`);
      }
      options.onEvent?.('sent', prompt);
      await waitUntil(async () => {
        if (await turns.count() !== previousTurns + 1 || await stopped.isVisible()) return false;
        const turn = turns.nth(previousTurns);
        return await turn.getAttribute('data-talvt-turn-state') === 'complete' &&
          await turn.locator('[data-conversation-role="assistant"]').count() > 0;
      }, answerTimeoutMs, 'Assistant answer');
      options.onEvent?.('completed', prompt);
    }
  } finally {
    identityRevision++;
    planRevision++;
    page.off('response', onResponse);
  }
}
