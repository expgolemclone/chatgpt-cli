import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertProfileDirectory, createProfile, resolveProfiles } from '../src/browser/profiles.ts';
import { generateBatches, type Prompt } from '../src/prompts/generate.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('standalone CLI resolves its own dedicated profiles without another project or PowerShell', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-cli-');
  try {
    const localAppData = join(temporary, 'localappdata');
    const defaultRoot = join(localAppData, 'chatgpt-cli', 'profiles');
    const run = (...args: string[]) => spawnSync(process.execPath,
      ['--import', new URL('./fixtures/send-lock.mjs', import.meta.url).href, cli, ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, LOCALAPPDATA: localAppData, PATH: dirname(process.execPath) },
    });
    await t.test('help describes login, safety, and the only runtime requirements without creating state', () => {
      for (const args of [[], ['--help'], ['send', '--help']]) {
        const result = run(...args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /<login\|open\|profiles\|inspect\|sync\|send>/);
        assert.match(result.stdout, /No PowerShell 7 or other project/);
        assert.match(result.stdout, /Send force-closes only selected dedicated Edge profiles/);
        assert.match(result.stdout, /Other commands never terminate existing browser windows/);
        assert.match(result.stdout, /challenges try a visible verification checkbox once and wait up to 2 minutes/);
        assert.match(result.stdout, /Five consecutive Cloudflare challenge responses skip that account for this run/);
        assert.match(result.stdout, /count resets when access clears/);
        assert.match(result.stdout, /%LOCALAPPDATA%\/chatgpt-cli\/profiles/);
        assert.match(result.stdout, /accounts in order for 5 loops/);
        assert.match(result.stdout, /5 prompt\/answer rounds \(25 per account\)/);
        assert.match(result.stdout, /including account and loop boundaries/);
        assert.doesNotMatch(result.stdout, /gpt-send-messages|--questions|--sessions|--rounds/);
        assert.equal(existsSync(localAppData), false);
      }
    });
    await t.test('empty default collection is read-only and never falls back to legacy profiles', () => {
      assert.deepEqual(JSON.parse(run('profiles').stdout), { root: defaultRoot, profiles: [] });
      for (const args of [['send'], ['send', '--dry-run']]) {
        const result = run(...args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Run npm run login first/);
        assert.equal(existsSync(localAppData), false);
      }
      try {
        const legacy = createProfile(join(localAppData, 'gpt-usage'));
        mkdirSync(join(localAppData, 'gpt-send-messages', 'profile'), { recursive: true });
        assert.deepEqual(JSON.parse(run('profiles').stdout), { root: defaultRoot, profiles: [] });
        const result = run('send', '--dry-run');
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /No owned profiles/);
        assert.equal(readFileSync(join(legacy.path, '.gpt-usage-id'), 'utf8'), legacy.id);
        assert.equal(existsSync(defaultRoot), false);
      } finally { rmSync(localAppData, { recursive: true, force: true }); }
    });
    await t.test('default preview uses marked profiles without opening a browser or writing logs', () => {
      try {
        const profiles = [createProfile(defaultRoot), createProfile(defaultRoot)];
        mkdirSync(join(defaultRoot, 'unmarked'));
        mkdirSync(join(defaultRoot, 'archive'));
        writeFileSync(join(defaultRoot, 'archive', '.gpt-usage-id'), 'invalid archive identity');
        const listed = run('profiles');
        assert.equal(listed.status, 0, listed.stdout + listed.stderr);
        assert.deepEqual(JSON.parse(listed.stdout), { root: defaultRoot, profiles });
        const result = run('send', '--dry-run', '--seed', 'test-seed');
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const prompts = generateBatches(profiles.map(item => item.path.toLowerCase()), 'test-seed', 25);
        assert.deepEqual(JSON.parse(result.stdout), {
          seed: 'test-seed',
          profiles: profiles.map((profile, index) => ({
            name: profile.name,
            sessions: Array.from({ length: 5 }, (_, session) => prompts[index]!.slice(session * 5, (session + 1) * 5)),
          })),
        });
        assert.equal(existsSync(join(localAppData, 'chatgpt-cli', 'logs')), false);
        assert.equal(existsSync(join(localAppData, 'gpt-send-messages')), false);
      } finally { rmSync(localAppData, { recursive: true, force: true }); }
    });
    await t.test('explicit profiles need no markers or inventory and keep their own reproducible selection', () => {
      const paths = [join(temporary, '専用 profile'), join(temporary, 'second')];
      const result = run('send', '--dry-run', '--seed', 'batch', ...paths.flatMap(path => ['--profile', path]));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const sessions = JSON.parse(result.stdout).profiles.map((profile: { sessions: Prompt[][] }) => profile.sessions);
      for (const profile of sessions) {
        assert.deepEqual(profile.map((session: Prompt[]) => session.length), [5, 5, 5, 5, 5]);
      }
      assert.deepEqual(sessions.map((profile: Prompt[][]) => profile.flat()),
        generateBatches(paths.map(path => path.toLowerCase()), 'batch', 25));
      for (const path of paths) assert.equal(existsSync(path), false);
      assert.equal(existsSync(localAppData), false);
    });
    await t.test('preview uses attempted history across profiles without changing the logs', () => {
      const paths = [join(temporary, 'preview-one'), join(temporary, 'preview-two')];
      const ids = paths.map(path => path.toLowerCase());
      const initial = generateBatches(ids, 'history', 25);
      const attempted = initial[0]![0]!.id;
      const planned = initial[0]![1]!.id;
      const time = '2026-01-01T00:00:00.000Z';
      const contents = [
        JSON.stringify({ event: 'sending', time, promptId: attempted }),
        JSON.stringify({ event: 'profile-failed', time }),
        JSON.stringify({ event: 'planned', time, promptId: planned }),
      ].join('\n') + '\n';
      const logs = join(localAppData, 'chatgpt-cli', 'logs');
      try {
        mkdirSync(logs, { recursive: true });
        const log = join(logs, 'old.jsonl');
        writeFileSync(log, contents);
        const args = ['send', '--dry-run', '--seed', 'history', ...paths.flatMap(path => ['--profile', path])];
        const first = run(...args);
        const second = run(...args);
        assert.equal(first.status, 0, first.stdout + first.stderr);
        assert.equal(second.status, 0, second.stdout + second.stderr);
        assert.equal(first.stdout, second.stdout);
        const actual: Prompt[][][] = JSON.parse(first.stdout).profiles.map((profile: { sessions: Prompt[][] }) => profile.sessions);
        assert.deepEqual(actual.map(sessions => sessions.flat()),
          generateBatches(ids, 'history', 25, new Map([[attempted, Date.parse(time)]])));
        assert.equal(new Set(actual.flat(2).map(prompt => prompt.id)).size, 50);
        assert.equal(actual.flat(2).some(prompt => prompt.id === attempted), false);
        assert.deepEqual(readdirSync(logs), ['old.jsonl']);
        assert.equal(readFileSync(log, 'utf8'), contents);
        for (const path of paths) assert.equal(existsSync(path), false);
      } finally { rmSync(localAppData, { recursive: true, force: true }); }
    });
    await t.test('invalid commands, removed count options, paths, and login options fail before side effects', () => {
      const cases = [
        ['invalid'], ['send', 'extra'], ['send', '--manifest', 'old.json'],
        ['send', '--profile', ''], ['send', '--profile', 'relative'],
        ['login', '--questions', '1'], ['login', '--seed', 'test'], ['login', '--dry-run'],
        ['login', '--profile', join(temporary, 'one'), '--profile', join(temporary, 'two')],
        ...['--questions', '--sessions', '--rounds'].map(option => ['send', option, '5']),
        ['send', '--questions=1'],
      ];
      for (const args of cases) {
        const result = run(...args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, JSON.stringify(args) + result.stdout + result.stderr);
        assert.equal(result.stdout, '');
        assert.equal(existsSync(localAppData), false);
      }
    });
    await t.test('send cannot silently create a missing or misspelled profile', () => {
      for (const selection of [[], ['--profile', join(temporary, 'missing')]]) {
        const result = run('send', ...selection);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Run npm run login first/);
        assert.equal(existsSync(localAppData), false);
      }
    });
    await t.test('normal Edge data, overlapping directories, files, and links are rejected', () => {
      const profilePath = join(temporary, 'dedicated');
      mkdirSync(profilePath);
      assert.deepEqual(resolveProfiles([profilePath], localAppData), [{ name: 'dedicated', path: profilePath }]);
      assert.doesNotThrow(() => assertProfileDirectory(profilePath, true));
      for (const paths of [
        [join(localAppData, 'Microsoft', 'Edge', 'User Data')],
        [join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default')],
        [join(localAppData, 'Microsoft', 'Edge', 'User Data', '..automation')],
        [localAppData], [profilePath, profilePath.toUpperCase()],
        [profilePath, join(profilePath, 'child')],
      ]) assert.throws(() => resolveProfiles(paths, localAppData));
      const file = join(temporary, 'not-directory');
      writeFileSync(file, 'test');
      assert.throws(() => resolveProfiles([file], localAppData));
      const link = join(temporary, 'linked');
      symlinkSync(profilePath, link, 'junction');
      assert.throws(() => resolveProfiles([link], localAppData));
      assert.throws(() => resolveProfiles([join(link, 'missing')], localAppData));
      assert.deepEqual(resolveProfiles([], localAppData), []);
      assert.throws(() => resolveProfiles([], 'relative'));
      assert.throws(() => resolveProfiles([], ''));
    });
    await t.test('npm entry points invoke Node directly and do not depend on a PowerShell adapter', () => {
      const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      assert.equal(manifest.scripts.login, 'node src/main.ts login');
      assert.equal(manifest.scripts.preview, 'node src/main.ts send --dry-run');
      assert.equal(manifest.scripts.start, 'node src/main.ts send');
      assert.equal(existsSync(new URL('../send-messages.ps1', import.meta.url)), false);
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
