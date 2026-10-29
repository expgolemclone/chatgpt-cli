import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { profileDirectory, terminateProfiles } from '../src/browser/processes.ts';
import { createProfile } from '../src/browser/profiles.ts';

const executable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profilePath = "C:\\dedicated profiles\\日本語's account@example.test";
const command = (arguments_: string) => '"' + executable + '" ' + arguments_;
const matches = (commandLine: string) => profileDirectory(commandLine) === resolve(profilePath).toLowerCase();

test('Windows parsing identifies complete directories with spaces, Unicode, escaped quotes, and long arguments', () => {
  for (const arguments_ of [
    '"--user-data-dir=' + profilePath + '" --new-window https://chatgpt.com/',
    '--user-data-dir="' + profilePath + '" --new-window',
    '"--user-data-dir=' + profilePath.toUpperCase().replaceAll('\\', '/') + '"',
    '--features=' + 'x'.repeat(900) + ' "--user-data-dir=' + profilePath + '"',
    '"--user-data-dir=' + profilePath + '" --type=renderer',
    '"--user-data-dir=' + profilePath + '" --title="escaped \\"quote\\""',
    '-USER-DATA-DIR="' + profilePath + '"',
    '/user-data-dir="' + profilePath + '"',
    '"--user-data-dir=' + profilePath + '" -- --user-data-dir=C:\\different',
  ]) assert.equal(matches(command(arguments_)), true, arguments_);
  assert.equal(profileDirectory(command('--user-data-dir=C:\\dedicated\\account@example.test')),
    'c:\\dedicated\\account@example.test');
});

test('Windows parsing rejects ordinary profiles, ambiguous switches, URL lookalikes, and positional arguments', () => {
  for (const arguments_ of [
    '', '--new-window https://chatgpt.com/',
    '"--user-data-dir=' + profilePath + '-other"',
    '"--user-data-dir=' + profilePath + '\\nested"',
    '"--user-data-dir=C:\\dedicated profiles"',
    '"--user-data-dir=relative"',
    '"--user-data-dir=' + profilePath + '" "--user-data-dir=' + profilePath + '"',
    '"--user-data-dir=' + profilePath + '" --user-data-dir=C:\\different',
    '"--user-data-dir=' + profilePath + '" -USER-DATA-DIR=C:\\different',
    '"--user-data-dir=' + profilePath + '" /user-data-dir=C:\\different',
    '"--user-data-dir=' + profilePath + '" --user-data-dir=',
    '"--user-data-dir=' + profilePath + '" --user-data-dir',
    '--user-data-dir "' + profilePath + '"',
    '-- "--user-data-dir=' + profilePath + '"',
    '--single-argument "--user-data-dir=' + profilePath + '"',
    '"--user-data-dir=' + profilePath + '" " --user-data-dir= "',
    '"--user-data-dir=' + profilePath + '" "\u0085--user-data-dir=\u0085"',
    '" --user-data-dir=' + profilePath + '"',
    '"https://example.test/ --user-data-dir=' + profilePath + ' other"',
    '"https://example.test/ --user-data-dir=C:\\dedicated other"',
    '"--user-data-dir=\\"' + profilePath + '\\""',
  ]) assert.equal(matches(command(arguments_)), false, arguments_);
  assert.equal(profileDirectory(command('"https://example.test/ --user-data-dir=C:\\dedicated other"')), undefined);
  assert.equal(profileDirectory(command('--user-data-dir=\\dedicated')), undefined,
    'Drive-relative roots cannot be resolved using a different process working directory.');
});

test('termination validates identities and excludes normal Edge before touching browsers', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-termination-boundary-');
  try {
    const profile = createProfile(join(temporary, 'profiles'));
    writeFileSync(join(profile.path, '.gpt-usage-id'), '0'.repeat(32));
    await assert.rejects(terminateProfiles([profile]), /identity changed/);
    await assert.rejects(terminateProfiles([{ name: 'normal',
      path: join(process.env.LOCALAPPDATA!, 'Microsoft', 'Edge', 'User Data') }]), /Normal Edge/);
    assert.deepEqual(await terminateProfiles([]), []);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('a non-Edge executable with the selected directory in its command line is never terminated', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-termination-executable-');
  const profile = createProfile(join(temporary, 'profiles'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)',
    '--', '--user-data-dir=' + profile.path], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    assert.deepEqual(await terminateProfiles([profile]), []);
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('a growing or failed native inventory cannot cause partial discovery or termination', () => {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-termination-inventory-');
  try {
    const profile = createProfile(join(temporary, 'profiles'));
    const script = [
      'import assert from "node:assert/strict";',
      'import koffi from ' + JSON.stringify(import.meta.resolve('koffi')) + ';',
      'const sizes = [];',
      'const load = koffi.load;',
      'koffi.load = name => {',
      '  const library = load(name);',
      '  if (name !== "kernel32.dll") return library;',
      '  const func = library.func.bind(library);',
      '  return { ...library, func(definition) {',
      '    if (definition.includes("K32EnumProcesses")) return (pids, bytes, used) => {',
      '      sizes.push(bytes); used[0] = bytes; return sizes.length === 1 ? 1 : 0;',
      '    };',
      '    if (definition.includes("OpenProcess") || definition.includes("TerminateProcess")) {',
      '      return () => { throw new Error("Discovery or termination must not run."); };',
      '    }',
      '    return func(definition);',
      '  } };',
      '};',
      'const { terminateProfiles } = await import(' + JSON.stringify(new URL('../src/browser/processes.ts', import.meta.url).href) + ');',
      'await assert.rejects(terminateProfiles(' + JSON.stringify([profile]) + '), /Process inventory failed/);',
      'assert.deepEqual(sizes, [1024, 2048]);',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
