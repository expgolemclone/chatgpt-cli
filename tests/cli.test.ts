import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDedicatedDirectory, createProfile } from '../src/browser/profiles.ts';
import { generateBatches, type Prompt } from '../src/prompts/generate.ts';
import { createNamedProfile } from './fixtures/profiles.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('the standalone CLI discovers the default collection and validates each command before side effects', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-cli-test-');
  const localAppData = join(temporary, 'localappdata');
  const root = join(localAppData, 'chatgpt-cli', 'profiles');
  const logs = join(localAppData, 'chatgpt-cli', 'logs');
  const env = { ...process.env, LOCALAPPDATA: localAppData, PATH: dirname(process.execPath) };
  const lock = new URL('./fixtures/send-lock.mjs', import.meta.url).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', lock, cli, ...args], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  try {
    await t.test('help lists everyday commands and only the options for the selected command', () => {
      for (const args of [[], ['--help'], ['-h']]) {
        const result = run(...args);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /chatgpt-cli COMMAND/);
        assert.match(result.stdout, /Start with chatgpt-cli login/);
        assert.doesNotMatch(result.stdout, /--profile-root|--apply|--reference/);
      }
      const send = run('send', '--help');
      assert.equal(send.status, 0, send.stderr);
      assert.match(send.stdout, /--dry-run/);
      assert.match(send.stdout, /closes any open Edge windows in the selected dedicated profiles/);
      assert.match(send.stdout, /5 loops, with 5 rounds per visit and at least 30 seconds/);
      assert.match(send.stdout, /without interacting with verification controls/);
      assert.match(send.stdout, /five consecutive Cloudflare challenge responses/);
      assert.doesNotMatch(send.stdout, /--apply|--reference/);
      assert.match(run('profiles', '--help').stdout, /Commands:[\s\S]*check[\s\S]*sync[\s\S]*prune/);
      assert.match(run('profiles', 'prune', '-h').stdout, /--apply[\s\S]*five-minute inspection cooldown/);
      assert.equal(existsSync(localAppData), false);
    });

    await t.test('an empty collection is read-only and never falls back to legacy profiles', () => {
      assert.match(run('profiles').stdout, /No dedicated profiles/);
      for (const args of [['send'], ['send', '--dry-run']]) {
        const result = run(...args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Run chatgpt-cli login/);
        assert.equal(existsSync(localAppData), false);
      }
      const legacy = createProfile(join(localAppData, 'gpt-usage'));
      assert.match(run('profiles').stdout, /No dedicated profiles/);
      assert.equal(run('send', '--dry-run').status, 1);
      assert.equal(readFileSync(join(legacy.path, '.gpt-usage-id'), 'utf8'), legacy.id);
      assert.equal(existsSync(root), false);
      rmSync(localAppData, { recursive: true });
    });

    await t.test('invalid commands, obsolete flags and unknown names never create state', () => {
      for (const args of [
        ['unknown'], ['constructor'], ['send', 'extra'], ['send', '--questions=1'],
        ['send', '--apply'], ['send', '--profile-root', root], ['open', '--dry-run'],
        ['profiles', 'toString'], ['profiles', 'check'], ['profiles', 'check', '--profile', ' '],
        ['profiles', 'sync'], ['profiles', 'prune', '--profile', 'one'], ['profiles', 'prune', '--dry-run'],
        ['login', '--profile', 'one', '--profile', 'two'], ['login', '--profile', 'missing'],
        ['login', '--profile', join(temporary, 'absolute')], ['send', '--profile', 'missing', '--dry-run'],
      ]) {
        const result = run(...args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, JSON.stringify(args) + result.stdout + result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /chatgpt-cli .*--help|Run chatgpt-cli profiles/);
        assert.equal(existsSync(localAppData), false);
      }
    });

    const profiles = [createNamedProfile(root, 'free one'), createNamedProfile(root, 'free-two')];
    mkdirSync(join(root, 'unmarked'));
    createProfile(join(root, 'archive'));
    const names = profiles.map(profile => profile.name);
    const ids = profiles.map(profile => profile.path.toLowerCase());
    await t.test('preview uses owned profiles and supports an exact case-insensitive name', () => {
      assert.equal(run('profiles').stdout.trimEnd(), names.join('\n'));
      const result = run('send', '--dry-run', '--seed', 'test-seed');
      assert.equal(result.status, 0, result.stderr);
      const prompts = generateBatches(ids, 'test-seed', 25);
      assert.deepEqual(JSON.parse(result.stdout), {
        seed: 'test-seed',
        profiles: names.map((name, index) => ({
          name,
          sessions: Array.from({ length: 5 }, (_, session) => prompts[index]!.slice(session * 5, (session + 1) * 5)),
        })),
      });
      const single = run('send', '--dry-run', '--profile', 'FREE ONE');
      assert.equal(single.status, 0, single.stderr);
      assert.deepEqual(JSON.parse(single.stdout).profiles.map((profile: { name: string }) => profile.name), [names[0]]);
      for (const name of [profiles[0]!.path, 'free', 'unmarked', 'archive', '../gpt-usage']) {
        assert.match(run('send', '--dry-run', '--profile', name).stderr, /No profile named/);
      }
      assert.equal(existsSync(logs), false);
      for (const profile of profiles) assert.deepEqual(readdirSync(profile.path), ['.gpt-usage-id']);
    });

    await t.test('preview uses attempted history and live unattended replay is refused without opening Edge', () => {
      const attempted = generateBatches(ids, 'history', 25)[0]![0]!.id;
      const time = '2026-01-01T00:00:00.000Z';
      const contents = [
        JSON.stringify({ event: 'sending', time, promptId: attempted }),
        JSON.stringify({ event: 'profile-failed', time }),
      ].join('\n') + '\n';
      mkdirSync(logs);
      const log = join(logs, 'old.jsonl');
      writeFileSync(log, contents);
      const result = run('send', '--dry-run', '--seed', 'history');
      assert.equal(result.status, 0, result.stderr);
      const batches: Prompt[][][] = JSON.parse(result.stdout).profiles.map((profile: { sessions: Prompt[][] }) => profile.sessions);
      assert.deepEqual(batches.map(sessions => sessions.flat()),
        generateBatches(ids, 'history', 25, new Map([[attempted, Date.parse(time)]])));
      assert.equal(new Set(batches.flat(2).map(prompt => prompt.id)).size, 50);
      for (const args of [[], ['--profile', names[0]!]]) {
        const retry = run('send', ...args);
        assert.equal(retry.status, 1);
        assert.match(retry.stderr, /Automatic replay refused/);
        assert.equal(retry.stdout, '');
      }
      assert.deepEqual(readdirSync(logs), ['old.jsonl']);
      assert.equal(readFileSync(log, 'utf8'), contents);
      for (const profile of profiles) assert.deepEqual(readdirSync(profile.path), ['.gpt-usage-id']);
      rmSync(logs, { recursive: true });
    });

    await t.test('elevated live commands stop before touching Edge, profiles, logs, or the ledger', () => {
      const elevated = join(temporary, 'elevated.mjs');
      writeFileSync(elevated, [
        'import koffi from ' + JSON.stringify(import.meta.resolve('koffi')) + ';',
        'const load = koffi.load;',
        'koffi.load = name => name === "shell32.dll" ? { func(definition) {',
        '  if (!definition.includes("IsUserAnAdmin")) throw new Error("Unexpected browser process access.");',
        '  return () => 1;',
        '} } : load(name);',
      ].join('\n'));
      const ledger = join(temporary, 'ledger.csv');
      const csv = 'kind,value,state\n';
      writeFileSync(ledger, csv);
      for (const args of [
        ['profiles', 'check', '--profile', names[0]!], ['profiles', 'sync', ledger],
        ['profiles', 'prune', '--apply'], ['send'], ['image', 'brief.txt', 'new.png', '--profile', names[0]!],
      ]) {
        const result = spawnSync(process.execPath, ['--import', lock, '--import', pathToFileURL(elevated).href, cli, ...args],
          { encoding: 'utf8', timeout: 10_000, env });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /non-elevated Windows terminal/);
        assert.equal(result.stdout, '');
      }
      assert.equal(existsSync(logs), false);
      for (const profile of profiles) assert.deepEqual(readdirSync(profile.path), ['.gpt-usage-id']);
      assert.equal(readFileSync(ledger, 'utf8'), csv);
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('dedicated directories reject normal Edge data, files, and links', () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-dedicated-dir-');
  try {
    const local = process.env.LOCALAPPDATA!;
    const normal = join(local, 'Microsoft', 'Edge', 'User Data');
    for (const path of [local, normal, join(normal, 'Default'), 'relative']) {
      assert.throws(() => assertDedicatedDirectory(path, false));
    }
    const file = join(temporary, 'file');
    writeFileSync(file, 'untouched');
    assert.throws(() => assertDedicatedDirectory(file, false), /regular, unlinked directories/);
    const directory = join(temporary, 'directory');
    mkdirSync(directory);
    const link = join(temporary, 'linked');
    symlinkSync(directory, link, 'junction');
    for (const path of [link, join(link, 'missing')]) {
      assert.throws(() => assertDedicatedDirectory(path, false), /unlinked/);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('npm exposes the same Node entry point without redundant scripts', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.bin, { 'chatgpt-cli': 'src/main.ts' });
  for (const alias of ['login', 'preview', 'start']) assert.equal(Object.hasOwn(manifest.scripts, alias), false);
});
