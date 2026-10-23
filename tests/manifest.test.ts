import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readManifest } from '../src/main.js';

test('manifest accepts existing dedicated directories only', () => {
  const temp = mkdtempSync('C:/dev/tmp/gpt-message-manifest-');
  try {
    const root = join(temp, 'profiles');
    const profilePath = join(root, 'test-profile');
    mkdirSync(profilePath, { recursive: true });
    const file = join(temp, 'manifest.json');
    const profile = { id: 'a'.repeat(32), name: 'test-profile', path: profilePath };
    const manifest = { schemaVersion: 1, edgePath: process.execPath, edgeArguments: ['--no-first-run'], profileRoot: root, profiles: [profile] };
    const check = (data: unknown) => { writeFileSync(file, JSON.stringify(data)); return () => readManifest(file); };
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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
