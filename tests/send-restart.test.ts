import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { launchProfile } from '../src/browser/edge.ts';
import { createProfile } from '../src/browser/profiles.ts';
import { fixture } from './fixtures/chat.ts';
import { closeWindow, manualPreload } from './fixtures/native-edge.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const execute = promisify(execFile);

for (const marked of [true, false]) test(`send kills an open ${marked ? 'marked' : 'explicit unmarked'} profile, retains its data, and leaves another browser alive`, async () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-send-restart-');
  const observed: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/ready?')) {
      observed.push(new URL(request.url, 'http://localhost').searchParams.get('local')!);
      response.end('ok');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end("<title>Retained profile data</title><script>fetch('/ready?local='+encodeURIComponent(localStorage.getItem('identity')))</script>");
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let ordinaryPid: number | undefined;
  let other: Awaited<ReturnType<typeof launchProfile>> | undefined;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}/`;
    const root = join(temporary, "dedicated profiles 日本語's");
    const created = createProfile(root);
    const untouched = createProfile(root);
    if (!marked) unlinkSync(join(created.path, '.gpt-usage-id'));
    const selected = marked ? created : { name: created.name, path: created.path };
    const seeded = await launchProfile(selected);
    try {
      await seeded.context.addCookies([{ name: 'identity', value: 'retained-cookie', url: origin,
        expires: Date.now() / 1000 + 3600, httpOnly: true }]);
      const page = seeded.context.pages()[0]!;
      await page.goto(origin);
      await page.evaluate(() => localStorage.setItem('identity', 'retained-storage'));
    } finally { await seeded.close(); }
    observed.length = 0;
    other = await launchProfile(untouched);
    const otherPage = other.context.pages()[0]!;
    await otherPage.setContent('<title>Keep this other profile open</title>');

    const launches = join(temporary, 'launches.jsonl');
    const manual = join(temporary, 'manual.mjs');
    writeFileSync(manual, manualPreload);
    const opened = await execute(process.execPath,
      ['--import', pathToFileURL(manual).href, cli, 'open', '--profile', selected.path], {
        encoding: 'utf8', timeout: 20_000, env: { ...process.env,
          LOCALAPPDATA: join(temporary, 'localappdata'), FIXTURE_URL: origin,
          FIXTURE_LAUNCHES: launches, FIXTURE_PADDING: '1' },
      });
    assert.match(opened.stdout, /"profile-opened"/);
    ordinaryPid = JSON.parse(readFileSync(launches, 'utf8').trim().split('\n').at(-1)!).pid;
    const deadline = Date.now() + 15_000;
    while (!observed.includes('retained-storage') && Date.now() < deadline) await setTimeout(100);
    assert.ok(observed.includes('retained-storage'), 'The ordinary browser loaded the retained profile.');
    assert.equal(existsSync(join(selected.path, 'DevToolsActivePort')), false);
    // The preload puts 900 characters before user-data-dir. Selection must use its full native command line.
    const run = (...args: string[]) => execute(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    await run('send', '--profile', selected.path, '--questions', '1', '--dry-run');
    await assert.rejects(run('send', '--profile', selected.path, '--questions', '0'), /Prompt count must be/);
    assert.doesNotThrow(() => process.kill(ordinaryPid!, 0), 'Read-only and invalid invocations never kill Edge.');
    const denied = join(temporary, 'deny-termination.mjs');
    writeFileSync(denied, `
      import koffi from ${JSON.stringify(import.meta.resolve('koffi'))};
      const load = koffi.load;
      koffi.load = name => {
        const library = load(name);
        if (name !== 'kernel32.dll') return library;
        const func = library.func.bind(library);
        return { ...library, func(definition) {
          const native = func(definition);
          return definition.includes('OpenProcess')
            ? (access, ...args) => access & 1 ? 0 : native(access, ...args) : native;
        } };
      };
    `);
    await assert.rejects(execute(process.execPath, ['--import', pathToFileURL(denied).href,
      cli, 'send', '--profile', selected.path, '--questions', '1'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    }), /Cannot terminate the selected Edge profile/);
    assert.doesNotThrow(() => process.kill(ordinaryPid!, 0), 'A denied termination never launches automation.');

    const preload = join(temporary, 'offline-chat.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const read = fs.readFileSync;
      let busyReads = 0;
      fs.readFileSync = (path, ...args) => {
        if (String(path) === ${JSON.stringify(join(selected.path, 'DevToolsActivePort'))} && busyReads++ < 2) {
          console.log(JSON.stringify({ event: 'fixture-endpoint-busy' }));
          throw Object.assign(new Error('Edge is publishing its endpoint.'), { code: 'EBUSY' });
        }
        return read(path, ...args);
      };
      syncBuiltinESMExports();
      const connect = chromium.connectOverCDP.bind(chromium);
      chromium.connectOverCDP = async (endpoint, options) => {
        const browser = await connect(endpoint, options);
        const context = browser.contexts()[0];
        assert.ok((await context.cookies(${JSON.stringify(origin)})).some(cookie =>
          cookie.name === 'identity' && cookie.value === 'retained-cookie'), 'Saved authentication survives termination.');
        const page = context.pages()[0];
        await page.goto(${JSON.stringify(origin)});
        assert.equal(await page.evaluate(() => localStorage.getItem('identity')), 'retained-storage');
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'https://chatgpt.com') return route.abort();
          if (url.pathname === '/backend-api/me') return route.fulfill({ json: { email: 'fixture@example.test' } });
          if (url.pathname.startsWith('/backend-api/accounts/check/')) {
            return route.fulfill({ json: { accounts: { default: { account: { plan_type: 'free' } } } } });
          }
          if (url.pathname === '/backend-api/f/conversation') {
            console.log(JSON.stringify({ event: 'fixture-submitted' }));
            return route.fulfill({ status: 200, body: 'Local answer only' });
          }
          if (route.request().isNavigationRequest()) return route.fulfill({
            contentType: 'text/html; charset=utf-8', body: ${JSON.stringify(fixture('modern'))},
          });
          return route.abort();
        });
        return browser;
      };
    `);
    const sent = await execute(process.execPath, ['--import', pathToFileURL(preload).href,
      cli, 'send', '--profile', selected.path, '--questions', '1', '--seed', 'restart-fixture'], {
      encoding: 'utf8', timeout: 45_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    const records = sent.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.event === 'profile-terminated' && record.pid === ordinaryPid));
    assert.equal(records.filter(record => record.event === 'fixture-endpoint-busy').length, 2);
    assert.equal(records.filter(record => record.event === 'fixture-submitted').length, 1);
    assert.equal(records.filter(record => record.event === 'sent').length, 1);
    assert.equal(records.filter(record => record.event === 'completed').length, 1);
    assert.equal(records.at(-1).success, true);
    assert.throws(() => process.kill(ordinaryPid!, 0), 'The pre-existing selected browser was terminated.');
    if (marked) assert.equal(readFileSync(join(selected.path, '.gpt-usage-id'), 'utf8'), created.id);
    else assert.equal(existsSync(join(selected.path, '.gpt-usage-id')), false);
    assert.equal(readFileSync(join(untouched.path, '.gpt-usage-id'), 'utf8'), untouched.id);
    assert.equal(await otherPage.title(), 'Keep this other profile open');
    assert.equal(existsSync(join(untouched.path, 'DevToolsActivePort')), true);
    assert.equal(existsSync(join(selected.path, 'DevToolsActivePort')), false);
  } finally {
    if (ordinaryPid !== undefined) await closeWindow(ordinaryPid);
    await other?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
