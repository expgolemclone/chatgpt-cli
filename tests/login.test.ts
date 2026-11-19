import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchProfile } from '../src/browser/edge.ts';
import { createProfile, listProfiles } from '../src/browser/profiles.ts';
import { closeWindow, manualPreload, removeNativeFixture } from './fixtures/native-edge.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('ordinary Edge login persists data and is not launched or controlled by Playwright', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-native-login-');
  const observed: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/observed?')) {
      observed.push(new URL(request.url, 'http://localhost').searchParams.get('previous')!);
      response.end('ok');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(`<title>Ordinary Edge login fixture</title><script>
        const previous = localStorage.getItem('fixture');
        localStorage.setItem('fixture','retained');
        fetch('/observed?previous='+encodeURIComponent(previous));
      </script>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const localAppData = join(temporary, 'localappdata');
  const profileRoot = join(localAppData, 'chatgpt-cli', 'profiles');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let profilePath: string | undefined;
    const preload = join(temporary, 'fixture.mjs');
    const launches = join(temporary, 'launches.jsonl');
    writeFileSync(preload, manualPreload);
    for (const previous of ['null', 'retained']) {
      await t.test(previous === 'null' ? 'creates its own dedicated profile' : 'reopens it without copying browser data', async () => {
        const before = observed.length;
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'login',
          ...(profilePath === undefined ? [] : ['--profile', profilePath])], {
          encoding: 'utf8', timeout: 15_000, env: { ...process.env, LOCALAPPDATA: localAppData,
            FIXTURE_LAUNCHES: launches, FIXTURE_URL: `http://127.0.0.1:${address.port}/` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(records.filter(record => record.event === 'profile-opened').length, 1);
        assert.equal(records.some(record => ['sending','sent','completed'].includes(record.event)), false);
        const launch = readFileSync(launches, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1)!;
        const profiles = listProfiles(profileRoot);
        assert.equal(profiles.length, 1);
        if (profilePath === undefined) profilePath = profiles[0]!.path;
        assert.equal(launch.directory, profilePath);
        assert.equal(dirname(launch.directory), profileRoot);
        assert.equal(readFileSync(join(launch.directory, '.gpt-usage-id'), 'utf8'), profiles[0]!.id);
        assert.equal(launch.url, 'https://chatgpt.com/');
        const deadline = Date.now() + 15_000;
        while (observed.length === before && Date.now() < deadline) await setTimeout(100);
        assert.ok(observed.length > before, 'The new window must load the page.');
        assert.equal(observed.at(-1), previous);
        assert.equal(existsSync(join(profilePath, 'DevToolsActivePort')), false, 'Manual Edge has no debugging endpoint.');
        await closeWindow(launch.pid);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
        assert.equal(existsSync(join(localAppData, 'gpt-send-messages')), false);
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeNativeFixture(temporary, listProfiles(profileRoot));
  }
});

test('prune, inspection, and send dry-run leave a busy browser in place', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-native-lock-');
  const profile = createProfile(join(temporary, 'profiles'));
  const edge = await launchProfile(profile);
  try {
    const page = edge.context.pages()[0]!;
    await page.goto('data:text/html,' + encodeURIComponent('<title>Keep existing browser</title>'));
    const run = (command: string, ...args: string[]) => spawnSync(process.execPath, [cli, command, ...args], {
      encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    const sent = run('send', '--profile', profile.path, '--dry-run');
    assert.equal(sent.status, 0, sent.stdout + sent.stderr);
    assert.deepEqual(JSON.parse(sent.stdout).profiles[0].sessions.map((session: unknown[]) => session.length), [5, 5, 5, 5, 5]);
    const pruned = run('prune', '--profile-root', dirname(profile.path), '--apply');
    assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    assert.deepEqual(JSON.parse(pruned.stdout), { profile, status: 'unknown', reason: 'profile_in_use', action: 'keep' });
    assert.equal(existsSync(join(profile.path, '.gpt-usage-access.json')), false);
    const inspected = run('inspect', '--profile', profile.path);
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).status, 'unknown');
    assert.equal(await page.title(), 'Keep existing browser');
    assert.equal(existsSync(join(profile.path, 'DevToolsActivePort')), true);
  } finally {
    await edge.close();
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
