import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Inspection } from '../src/browser/inspect.ts';
import { createProfile, listProfiles, type Profile } from '../src/browser/profiles.ts';
import { readRegularFile, replaceRegularFile } from '../src/storage/files.ts';
import { readLedger } from '../src/usage/ledger.ts';
import { syncUsage } from '../src/usage/sync.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const fixtureCsv = 'kind,value,state\nemail,a@example.test,無料\nemail,other@example.test,不明\ncard,1234,使用済み\nphone,0123456789,使用中\n';
const inspection = (email_address: string | null = 'a@example.test', state: Inspection['state'] = 'plus',
  status: Inspection['status'] = 'logged_in', reason = 'confirmed'): Inspection => ({ email_address, state, status, reason });
const unknown = () => inspection(null, '不明', 'unknown', 'fixture');

function fixture() {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-usage-test-');
  const root = join(temporary, 'profiles');
  const ledger = join(temporary, 'private-data', 'ledger.csv');
  mkdirSync(join(temporary, 'private-data'));
  writeFileSync(ledger, fixtureCsv);
  const profiles = [createProfile(root), createProfile(root)];
  for (const profile of profiles) writeFileSync(join(profile.path, 'cookies.txt'), 'existing browser data');
  return { temporary, root, ledger, profiles, dispose: () => rmSync(temporary, { recursive: true, force: true }) };
}

const run = (temporary: string, args: string[], preload?: string) => spawnSync(process.execPath,
  [...(preload ? ['--import', pathToFileURL(preload).href] : []), cli, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
  });

test('standard CSV parsing preserves unrelated quoted and multiline fields and validates the email inventory', () => {
  const f = fixture();
  try {
    writeFileSync(f.ledger, '\uFEFFkind,value,state\r\nemail,a@example.test,不明\r\ncard,"12,34","line one\nline two"\r\n');
    assert.deepEqual(readLedger(f.ledger).rows, [
      { kind: 'email', value: 'a@example.test', state: '不明' },
      { kind: 'card', value: '12,34', state: 'line one\nline two' },
    ]);
    for (const contents of [
      '', 'email,state\na@example.test,plus\n', fixtureCsv + 'email,A@example.test,plus\n',
      'kind,value,state\nemail,invalid,plus\n', 'kind,value,state\nemail,a@example.test,pro\n',
      'kind,value,state\ncard,,不明\n', 'kind,value,state\ncard,1234\n',
      'kind,value,state\ncard,"unfinished,不明\n',
    ]) {
      writeFileSync(f.ledger, contents);
      assert.throws(() => readLedger(f.ledger));
    }
    const missing = join(f.temporary, 'missing.csv');
    assert.throws(() => readLedger(missing), /existing ledger/);
    const link = join(f.temporary, 'linked');
    symlinkSync(join(f.temporary, 'private-data'), link, 'junction');
    assert.throws(() => readLedger(join(link, 'ledger.csv')), /unlinked/);
  } finally { f.dispose(); }
});

test('atomic file replacement rejects concurrent edits instead of clobbering them', () => {
  const f = fixture();
  try {
    const before = readRegularFile(f.ledger);
    writeFileSync(f.ledger, fixtureCsv + 'card,5678,未使用\n');
    assert.throws(() => replaceRegularFile(f.ledger, 'must not be written', before), /changed during/);
    assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv + 'card,5678,未使用\n');
  } finally { f.dispose(); }
});

test('confirmed identity updates only its email row and moves browser data without changing its identity', async () => {
  const f = fixture();
  try {
    const first = f.profiles[0]!;
    const second = f.profiles[1]!;
    const results = await syncUsage({ profile: first.path }, f.ledger, async () => inspection());
    assert.equal(results[0]!.updated, true);
    assert.equal(results[0]!.renamed, true);
    const renamed = join(f.root, 'a@example.test');
    assert.equal(results[0]!.profile.path, renamed);
    assert.equal(results[0]!.profile.name, 'a@example.test');
    assert.equal(readFileSync(join(renamed, '.gpt-usage-id'), 'utf8'), first.id);
    assert.equal(readFileSync(join(renamed, 'cookies.txt'), 'utf8'), 'existing browser data');
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), true);
    assert.deepEqual(readLedger(f.ledger).rows, [
      { kind: 'email', value: 'a@example.test', state: 'plus' },
      ...readLedgerFromFixture().slice(1),
    ]);
    await syncUsage({ profile: second.path }, f.ledger, async () => inspection('b@example.test', '無料'));
    assert.equal(readLedger(f.ledger).rows.at(-1)!.value, 'b@example.test');
    assert.equal(readFileSync(join(f.root, 'b@example.test', 'cookies.txt'), 'utf8'), 'existing browser data');
    const before = readFileSync(f.ledger, 'utf8');
    const unchanged = await syncUsage({ profile: renamed }, f.ledger, async () => inspection());
    assert.equal(unchanged[0]!.updated, false);
    assert.equal(unchanged[0]!.renamed, false);
    assert.equal(readFileSync(f.ledger, 'utf8'), before);
  } finally { f.dispose(); }
});

function readLedgerFromFixture() {
  return [
    { kind: 'email', value: 'a@example.test', state: '無料' },
    { kind: 'email', value: 'other@example.test', state: '不明' },
    { kind: 'card', value: '1234', state: '使用済み' },
    { kind: 'phone', value: '0123456789', state: '使用中' },
  ];
}

test('logged-out and unknown profiles never rewrite inferred plans, and unconfirmed plans remain unknown', async () => {
  const f = fixture();
  try {
    const first = f.profiles[0]!;
    for (const status of ['logged_out', 'unknown'] as const) {
      await syncUsage({ profile: first.path }, f.ledger, async () => inspection(null, '不明', status));
      assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv);
      assert.equal(existsSync(first.path), true);
    }
    await syncUsage({ profile: first.path }, f.ledger, async () => inspection('a@example.test', '不明'));
    assert.equal(readLedger(f.ledger).rows[0]!.state, '不明');
    assert.equal(readLedger(f.ledger).rows[1]!.state, '不明');
    assert.equal(existsSync(join(f.root, 'a@example.test')), true);
  } finally { f.dispose(); }
});

test('collisions, invalid inspections, duplicate emails, and changed identities fail before ledger changes', async () => {
  for (const scenario of ['collision', 'identity', 'duplicate', 'invalid-state', 'invalid-status',
    '../outside@example.test', 'bad:email@example.test', 'a@example.test.', 'invalid']) {
    const f = fixture();
    try {
      const first = f.profiles[0]!;
      if (scenario === 'collision') mkdirSync(join(f.root, 'a@example.test'));
      if (scenario === 'duplicate') writeFileSync(f.ledger, fixtureCsv + 'email,A@example.test,plus\n');
      const before = readFileSync(f.ledger, 'utf8');
      await assert.rejects(syncUsage({ profile: first.path }, f.ledger, async () => {
        if (scenario === 'identity') writeFileSync(join(first.path, '.gpt-usage-id'), '0'.repeat(32));
        if (scenario === 'invalid-state') return { ...inspection(), state: 'pro' } as unknown as Inspection;
        if (scenario === 'invalid-status') return { ...inspection(), status: 'invalid' } as unknown as Inspection;
        return inspection(scenario.includes('@') || scenario === 'invalid' ? scenario : 'a@example.test');
      }));
      assert.equal(readFileSync(f.ledger, 'utf8'), before);
      assert.equal(existsSync(first.path), true);
    } finally { f.dispose(); }
  }
});

test('access rejection and cooldown stop the whole collection without retrying or contacting later profiles', async () => {
  for (const reason of ['identity_http_403', 'plan_http_429', 'access_cooldown_until_later', 'access_blocked']) {
    const f = fixture();
    try {
      const calls: string[] = [];
      await assert.rejects(syncUsage({ root: f.root }, f.ledger, async profile => {
        calls.push(profile.path);
        return { ...unknown(), reason };
      }), /Sync stopped/);
      assert.equal(calls.length, 1);
      assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv);
      assert.equal(listProfiles(f.root).length, 2);
    } finally { f.dispose(); }
  }
});

test('profile and ledger locks exclude other CLI processes and release after inspection failure', async () => {
  const f = fixture();
  let resume!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = syncUsage({ profile: f.profiles[0]!.path }, f.ledger, async () => {
    entered();
    await waiting;
    throw new Error('fixture inspection failure');
  });
  try {
    await started;
    const otherRoot = join(f.temporary, 'other-pc');
    createProfile(otherRoot);
    for (const root of [f.root, otherRoot]) {
      const child = run(f.temporary, ['sync', '--profile-root', root, '--ledger', f.ledger]);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /already being held/);
    }
    resume();
    await assert.rejects(first, /fixture inspection failure/);
    const next = await syncUsage({ profile: f.profiles[0]!.path }, f.ledger, async () => unknown());
    assert.equal(next.length, 1);
  } finally {
    resume();
    await first.catch(() => {});
    f.dispose();
  }
});

test('collection inspections remain sequential with thirty seconds after the previous inspection finishes', async () => {
  const f = fixture();
  try {
    const times: number[] = [];
    const results = await syncUsage({ root: f.root }, f.ledger, async () => {
      times.push(Date.now());
      return unknown();
    });
    assert.equal(results.length, 2);
    assert.ok(times[1]! - times[0]! >= 29_900, JSON.stringify(times));
    assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv);
  } finally { f.dispose(); }
});

test('sync requires a ledger and validates selections without creating profiles or changing other commands', async () => {
  const f = fixture();
  try {
    const missing = join(f.temporary, 'missing');
    for (const args of [
      ['sync'], ['sync', '--ledger', f.ledger],
      ['sync', '--profile-root', f.root], ['sync', '--profile-root', f.root, '--ledger', ''],
      ['sync', '--profile', f.profiles[0]!.path, '--profile', f.profiles[1]!.path, '--ledger', f.ledger],
      ['sync', '--profile-root', f.root, '--profile', f.profiles[0]!.path, '--ledger', f.ledger],
      ['sync', '--profile', missing, '--ledger', f.ledger],
      ['sync', '--profile-root', f.root, '--ledger', f.ledger, '--dry-run'],
      ['open', '--ledger', f.ledger], ['inspect', '--profile', f.profiles[0]!.path, '--ledger', f.ledger],
      ['send', '--dry-run', '--ledger', f.ledger],
    ]) {
      const result = run(f.temporary, args);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, JSON.stringify(args) + result.stdout + result.stderr);
      assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv);
      assert.equal(existsSync(missing), false);
    }
    const empty = join(f.temporary, 'empty');
    mkdirSync(empty);
    assert.deepEqual(await syncUsage({ root: empty }, f.ledger), []);
    const unmarked = join(empty, 'unmarked');
    mkdirSync(unmarked);
    await assert.rejects(syncUsage({ profile: unmarked }, f.ledger), /marked profile/);
    const unsafeLedger = join(f.root, 'ledger.csv');
    writeFileSync(unsafeLedger, fixtureCsv);
    await assert.rejects(syncUsage({ root: f.root }, unsafeLedger), /outside/);
  } finally { f.dispose(); }
});

test('real standalone CLI inspects without renaming and syncs only after ordinary Edge closes, without sending', () => {
  const f = fixture();
  try {
    const preload = join(f.temporary, 'native-inspection.mjs');
    const closed = join(f.temporary, 'closed.jsonl');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const connect = chromium.connectOverCDP.bind(chromium);
      chromium.connectOverCDP = async (endpoint, options) => {
        const browser = await connect(endpoint, options);
        const context = browser.contexts()[0];
        context.on('close', () => appendFileSync(${JSON.stringify(closed)}, 'closed\\n'));
        await context.route('**/*', route => {
          assert.equal(route.request().method(), 'GET', 'Inspection must never submit prompts.');
          const url = new URL(route.request().url());
          if (url.origin !== 'https://chatgpt.com') return route.abort();
          if (url.pathname === '/backend-api/me') return route.fulfill({json:{email:'a@example.test',accessToken:'SECRET'}});
          if (url.pathname.startsWith('/backend-api/accounts/check/')) return route.fulfill({json:{accounts:{default:{account:{
            structure:'personal',is_deactivated:false,plan_type:'plus'
          }}}}});
          return route.fulfill({contentType:'text/html',body:"<title>Inspection fixture</title><script>fetch('/backend-api/me');fetch('/backend-api/accounts/check/test');</script>"});
        });
        return browser;
      };
    `);
    const inspected = run(f.temporary, ['inspect', '--profile', f.profiles[0]!.path], preload);
    assert.equal(inspected.error, undefined, inspected.stdout + inspected.stderr);
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).state, 'plus');
    assert.equal(inspected.stdout.includes('SECRET'), false);
    assert.equal(existsSync(f.profiles[0]!.path), true);
    assert.equal(readFileSync(f.ledger, 'utf8'), fixtureCsv);
    const synced = run(f.temporary, ['sync', '--profile', f.profiles[1]!.path, '--ledger', f.ledger], preload);
    assert.equal(synced.error, undefined, synced.stdout + synced.stderr);
    assert.equal(synced.status, 0, synced.stdout + synced.stderr);
    assert.equal(synced.stdout.includes('SECRET'), false);
    assert.equal(JSON.parse(synced.stdout).results[0].state, 'plus');
    assert.equal(readLedger(f.ledger).rows[0]!.state, 'plus');
    const renamed = join(f.root, 'a@example.test');
    assert.equal(readFileSync(join(renamed, '.gpt-usage-id'), 'utf8'), f.profiles[1]!.id);
    assert.equal(readFileSync(join(renamed, 'cookies.txt'), 'utf8'), 'existing browser data');
    assert.equal(existsSync(join(renamed, '.gpt-usage-access.json')), true);
    const defaultRoot = join(f.temporary, 'localappdata', 'chatgpt-cli', 'profiles');
    const defaultProfile = createProfile(defaultRoot);
    writeFileSync(join(defaultProfile.path, 'cookies.txt'), 'default browser data');
    const defaultSynced = run(f.temporary, ['sync', '--ledger', f.ledger], preload);
    assert.equal(defaultSynced.error, undefined, defaultSynced.stdout + defaultSynced.stderr);
    assert.equal(defaultSynced.status, 0, defaultSynced.stdout + defaultSynced.stderr);
    const defaultResults = JSON.parse(defaultSynced.stdout).results;
    assert.equal(defaultResults.length, 1);
    assert.equal(defaultResults[0].state, 'plus');
    assert.equal(defaultResults[0].profile.path, join(defaultRoot, 'a@example.test'));
    assert.equal(defaultResults[0].profile.id, defaultProfile.id);
    assert.equal(readFileSync(join(defaultRoot, 'a@example.test', 'cookies.txt'), 'utf8'), 'default browser data');
    assert.equal(readFileSync(closed, 'utf8'), 'closed\nclosed\nclosed\n');
    assert.equal(existsSync(f.profiles[0]!.path), true);
  } finally { f.dispose(); }
});
