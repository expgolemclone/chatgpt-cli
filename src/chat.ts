import type { Locator, Page, Response } from 'playwright';
import type { Prompt } from './prompts.js';

export class AccessBlockedError extends Error {}
export class ProfileNotReadyError extends Error {}

export interface ChatOptions {
  url?: string;
  readyTimeoutMs?: number;
  responseTimeoutMs?: number;
  pollMs?: number;
  stableMs?: number;
  beforeSend?: () => Promise<void>;
  onEvent?: (event: 'sending' | 'completed', prompt: Prompt) => void;
}

const stopName = /^(Stop generating|Stop streaming|生成を停止する|生成を停止|停止)$/i;
const loginName = /^(Log in|Sign in|ログイン)$/i;
const blockedText = /you(?:(?:'|’)?ve| have) (?:reached|hit).{0,80}(?:limit|maximum)|too many requests|usage limit|利用制限に達|上限に達|リクエストが多すぎ|verify you are human|人間であることを確認/i;

async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate(element =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent ?? '');
}

/** New chat for every prompt. Enter is explicit: codegen missed this action. */
export async function runChat(page: Page, prompts: Prompt[], options: ChatOptions = {}): Promise<void> {
  const url = options.url ?? 'https://chatgpt.com/';
  const origin = new URL(url).origin;
  const pollMs = options.pollMs ?? 500;
  const stableMs = options.stableMs ?? 1500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  let httpBlock: string | undefined;
  const onResponse = (response: Response) => {
    const target = new URL(response.url());
    const request = response.request();
    const mainDocument = request.isNavigationRequest() && response.frame() === page.mainFrame();
    if (target.origin === origin && (mainDocument || target.pathname.startsWith('/backend-api/')) &&
        (response.status() === 403 || response.status() === 429)) {
      httpBlock = `HTTP ${response.status()} ${target.pathname}`;
    }
  };
  page.on('response', onResponse);
  const stopped = page.getByTestId('stop-button').or(page.getByRole('button', { name: stopName })).first();
  const guard = async () => {
    if (page.isClosed()) throw new Error('Automation tab was closed. No retry will be attempted.');
    if (httpBlock) throw new AccessBlockedError(httpBlock);
    const title = await page.title();
    const text = await page.locator('body').innerText();
    if (/just a moment|attention required/i.test(title) || blockedText.test(text) ||
        await page.locator('iframe[src*="challenges.cloudflare.com"]').first().isVisible()) {
      throw new AccessBlockedError('Challenge or usage limit detected. Stopping the batch.');
    }
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
      await page.waitForTimeout(pollMs);
    } while (Date.now() < deadline);
    throw new Error(`${label} timed out. No automatic resend will be attempted.`);
  };

  try {
    for (const prompt of prompts) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
      const composer = page.locator('#prompt-textarea').or(page.getByRole('textbox', {
        name: /ChatGPT に聞く|Ask anything|Ask ChatGPT|Message ChatGPT/i,
      })).filter({ visible: true }).first();
      // Both the legacy UI and the current app shell are used across accounts.
      const account = page.getByTestId('accounts-profile-button').or(page.getByRole('button', {
        name: /^(プロフィールメニューを開く|Open profile menu)$/i,
      })).filter({ visible: true });
      const readiness = { signedIn: false, composerVisible: false, composerEditable: false, generating: false };
      try {
        await waitUntil(async () => {
          // Hydration can briefly expose both a loading control and the real account menu.
          readiness.signedIn = await account.evaluateAll(elements => elements.some(element =>
            !(element instanceof HTMLButtonElement && element.disabled) &&
            element.getAttribute('aria-disabled') !== 'true' &&
            !/プロフィールを読み込み中|loading profile/i.test(element.textContent ?? '')));
          readiness.composerVisible = await composer.isVisible();
          readiness.composerEditable = readiness.composerVisible && await composer.isEditable();
          readiness.generating = await stopped.isVisible();
          return readiness.signedIn && readiness.composerEditable && !readiness.generating;
        }, readyTimeoutMs, 'Signed-in composer');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Signed-in composer timed out')) {
          throw new ProfileNotReadyError(`${error.message} Readiness: ${JSON.stringify(readiness)}`);
        }
        throw error;
      }
      if ((await composerText(composer)).trim()) {
        throw new ProfileNotReadyError('An existing draft is present; it will not be overwritten.');
      }
      const users = page.locator('[data-message-author-role="user"], [data-user-message-bubble]');
      const assistants = page.locator('[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]');
      const previousUsers = await users.count();
      const previousAssistants = await assistants.count();
      await composer.fill(prompt.text);
      // The rich-text editor normalizes paragraphs/blank lines during fill. Compare its
      // post-fill state, not the original plain text, to detect later manual edits.
      const filledText = await composerText(composer);
      if (!filledText.trim()) throw new ProfileNotReadyError('Composer is empty after filling.');
      await options.beforeSend?.();
      await guard();
      if ((await composerText(composer)).replaceAll('\r\n', '\n') !== filledText.replaceAll('\r\n', '\n')) {
        throw new ProfileNotReadyError('Composer changed before sending; no message will be sent.');
      }
      const beforeSubmitUrl = page.url();
      options.onEvent?.('sending', prompt);
      await composer.press('Enter'); // Send ONCE. Never retry an uncertain submission.
      const timeout = options.responseTimeoutMs ?? 300_000;
      try {
        await waitUntil(async () => {
          const current = new URL(page.url());
          const newConversation = current.origin === origin &&
            /^\/c\/[a-f0-9-]+$/i.test(current.pathname) && page.url() !== beforeSubmitUrl;
          return (await users.count() > previousUsers || newConversation) &&
            !(await composerText(composer)).trim();
        }, readyTimeoutMs, 'Submission acknowledgement');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Submission acknowledgement timed out')) {
          throw new Error(`${error.message} URL: ${page.url()}; user messages: ${await users.count()}; composer length: ${(await composerText(composer)).trim().length}`);
        }
        throw error;
      }

      let previousContent = '';
      let stableSince = Date.now();
      await waitUntil(async () => {
        if (await assistants.count() <= previousAssistants || await stopped.isVisible()) {
          stableSince = Date.now();
          return false;
        }
        const last = assistants.last();
        const rendered = last.locator('[data-dil-message-id]').last();
        const content = await rendered.count() ? await rendered.innerText() : await last.innerText();
        // The current shell marks the turn complete before its answer finishes rendering.
        // Require its response-level Copy action as well; code-block Copy is not sufficient.
        const turn = page.locator('[data-testid^="conversation-turn-"], [data-talvt-turn-state]')
          .filter({ has: last }).last();
        const complete = await turn.getByTestId('copy-turn-action-button').isVisible() ||
          (await turn.getAttribute('data-talvt-turn-state') === 'complete' &&
            await turn.getByRole('button', { name: /^(コピーする|Copy|Copy response)$/i })
              .filter({ visible: true }).first().isVisible());
        const fingerprint = content;
        if (fingerprint !== previousContent || !complete) {
          previousContent = fingerprint;
          stableSince = Date.now();
        }
        const hasAnswer = content.trim().length > 0;
        return hasAnswer && complete && Date.now() - stableSince >= stableMs;
      }, timeout, 'Assistant response completion');
      options.onEvent?.('completed', prompt);
    }
  } finally {
    page.off('response', onResponse);
  }
}
