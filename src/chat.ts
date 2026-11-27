import { basename } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { JSHandle, Locator, Page, Response } from 'playwright';
import type { Prompt } from './prompts/generate.ts';
import { AccessBlockedError, CloudflareChallengeError, assertAccess, isLoginSurface, observeAccount,
  type AccessOptions, type ChallengeEvent } from './browser/account.ts';
import { classifyProfile } from './browser/inspect.ts';

export class ProfileNotReadyError extends Error {}
export class LoginRequiredError extends ProfileNotReadyError {}
export class NonFreeAccountError extends Error {}

export interface ChatOptions extends AccessOptions {
  url?: string;
  readyTimeoutMs?: number;
  answerTimeoutMs?: number;
  beforeSend?: () => Promise<void>;
  onEvent?: (event: 'sending' | 'sent' | 'completed', prompt: Prompt) => void;
}

const stopName = /^(Stop generating|Stop streaming|生成を停止する|生成を停止|停止)$/i;

async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate(element =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent ?? '');
}

function hasCompletedReply(
  page: Page,
  prior: JSHandle<Set<Element>> | null,
  submitted: string | null,
): Promise<boolean> {
  return page.evaluate(({ prior, submitted }) => {
    const elements = Array.from(document.querySelectorAll('[data-talvt-turn-state]'));
    const turn = elements.at(-1);
    if (!turn || (prior ? prior.has(turn) : submitted !== null && elements.length !== 1)
        || turn.getAttribute('data-talvt-turn-state') !== 'complete') return false;
    if (submitted !== null) {
      const bubble = turn.querySelector<HTMLElement>('[data-user-message-bubble], [data-message-author-role="user"]');
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      if (!bubble) return false;
      // Long messages have a localized expand affordance inside the message bubble.
      const actual = normalize(bubble.innerText), expected = normalize(submitted);
      if (actual !== expected && actual !== expected + ' … 展開' && actual !== expected + ' … Expand') return false;
    }
    // Image-only turns can lose their assistant heading when the final gallery replaces the progress UI.
    const gallery = turn.querySelector('[data-testid="generated-image-gallery"]');
    if (!gallery) return turn.querySelector('[data-conversation-role="assistant"]') !== null;
    return Array.from(gallery.querySelectorAll<HTMLImageElement>('[data-testid="generated-image-preview"] img'))
      .some(image => image.complete && image.naturalWidth > 0);
  }, { prior, submitted });
}

interface ImageTurn {
  prompt: Prompt;
  expectedEmail?: string;
  references?: string[];
  save: (turn: Locator) => Promise<void>;
}

/** Free batches and single Plus images share one guarded submission and acknowledgement path. */
export async function runChat(page: Page, request: Prompt[] | ImageTurn, options: ChatOptions = {}): Promise<void> {
  const image = Array.isArray(request) ? undefined : request;
  const prompts = Array.isArray(request) ? request : [request.prompt];
  const url = options.url ?? 'https://chatgpt.com/';
  const origin = new URL(url).origin;
  const pollMs = options.pollMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const answerTimeoutMs = options.answerTimeoutMs ?? 600_000;
  const cancellation = options.signal ? { signal: options.signal } : {};
  const actionOptions = { timeout: readyTimeoutMs, ...cancellation };
  let stage: NonNullable<ChallengeEvent['stage']> = 'navigation';
  const onChallenge = (event: ChallengeEvent) => options.onChallenge?.({ ...event, stage });
  const accessOptions = { ...options, onChallenge };
  const { account, dispose } = observeAccount(page, origin, onChallenge);
  let expectedEmail = image?.expectedEmail?.toLowerCase();
  const hasRequiredPlan = () => {
    if (!image) return account.plan?.sending === 'free';
    const inspection = classifyProfile(account, false); // guard separately rejects a visible login control.
    if (inspection.status !== 'logged_in' || !account.plan?.settled) return false;
    const email = inspection.email_address!.toLowerCase();
    if (expectedEmail && email !== expectedEmail) throw new ProfileNotReadyError('Account changed; check the selected profile.');
    if (inspection.state !== 'plus') throw new ProfileNotReadyError('Personal Plus is not confirmed; check the selected account.');
    expectedEmail = email; // Pin even an explicitly selected profile with a non-email directory name.
    return true;
  };
  const stopped = page.getByTestId('stop-button').or(page.getByRole('button', { name: stopName })).first();
  const turns = page.locator('[data-talvt-turn-state]');
  const guard = async () => {
    options.signal?.throwIfAborted();
    const pausedMs = await assertAccess(page, account, accessOptions);
    if (image && new URL(page.url()).origin !== origin) throw new ProfileNotReadyError('Chat origin changed; check the selected profile.');
    if (!image && account.plan?.sending === 'non-free') throw new NonFreeAccountError('Non-free account detected; this profile will be skipped.');
    if (await isLoginSurface(page, origin)) {
      throw new LoginRequiredError('Login required; manual login is needed.');
    }
    return pausedMs;
  };
  const waitUntil = async (condition: () => Promise<boolean>, timeout: number, label: string) => {
    let deadline = Date.now() + timeout;
    do {
      deadline += await guard();
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
      stage = 'readiness';
      const readiness = { signedIn: false, planConfirmed: false, composerVisible: false, composerEditable: false, generating: false };
      try {
        await waitUntil(async () => {
          readiness.signedIn = Boolean(account.identity?.email);
          readiness.planConfirmed = hasRequiredPlan();
          readiness.composerVisible = await composer.isVisible();
          readiness.composerEditable = readiness.composerVisible && await composer.isEditable();
          readiness.generating = await stopped.isVisible();
          return readiness.signedIn && readiness.planConfirmed && readiness.composerEditable && !readiness.generating;
        }, readyTimeoutMs, 'Signed-in composer');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Signed-in composer timed out')) {
          throw new ProfileNotReadyError(image ? 'Cannot confirm the signed-in Plus composer; check the selected profile.'
            : `${error.message} Readiness: ${JSON.stringify(readiness)}`);
        }
        throw error;
      }
      stage = 'submission';
      const references = image?.references ?? [];
      const names = references.map(file => basename(file));
      const form = page.locator('form').filter({ has: composer });
      const attachments = form.getByRole('button', { name: /^(?:Remove .+|.+ を削除する)$/i });
      const readyAttachments = async () => await attachments.count() === names.length &&
        (!names.length || await form.locator('img[alt]').evaluateAll((nodes, expected) => {
          const loaded = nodes.filter((node): node is HTMLImageElement =>
            node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0);
          // The upload UI can add "(1)" before the extension when reusing a filename.
          const matched = expected.map(name => loaded.filter(img =>
            img.alt === name || img.alt.replace(/ ?\(\d+\)(?=\.[^.]+$)/, '') === name));
          return matched.every(matches => matches.length === 1) && new Set(matched.flat()).size === expected.length;
        }, names));
      if (image && (await turns.count() !== 0 || new URL(page.url()).pathname !== '/' || (await composerText(composer)).trim() || await attachments.count())) {
        throw new ProfileNotReadyError('Expected an empty new chat; leave any existing draft untouched.');
      }
      if (references.length) {
        try {
          const input = form.getByLabel(/^(?:Attach files?|ファイルを添付)$/i);
          await guard();
          if (!hasRequiredPlan() || new URL(page.url()).pathname !== '/' || await turns.count() !== 0) {
            throw new ProfileNotReadyError('The verified new chat changed before attaching references.');
          }
          await input.setInputFiles(references, actionOptions);
          await waitUntil(readyAttachments, readyTimeoutMs, 'Reference previews');
        } catch (error) {
          if (error instanceof AccessBlockedError || error instanceof ProfileNotReadyError) throw error;
          throw new ProfileNotReadyError('Could not confirm all reference images in the composer.', { cause: error });
        }
      }
      await composer.fill(prompt.text, actionOptions);
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
      if (!account.identity?.email) throw new ProfileNotReadyError('Native login identity is no longer confirmed; no message will be sent.');
      if (image && (new URL(page.url()).pathname !== '/' || await turns.count() !== 0 ||
          !await readyAttachments() || !await send.isEnabled())) {
        throw new ProfileNotReadyError('Chat or attachments changed before submission.');
      }
      if (!hasRequiredPlan()) throw new ProfileNotReadyError('Required account plan is no longer confirmed; no message will be sent.');
      const priorTurns = await turns.count() > 0
        ? await page.evaluateHandle(() => new Set(Array.from(document.querySelectorAll('[data-talvt-turn-state]'))))
        : null;
      try {
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
        stage = 'answer';
        options.onEvent?.('sent', prompt);
        await waitUntil(async () => !(await stopped.isVisible()) && hasCompletedReply(page, priorTurns, image ? filledText : null),
          answerTimeoutMs, 'Assistant answer');
      } finally {
        await priorTurns?.dispose().catch(() => {});
      }
      if (image) {
        // The streamed preview can look complete before its download viewer is usable.
        // Open the saved conversation with a GET; never submit the prompt again.
        const saved = new URL(page.url());
        if (saved.origin !== origin || !/^\/c\/[a-z0-9-]+$/i.test(saved.pathname)) {
          throw new ProfileNotReadyError('Cannot identify the saved image conversation.');
        }
        await page.goto(origin + saved.pathname, { waitUntil: 'domcontentloaded', ...actionOptions });
        await waitUntil(async () => {
          if (new URL(page.url()).pathname !== saved.pathname) throw new ProfileNotReadyError('Saved conversation changed.');
          return hasRequiredPlan() && !(await stopped.isVisible()) && hasCompletedReply(page, null, filledText);
        }, readyTimeoutMs, 'Saved image reply');
        await guard();
        if (!hasRequiredPlan()) throw new ProfileNotReadyError('Account can no longer be confirmed.');
        await image.save(turns.last());
      }
      options.onEvent?.('completed', prompt);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof AccessBlockedError) throw error;
    if (account.block) throw new AccessBlockedError(`HTTP ${account.block.status} ${account.block.path}`, { cause: error });
    if (account.challengeLimit) throw account.challengeLimit;
    if (account.challenges?.size) {
      throw new CloudflareChallengeError(`Cloudflare challenge prevented ${stage}. Stopping the batch.`, { cause: error });
    }
    throw error;
  } finally {
    dispose();
  }
}
