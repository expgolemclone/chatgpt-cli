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
  const localAppData = join(temporary, 'localappdata');
  const defaultRoot = join(localAppData, 'chatgpt-cli', 'profiles');
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
          if (url.origin !== 'https://chatgpt.com') return route.abort();
          assert.equal(request.method(), 'GET');
          if (url.pathname === '/backend-api/me') {
            if (mode === 'failed-identity') {
              if (url.search !== '?earlier') return route.abort();
              // An older 401 must not override the failed request for current identity.
              await new Promise(resolve => setTimeout(resolve, 500));
              return route.fulfill({status: 401, json: {}});
            }
            if (mode === 'signed-out') return route.fulfill({status: 401, json: {}});
            return route.fulfill({json: {email: 'fixture@example.test'}});
          }
          if (url.pathname.startsWith('/backend-api/accounts/check/')) return route.fulfill({json: {}});
          if (!request.isNavigationRequest()) return route.abort();
          const login = '<button id="login">Log in</button>';
          const identity = "fetch('/backend-api/me').catch(() => {});";
          const script = mode === 'guest' ? '' : mode === 'signed-in' ?
            "setTimeout(() => { document.querySelector('#login').remove(); " + identity +
              "fetch('/backend-api/accounts/check/test'); }, 2500);" : mode === 'failed-identity' ?
                "fetch('/backend-api/me?earlier').catch(() => {}); " + identity : identity;
          return route.fulfill({contentType: 'text/html', body: login + '<script>' + script + '</script>'});
        });
        return browser;
      };
    `);
    const run = (mode: string, ...args: string[]) => spawnSync(process.execPath,
      ['--import', pathToFileURL(preload).href, cli, 'prune', ...args], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOCALAPPDATA: localAppData, FIXTURE_MODE: mode },
      });
    await t.test('an empty collection creates nothing', () => {
      const result = run('guest', '--apply');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(defaultRoot), false);
    });
    await t.test('preview keeps the profile and apply respects inspection cooldown', () => {
      const profile = createProfile(defaultRoot);
      const result = run('guest');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        profile, status: 'logged_out', reason: 'login_surface_without_authenticated_identity', action: 'would-delete',
      });
      const blocked = run('guest', '--apply');
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, /access_cooldown/);
      assert.equal(existsSync(profile.path), true);
    });
    for (const [mode, status, action] of [
      ['signed-out', 'logged_out', 'deleted'],
      ['signed-in', 'logged_in', 'keep'],
      ['failed-identity', 'unknown', 'keep'],
    ] as const) {
      await t.test(mode, () => {
        const root = join(temporary, mode);
        const profile = createProfile(root);
        if (mode === 'signed-out') {
          const name = 'expired@example.test';
          renameSync(profile.path, join(root, name));
          Object.assign(profile, { name, path: join(root, name) });
        }
        const archived = createProfile(join(root, 'archive'));
        const unmarked = join(root, 'unmarked');
        mkdirSync(unmarked);
        const outside = join(temporary, 'outside-' + mode);
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.txt'), 'unchanged');
        symlinkSync(outside, join(profile.path, 'linked-content'), 'junction');
        const result = run(mode, '--apply', '--profile-root', root);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const { reason, ...details } = JSON.parse(result.stdout);
        assert.deepEqual(details, { profile, status, action });
        if (mode === 'failed-identity') assert.equal(reason, 'identity_response_unsettled');
        assert.equal(existsSync(profile.path), action !== 'deleted');
        assert.equal(existsSync(archived.path), true);
        assert.equal(existsSync(unmarked), true);
        assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'unchanged');
      });
    }
  } finally { rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
