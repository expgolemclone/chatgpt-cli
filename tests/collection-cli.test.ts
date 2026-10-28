import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProfile, listProfiles } from '../src/browser/profiles.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('collection CLI moves discovery fresh login and Usage opening into the browser owner', () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-collection-cli-');
  try {
    const root = join(temporary, 'profiles');
    const localAppData = join(temporary, 'localappdata');
    const run = (args: string[], preload?: string) => spawnSync(process.execPath,
      [...(preload ? ['--import', pathToFileURL(preload).href] : []), cli, ...args], {
        encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOCALAPPDATA: localAppData },
      });
    assert.deepEqual(JSON.parse(run(['profiles', '--profile-root', root]).stdout), { root, profiles: [] });
    assert.equal(existsSync(root), false);
    for (const args of [
      ['profiles'], ['inspect'], ['inspect', '--profile-root', root],
      ['profiles', '--profile-root', root, '--profile', root],
      ['open', '--questions', '1'], ['open', '--dry-run'], ['profiles', '--seed', 'invalid'],
      ['login', '--profile-root', 'relative'], ['send', '--profile-root', root, '--dry-run'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(existsSync(root), false);
      assert.equal(existsSync(localAppData), false);
    }
    const first = createProfile(root);
    writeFileSync(join(first.path, 'keep.txt'), 'untouched');
    const preload = join(temporary, 'window-fixture.mjs');
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      const launch = chromium.launchPersistentContext.bind(chromium);
      chromium.launchPersistentContext = async (path, options) => {
        assert.match(readFileSync(path + '/.gpt-usage-id', 'utf8'), /^[0-9a-f]{32}$/);
        const context = await launch(path, options);
        await context.route('**/*', route => {
          assert.equal(route.request().method(), 'GET');
          return route.fulfill({contentType:'text/html',body:'<title>Window fixture</title>'});
        });
        const page = context.pages()[0];
        page.once('domcontentloaded', () => {
          console.log(JSON.stringify({event:'fixture-opened',url:page.url()}));
          setTimeout(() => context.close(), 150);
        });
        return context;
      };
    `);
    for (let count = 2; count <= 3; count++) {
      const result = run(['login', '--profile-root', root], preload);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(listProfiles(root).length, count, 'Every login creates exactly one new profile.');
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.event === 'fixture-opened').length, 1);
      assert.equal(records.find(record => record.event === 'fixture-opened').url, 'https://chatgpt.com/');
      assert.equal(records.some(record => record.event === 'sending'), false);
    }
    const before = listProfiles(root);
    const opened = run(['open', '--profile-root', root], preload);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    const records = opened.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.event === 'fixture-opened').length, 3);
    assert.ok(records.filter(record => record.event === 'fixture-opened').every(record => record.url.endsWith('#settings/Usage')));
    assert.equal(records.some(record => record.event === 'sending'), false);
    assert.deepEqual(listProfiles(root), before, 'Opening never renames or changes profile identities.');
    assert.equal(readFileSync(join(first.path, 'keep.txt'), 'utf8'), 'untouched');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
