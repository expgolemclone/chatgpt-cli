import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AccessBlockedError, assertAccess, type ChallengeEvent } from '../src/browser/account.ts';
import { launchProfile } from '../src/browser/edge.ts';

test('only visible Cloudflare verification checkboxes are pressed', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-challenge-test-');
  const server = createServer((_request, response) => response.end('<!doctype html><title>Chat fixture</title>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = await launchProfile({ path: temporary, name: 'fixture' });
  try {
    const page = await edge.context.newPage();
    const windowSession = await edge.context.newCDPSession(page);
    try {
      const { windowId } = await windowSession.send('Browser.getWindowForTarget');
      await windowSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } finally { await windowSession.detach(); }
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.route('https://challenges.cloudflare.com/**', route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>
        const root = document.body.attachShadow({ mode: 'closed' });
        root.innerHTML = '<label style="display:none"><input type="checkbox">Hidden</label>' +
          '<label><input type="checkbox" disabled>Disabled</label><label><input type="checkbox">Verify</label>';
        root.querySelectorAll('input').forEach(input => input.addEventListener('click', event => {
          if (${JSON.stringify(name)} === 'stuck') event.preventDefault();
          parent.postMessage({ name: ${JSON.stringify(name)}, trusted: event.isTrusted }, '*');
        }));
      </script></body>` });
    });
    await page.route('https://challenges.cloudflare.com.evil.test/**', route => route.fulfill({
      contentType: 'text/html', body: '<label><input type="checkbox">Unrelated checkbox</label>',
    }));

    await t.test('closed shadow roots, hidden frames, and lookalike origins', async () => {
      await page.setContent('<!doctype html><title>Chat fixture</title><input id="ordinary" type="checkbox">');
      const navigations = ['target', 'hidden', 'unrelated'].map(name => page.waitForEvent('framenavigated', {
        predicate: frame => frame.url().endsWith('/' + name),
      }));
      await page.evaluate(() => {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'closed' });
        const frame = document.createElement('iframe');
        frame.src = 'https://challenges.cloudflare.com/target';
        root.append(frame);
        document.body.append(host);
        for (const [url, hidden] of [
          ['https://challenges.cloudflare.com/hidden', true],
          ['https://challenges.cloudflare.com.evil.test/unrelated', false],
        ] as const) {
          const other = document.createElement('iframe');
          other.src = url;
          if (hidden) other.style.display = 'none';
          document.body.append(other);
        }
        window.addEventListener('message', event => {
          if (event.data?.name === 'target' || event.data?.name === 'hidden') {
            const messages = JSON.parse(document.body.dataset.messages ?? '[]') as unknown[];
            messages.push(event.data);
            document.body.dataset.messages = JSON.stringify(messages);
            if (event.data.name === 'target') host.remove();
          }
        });
      });
      await Promise.all(navigations);
      const events: ChallengeEvent[] = [];
      await assertAccess(page, {}, { pollMs: 25, challengeTimeoutMs: 5000, onChallenge: event => events.push(event) });
      assert.deepEqual(events.map(event => event.phase), ['waiting', 'cleared']);
      const waiting = events[0];
      assert.ok(waiting && waiting.phase === 'waiting');
      assert.deepEqual(waiting.indicators, ['iframe']);
      assert.deepEqual(JSON.parse(await page.locator('body').getAttribute('data-messages') ?? '[]'), [
        { name: 'target', trusted: true },
      ]);
      assert.equal(await page.locator('#ordinary').isChecked(), false);
      const unrelated = page.frames().find(frame => frame.url().endsWith('/unrelated'));
      assert.ok(unrelated);
      assert.equal(await unrelated.locator('input').isChecked(), false);
    });

    await t.test('an unresolved checkbox is not clicked repeatedly', async () => {
      await page.setContent('<!doctype html><title>Chat fixture</title>');
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().endsWith('/stuck') });
      await page.evaluate(() => {
        window.addEventListener('message', event => {
          if (event.data?.name === 'stuck') {
            document.body.dataset.clicks = String(Number(document.body.dataset.clicks ?? 0) + 1);
          }
        });
        const frame = document.createElement('iframe');
        frame.src = 'https://challenges.cloudflare.com/stuck';
        document.body.append(frame);
      });
      await navigation;
      await assert.rejects(assertAccess(page, {}, { pollMs: 25, challengeTimeoutMs: 700 }),
        (error: unknown) => error instanceof AccessBlockedError && /Cloudflare challenge timed out/.test(error.message));
      assert.equal(await page.locator('body').getAttribute('data-clicks'), '1');
    });
  } finally {
    await edge.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
