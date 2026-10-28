import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertProfileDirectory, resolveProfiles } from '../src/browser/profiles.ts';
import { generatePrompts, maxPrompts } from '../src/prompts/generate.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('standalone CLI resolves its own dedicated profiles without another project or PowerShell', async t => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-message-cli-');
  try {
    const localAppData = join(temporary, 'localappdata');
    const defaultPath = join(localAppData, 'gpt-send-messages', 'profile');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, LOCALAPPDATA: localAppData, PATH: dirname(process.execPath) },
    });
    await t.test('help describes login, safety, and the only runtime requirements without creating state', () => {
      for (const args of [[], ['--help'], ['send', '--help']]) {
        const result = run(...args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /<login\|open\|profiles\|inspect\|send>/);
        assert.match(result.stdout, /No PowerShell 7 or other project/);
        assert.equal(existsSync(localAppData), false);
      }
    });
    await t.test('default preview works before login, without logs, a browser, or profile files', () => {
      for (const count of [5, 1, 2, 13, maxPrompts]) {
        const result = run('send', '--dry-run', '--seed', 'test-seed',
          ...(count === 5 ? [] : ['--questions', String(count)]));
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          seed: 'test-seed',
          profiles: [{ name: 'profile', prompts: generatePrompts(defaultPath.toLowerCase(), 'test-seed', count) }],
        });
        assert.equal(existsSync(localAppData), false);
      }
    });
    await t.test('explicit profiles need no markers or inventory and keep their own reproducible selection', () => {
      const paths = [join(temporary, '専用 profile'), join(temporary, 'second')];
      const result = run('send', '--dry-run', '--seed', 'batch', ...paths.flatMap(path => ['--profile', path]));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).profiles.map((profile: { prompts: unknown }) => profile.prompts),
        paths.map(path => generatePrompts(path.toLowerCase(), 'batch')));
      for (const path of paths) assert.equal(existsSync(path), false);
      assert.equal(existsSync(localAppData), false);
    });
    await t.test('invalid commands, counts, paths, and login options fail before side effects', () => {
      const cases = [
        ['invalid'], ['send', 'extra'], ['send', '--manifest', 'old.json'],
        ['send', '--profile', ''], ['send', '--profile', 'relative'],
        ['login', '--questions', '1'], ['login', '--seed', 'test'], ['login', '--dry-run'],
        ['login', '--profile', join(temporary, 'one'), '--profile', join(temporary, 'two')],
        ...['', '0', '-1', '1.5', 'NaN', 'Infinity', 'invalid', String(maxPrompts + 1)]
          .map(count => ['send', `--questions=${count}`]),
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
      const result = run('send', '--questions', '1');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Run npm run login first/);
      assert.equal(existsSync(localAppData), false);
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
