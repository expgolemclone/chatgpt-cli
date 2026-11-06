import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { challengeFixture, featurePath, fixture } from './fixtures/chat.ts';

test('sequential minimized profiles skip paid accounts, finish five rallies, and stop on access blocks', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-profiles-test-');
  try {
    const preload = join(temporary, 'fixture.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import { basename, join } from 'node:path';
      import { existsSync, readFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const connect = chromium.connectOverCDP.bind(chromium);
      chromium.connectOverCDP = async (endpoint, options) => {
        const port = new URL(endpoint).port;
        const directory = process.argv.filter((value,index) => process.argv[index-1] === '--profile')
          .find(path => existsSync(join(path,'DevToolsActivePort')) &&
            readFileSync(join(path,'DevToolsActivePort'),'utf8').split(/\\r?\\n/)[0] === port);
        assert.ok(directory, 'CDP must attach only to an explicitly selected profile.');
        const name = basename(directory);
        const browser = await connect(endpoint, options);
        const context = browser.contexts()[0];
        const session = await context.newCDPSession(context.pages()[0]);
        await assert.rejects(session.send('Browser.getBrowserCommandLine'), /--enable-automation.*not set/);
        await session.detach();
        const newPageSession = context.newCDPSession.bind(context);
        context.newCDPSession = async (...args) => {
          const pageSession = await newPageSession(...args);
          const send = pageSession.send.bind(pageSession);
          pageSession.send = async (...command) => {
            const result = await send(...command);
            if (command[0] === 'Browser.setWindowBounds') {
              assert.equal(command[1].bounds.windowState, 'minimized');
              console.log(JSON.stringify({ event: 'fixture-window-minimized', profile: name }));
            }
            return result;
          };
          return pageSession;
        };
        await context.route('**/*', async route => {
          try {
            const target = new URL(route.request().url());
            if (target.origin !== 'https://chatgpt.com') return await route.abort();
            if (target.pathname === '/backend-api/me') {
              if (name === 'waiting') {
                await new Promise(resolve => context.once('close', resolve));
                return;
              }
              return await route.fulfill({ json: { email: 'fixture@example.test' } });
            }
            if (target.pathname.startsWith('/backend-api/accounts/check/')) {
              return await route.fulfill({ json: { accounts: { default: { account: { plan_type: name === 'paid' ? 'plus' : 'free' } } } } });
            }
            if (target.pathname === ${JSON.stringify(featurePath)}) {
              return await route.fulfill({ status: name === 'feature-limited' ? 429 : 403, json: {} });
            }
            if (target.pathname === '/backend-api/f/conversation') {
              console.log(JSON.stringify({ event: 'fixture-submitted', profile: name, time: Date.now() }));
              if (name === 'delayed-blocked') await setTimeout(1500);
              return await route.fulfill({ status: name === 'submission-blocked' ? 403
                : ['submission-limited', 'delayed-blocked'].includes(name) ? 429 : 200, body: 'ok' });
            }
            if (route.request().isNavigationRequest()) {
              if (!target.search) console.log(JSON.stringify({ event: 'fixture-navigated', profile: name }));
              if (name === 'challenge' && !target.search) return await route.fulfill({ status: 403,
                headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html',
                body: ${JSON.stringify(challengeFixture(750))} });
              return await route.fulfill({ status: name === 'blocked' ? 403 : 200,
                contentType: 'text/html; charset=utf-8', body: name === 'login'
                  ? ${JSON.stringify(fixture('login'))} : ${JSON.stringify(fixture('feature-failure'))} });
            }
            return await route.abort();
          } catch (error) {
            if (!String(error).includes('Target page, context or browser has been closed')) throw error;
          }
        });
        context.on('close', () => console.log(JSON.stringify({ event: 'fixture-profile-closed', profile: name })));
        if (name === 'cleanup-error') {
          const newSession = browser.newBrowserCDPSession.bind(browser);
          browser.newBrowserCDPSession = async () => {
            const closeSession = await newSession();
            const send = closeSession.send.bind(closeSession);
            closeSession.send = async (...args) => {
              const result = await send(...args);
              if (args[0] === 'Browser.close') throw new Error('Fixture close failure');
              return result;
            };
            return closeSession;
          };
        }
        console.log(JSON.stringify({ event: 'fixture-profile-opened', profile: name }));
        return browser;
      };
    `);
    const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const scenarios = [
      { names: ['paid', 'free'], count: 1, status: 0, submitted: ['free'], skipped: ['paid'] },
      { names: ['paid'], count: 1, status: 0, submitted: [], skipped: ['paid'] },
      { names: ['challenge', 'free'], count: 1, status: 0, submitted: ['challenge', 'free'], skipped: [] },
      { names: ['feature-limited'], count: 1, status: 0, submitted: ['feature-limited'], skipped: [] },
      { names: ['login', 'free'], count: 1, status: 1, submitted: ['free'], skipped: [], failed: 'login' },
      { names: ['cleanup-error', 'free'], count: 1, status: 1, submitted: ['cleanup-error'], skipped: [], stopped: true },
      { names: ['blocked', 'waiting'], count: 1, status: 1, submitted: [], skipped: [], stopped: true },
      { names: ['submission-blocked', 'waiting'], count: 1, status: 1, submitted: ['submission-blocked'], skipped: [], stopped: true },
      { names: ['submission-limited', 'waiting'], count: 1, status: 1, submitted: ['submission-limited'], skipped: [], stopped: true },
      { names: ['delayed-blocked', 'free'], count: 2, status: 1, submitted: ['delayed-blocked'], skipped: [], stopped: true },
      { names: ['free-a', 'free-b', 'paid'], count: undefined, status: 0,
        submitted: ['free-a', 'free-b'].flatMap(name => Array<string>(5).fill(name)), skipped: ['paid'] },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await t.test(scenario.names.join(', '), () => {
        const root = join(temporary, String(index), 'profiles');
        const profiles = scenario.names.map(name => {
          const path = join(root, name);
          mkdirSync(path, { recursive: true });
          return { name, path };
        });
        const localAppData = join(temporary, String(index), 'localappdata');
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'send',
          ...profiles.flatMap(profile => ['--profile', profile.path]),
          ...(scenario.count === undefined ? [] : ['--questions', String(scenario.count)]), '--seed', 'fixture'], {
          encoding: 'utf8', timeout: scenario.count === undefined ? 330_000 : scenario.status ? 25_000 : 55_000,
          env: { ...process.env, LOCALAPPDATA: localAppData },
        });
        assert.equal(result.error, undefined, result.stdout + result.stderr);
        assert.equal(result.status, scenario.status, result.stdout + result.stderr);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        const profilesFor = (event: string) => records.filter(record => record.event === event).map(record => record.profile).sort();
        assert.deepEqual(profilesFor('fixture-submitted'), scenario.submitted, result.stdout + result.stderr);
        const launched = scenario.stopped ? scenario.names.slice(0, 1) : scenario.names;
        const lifecycle = records.filter(record => ['fixture-profile-opened', 'fixture-profile-closed'].includes(record.event))
          .map(record => `${record.event}:${record.profile}`);
        assert.deepEqual(lifecycle, launched.flatMap(name => [`fixture-profile-opened:${name}`, `fixture-profile-closed:${name}`]));
        assert.deepEqual(profilesFor('fixture-window-minimized'), [...launched].sort());
        assert.deepEqual(profilesFor('fixture-navigated'), [...launched].sort());
        for (const name of launched) {
          const minimized = records.findIndex(record => record.event === 'fixture-window-minimized' && record.profile === name);
          const navigated = records.findIndex(record => record.event === 'fixture-navigated' && record.profile === name);
          assert.ok(minimized >= 0 && minimized < navigated);
        }
        assert.deepEqual(profilesFor('profile-skipped'), scenario.skipped);
        assert.deepEqual(profilesFor('profile-failed'), scenario.status ? [scenario.failed ?? scenario.names[0]] : []);
        assert.equal(records.filter(record => record.event === 'batch-stopped').length, scenario.stopped ? 1 : 0);
        const stopped = records.findIndex(record => record.event === 'batch-stopped');
        if (stopped >= 0) {
          assert.equal(records[stopped].profile, scenario.names[0]);
          assert.equal(records.slice(stopped).some(record => record.event === 'fixture-submitted'), false);
        }
        if (scenario.names.includes('challenge')) {
          const diagnostics = records.filter(record => record.event === 'challenge' && record.profile === 'challenge');
          assert.ok(diagnostics.some(record => record.phase === 'response' && record.stage === 'navigation' &&
            record.response.request === 'document' && record.response.status === 403));
          assert.ok(diagnostics.some(record => record.phase === 'waiting' &&
            record.indicators.includes('response') && record.indicators.includes('text')));
          const cleared = records.findIndex(record => record.event === 'challenge' &&
            record.profile === 'challenge' && record.phase === 'cleared');
          const submitted = records.findIndex(record => record.event === 'fixture-submitted' && record.profile === 'challenge');
          assert.ok(cleared >= 0 && submitted > cleared);
          assert.doesNotMatch(JSON.stringify(diagnostics), /fixture@example|Verify you are human|challenge=cleared/);
        }
        if (scenario.names.includes('free-a')) {
          const submissions = records.filter(record => record.event === 'sending');
          assert.deepEqual(submissions.map(record => record.profile),
            ['free-a', 'free-b'].flatMap(name => Array<string>(5).fill(name)));
          const times = submissions.map(record => Date.parse(record.time));
          for (let index = 1; index < times.length; index++) {
            assert.ok(times[index]! - times[index - 1]! >= 29_900, JSON.stringify(times));
          }
          assert.equal(records.filter(record => record.event === 'completed').length, 10);
        }
        assert.equal(records.at(-1).event, 'finished');
        assert.equal(records.at(-1).success, scenario.status === 0);
        assert.deepEqual(readdirSync(join(localAppData, 'chatgpt-cli')), ['logs']);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
