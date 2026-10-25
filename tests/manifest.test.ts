import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readManifest } from '../src/main.js';
import { generatePrompts, maxPrompts } from '../src/prompts/generate.js';

test('manifest and CLI use existing dedicated directories only', async t => {
  const temp = mkdtempSync('C:/dev/tmp/gpt-message-manifest-');
  try {
    const root = join(temp, 'profiles');
    const profilePath = join(root, 'test-profile');
    mkdirSync(profilePath, { recursive: true });
    const file = join(temp, 'manifest.json');
    const profile = { id: 'a'.repeat(32), name: 'test-profile', path: profilePath };
    const manifest = { schemaVersion: 1, edgePath: process.execPath, edgeArguments: ['--no-first-run'], profileRoot: root, profiles: [profile] };
    const check = (data: unknown) => { writeFileSync(file, JSON.stringify(data)); return () => readManifest(file); };
    await t.test('manifest rejects missing, duplicate, or unsafe profiles', () => {
      assert.equal(check(manifest)().profiles.length, 1);
      assert.throws(check({ ...manifest, profiles: [profile, profile] }));
      assert.throws(check({ ...manifest, schemaVersion: 2 }));
      assert.throws(check({ ...manifest, profiles: [] }));
      assert.throws(check({ ...manifest, edgeArguments: undefined }));
      assert.throws(check({ ...manifest, edgeArguments: [123] }));
      assert.throws(check({ ...manifest, profiles: [{ ...profile, name: 'missing', path: join(root, 'missing') }] }));
      assert.throws(check({ ...manifest, profiles: [{ ...profile, name: 'profiles', path: root }] }));
      assert.throws(check({ ...manifest, profiles: [{ ...profile, name: 'archive', path: join(root, 'archive') }] }));
      assert.throws(check({ ...manifest, profiles: [{ ...profile, path: join(temp, 'test-profile') }] }));
    });

    check(manifest)();
    const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
    const localAppData = join(temp, 'localappdata');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--manifest', file, '--seed', 'test-seed', ...args], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    await t.test('dry-run uses the generator for default and larger batches without recording history', () => {
      for (const count of [5, 1, 2, 13, 100]) {
        const result = run('--dry-run', ...(count === 5 ? [] : ['--questions', String(count)]));
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          seed: 'test-seed',
          profiles: [{ name: profile.name, prompts: generatePrompts(profile.id, 'test-seed', count) }],
        });
        assert.equal(existsSync(localAppData), false, 'Dry-run must not create logs or launch a browser.');
      }
    });
    await t.test('invalid counts fail before the live path creates logs or launches a browser', () => {
      for (const count of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', 'invalid', String(maxPrompts + 1)]) {
        const result = run(`--questions=${count}`);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(result.stderr.includes(`Prompt count must be between 1 and ${maxPrompts}.`), result.stderr);
        assert.equal(result.stdout, '');
        assert.equal(existsSync(localAppData), false, 'Invalid counts must fail before any live side effects.');
      }
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
