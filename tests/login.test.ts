import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('login opens only its own dedicated Edge window, persists browser data, and never sends', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-login-');
  try {
    const localAppData = join(temporary, 'localappdata');
    const profilePath = join(localAppData, 'gpt-send-messages', 'profile');
    const preload = join(temporary, 'fixture.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const launch = chromium.launchPersistentContext.bind(chromium);
      chromium.launchPersistentContext = async (directory, options) => {
        assert.equal(options.channel, 'msedge');
        assert.equal(options.headless, false);
        assert.equal(directory, process.env.EXPECTED_PROFILE);
        const context = await launch(directory, { ...options, args: [...options.args, '--disable-background-networking'] });
        await context.route('**/*', route => {
          assert.equal(route.request().method(), 'GET', 'Login must never submit prompts.');
          assert.equal(new URL(route.request().url()).origin, 'https://chatgpt.com');
          return route.fulfill({ contentType: 'text/html', body: '<title>Offline login fixture</title><p>Manual login window</p>' });
        });
        const page = context.pages()[0];
        page.once('domcontentloaded', async () => {
          const previous = await page.evaluate(() => localStorage.getItem('fixture'));
          assert.equal(previous, process.env.EXPECTED_PREVIOUS || null);
          await page.evaluate(() => localStorage.setItem('fixture', 'retained'));
          console.log(JSON.stringify({ event: 'fixture-login-opened' }));
          setTimeout(() => context.close(), 150);
        });
        return context;
      };
    `);
    for (const previous of ['', 'retained']) {
      await t.test(previous ? 'reopens the same dedicated profile without copying data' : 'creates its own first profile', () => {
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'login'], {
          encoding: 'utf8', timeout: 20_000,
          env: { ...process.env, LOCALAPPDATA: localAppData, EXPECTED_PROFILE: profilePath, EXPECTED_PREVIOUS: previous },
        });
        assert.equal(result.error, undefined, result.stdout + result.stderr);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(records.filter(record => record.event === 'fixture-login-opened').length, 1);
        assert.equal(records.filter(record => record.event === 'login-window-closed').length, 1);
        assert.equal(records.some(record => ['sending', 'sent', 'completed'].includes(record.event)), false);
        assert.equal(records.at(-1).success, true);
        assert.equal(existsSync(profilePath), true);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a busy profile fails without terminating or unlocking its existing browser', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-lock-');
  const profilePath = join(temporary, 'dedicated');
  mkdirSync(profilePath);
  const context = await chromium.launchPersistentContext(profilePath, { channel: 'msedge', headless: true });
  try {
    const page = context.pages()[0]!;
    await page.setContent('<title>Keep existing browser</title>');
    const result = spawnSync(process.execPath, [cli, 'send', '--profile', profilePath, '--questions', '1'], {
      encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    assert.equal(result.error, undefined, result.stdout + result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.some(record => record.event === 'sending'), false);
    assert.equal(records.at(-1).success, false);
    assert.equal(await page.title(), 'Keep existing browser');
    const inspected = spawnSync(process.execPath, [cli, 'inspect', '--profile', profilePath], {
      encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    const inspection = JSON.parse(inspected.stdout);
    assert.equal(inspection.status, 'unknown');
    assert.match(inspection.reason, /^browser_launch:/);
    assert.equal(await page.title(), 'Keep existing browser', 'Inspection must not close or unlock the external browser.');
  } finally {
    await context.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
