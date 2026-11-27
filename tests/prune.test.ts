import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Inspection } from '../src/browser/inspect.ts';
import { createProfile } from '../src/browser/profiles.ts';
import { pruneProfiles } from '../src/browser/prune.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('prune fails closed for linked directories, archive roots, and changed profile identities', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-prune-safety-');
  try {
    const root = join(temporary, 'profiles');
    const profile = createProfile(root);
    const archive = createProfile(join(root, 'archive'));
    const linked = join(temporary, 'linked');
    symlinkSync(root, linked, 'junction');
    const neverInspect = async (): Promise<Inspection> => { throw new Error('Unexpected inspection'); };
    await assert.rejects(pruneProfiles(linked, true, neverInspect).next(), /unlinked/);
    await assert.rejects(pruneProfiles(join(root, 'archive'), true, neverInspect).next(), /Archived profiles/);
    await assert.rejects(pruneProfiles(root, true, async () => {
      writeFileSync(join(profile.path, '.gpt-usage-id'), '0'.repeat(32));
      return { status: 'logged_out', email_address: null, state: '不明', reason: 'fixture' };
    }).next(), /identity changed/);
    assert.equal(existsSync(profile.path), true);
    assert.equal(existsSync(archive.path), true);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('real Edge prune previews or deletes only confirmed signed-out profiles, regardless of their names', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-prune-');
  const localAppData = (mode: string) => join(temporary, mode, 'localappdata');
  const profileRoot = (mode: string) => join(localAppData(mode), 'chatgpt-cli', 'profiles');
  try {
    const preload = join(temporary, 'inspect-fixture.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const connect = chromium.connectOverCDP.bind(chromium);
      const mode = process.env.FIXTURE_MODE;
      chromium.connectOverCDP = async (...args) => {
        const browser = await connect(...args);
        await browser.contexts()[0].route('**/*', async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin === 'https://auth.openai.com' && ['auth-origin-redirect', 'auth-authorize-only'].includes(mode)) {
            const body = mode === 'auth-origin-redirect'
              ? '<h1>Log in or sign up</h1><input type="email" name="username"><button>Continue</button>'
              : '<p>Redirecting...</p>';
            return route.fulfill({ contentType: 'text/html', body });
          }
          if (url.origin === 'https://evil.invalid' && mode === 'unexpected-origin') {
            return route.fulfill({ contentType: 'text/html', body: '<h1>Log in or sign up</h1><button>Continue</button>' });
          }
          if (url.origin !== 'https://chatgpt.com') return route.abort();
          assert.equal(request.method(), 'GET');
          if (url.pathname === '/backend-api/me') {
            if (mode === 'failed-identity') {
              if (url.search !== '?earlier') return route.abort();
              // An older 401 must not override the failed request for current identity.
              await new Promise(resolve => setTimeout(resolve, 500));
              return route.fulfill({status: 401, json: {}});
            }
            if (['signed-out', 'session-expired'].includes(mode)) return route.fulfill({status: 401, json: {}});
            return route.fulfill({json: {email: 'fixture@example.test'}});
          }
          if (url.pathname.startsWith('/backend-api/accounts/check/')) {
            return route.fulfill({status: mode === 'session-expired' ? 401 : 200, json: {}});
          }
          if (!request.isNavigationRequest()) return route.abort();
          if (mode === 'auth-origin-redirect') {
            return route.fulfill({ contentType: 'text/html', body: "<script>location.replace('https://auth.openai.com/log-in-or-create-account');</script>" });
          }
          if (mode === 'auth-authorize-only') {
            return route.fulfill({ contentType: 'text/html', body: "<script>location.replace('https://auth.openai.com/authorize');</script>" });
          }
          if (mode === 'unexpected-origin') {
            return route.fulfill({ contentType: 'text/html', body: "<script>location.replace('https://evil.invalid/auth/login');</script>" });
          }
          if (mode === 'auth-login-route') {
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: "<script>history.replaceState(null, '', '/auth/login?next=%2Fsettings%2Faccount%3Fmweb_fallback%3D1');</script>" +
                '<h1>ログインまたは新規登録</h1><input type="email" name="username"><button>Google で続ける</button><button>続ける</button>',
            });
          }
          if (mode === 'auth-login-blank') {
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: "<script>history.replaceState(null, '', '/auth/login?next=%2Fsettings%2Faccount');</script><p>Loading...</p>",
            });
          }
          if (mode === 'session-expired') {
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: "<h2>セッションの有効期限が切れました</h2><button>ログイン</button><script>fetch('/backend-api/me').catch(() => {}); fetch('/backend-api/accounts/check/test').catch(() => {});</script>",
            });
          }
          const login = '<button id="login">Log in</button>';
          const identity = "fetch('/backend-api/me').catch(() => {});";
          const script = mode === 'guest' ? '' : mode === 'signed-in' ?
            "setTimeout(() => { document.querySelector('#login').remove(); document.body.insertAdjacentHTML('beforeend', '<input type=email name=email><button>続ける</button>'); " + identity +
              "fetch('/backend-api/accounts/check/test'); }, 2500);" : mode === 'failed-identity' ?
                "fetch('/backend-api/me?earlier').catch(() => {}); " + identity : identity;
          return route.fulfill({contentType: 'text/html; charset=utf-8', body: login + '<script>' + script + '</script>'});
        });
        return browser;
      };
    `);
    const run = (mode: string, ...args: string[]) => spawnSync(process.execPath,
      ['--import', pathToFileURL(preload).href, cli, 'profiles', 'prune', ...args], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOCALAPPDATA: localAppData(mode), FIXTURE_MODE: mode },
      });
    await t.test('an empty collection creates nothing', () => {
      const result = run('guest', '--apply');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(profileRoot('guest')), false);
    });
    await t.test('preview keeps the profile and apply respects inspection cooldown', () => {
      const profile = createProfile(profileRoot('guest'));
      const result = run('guest');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), 'Would delete ' + profile.name + ' (login_surface_without_authenticated_identity).');
      const blocked = run('guest', '--apply');
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, /access_cooldown/);
      assert.equal(existsSync(profile.path), true);
    });
    for (const [mode, action, renameTo] of [
      ['signed-out', 'Deleted', 'expired@example.test'],
      ['session-expired', 'Deleted', 'expired-session@example.test'],
      ['auth-login-route', 'Deleted', 'logged-out@example.test'],
      ['auth-origin-redirect', 'Deleted', 'oauth-out@example.test'],
      ['auth-login-blank', 'Kept', 'blank-login@example.test'],
      ['auth-authorize-only', 'Kept', 'authorize@example.test'],
      ['unexpected-origin', 'Kept', 'other-origin@example.test'],
      ['signed-in', 'Kept', undefined],
      ['failed-identity', 'Kept', undefined],
    ] as const) {
      await t.test(mode, () => {
        const root = profileRoot(mode);
        const profile = createProfile(root);
        if (renameTo) {
          renameSync(profile.path, join(root, renameTo));
          Object.assign(profile, { name: renameTo, path: join(root, renameTo) });
        }
        const archived = createProfile(join(root, 'archive'));
        const unmarked = join(root, 'unmarked');
        mkdirSync(unmarked);
        const outside = join(temporary, 'outside-' + mode);
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.txt'), 'unchanged');
        symlinkSync(outside, join(profile.path, 'linked-content'), 'junction');
        const result = run(mode, '--apply');
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.stdout.startsWith(action + ' ' + profile.name + ' ('), result.stdout);
        if (mode === 'failed-identity') assert.match(result.stdout, /identity_response_unsettled/);
        if (mode === 'unexpected-origin') assert.match(result.stdout, /navigation_origin_changed/);
        assert.equal(existsSync(profile.path), action !== 'Deleted');
        assert.equal(existsSync(archived.path), true);
        assert.equal(existsSync(unmarked), true);
        assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'unchanged');
      });
    }
  } finally { rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
