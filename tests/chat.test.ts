import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { AccessBlockedError, ProfileNotReadyError, runChat } from '../src/chat.js';
import type { Prompt } from '../src/prompts.js';

const edge = process.env.EDGE_EXECUTABLE ?? (process.platform === 'win32'
  ? join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')
  : chromium.executablePath());
const prompt: Prompt = { id: 'test', text: 'Review this:\n```ts\nconst n = 3;\n```' };

function fixture(mode: string): string {
  return `<!doctype html><html><head><title>Local chat fixture</title></head><body>
  ${mode === 'login' ? '<button>ログイン</button>' : mode === 'modern'
    ? '<button aria-label="プロフィールメニューを開く">プロフィールを読み込み中</button><button aria-label="プロフィールメニューを開く"></button>'
    : '<button data-testid="accounts-profile-button">Account</button>'}
  ${mode === 'modern' ? '<div id="prompt-textarea" contenteditable="true" style="display:none"></div>' : ''}
  <div ${mode === 'modern' ? '' : 'id="prompt-textarea"'} contenteditable="true" role="textbox" aria-label="ChatGPT に聞く">${mode === 'draft' ? 'Do not overwrite my draft' : ''}</div>
  <main></main>
  <script>
    const mode = ${JSON.stringify(mode)};
    const composer = document.querySelector('[role="textbox"]');
    if (mode === 'modern') composer.addEventListener('input', () => {
      const paragraphs = composer.innerText.split('\\n').map(line => {
        const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph;
      });
      composer.replaceChildren(...paragraphs);
    });
    composer.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      const text = composer.innerText;
      fetch('/sent', {method: 'POST', body: text});
      const user = document.createElement('div');
      if (mode === 'modern') user.dataset.userMessageBubble = 'true';
      else if (mode !== 'url-ack') user.dataset.messageAuthorRole = 'user';
      if (mode === 'url-ack') history.pushState(null, '', '/c/11111111-1111-4111-8111-111111111111');
      user.textContent = text;
      document.querySelector('main').append(user);
      composer.textContent = '';
      if (mode === 'no-answer') return;
      if (mode === 'limit') { document.body.append("You've reached the usage limit"); return; }
      const turn = document.createElement('article');
      if (mode === 'modern') turn.dataset.talvtTurnState = 'complete';
      else turn.dataset.testid = 'conversation-turn-1';
      const assistant = document.createElement('div');
      if (mode === 'modern') assistant.dataset.contentSearchUnitKey = 'fallback-turn-0:2:assistant';
      else assistant.dataset.messageAuthorRole = 'assistant';
      assistant.textContent = 'Working...';
      turn.append(assistant); document.querySelector('main').append(turn);
      // A gap without a stop button must NOT be mistaken for completion.
      setTimeout(() => {
        const stop = document.createElement('button'); stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop generating'; document.body.append(stop);
        setTimeout(() => {
          assistant.textContent = 'Final answer';
          stop.remove();
          const copy = document.createElement('button');
          if (mode === 'modern') copy.setAttribute('aria-label', 'コピーする');
          else copy.dataset.testid = 'copy-turn-action-button';
          copy.textContent = 'Copy'; turn.append(copy);
        }, 150);
      }, 100);
    });
  </script></body></html>`;
}

test('chat flow uses only a disposable profile and a local HTTP fixture', async t => {
  assert.ok(existsSync(edge), `Browser executable is required: ${edge}`);
  const sent: string[] = [];
  let mode = 'normal';
  const server = createServer(async (request, response) => {
    if (request.url === '/sent') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      sent.push(body);
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
  const options = { url, readyTimeoutMs: 2000, responseTimeoutMs: 2000, stableMs: 40, pollMs: 20 };
  try {
    await t.test('sends with Enter once and waits for completion before the next chat', async () => {
      sent.length = 0; mode = 'normal';
      const events: string[] = [];
      await runChat(page, [prompt, { ...prompt, id: 'second', text: 'Second question' }], {
        ...options, onEvent: (event, item) => events.push(`${event}:${item.id}`),
      });
      assert.deepEqual(sent, [prompt.text, 'Second question']);
      assert.deepEqual(events, ['sending:test', 'completed:test', 'sending:second', 'completed:second']);
      assert.equal(await page.locator('[data-message-author-role="assistant"]').innerText(), 'Final answer');
    });
    await t.test('current rich-text UI works without legacy ids and waits for rendered completion', async () => {
      sent.length = 0; mode = 'modern';
      await runChat(page, [prompt, { ...prompt, text: 'Next modern question' }], options);
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.replace(/\s+/g, ' '), prompt.text.replace(/\s+/g, ' '));
      assert.equal(sent[1], 'Next modern question');
      assert.equal(await page.locator('[data-content-search-unit-key$=":assistant"]').innerText(), 'Final answer');
    });
    await t.test('a new server-assigned conversation URL also acknowledges submission', async () => {
      sent.length = 0; mode = 'url-ack';
      await runChat(page, [prompt], options);
      assert.deepEqual(sent, [prompt.text]);
      assert.match(page.url(), /\/c\/11111111-1111-4111-8111-111111111111$/);
    });
    await t.test('logged-out pages and drafts are not submitted', async () => {
      for (const value of ['login', 'draft']) {
        mode = value; sent.length = 0;
        await assert.rejects(runChat(page, [prompt], options), ProfileNotReadyError);
        assert.equal(sent.length, 0);
      }
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
    await t.test('an uncertain response is never resent', async () => {
      mode = 'no-answer'; sent.length = 0;
      await assert.rejects(runChat(page, [prompt, prompt], { ...options, responseTimeoutMs: 150 }), /No automatic resend/);
      assert.equal(sent.length, 1);
    });
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
