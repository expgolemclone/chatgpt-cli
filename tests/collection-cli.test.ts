import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProfile, listProfiles } from '../src/browser/profiles.ts';
import { closeWindow, manualPreload, removeNativeFixture } from './fixtures/native-edge.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('the default collection opens marked profiles in ordinary Edge without inspecting login', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-collection-cli-');
  let navigations = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    if (request.url === '/') navigations++;
    response.setHeader('content-type', 'text/html');
    response.end('<title>Ordinary Edge collection fixture</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const pids: number[] = [];
  const localAppData = join(temporary, 'localappdata');
  const root = join(localAppData, 'chatgpt-cli', 'profiles');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const launches = join(temporary, 'launches.jsonl');
    const run = (args: string[], preload?: string) => spawnSync(process.execPath,
      [...(preload ? ['--import', pathToFileURL(preload).href] : []), cli, ...args], {
        encoding: 'utf8', timeout: 15_000, env: { ...process.env, LOCALAPPDATA: localAppData,
          FIXTURE_LAUNCHES: launches, FIXTURE_URL: `http://127.0.0.1:${address.port}/` },
      });
    const first = createProfile(root);
    writeFileSync(join(first.path, 'keep.txt'), 'untouched');
    const preload = join(temporary, 'window-fixture.mjs');
    writeFileSync(preload, manualPreload);
    const verifyLaunches = async (count: number, url: string) => {
      const records = readFileSync(launches, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const added = records.slice(pids.length);
      assert.equal(added.length, count);
      for (const record of added) {
        pids.push(record.pid);
        assert.equal(record.url, url);
        assert.match(readFileSync(join(record.directory, '.gpt-usage-id'), 'utf8'), /^[0-9a-f]{32}$/);
      }
      const deadline = Date.now() + 15_000;
      while (navigations < pids.length && Date.now() < deadline) await setTimeout(100);
      assert.equal(navigations, pids.length);
      for (const record of added) {
        assert.equal(existsSync(join(record.directory, 'DevToolsActivePort')), false);
      }
    };
    for (let count = 2; count <= 3; count++) {
      const result = run(['login'], preload);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(listProfiles(root).length, count);
      await verifyLaunches(1, 'https://chatgpt.com/');
      await closeWindow(pids.at(-1)!);
    }
    const before = listProfiles(root);
    const opened = run(['open'], preload);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    await verifyLaunches(3, 'https://chatgpt.com/#settings/Usage');
    assert.deepEqual(listProfiles(root), before);
    assert.equal(readFileSync(join(first.path, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(existsSync(join(localAppData, 'chatgpt-cli', 'logs')), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeNativeFixture(temporary, listProfiles(root));
  }
});
