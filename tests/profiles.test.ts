import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { challengeFixture, featurePath, fixture } from './fixtures/chat.ts';

test('parallel minimized profiles skip paid accounts, finish five rallies, and stop together on access blocks', async t => {
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
      let opened = 0;
      let release;
      const allOpened = new Promise(resolve => { release = resolve; });
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
        await context.route('**/*', async route => {
          const target = new URL(route.request().url());
          if (target.origin !== 'https://chatgpt.com') return route.abort();
          if (target.pathname === '/backend-api/me') {
            if (name === 'waiting') {
              await new Promise(resolve => context.once('close', resolve));
              return;
            }
            return route.fulfill({ json: { email: 'fixture@example.test' } });
          }
          if (target.pathname.startsWith('/backend-api/accounts/check/')) {
            return route.fulfill({ json: { accounts: { default: { account: { plan_type: name === 'paid' ? 'plus' : 'free' } } } } });
          }
          if (target.pathname === ${JSON.stringify(featurePath)}) {
            return route.fulfill({ status: name === 'feature-limited' ? 429 : 403, json: {} });
          }
          if (target.pathname === '/backend-api/f/conversation') {
            const { bounds } = await session.send('Browser.getWindowForTarget');
            assert.equal(bounds.windowState, 'minimized');
            console.log(JSON.stringify({ event: 'fixture-submitted', profile: name, time: Date.now() }));
            if (name === 'delayed-blocked') await setTimeout(1500);
            return route.fulfill({ status: name === 'submission-blocked' ? 403
              : ['submission-limited', 'delayed-blocked'].includes(name) ? 429 : 200, body: 'ok' });
          }
          if (route.request().isNavigationRequest()) {
            await allOpened;
            const { bounds } = await session.send('Browser.getWindowForTarget');
            assert.equal(bounds.windowState, 'minimized');
            if (!target.search) console.log(JSON.stringify({ event: 'fixture-navigated', profile: name }));
            if (name === 'challenge' && !target.search) return route.fulfill({ status: 403,
              headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html',
              body: ${JSON.stringify(challengeFixture(750))} });
            return route.fulfill({ status: name === 'blocked' ? 403 : 200,
              contentType: 'text/html; charset=utf-8', body: ${JSON.stringify(fixture('feature-failure'))} });
          }
          return route.abort();
        });
        context.on('close', () => console.log(JSON.stringify({ event: 'fixture-profile-closed', profile: name })));
        console.log(JSON.stringify({ event: 'fixture-profile-opened', profile: name }));
        if (++opened === Number(process.env.FIXTURE_PROFILE_COUNT)) release();
        return browser;
      };
    `);
    const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const scenarios = [
      { names: ['paid', 'free'], count: 1, status: 0, submitted: ['free'], skipped: ['paid'] },
      { names: ['paid'], count: 1, status: 0, submitted: [], skipped: ['paid'] },
      { names: ['challenge', 'free'], count: 1, status: 0, submitted: ['challenge', 'free'], skipped: [] },
      { names: ['feature-limited'], count: 1, status: 0, submitted: ['feature-limited'], skipped: [] },
      { names: ['blocked', 'waiting'], count: 1, status: 1, submitted: [], skipped: [] },
      { names: ['submission-blocked', 'waiting'], count: 1, status: 1, submitted: ['submission-blocked'], skipped: [] },
      { names: ['submission-limited', 'waiting'], count: 1, status: 1, submitted: ['submission-limited'], skipped: [] },
      { names: ['delayed-blocked', 'free'], count: 2, status: 1, submitted: ['delayed-blocked', 'free'], skipped: [] },
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
          encoding: 'utf8', timeout: scenario.count === undefined ? 160_000 : scenario.status ? 20_000 : 55_000,
          env: { ...process.env, LOCALAPPDATA: localAppData, FIXTURE_PROFILE_COUNT: String(profiles.length) },
        });
        assert.equal(result.error, undefined, result.stdout + result.stderr);
        assert.equal(result.status, scenario.status, result.stdout + result.stderr);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        const profilesFor = (event: string) => records.filter(record => record.event === event).map(record => record.profile).sort();
        assert.deepEqual(profilesFor('fixture-submitted'), scenario.submitted);
        assert.deepEqual(profilesFor('fixture-profile-opened'), [...scenario.names].sort());
        assert.deepEqual(profilesFor('fixture-profile-closed'), [...scenario.names].sort());
        const navigated = profilesFor('fixture-navigated');
        if (scenario.status === 0) {
          assert.deepEqual(navigated, [...scenario.names].sort());
        } else {
          assert.ok(navigated.includes(scenario.names[0]));
          assert.ok(navigated.every(profile => scenario.names.includes(profile)));
        }
        assert.deepEqual(profilesFor('profile-skipped'), scenario.skipped);
        assert.equal(records.filter(record => record.event === 'batch-stopped').length, scenario.status);
        const stopped = records.findIndex(record => record.event === 'batch-stopped');
        if (stopped >= 0) assert.equal(records.slice(stopped).some(record => record.event === 'fixture-submitted'), false);
        if (scenario.names.includes('free-a')) {
          const submissions = records.filter(record => record.event === 'sending');
          assert.equal(new Set(submissions.slice(0, 2).map(record => record.profile)).size, 2);
          for (const name of ['free-a', 'free-b']) {
            const times = submissions.filter(record => record.profile === name).map(record => Date.parse(record.time));
            assert.equal(times.length, 5);
            for (let index = 1; index < times.length; index++) {
              assert.ok(times[index]! - times[index - 1]! >= 29_900, JSON.stringify(times));
            }
          }
          assert.ok(Math.abs(Date.parse(submissions[0].time) - Date.parse(submissions[1].time)) < 10_000);
          assert.equal(records.filter(record => record.event === 'completed').length, 10);
        }
        assert.equal(records.at(-1).event, 'finished');
        assert.equal(records.at(-1).success, scenario.status === 0);
        assert.deepEqual(readdirSync(join(localAppData, 'chatgpt-cli')), ['logs']);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
