import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { AccessBlockedError, ProfileNotReadyError, runChat } from '../src/chat.js';
import { generatePrompts, maxPrompts, type Prompt } from '../src/prompts/generate.js';

const edge = process.env.EDGE_EXECUTABLE ?? (process.platform === 'win32'
  ? join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')
  : chromium.executablePath());
const prompt: Prompt = { id: 'test', text: 'Review this:\n```ts\nconst n = 3;\n```' };

function fixture(mode: string): string {
  return `<!doctype html><html><head><title>Local chat fixture</title></head><body>
  ${['login', 'conflicting-login'].includes(mode) ? '<button>ログイン</button>' : mode === 'collapsed' ? '' : mode === 'modern'
    ? '<button aria-label="プロフィールメニューを開く">プロフィールを読み込み中</button><button aria-label="プロフィールメニューを開く"></button>'
    : '<button data-testid="accounts-profile-button">Account</button>'}
  ${mode === 'modern' ? '<div id="prompt-textarea" contenteditable="true" style="display:none"></div>' : ''}
  <div ${mode === 'modern' ? '' : 'id="prompt-textarea"'} contenteditable="true" role="textbox" aria-label="ChatGPT に聞く">${mode === 'draft' ? 'Existing draft' : ''}</div>
  <button aria-label="送信" disabled>Send</button>
  <main></main>
  <script>
    const mode = ${JSON.stringify(mode)};
    if (mode !== 'identity-missing') fetch('/backend-api/me');
    const composer = document.querySelector('[role="textbox"]');
    if (mode === 'modern') composer.addEventListener('input', () => {
      const paragraphs = composer.innerText.split('\\n').map(line => {
        const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph;
      });
      composer.replaceChildren(...paragraphs);
    });
    const send = document.querySelector('[aria-label="送信"]');
    composer.addEventListener('input', () => {
      if (mode !== 'send-disabled') setTimeout(() => { send.disabled = false; }, mode === 'delayed-send' ? 150 : 0);
    });
    send.addEventListener('click', () => {
      const text = composer.innerText;
      fetch('/backend-api/f/conversation', {method: 'POST', body: text});
      if (mode === 'no-dom-ack') return;
      const user = document.createElement('div');
      if (mode === 'modern') user.dataset.userMessageBubble = 'true';
      else user.dataset.messageAuthorRole = 'user';
      user.textContent = text;
      document.querySelector('main').append(user);
      composer.textContent = '';
      if (mode === 'generating') {
        const stop = document.createElement('button'); stop.dataset.testid = 'stop-button';
        document.body.append(stop); return;
      }
      if (mode === 'image-only') {
        document.querySelector('main').insertAdjacentHTML('beforeend',
          '<div data-talvt-turn-state="complete"><button data-testid="generated-image-preview"><img alt="生成画像1" src="data:image/png;base64,broken"></button></div>');
        return;
      }
      if (mode === 'limit') document.body.append("You've reached the usage limit");
    });
  </script></body></html>`;
}

test('chat flow uses only a disposable profile and a local HTTP fixture', async t => {
  assert.ok(existsSync(edge), `Browser executable is required: ${edge}`);
  const sent: string[] = [];
  let mode = 'normal';
  let identityRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/backend-api/me') {
      identityRequests++;
      const status = mode === 'identity-forbidden' ? 403 : mode === 'identity-limited' ? 429
        : mode === 'identity-unauthorized' || (mode === 'identity-expires' && identityRequests > 1) ? 401 : 200;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(mode === 'identity-invalid' ? 'invalid-json'
        : JSON.stringify(mode === 'identity-no-email' ? {} : { email: 'fixture@example.test' }));
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
      const status = mode === 'submission-forbidden' ? 403 : mode === 'submission-limited' ? 429
        : mode === 'submission-error' ? 500 : 200;
      response.writeHead(status);
      response.end('ok');
    } else {
      response.writeHead(mode === 'forbidden' ? 403 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture(mode));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-chat-test-');
  const context = await chromium.launchPersistentContext(temporary, { executablePath: edge, headless: true });
  const page = await context.newPage();
  const options = { url, readyTimeoutMs: 2000, pollMs: 20 };
  try {
    await t.test('clicks Send once and confirms acceptance before the next chat', async () => {
      sent.length = 0; mode = 'normal';
      const events: string[] = [];
      await runChat(page, [prompt, { ...prompt, id: 'second', text: 'Second question' }], {
        ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`),
      });
      assert.deepEqual(sent, [prompt.text, 'Second question']);
      assert.deepEqual(events, ['sending:test', 'sent:test', 'sending:second', 'sent:second']);
    });
    await t.test('current rich-text UI works without legacy ids', async () => {
      sent.length = 0; mode = 'modern';
      await runChat(page, [prompt, { ...prompt, text: 'Next modern question' }], options);
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.replace(/\s+/g, ' '), prompt.text.replace(/\s+/g, ' '));
      assert.equal(sent[1], 'Next modern question');
    });
    await t.test('image and Codex prompt bodies reach the local fixture without code review wrapping', async () => {
      const prompts = generatePrompts('a', 'mixed-chat', maxPrompts).filter(item =>
        item.id === 'image-presentation-cover' || item.id === 'codex-pilot');
      assert.equal(prompts.length, 2);
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
    await t.test('profile controls cannot replace a missing, invalid, or unauthorized native identity', async () => {
      for (const value of ['identity-missing', 'identity-invalid', 'identity-no-email', 'identity-unauthorized', 'conflicting-login']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], { ...options, readyTimeoutMs: 350 }), ProfileNotReadyError);
        assert.equal(sent.length, 0, value);
      }
    });
    await t.test('native login identity is revalidated for every new chat', async () => {
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
    await t.test('server acceptance does not depend on optimistic user bubbles or composer clearing', async () => {
      sent.length = 0; mode = 'no-dom-ack';
      await runChat(page, [prompt], options);
      assert.deepEqual(sent, [prompt.text]);
      assert.equal(await page.getByRole('textbox').innerText(), prompt.text);
      assert.equal(await page.locator('[data-message-author-role="user"]').count(), 0);
    });
    await t.test('replaces existing drafts with only the current prompt in every new chat', async () => {
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
    await t.test('403 and visible usage limits stop rather than trying another question', async () => {
      mode = 'forbidden'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt], options), AccessBlockedError);
      assert.equal(sent.length, 0);
      mode = 'limit';
      await assert.rejects(runChat(page, [prompt, prompt], options), AccessBlockedError);
      assert.equal(sent.length, 1);
    });
    await t.test('moves on without waiting for absent, unfinished, or image-only answers', async () => {
      for (const value of ['normal', 'generating', 'image-only', 'streaming-response']) {
        mode = value; sent.length = 0;
        const events: string[] = [];
        await runChat(page, [prompt, { ...prompt, id: 'next', text: 'Next question' }], {
          ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`),
        });
        assert.deepEqual(sent, [prompt.text, 'Next question'], value);
        assert.deepEqual(events, ['sending:test', 'sent:test', 'sending:next', 'sent:next'], value);
        if (value === 'generating') assert.equal(await page.getByTestId('stop-button').isVisible(), true);
        if (value === 'image-only') assert.equal(await page.getByTestId('generated-image-preview').count(), 1);
      }
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
      assert.equal(await page.locator('[data-message-author-role="user"]').count(), 1);
      assert.deepEqual(events, ['sending']);
    });
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
