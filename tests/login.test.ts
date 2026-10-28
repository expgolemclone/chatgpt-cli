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
import { closeWindow, manualPreload } from './fixtures/native-edge.ts';

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
  const pids: number[] = [];
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localAppData = join(temporary, 'localappdata');
    const profileRoot = join(localAppData, 'chatgpt-cli', 'profiles');
    let profilePath: string | undefined;
    const preload = join(temporary, 'fixture.mjs');
    const launches = join(temporary, 'launches.jsonl');
    writeFileSync(preload, manualPreload);
    for (const previous of ['null', 'retained']) {
      await t.test(previous === 'null' ? 'creates its own dedicated profile' : 'reopens it without copying browser data', async () => {
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
        pids.push(launch.pid);
        const profiles = listProfiles(profileRoot);
        assert.equal(profiles.length, 1);
        if (profilePath === undefined) profilePath = profiles[0]!.path;
        assert.equal(launch.directory, profilePath);
        assert.equal(dirname(launch.directory), profileRoot);
        assert.equal(readFileSync(join(launch.directory, '.gpt-usage-id'), 'utf8'), profiles[0]!.id);
        assert.equal(launch.url, 'https://chatgpt.com/');
        const deadline = Date.now() + 15_000;
        while (observed.length < pids.length && Date.now() < deadline) await setTimeout(100);
        assert.equal(observed.at(-1), previous);
        assert.equal(existsSync(join(profilePath, 'DevToolsActivePort')), false, 'Manual Edge has no debugging endpoint.');
        await closeWindow(launch.pid);
        assert.equal(existsSync(join(localAppData, 'gpt-usage')), false);
        assert.equal(existsSync(join(localAppData, 'gpt-send-messages')), false);
      });
    }
  } finally {
    for (const pid of pids) await closeWindow(pid);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('busy ordinary Edge profiles reject attachment without terminating or unlocking their browser', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-native-lock-');
  const profile = createProfile(join(temporary, 'profiles'));
  const edge = await launchProfile(profile);
  try {
    const page = edge.context.pages()[0]!;
    await page.setContent('<title>Keep existing browser</title>');
    const run = (command: string) => spawnSync(process.execPath, [cli, command, '--profile', profile.path,
      ...(command === 'send' ? ['--questions','1'] : [])], {
      encoding: 'utf8', timeout: 25_000, env: { ...process.env, LOCALAPPDATA: join(temporary, 'localappdata') },
    });
    const sent = run('send');
    assert.equal(sent.status, 1, sent.stdout + sent.stderr);
    const records = sent.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.some(record => record.event === 'sending'), false);
    assert.equal(records.at(-1).success, false);
    const inspected = run('inspect');
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).status, 'unknown');
    assert.equal(await page.title(), 'Keep existing browser');
    assert.equal(existsSync(join(profile.path, 'DevToolsActivePort')), true);
  } finally {
    await edge.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
