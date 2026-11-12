import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateBatches } from '../src/prompts/generate.ts';
import { challengeFixture, featurePath, fixture } from './fixtures/chat.ts';
import { sendPacingFixture } from './fixtures/send-pacing.ts';

interface Scenario {
  names: string[];
  visits: string[];
  status: number;
  skipped?: string[];
  failed?: string[];
  stopped?: boolean;
  attempts?: Record<string, number>;
  completions?: Record<string, number>;
  realDelays?: number[];
}

const allVisits = (...names: string[]) => Array.from({ length: 5 }, (_, session) =>
  names.map(name => `${name}:${session + 1}`)).flat();

test('five round-robin loops finish five rounds per session, exclude failed accounts, and stop on access blocks', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-profiles-test-');
  try {
    const preload = join(temporary, 'fixture.mjs');
    writeFileSync(preload, `
      import ${JSON.stringify(new URL('./fixtures/send-lock.mjs', import.meta.url).href)};
      import assert from 'node:assert/strict';
      import { basename, join } from 'node:path';
      import { existsSync, readFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const visits = new Map();
      const connect = chromium.connectOverCDP.bind(chromium);
      chromium.connectOverCDP = async (endpoint, options) => {
        const port = new URL(endpoint).port;
        const directory = process.argv.filter((value,index) => process.argv[index-1] === '--profile')
          .find(path => existsSync(join(path,'DevToolsActivePort')) &&
            readFileSync(join(path,'DevToolsActivePort'),'utf8').split(/\\r?\\n/)[0] === port);
        assert.ok(directory, 'CDP must attach only to an explicitly selected profile.');
        const name = basename(directory);
        const visit = (visits.get(name) ?? 0) + 1;
        visits.set(name, visit);
        const details = { profile: name, session: visit };
        let round = 0;
        let challengeResponses = 0;
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
              console.log(JSON.stringify({ event: 'fixture-window-minimized', ...details }));
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
              const paid = name === 'paid' || (name === 'late-paid' && visit === 2);
              return await route.fulfill({ json: { accounts: { default: { account: { plan_type: paid ? 'plus' : 'free' } } } } });
            }
            if (target.pathname === ${JSON.stringify(featurePath)}) {
              return await route.fulfill({ status: name === 'feature-limited' ? 429 : 403, json: {} });
            }
            if (target.pathname === '/backend-api/f/conversation') {
              console.log(JSON.stringify({ event: 'fixture-submitted', ...details, round: ++round }));
              if (name === 'delayed-blocked') await setTimeout(1500);
              const uncertain = (name === 'uncertain' && round === 3) ||
                (name === 'late-uncertain' && visit === 2 && round === 1);
              return await route.fulfill({ status: name === 'submission-blocked' ? 403
                : ['submission-limited', 'delayed-blocked'].includes(name) ? 429 : uncertain ? 500 : 200, body: 'ok' });
            }
            if (route.request().isNavigationRequest()) {
              if (!target.search) console.log(JSON.stringify({ event: 'fixture-navigated', ...details }));
              const challengeLoop = name.startsWith('challenge-loop') || (name === 'late-challenge-loop' && visit === 2);
              if (challengeLoop || (name === 'challenge-four' && challengeResponses < 4)) {
                challengeResponses++;
                return await route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html',
                  body: challengeResponses < 5 ? ${JSON.stringify(challengeFixture(150))} : ${JSON.stringify(challengeFixture())} });
              }
              if (name === 'challenge' && !target.search) return await route.fulfill({ status: 403,
                headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html',
                body: ${JSON.stringify(challengeFixture(750))} });
              const login = name === 'login' || (name === 'late-login' && visit === 2);
              const blocked = name === 'blocked' || (name === 'late-blocked' && visit === 2);
              return await route.fulfill({ status: blocked ? 403 : 200,
                contentType: 'text/html; charset=utf-8', body: (login
                  ? ${JSON.stringify(fixture('login'))} : ${JSON.stringify(fixture('feature-failure'))})
                  .replaceAll('fixture-conversation', name + '-' + visit) });
            }
            return await route.abort();
          } catch (error) {
            if (!String(error).includes('Target page, context or browser has been closed')) throw error;
          }
        });
        context.on('close', () => console.log(JSON.stringify({ event: 'fixture-profile-closed', ...details })));
        if (['cleanup-error', 'challenge-loop-cleanup-error'].includes(name) || (name === 'late-cleanup-error' && visit === 2)) {
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
        console.log(JSON.stringify({ event: 'fixture-profile-opened', ...details }));
        return browser;
      };
    `);
    const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const scenarios: Scenario[] = [
      { names: ['paid', 'free'], visits: ['paid:1', ...allVisits('free')], status: 0, skipped: ['paid:1'] },
      { names: ['paid'], visits: ['paid:1'], status: 0, skipped: ['paid:1'] },
      { names: ['challenge', 'free'], visits: allVisits('challenge', 'free'), status: 0 },
      { names: ['challenge-loop', 'free'], visits: ['challenge-loop:1', ...allVisits('free')],
        status: 0, skipped: ['challenge-loop:1'] },
      { names: ['challenge-loop'], visits: ['challenge-loop:1'], status: 0, skipped: ['challenge-loop:1'] },
      { names: ['challenge-four'], visits: allVisits('challenge-four'), status: 0 },
      { names: ['late-challenge-loop', 'free'], visits: ['late-challenge-loop:1', 'free:1', 'late-challenge-loop:2', ...allVisits('free').slice(1)],
        status: 0, skipped: ['late-challenge-loop:2'] },
      { names: ['challenge-loop-cleanup-error', 'waiting'], visits: ['challenge-loop-cleanup-error:1'],
        status: 1, failed: ['challenge-loop-cleanup-error:1'], stopped: true },
      { names: ['feature-limited'], visits: allVisits('feature-limited'), status: 0 },
      { names: ['login', 'free'], visits: ['login:1', ...allVisits('free')], status: 1, failed: ['login:1'] },
      { names: ['cleanup-error', 'free'], visits: ['cleanup-error:1'], status: 1, failed: ['cleanup-error:1'],
        stopped: true, attempts: { 'cleanup-error:1': 5 }, completions: { 'cleanup-error:1': 5 } },
      { names: ['blocked', 'waiting'], visits: ['blocked:1'], status: 1, failed: ['blocked:1'], stopped: true },
      { names: ['submission-blocked', 'waiting'], visits: ['submission-blocked:1'], status: 1,
        failed: ['submission-blocked:1'], stopped: true, attempts: { 'submission-blocked:1': 1 } },
      { names: ['submission-limited', 'waiting'], visits: ['submission-limited:1'], status: 1,
        failed: ['submission-limited:1'], stopped: true, attempts: { 'submission-limited:1': 1 } },
      { names: ['delayed-blocked', 'free'], visits: ['delayed-blocked:1'], status: 1,
        failed: ['delayed-blocked:1'], stopped: true, attempts: { 'delayed-blocked:1': 1 } },
      { names: ['late-paid', 'free'], visits: ['late-paid:1', 'free:1', 'late-paid:2', ...allVisits('free').slice(1)],
        status: 0, skipped: ['late-paid:2'] },
      { names: ['late-login', 'free'], visits: ['late-login:1', 'free:1', 'late-login:2', ...allVisits('free').slice(1)],
        status: 1, failed: ['late-login:2'] },
      { names: ['late-blocked', 'free'], visits: ['late-blocked:1', 'free:1', 'late-blocked:2'],
        status: 1, failed: ['late-blocked:2'], stopped: true },
      { names: ['uncertain', 'free'], visits: ['uncertain:1', ...allVisits('free')], status: 1,
        failed: ['uncertain:1'], attempts: { 'uncertain:1': 3 }, completions: { 'uncertain:1': 2 } },
      { names: ['late-uncertain', 'free'], visits: ['late-uncertain:1', 'free:1', 'late-uncertain:2', ...allVisits('free').slice(1)],
        status: 1, failed: ['late-uncertain:2'], attempts: { 'late-uncertain:2': 1 } },
      { names: ['late-cleanup-error', 'free'], visits: ['late-cleanup-error:1', 'free:1', 'late-cleanup-error:2'],
        status: 1, failed: ['late-cleanup-error:2'], stopped: true,
        attempts: { 'late-cleanup-error:2': 5 }, completions: { 'late-cleanup-error:2': 5 } },
      { names: ['free-a', 'free-b', 'paid'], visits: ['free-a:1', 'free-b:1', 'paid:1', ...allVisits('free-a', 'free-b').slice(2)],
        status: 0, skipped: ['paid:1'], realDelays: [5, 10] },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await t.test(scenario.names.join(', '), () => {
        const root = join(temporary, String(index), 'profiles');
        const profiles = scenario.names.map(name => {
          const path = join(root, name);
          mkdirSync(path, { recursive: true });
          return { name, path };
        });
        const planned = generateBatches(profiles.map(profile => profile.path.toLowerCase()), 'fixture', 25);
        const pacing = join(temporary, String(index), 'pacing.mjs');
        writeFileSync(pacing, sendPacingFixture(scenario.realDelays));
        const localAppData = join(temporary, String(index), 'localappdata');
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(pacing).href,
          '--import', pathToFileURL(preload).href, cli, 'send',
          ...profiles.flatMap(profile => ['--profile', profile.path]), '--seed', 'fixture'], {
          encoding: 'utf8', timeout: scenario.realDelays ? 240_000 : 180_000,
          env: { ...process.env, LOCALAPPDATA: localAppData },
        });
        assert.equal(result.error, undefined, result.stdout + result.stderr);
        assert.equal(result.status, scenario.status, result.stdout + result.stderr);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        const visitOf = (record: { profile: string; session: number }) => `${record.profile}:${record.session}`;
        const visitsFor = (event: string) => records.filter(record => record.event === event).map(visitOf);
        const skipped = scenario.skipped ?? [];
        const failed = scenario.failed ?? [];
        const completedVisits = scenario.visits.filter(visit => !skipped.includes(visit) && !failed.includes(visit));
        assert.deepEqual(visitsFor('session-started'), scenario.visits);
        assert.deepEqual(visitsFor('fixture-profile-opened'), scenario.visits);
        assert.deepEqual(visitsFor('fixture-profile-closed'), scenario.visits);
        assert.deepEqual(records.filter(record => ['fixture-profile-opened', 'fixture-profile-closed'].includes(record.event))
          .map(record => `${record.event}:${visitOf(record)}`),
        scenario.visits.flatMap(visit => [`fixture-profile-opened:${visit}`, `fixture-profile-closed:${visit}`]));
        assert.deepEqual(visitsFor('fixture-window-minimized'), scenario.visits);
        assert.deepEqual(visitsFor('fixture-navigated'), scenario.visits);
        for (const visit of scenario.visits) {
          const minimized = records.findIndex(record => record.event === 'fixture-window-minimized' && visitOf(record) === visit);
          const navigated = records.findIndex(record => record.event === 'fixture-navigated' && visitOf(record) === visit);
          assert.ok(minimized >= 0 && minimized < navigated);
        }
        assert.deepEqual(visitsFor('profile-skipped'), skipped);
        for (const record of records.filter(record => record.event === 'profile-skipped' && record.profile.includes('challenge-loop'))) {
          assert.equal(record.reason, 'cloudflare-challenge-limit');
          const responses = records.filter(event => event.event === 'challenge' && event.phase === 'response' &&
            visitOf(event) === visitOf(record));
          assert.equal(responses.length, 5);
          const closed = records.findIndex(event => event.event === 'fixture-profile-closed' && visitOf(event) === visitOf(record));
          assert.ok(closed >= 0 && closed < records.indexOf(record), 'Close the skipped account before continuing.');
        }
        if (scenario.names.includes('challenge-four')) {
          for (const visit of scenario.visits) {
            assert.equal(records.filter(record => record.event === 'challenge' && record.phase === 'response' &&
              visitOf(record) === visit).length, 4);
          }
        }
        assert.deepEqual(visitsFor('profile-failed'), failed);
        assert.deepEqual(visitsFor('session-completed'), completedVisits);
        assert.deepEqual(visitsFor('profile-completed'), completedVisits.filter(visit => visit.endsWith(':5')));
        const attempts = scenario.visits.flatMap(visit => Array.from({ length: scenario.attempts?.[visit] ??
          (completedVisits.includes(visit) ? 5 : 0) }, (_, round) => `${visit}:${round + 1}`));
        const completions = scenario.visits.flatMap(visit => Array.from({ length: scenario.completions?.[visit] ??
          (completedVisits.includes(visit) ? 5 : 0) }, (_, round) => `${visit}:${round + 1}`));
        for (const event of ['sending', 'fixture-submitted', 'sent', 'completed']) {
          assert.deepEqual(records.filter(record => record.event === event).map(record => `${visitOf(record)}:${record.round}`),
            event === 'sending' || event === 'fixture-submitted' ? attempts : completions, result.stdout + result.stderr);
        }
        for (const record of records.filter(record => record.event === 'sending')) {
          const profile = scenario.names.indexOf(record.profile);
          assert.equal(record.promptId, planned[profile]![(record.session - 1) * 5 + record.round - 1]!.id);
        }
        for (const record of records.filter(record => record.event === 'completed')) {
          assert.equal(new URL(record.url).pathname, `/c/${record.profile}-${record.session}`);
        }
        assert.equal(new Set(records.filter(record => record.event === 'sending').map(record => record.promptId)).size, attempts.length);
        const realBoundaries: string[] = [];
        let previous = -1;
        for (const [position, record] of records.entries()) {
          if (record.event !== 'sending') continue;
          if (previous >= 0) {
            const earlier = records[previous];
            const delays = records.slice(previous + 1, position).filter(record => record.event === 'fixture-send-delay');
            const elapsed = Date.parse(record.time) - Date.parse(earlier.time);
            assert.ok(delays.length <= 1);
            if (delays.length === 0) assert.ok(elapsed >= 29_900, 'No boundary may reset the global send clock.');
            for (const delay of delays) {
              assert.ok(delay.delay > 0 && delay.delay <= 30_000);
              assert.ok(Math.abs(delay.time + delay.delay - Date.parse(earlier.time) - 30_000) < 100);
              if (delay.real) {
                assert.ok(elapsed >= 29_900, `${elapsed}ms between submissions`);
                realBoundaries.push(`${visitOf(earlier)}:${earlier.round}->${visitOf(record)}:${record.round}`);
              }
            }
          }
          previous = position;
        }
        assert.deepEqual(realBoundaries, scenario.realDelays ? ['free-a:1:5->free-b:1:1', 'free-b:1:5->free-a:2:1'] : []);
        assert.equal(records.filter(record => record.event === 'batch-stopped').length, scenario.stopped ? 1 : 0);
        const stopped = records.findIndex(record => record.event === 'batch-stopped');
        if (stopped >= 0) {
          assert.equal(visitOf(records[stopped]), failed.at(-1));
          assert.equal(records.slice(stopped).some(record => ['sending', 'fixture-submitted', 'session-started'].includes(record.event)), false);
        }
        if (scenario.names.includes('challenge')) {
          const diagnostics = records.filter(record => record.event === 'challenge' && record.profile === 'challenge');
          assert.ok(diagnostics.some(record => record.phase === 'response' && record.stage === 'navigation' &&
            record.response.request === 'document' && record.response.status === 403));
          assert.ok(diagnostics.some(record => record.phase === 'waiting' &&
            record.indicators.includes('response') && record.indicators.includes('text')));
          for (let session = 1; session <= 5; session++) {
            const cleared = records.findIndex(record => record.event === 'challenge' && record.session === session &&
              record.profile === 'challenge' && record.phase === 'cleared');
            const submitted = records.findIndex(record => record.event === 'fixture-submitted' &&
              record.profile === 'challenge' && record.session === session);
            assert.ok(cleared >= 0 && submitted > cleared);
          }
          assert.doesNotMatch(JSON.stringify(diagnostics), /fixture@example|Verify you are human|challenge=cleared/);
        }
        assert.equal(records.at(-1).event, 'finished');
        assert.equal(records.at(-1).success, scenario.status === 0);
        const persisted = readFileSync(records.find(record => record.event === 'started').logFile, 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(persisted, records.filter(record => !record.event.startsWith('fixture-')));
        assert.deepEqual(readdirSync(join(localAppData, 'chatgpt-cli')), ['logs']);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
