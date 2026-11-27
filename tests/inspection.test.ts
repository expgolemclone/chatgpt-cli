import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAllowedOrigin, isLoginUrl, parseIdentity, parsePlan, type Account } from '../src/browser/account.ts';
import { claimAccess, classifyProfile, inspectProfile } from '../src/browser/inspect.ts';
import { createProfile, listProfiles } from '../src/browser/profiles.ts';
import { challengeFixture } from './fixtures/chat.ts';

const identity = { status: 200, settled: true, validJson: true, email: 'a@example.test' } as const;
const plan = { status: 200, settled: true, personal: 'plus', sending: 'non-free' } as const;

test('native metadata keeps personal ledger plans separate from all-workspace sending eligibility', () => {
  assert.deepEqual(parseIdentity({ email: 'a@example.test', accessToken: 'SECRET' }), { validJson: true, email: 'a@example.test' });
  for (const value of [null, [], 'invalid', { email: '' }, { email: 'invalid' }]) assert.equal(parseIdentity(value).email, null);
  for (const [type, structure, active, personal] of [
    ['free', 'personal', false, '無料'], ['plus', 'personal', false, 'plus'],
    ['pro', 'personal', false, '不明'], ['plus', 'workspace', false, '不明'], ['plus', 'personal', true, '不明'],
  ]) {
    const account = { structure, is_deactivated: active, plan_type: type };
    assert.equal(parsePlan({ accounts: { default: { account } } }).personal, personal);
  }
  assert.deepEqual(parsePlan({ accounts: {
    default: { account: { structure: 'personal', is_deactivated: false, plan_type: 'free' } },
    work: { account: { plan_type: 'plus' } },
  } }), { personal: '無料', sending: 'non-free' });
  assert.deepEqual(parsePlan({ accounts: { default: { account: { plan_type: 'free' } }, other: {} } }),
    { personal: '不明', sending: 'unknown' });
});

test('inspection requires current native identity and never infers login or plan from directory names', () => {
  assert.equal(classifyProfile({ identity, plan }, false).state, 'plus');
  assert.equal(classifyProfile({ identity }, false).state, '不明');
  assert.equal(classifyProfile({ identity }, true).status, 'unknown');
  assert.equal(classifyProfile({}, true).status, 'logged_out');
  assert.equal(classifyProfile({ plan }, true).status, 'unknown');
  assert.equal(classifyProfile({ identity: { ...identity, status: 401, validJson: false, email: null } }, true).status, 'logged_out');
  assert.equal(classifyProfile({ identity: { ...identity, status: null, settled: false, email: null } }, true).status, 'unknown');
  assert.equal(classifyProfile({}, false).status, 'unknown');
  for (const status of [403, 429, 500]) {
    assert.equal(classifyProfile({ identity: { ...identity, status, validJson: false, email: null } }, true).status, 'unknown');
  }
  for (const status of [403, 429]) {
    const account: Account = { identity, plan, block: { status, path: '/backend-api/me' } };
    assert.equal(classifyProfile(account, true).reason, `http_${status}`);
  }
});

test('login routes and allowed origins recognize ChatGPT and OpenAI auth pages without permitting third parties', () => {
  const origin = 'https://chatgpt.com';
  for (const url of [
    'https://chatgpt.com/auth/login?next=%2Fsettings%2Faccount',
    'https://chatgpt.com/auth/login/',
    'https://auth.openai.com/log-in',
    'https://auth.openai.com/log-in-or-create-account',
    'https://auth.openai.com/u/login/identifier',
    'https://auth0.openai.com/u/login',
  ]) {
    assert.equal(isAllowedOrigin(url, origin), true, url);
    assert.equal(isLoginUrl(url, origin), true, url);
  }
  for (const url of [
    'https://chatgpt.com/',
    'https://chatgpt.com/settings/account',
    'https://auth.openai.com/authorize?client_id=test',
  ]) {
    assert.equal(isAllowedOrigin(url, origin), true, url);
    assert.equal(isLoginUrl(url, origin), false, url);
  }
  for (const url of [
    'https://evil.invalid/auth/login',
    'https://auth.openai.com.evil.invalid/log-in',
    'about:blank',
    'not-a-url',
  ]) {
    assert.equal(isAllowedOrigin(url, origin), false, url);
    assert.equal(isLoginUrl(url, origin), false, url);
  }
  assert.equal(isAllowedOrigin('https://auth.openai.com/log-in', 'http://127.0.0.1:8080'), false);
  assert.equal(isLoginUrl('http://127.0.0.1:8080/auth/login', 'http://127.0.0.1:8080'), true);
});

test('profile collection discovers only owned direct profiles and creates complete fresh identities', () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-collection-');
  try {
    const root = join(temporary, 'profiles');
    assert.deepEqual(listProfiles(root), []);
    assert.equal(existsSync(root), false);
    const first = createProfile(root);
    writeFileSync(join(first.path, 'cookies.txt'), 'existing data');
    const second = createProfile(root);
    assert.equal(first.name, '未ログイン-001');
    assert.equal(second.name, '未ログイン-002');
    assert.notEqual(first.id, second.id);
    assert.equal(readFileSync(join(first.path, '.gpt-usage-id'), 'utf8'), first.id);
    mkdirSync(join(root, 'archive'));
    writeFileSync(join(root, 'archive', '.gpt-usage-id'), 'invalid archive identity');
    mkdirSync(join(root, 'unmarked'));
    writeFileSync(join(root, '未ログイン-003'), 'occupied file');
    assert.equal(createProfile(root).name, '未ログイン-004');
    assert.equal(listProfiles(root).length, 3);
    assert.equal(readFileSync(join(first.path, 'cookies.txt'), 'utf8'), 'existing data');
    const otherPC = createProfile(join(temporary, 'other-pc'));
    assert.notEqual(otherPC.id, first.id);
    const outside = join(temporary, 'outside');
    mkdirSync(outside);
    const link = join(root, 'linked');
    symlinkSync(outside, link, 'junction');
    assert.throws(() => listProfiles(root), /unlinked/);
    rmSync(link);
    writeFileSync(join(second.path, '.gpt-usage-id'), first.id!);
    assert.throws(() => listProfiles(root), /Duplicate/);
    writeFileSync(join(second.path, '.gpt-usage-id'), 'invalid');
    assert.throws(() => listProfiles(root), /Invalid/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('inspection cooldown persists across processes and cannot be bypassed by invalid metadata', () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-cooldown-');
  try {
    const now = Date.now();
    claimAccess(temporary, now);
    assert.throws(() => claimAccess(temporary, now + 4 * 60_000), /access_cooldown/);
    claimAccess(temporary, now + 5 * 60_000);
    writeFileSync(join(temporary, '.gpt-usage-access.json'), '{}');
    assert.throws(() => claimAccess(temporary, now), /access_state_invalid/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('real Edge inspection observes native responses, redacts credentials, persists blocks, and never sends', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-inspection-');
  let mode = 'plus';
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, 'GET');
    response.setHeader('content-type', 'application/json');
    if (['challenge-disconnected', 'blocked-disconnected'].includes(mode) && request.url === '/') {
      response.writeHead(403, mode === 'challenge-disconnected'
        ? { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } : { 'content-type': 'text/html' });
      response.flushHeaders();
      setTimeout(() => response.destroy(), 150);
    } else if (mode.startsWith('challenge') && request.url === '/') {
      response.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      response.end(challengeFixture(mode === 'challenge-stuck' ? undefined : 600));
    } else if (request.url === '/backend-api/me') {
      response.statusCode = mode === 'blocked' ? 403 : 200;
      response.end(JSON.stringify({ email: 'a@example.test', accessToken: 'SECRET' }));
    } else if (request.url?.startsWith('/backend-api/accounts/check/')) {
      response.end(JSON.stringify({ accounts: { default: { account: {
        structure: 'personal', is_deactivated: false, plan_type: 'plus',
      } } } }));
    } else if (mode === 'redirect-auth-login' && request.url === '/') {
      response.writeHead(302, { location: '/auth/login?next=%2Fsettings%2Faccount' });
      response.end();
    } else if (request.url?.startsWith('/auth/login')) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<title>ChatGPT</title><h1>ログインまたは新規登録</h1><input type="email" name="username"><button>続ける</button>');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(`<title>Local inspection fixture</title><script>
        fetch('/backend-api/me'); fetch('/backend-api/accounts/check/test');
      </script>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    const profile = createProfile(join(temporary, 'profiles'));
    const value = await inspectProfile(profile, { url, readyTimeoutMs: 3000 });
    assert.equal(value.status, 'logged_in');
    assert.equal(value.email_address, 'a@example.test');
    assert.equal(value.state, 'plus');
    assert.equal(JSON.stringify(value).includes('SECRET'), false);
    const before = requests;
    assert.match((await inspectProfile(profile, { url })).reason, /access_cooldown/);
    assert.equal(requests, before);
    mode = 'challenge-clears';
    const challenged = createProfile(join(temporary, 'profiles'));
    const cleared = await inspectProfile(challenged, { url, readyTimeoutMs: 350, pollMs: 20 });
    assert.equal(cleared.status, 'logged_in');
    assert.equal(cleared.email_address, 'a@example.test');
    assert.equal(cleared.state, 'plus');
    mode = 'challenge-stuck';
    const unresolved = createProfile(join(temporary, 'profiles'));
    const challengedAt = Date.now();
    assert.match((await inspectProfile(unresolved, { url, challengeTimeoutMs: 150, pollMs: 20 })).reason, /access_blocked/);
    const challengeCooldown = JSON.parse(readFileSync(join(unresolved.path, '.gpt-usage-access.json'), 'utf8'));
    assert.ok(Date.parse(challengeCooldown.next_allowed_at) >= challengedAt + 30 * 60_000);
    for (const value of ['challenge-disconnected', 'blocked-disconnected']) {
      mode = value;
      const disconnected = createProfile(join(temporary, 'profiles'));
      const disconnectedAt = Date.now();
      const result = await inspectProfile(disconnected, { url });
      assert.match(result.reason, value.startsWith('challenge') ? /access_blocked/ : /http_403/);
      const access = JSON.parse(readFileSync(join(disconnected.path, '.gpt-usage-access.json'), 'utf8'));
      assert.ok(Date.parse(access.next_allowed_at) >= disconnectedAt + 30 * 60_000);
    }
    mode = 'redirect-auth-login';
    const redirected = createProfile(join(temporary, 'profiles'));
    const signedOut = await inspectProfile(redirected, { url, readyTimeoutMs: 2000 });
    assert.equal(signedOut.status, 'logged_out');
    assert.equal(signedOut.reason, 'login_surface_without_authenticated_identity');
    mode = 'blocked';
    const blocked = createProfile(join(temporary, 'profiles'));
    const blockedAt = Date.now();
    assert.match((await inspectProfile(blocked, { url })).reason, /http_403/);
    const cooldown = JSON.parse(readFileSync(join(blocked.path, '.gpt-usage-access.json'), 'utf8'));
    assert.ok(Date.parse(cooldown.next_allowed_at) >= blockedAt + 30 * 60_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
