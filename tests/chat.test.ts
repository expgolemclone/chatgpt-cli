import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { launchProfile } from '../src/browser/edge.ts';
import { NonFreeAccountError, ProfileNotReadyError, runChat } from '../src/chat.ts';
import { AccessBlockedError, assertAccess } from '../src/browser/account.ts';
import { generatePrompts, maxPrompts, type Prompt } from '../src/prompts/generate.ts';
import { accountCheck, challengeFixture, featurePath, fixture } from './fixtures/chat.ts';

const prompt: Prompt = { id: 'test', text: 'Review this:\n```ts\nconst n = 3;\n```' };

test('access checks ignore conversation text but still detect actual warnings', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-access-text-test-');
  const edge = await launchProfile({ path: temporary, name: 'fixture' });
  try {
    const page = await edge.context.newPage();
    const options = { challengeTimeoutMs: 100, pollMs: 10 };
    await page.setContent(`<!doctype html><title>Notes about Just a moment</title>
      <nav>Too many requests</nav>
      <div role="textbox" contenteditable="true">Verify you are human</div>
      <main><article data-talvt-turn-state="complete">
        <div data-message-author-role="user">You've reached the usage limit</div>
        <div data-message-author-role="assistant">If you have reached your spending limit, stop the trial.
          Verify you are human.</div>
      </article></main>
      <div style="display:none">You've reached the usage limit</div>`);
    await assertAccess(page, {}, options);
    await page.evaluate(() => { document.body.append("You've reached the usage limit"); });
    await assert.rejects(assertAccess(page, {}, options),
      (error: unknown) => error instanceof AccessBlockedError && /Usage limit detected/.test(error.message));
    await page.evaluate(() => { document.body.lastChild?.remove(); });
    await page.evaluate(() => {
      const warning = document.createElement('div');
      warning.setAttribute('role', 'alert');
      warning.textContent = "You've reached the usage limit";
      document.body.append(warning);
    });
    await assert.rejects(assertAccess(page, {}, options),
      (error: unknown) => error instanceof AccessBlockedError && /Usage limit detected/.test(error.message));
    await page.setContent('<!doctype html><title>Just a moment...</title><body>Verify you are human</body>');
    await assert.rejects(assertAccess(page, {}, options),
      (error: unknown) => error instanceof AccessBlockedError && /Cloudflare challenge timed out/.test(error.message));
    await assert.rejects(assertAccess(page, { block: { status: 429, path: '/backend-api/me' } }, options),
      (error: unknown) => error instanceof AccessBlockedError && /HTTP 429/.test(error.message));
  } finally {
    await edge.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('access checks repeat only a read interrupted by navigation', async () => {
  let failure: Error | undefined = new Error('Execution context was destroyed, most likely because of a navigation');
  let reads = 0;
  const locator = {
    or() { return this; }, filter() { return this; }, first() { return this; },
    async evaluateAll() {
      reads++;
      if (failure) { const error = failure; failure = undefined; throw error; }
      return [];
    },
    async isVisible() { return false; },
  };
  const page = {
    isClosed: () => false, getByText: () => locator, locator: () => locator, title: async () => 'ChatGPT',
  } as unknown as Page;
  await assertAccess(page, {}, { pollMs: 1, challengeTimeoutMs: 1000 });
  assert.equal(reads, 2);
  failure = new Error('Target page, context or browser has been closed');
  await assert.rejects(assertAccess(page, {}), /Target page, context or browser has been closed/);
});

test('chat flow uses only a disposable profile and a local HTTP fixture', async t => {
  const sent: string[] = [];
  let mode = 'normal';
  let identityRequests = 0;
  let planRequests = 0;
  let navigations = 0;
  const failures = new Map<string, number>();
  const failedRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const failureStatus = failures.get(request.url ?? '');
    if (mode.startsWith('challenge-') && request.url === '/') {
      response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      response.end(challengeFixture(mode === 'challenge-stuck' ? undefined : mode === 'challenge-long' ? 61_000 : 600));
    } else if (failureStatus !== undefined) {
      failedRequests.push(request.url!);
      response.writeHead(failureStatus, { 'content-type': 'application/json' });
      response.end('{}');
    } else if (request.url === '/backend-api/me') {
      identityRequests++;
      if (['identity-challenge', 'multiple-challenges'].includes(mode) && identityRequests === 1) {
        response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        response.end(challengeFixture());
        return;
      }
      const status = mode === 'identity-forbidden' ? 403 : mode === 'identity-limited' ? 429
        : mode === 'identity-unauthorized' || (mode === 'identity-expires' && identityRequests > 1) ? 401 : 200;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(mode === 'identity-invalid' ? 'invalid-json'
        : JSON.stringify(mode === 'identity-no-email' ? {} : { email: 'fixture@example.test' }));
    } else if (request.url?.startsWith(accountCheck)) {
      planRequests++;
      if (['plan-challenge', 'multiple-challenges'].includes(mode) && planRequests === 1) {
        response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        response.end(challengeFixture());
        return;
      }
      const requestMode = mode;
      const status = requestMode === 'plan-forbidden' ? 403 : requestMode === 'plan-limited' ? 429
        : requestMode === 'plan-unauthorized' ? 401 : requestMode === 'plan-error' ? 500 : 200;
      const paid = ['plus', 'go', 'pro', 'team', 'enterprise', 'future'].find(plan => requestMode === `plan-${plan}`);
      const planType = paid ?? (requestMode === 'plan-plus-ui-free' || (requestMode === 'plan-expires' && planRequests > 1)
        ? 'plus' : 'free');
      const free = { account: { plan_type: 'free' } };
      const bodies: Record<string, unknown> = {
        'plan-null': null,
        'plan-no-accounts': {},
        'plan-empty': { accounts: {} },
        'plan-array': { accounts: [free] },
        'plan-no-type': { accounts: { default: { account: {} } } },
        'plan-invalid-type': { accounts: { default: { account: { plan_type: false } } } },
        'plan-partial': { accounts: { default: free, other: {} } },
        'plan-mixed': { accounts: { default: free, other: { account: { plan_type: 'plus' } } } },
      };
      const body = requestMode in bodies ? bodies[requestMode] : { accounts: { default: { account: { plan_type: planType } } } };
      if (requestMode === 'plan-delayed') await new Promise(resolve => setTimeout(resolve, 150));
      response.writeHead(status, { 'content-type': 'application/json' });
      if (requestMode === 'plan-pending') {
        response.flushHeaders();
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      response.end(requestMode === 'plan-invalid' ? 'invalid-json' : JSON.stringify(body));
    } else if (request.url === '/backend-api/f/conversation') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      sent.push(body);
      if (mode === 'no-ack') return;
      if (mode === 'streaming-response') {
        await new Promise(resolve => setTimeout(resolve, 150));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        response.write('data: started\n\n'); // Deliberately never finish the answer stream.
        return;
      }
      const status = ['submission-forbidden', 'submission-challenge'].includes(mode) ? 403 : mode === 'submission-limited' ? 429
        : mode === 'submission-error' ? 500 : 200;
      response.writeHead(status, mode === 'submission-challenge' ? { 'cf-mitigated': 'challenge' } : {});
      response.end('ok');
    } else {
      if (request.url === '/') navigations++;
      response.writeHead(mode === 'forbidden' ? 403 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture(mode === 'challenge-login' ? 'login' : mode));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-chat-test-');
  const edge = await launchProfile({ path: temporary, name: 'fixture' });
  const { context } = edge;
  const page = await context.newPage();
  page.on('pageerror', error => t.diagnostic(String(error)));
  const options = { url, readyTimeoutMs: 2000, answerTimeoutMs: 2000, pollMs: 20 };
  try {
    await t.test('completes five rallies in one conversation with one native identity and plan check', async () => {
      sent.length = 0; mode = 'normal'; navigations = 0; identityRequests = 0; planRequests = 0;
      const prompts = generatePrompts('a', 'default-batch');
      assert.equal(prompts.length, 5);
      const events: string[] = [];
      await runChat(page, prompts, {
        ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`),
      });
      assert.deepEqual(sent.map(text => text.replace(/\s+/g, ' ')),
        prompts.map(item => item.text.replace(/\s+/g, ' ')));
      assert.deepEqual(events, prompts.flatMap(item => [`sending:${item.id}`, `sent:${item.id}`, `completed:${item.id}`]));
      assert.equal(navigations, 1);
      assert.equal(identityRequests, 1);
      assert.equal(planRequests, 1);
      assert.equal(await page.locator('[data-talvt-turn-state="complete"]').count(), 5);
      assert.equal(await page.locator('[data-conversation-role="assistant"]').count(), 5);
      assert.equal(page.url(), new URL('/c/fixture-conversation', url).href);
    });
    await t.test('access phrases in prompts and answers do not stop a conversation', async () => {
      mode = 'quoted-access-text'; sent.length = 0;
      const quoted = { ...prompt, text: "If you've reached the usage limit, verify you are human." };
      const next = { ...prompt, id: 'next', text: 'Next question' };
      const events: string[] = [];
      await runChat(page, [quoted, next], {
        ...options, challengeTimeoutMs: 150, onEvent: (event, item) => events.push(`${event}:${item.id}`),
      });
      assert.deepEqual(sent, [quoted.text, next.text]);
      assert.deepEqual(events, ['sending:test', 'sent:test', 'completed:test', 'sending:next', 'sent:next', 'completed:next']);
    });
    await t.test('current rich-text UI works without legacy ids', async () => {
      sent.length = 0; mode = 'modern';
      await runChat(page, [prompt, { ...prompt, text: 'Next modern question' }], options);
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.replace(/\s+/g, ' '), prompt.text.replace(/\s+/g, ' '));
      assert.equal(sent[1], 'Next modern question');
    });
    await t.test('complete code review, image, and Codex prompts reach both composer variants', async () => {
      const generated = generatePrompts('a', 'mixed-chat', maxPrompts);
      const prompts = [generated.find(item => item.id.startsWith('code-review-'))!,
        generated.find(item => item.id.startsWith('image-'))!,
        generated.find(item => item.id.startsWith('codex-'))!];
      assert.ok(prompts.every(Boolean));
      for (const value of ['normal', 'modern']) {
        mode = value; sent.length = 0;
        await runChat(page, prompts, options);
        assert.deepEqual(sent.map(text => text.replace(/\s+/g, ' ')),
          prompts.map(item => item.text.replace(/\s+/g, ' ')));
      }
    });
    await t.test('waits for the Send control to become enabled without relying on Enter settings', async () => {
      mode = 'delayed-send'; sent.length = 0;
      await runChat(page, [prompt], options);
      assert.deepEqual(sent, [prompt.text]);
    });
    await t.test('never submits through a disabled Send control', async () => {
      mode = 'send-disabled'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], { ...options, readyTimeoutMs: 350 }), /Send control timed out/);
      assert.equal(sent.length, 0);
    });
    await t.test('a collapsed sidebar does not hide native authentication', async () => {
      mode = 'collapsed'; sent.length = 0;
      await runChat(page, [prompt], options);
      assert.deepEqual(sent, [prompt.text]);
    });
    await t.test('paid plans are skipped without filling, sending, or consuming the send delay', async () => {
      for (const value of ['plan-plus', 'plan-go', 'plan-pro', 'plan-team', 'plan-enterprise', 'plan-future', 'plan-mixed', 'plan-plus-ui-free']) {
        mode = value; sent.length = 0;
        const events: string[] = [];
        let beforeSend = false;
        await assert.rejects(runChat(page, [prompt, prompt], {
          ...options, beforeSend: async () => { beforeSend = true; }, onEvent: event => events.push(event),
        }), NonFreeAccountError);
        assert.equal(sent.length, 0, value);
        assert.equal(await page.getByRole('textbox').innerText(), '', value);
        assert.equal(beforeSend, false, value);
        assert.deepEqual(events, [], value);
      }
    });
    await t.test('missing, malformed, unauthorized, or incomplete plans never permit submission', async () => {
      for (const value of ['plan-missing', 'plan-invalid', 'plan-null', 'plan-no-accounts', 'plan-empty',
        'plan-array', 'plan-no-type', 'plan-invalid-type', 'plan-partial', 'plan-unauthorized', 'plan-error']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], { ...options, readyTimeoutMs: 350 }), ProfileNotReadyError);
        assert.equal(sent.length, 0, value);
        assert.equal(await page.getByRole('textbox').innerText(), '', value);
      }
    });
    await t.test('a delayed free plan and misleading sidebar label do not replace native plan checks', async () => {
      for (const value of ['plan-delayed', 'plan-free-ui-plus']) {
        mode = value; sent.length = 0; planRequests = 0;
        await runChat(page, [prompt], options);
        assert.deepEqual(sent, [prompt.text], value);
        assert.equal(planRequests, 1, 'The runner must only observe the app request, not issue its own.');
      }
    });
    await t.test('a native plan change during the same conversation prevents another submission', async () => {
      mode = 'plan-expires'; sent.length = 0; planRequests = 0;
      await assert.rejects(runChat(page, [prompt, prompt], options), NonFreeAccountError);
      assert.deepEqual(sent, [prompt.text]);
      assert.equal(planRequests, 2);
    });
    await t.test('a paid or unconfirmed plan after filling stops before clicking Send', async () => {
      for (const value of ['plan-plus', 'plan-unauthorized', 'plan-invalid', 'plan-pending']) {
        mode = 'normal'; sent.length = 0;
        const events: string[] = [];
        await assert.rejects(runChat(page, [prompt], {
          ...options, onEvent: event => events.push(event), beforeSend: async () => {
            mode = value;
            const response = page.waitForResponse(response => new URL(response.url()).pathname === accountCheck);
            await page.evaluate(async path => { await fetch(path); }, accountCheck);
            if (value !== 'plan-pending') await (await response).body();
          },
        }), value === 'plan-plus' ? NonFreeAccountError : ProfileNotReadyError);
        assert.equal(sent.length, 0, value);
        assert.deepEqual(events, [], value);
      }
    });
    await t.test('a late free-plan body cannot overwrite a newer paid or unauthorized response', async () => {
      for (const value of ['plan-plus', 'plan-unauthorized']) {
        mode = 'normal'; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], {
          ...options, beforeSend: async () => {
            mode = 'plan-pending';
            const old = page.waitForResponse(response => new URL(response.url()).pathname === accountCheck);
            await page.evaluate(async path => { await fetch(path); }, accountCheck);
            mode = value;
            const latest = page.waitForResponse(response => new URL(response.url()).pathname === accountCheck);
            await page.evaluate(async path => { await fetch(path); }, accountCheck);
            await (await latest).body();
            await (await old).body();
          },
        }), value === 'plan-plus' ? NonFreeAccountError : ProfileNotReadyError);
        assert.equal(sent.length, 0, value);
      }
    });
    await t.test('403 and 429 plan responses stop the batch before submission', async () => {
      for (const value of ['plan-forbidden', 'plan-limited']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], options), AccessBlockedError);
        assert.equal(sent.length, 0);
      }
    });
    await t.test('profile controls cannot replace a missing, invalid, or unauthorized native identity', async () => {
      for (const value of ['identity-missing', 'identity-invalid', 'identity-no-email', 'identity-unauthorized', 'conflicting-login']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], { ...options, readyTimeoutMs: 350 }), ProfileNotReadyError);
        assert.equal(sent.length, 0, value);
      }
    });
    await t.test('native login loss during the same conversation prevents another submission', async () => {
      mode = 'identity-expires'; identityRequests = 0; sent.length = 0;
      await assert.rejects(runChat(page, [prompt, prompt], { ...options, readyTimeoutMs: 350 }), ProfileNotReadyError);
      assert.equal(sent.length, 1);
      assert.equal(identityRequests, 2);
    });
    await t.test('login loss after filling stops before clicking Send', async () => {
      mode = 'normal'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], {
        ...options, beforeSend: async () => {
          mode = 'identity-unauthorized';
          await page.evaluate(async () => { await fetch('/backend-api/me'); });
        },
      }), ProfileNotReadyError);
      assert.equal(sent.length, 0);
    });
    await t.test('403 and 429 identity responses stop before submission', async () => {
      for (const value of ['identity-forbidden', 'identity-limited']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], options), AccessBlockedError);
        assert.equal(sent.length, 0);
      }
    });
    await t.test('server acceptance alone is not answer completion and never permits another submission', async () => {
      sent.length = 0; mode = 'no-dom-ack';
      const events: string[] = [];
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, answerTimeoutMs: 250, onEvent: event => events.push(event),
      }), /Assistant answer timed out/);
      assert.deepEqual(sent, [prompt.text]);
      assert.deepEqual(events, ['sending', 'sent']);
      assert.equal(await page.getByRole('textbox').innerText(), prompt.text);
    });
    await t.test('replaces existing drafts without resetting the conversation', async () => {
      mode = 'draft'; sent.length = 0;
      const next = { ...prompt, id: 'next', text: 'Replacement prompt' };
      await runChat(page, [prompt, next], options);
      assert.deepEqual(sent, [prompt.text, next.text]);
    });
    await t.test('logged-out pages are not submitted', async () => {
      mode = 'login'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], options), ProfileNotReadyError);
      assert.equal(sent.length, 0);
    });
    await t.test('manual edits after filling are not sent', async () => {
      mode = 'normal'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], {
        ...options, beforeSend: async () => { await page.getByRole('textbox').fill('Manual change'); },
      }), ProfileNotReadyError);
      assert.equal(sent.length, 0);
    });
    await t.test('feature-specific 403 and 429 responses do not block chat readiness or acceptance', async () => {
      try {
        for (const status of [403, 429]) {
          mode = 'feature-failure'; sent.length = 0; failedRequests.length = 0;
          failures.set(featurePath, status);
          failures.set('/backend-api/optional-feature', status);
          const events: string[] = [];
          await runChat(page, [prompt, { ...prompt, id: 'next', text: 'Next question' }], {
            ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`), beforeSend: async () => {
              // Exercise another feature before submission, not a Bazaar-specific exception.
              await page.evaluate(async () => { await fetch('/backend-api/optional-feature'); });
            },
          });
          assert.deepEqual(sent, [prompt.text, 'Next question']);
          assert.deepEqual(events, ['sending:test', 'sent:test', 'completed:test', 'sending:next', 'sent:next', 'completed:next']);
          assert.equal(failedRequests.filter(path => path === featurePath).length, 3);
          assert.equal(failedRequests.filter(path => path === '/backend-api/optional-feature').length, 2);
        }
      } finally {
        failures.clear();
      }
    });
    await t.test('403 and 429 chat preparation and security responses still stop before submission', async () => {
      try {
        for (const path of ['/backend-api/f/conversation/prepare', '/backend-api/sentinel/chat-requirements',
          '/backend-api/sentinel/chat-requirements/prepare']) {
          for (const status of [403, 429]) {
            mode = 'normal'; sent.length = 0;
            failures.clear(); failures.set(path, status);
            const events: string[] = [];
            await assert.rejects(runChat(page, [prompt, prompt], {
              ...options, onEvent: event => events.push(event), beforeSend: async () => {
                await page.evaluate(async path => { await fetch(path); }, path);
              },
            }), (error: unknown) => error instanceof AccessBlockedError && error.message === `HTTP ${status} ${path}`);
            assert.equal(sent.length, 0);
            assert.deepEqual(events, []);
          }
        }
      } finally {
        failures.clear();
      }
    });
    await t.test('Cloudflare interstitials clear automatically without using the composer timeout or resending', async () => {
      for (const value of ['challenge-clears', 'identity-challenge', 'plan-challenge', 'multiple-challenges']) {
        mode = value; sent.length = 0; identityRequests = 0; planRequests = 0;
        const events: string[] = [];
        await runChat(page, [prompt], {
          ...options, readyTimeoutMs: 350, onEvent: event => events.push(event),
        });
        assert.deepEqual(sent, [prompt.text], value);
        assert.deepEqual(events, ['sending', 'sent', 'completed'], value);
        assert.equal(identityRequests, ['identity-challenge', 'multiple-challenges'].includes(value) ? 2 : 1, value);
        assert.equal(planRequests, ['plan-challenge', 'multiple-challenges'].includes(value) ? 2 : 1, value);
      }
    });
    await t.test('the default Cloudflare grace period survives a real one-minute challenge', async () => {
      mode = 'challenge-long'; sent.length = 0;
      const started = Date.now();
      await runChat(page, [prompt], { ...options, readyTimeoutMs: 350 });
      assert.ok(Date.now() - started >= 61_000);
      assert.deepEqual(sent, [prompt.text]);
    });
    await t.test('visible challenges wait before sending without interacting with verification controls', async () => {
      for (const value of ['title', 'body', 'iframe']) {
        mode = 'normal'; sent.length = 0;
        await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ body: '' }));
        try {
          await runChat(page, [prompt], {
            ...options, beforeSend: async () => {
              await page.evaluate(value => {
                const marker = document.createElement(value === 'iframe' ? 'iframe' : 'p');
                if (value === 'title') document.title = 'Just a moment...';
                if (value === 'body') marker.textContent = 'Verify you are human';
                if (marker instanceof HTMLIFrameElement) marker.src = 'https://challenges.cloudflare.com/fixture';
                marker.addEventListener('click', () => { throw new Error('Verification must not be clicked'); });
                document.body.append(marker);
                setTimeout(() => { document.title = 'Local chat fixture'; marker.remove(); }, 600);
              }, value);
            },
          });
          assert.deepEqual(sent, [prompt.text], value);
        } finally {
          await page.unroute('https://challenges.cloudflare.com/**');
        }
      }
    });
    await t.test('Cloudflare waiting pauses answer deadlines without resubmitting', async () => {
      mode = 'normal'; sent.length = 0;
      const events: string[] = [];
      await runChat(page, [prompt, prompt], {
        ...options, answerTimeoutMs: 350, onEvent: event => {
          events.push(event);
          if (event === 'sent') void page.evaluate(() => {
            document.title = 'Just a moment...';
            setTimeout(() => { document.title = 'Local chat fixture'; }, 600);
          });
        },
      });
      assert.deepEqual(sent, [prompt.text, prompt.text]);
      assert.deepEqual(events, ['sending', 'sent', 'completed', 'sending', 'sent', 'completed']);
    });
    await t.test('Cloudflare waiting does not hide genuine HTTP blocks or usage limits', async () => {
      for (const value of ['http', 'usage']) {
        mode = 'normal'; sent.length = 0;
        const started = Date.now();
        await assert.rejects(runChat(page, [prompt], {
          ...options, beforeSend: async () => {
            await page.evaluate(value => {
              document.title = 'Just a moment...';
              if (value === 'usage') document.body.append("You've reached the usage limit");
            }, value);
            if (value === 'http') {
              mode = 'identity-limited';
              await page.evaluate(async () => { await fetch('/backend-api/me'); });
            }
          },
        }), (error: unknown) => error instanceof AccessBlockedError &&
          (value === 'http' ? /HTTP 429/.test(error.message) : /Usage limit detected/.test(error.message)));
        assert.ok(Date.now() - started < 5000);
        assert.deepEqual(sent, []);
      }
    });
    await t.test('unresolved Cloudflare challenges time out without filling or submitting', async () => {
      mode = 'challenge-stuck'; sent.length = 0;
      const events: string[] = [];
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, challengeTimeoutMs: 150, onEvent: event => events.push(event),
      }), (error: unknown) => error instanceof AccessBlockedError && /Cloudflare challenge timed out/.test(error.message));
      assert.deepEqual(sent, []);
      assert.deepEqual(events, []);
    });
    await t.test('batch cancellation interrupts the Cloudflare grace period promptly', async () => {
      mode = 'challenge-stuck'; sent.length = 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Test challenge cancelled')), 250);
      try {
        await assert.rejects(runChat(page, [prompt], {
          ...options, pollMs: 10_000, signal: controller.signal,
        }), /aborted|Test challenge cancelled/);
        assert.deepEqual(sent, []);
      } finally { clearTimeout(timer); }
    });
    await t.test('clearing a Cloudflare challenge does not replace authentication', async () => {
      mode = 'challenge-login'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], options), ProfileNotReadyError);
      assert.deepEqual(sent, []);
    });
    await t.test('a challenged submission is never resent', async () => {
      mode = 'submission-challenge'; sent.length = 0;
      const events: string[] = [];
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, challengeTimeoutMs: 150, onEvent: event => events.push(event),
      }), AccessBlockedError);
      assert.deepEqual(sent, [prompt.text]);
      assert.deepEqual(events, ['sending']);
    });
    await t.test('403 and 429 main documents still stop before submission', async () => {
      try {
        for (const status of [403, 429]) {
          mode = 'normal'; sent.length = 0;
          failures.set('/', status);
          await assert.rejects(runChat(page, [prompt, prompt], options), AccessBlockedError);
          assert.equal(sent.length, 0);
        }
      } finally {
        failures.clear();
      }
    });
    await t.test('403 and visible usage limits stop rather than trying another question', async () => {
      mode = 'forbidden'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], options), AccessBlockedError);
      assert.equal(sent.length, 0);
      mode = 'limit';
      await assert.rejects(runChat(page, [prompt, prompt], options), AccessBlockedError);
      assert.equal(sent.length, 1);
    });
    await t.test('waits for text and image-only answers, including the last answer', async () => {
      for (const value of ['normal', 'delayed-answer', 'image-only']) {
        mode = value; sent.length = 0;
        const events: string[] = [];
        await runChat(page, [prompt, { ...prompt, id: 'next', text: 'Next question' }], {
          ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`),
        });
        assert.deepEqual(sent, [prompt.text, 'Next question'], value);
        assert.deepEqual(events, ['sending:test', 'sent:test', 'completed:test', 'sending:next', 'sent:next', 'completed:next'], value);
        assert.equal(await page.locator('[data-talvt-turn-state="complete"]').count(), 2);
        assert.equal(await page.getByTestId('stop-button').count(), 0);
        if (value === 'image-only') assert.equal(await page.getByTestId('generated-image-preview').count(), 2);
      }
    });
    await t.test('missing or unfinished answers never trigger another prompt even when Stop is absent', async () => {
      for (const value of ['no-answer', 'generating', 'partial-answer', 'complete-while-stopping', 'streaming-response']) {
        mode = value; sent.length = 0;
        const events: string[] = [];
        await assert.rejects(runChat(page, [prompt, prompt], {
          ...options, answerTimeoutMs: 300, onEvent: event => events.push(event),
        }), /Assistant answer timed out/);
        assert.deepEqual(sent, [prompt.text], value);
        assert.deepEqual(events, ['sending', 'sent'], value);
      }
    });
    await t.test('an old completed turn cannot satisfy the new answer wait', async () => {
      mode = 'no-answer'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, answerTimeoutMs: 250, beforeSend: async () => {
          await page.locator('main').evaluate(element => {
            element.insertAdjacentHTML('afterbegin', '<div data-talvt-turn-state="complete"><h4 data-conversation-role="assistant">Old answer</h4></div>');
          });
        },
      }), /Assistant answer timed out/);
      assert.deepEqual(sent, [prompt.text]);
    });
    await t.test('batch cancellation interrupts answer waiting without another submission', async () => {
      mode = 'generating'; sent.length = 0;
      const controller = new AbortController();
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, signal: controller.signal, onEvent: event => {
          if (event === 'sent') controller.abort(new Error('Test batch stopped'));
        },
      }), /Test batch stopped/);
      assert.deepEqual(sent, [prompt.text]);
      const cancelled = new AbortController();
      cancelled.abort();
      sent.length = 0;
      await assert.rejects(runChat(page, [prompt], { ...options, signal: cancelled.signal }), /aborted/i);
      assert.deepEqual(sent, []);
    });
    await t.test('rejected submissions stop without resending or trying another prompt', async () => {
      for (const value of ['submission-forbidden', 'submission-limited', 'submission-error']) {
        mode = value; sent.length = 0;
        const events: string[] = [];
        await assert.rejects(runChat(page, [prompt, prompt], {
          ...options, onEvent: event => events.push(event),
        }), value === 'submission-error' ? /Submission rejected: HTTP 500/ : AccessBlockedError);
        assert.equal(sent.length, 1, value);
        assert.deepEqual(events, ['sending'], value);
      }
    });
    await t.test('an uncertain submission is never resent or followed by another prompt', async () => {
      mode = 'no-ack'; sent.length = 0;
      const events: string[] = [];
      await assert.rejects(runChat(page, [prompt, prompt], {
        ...options, readyTimeoutMs: 350, onEvent: event => events.push(event),
      }), /Submission acknowledgement failed.*No automatic resend/);
      assert.equal(sent.length, 1);
      assert.equal(await page.getByRole('textbox').innerText(), '');
      assert.equal(await page.locator('[data-user-message-bubble]').count(), 1);
      assert.deepEqual(events, ['sending']);
    });
  } finally {
    await edge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

