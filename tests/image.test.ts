import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchProfile } from '../src/browser/edge.ts';
import { createProfile } from '../src/browser/profiles.ts';
import { runChat } from '../src/chat.ts';
import { accountCheck, fixturePng } from './fixtures/chat.ts';
import { serveImageFixture } from './fixtures/image.ts';

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('standalone image CLI selects one Plus profile and saves just its downloaded PNG', async t => {
  const dir = mkdtempSync('C:/dev/tmp/chatgpt-image-test-');
  const local = join(dir, 'local'), profiles = join(local, 'chatgpt-cli', 'profiles');
  const selected = join(profiles, 'plus@example.test'), other = join(profiles, 'other@example.test');
  const csv = 'kind,value,state\nemail,PLUS@example.test,plus\nemail,other@example.test,無料\n';
  const ledger = join(dir, 'usage.csv'), brief = '非公開のテスト用プロンプト', args = ['--prompt-file', '指示 file.txt', '--output', 'out/new.png'];
  const output = join(dir, 'out/new.png'), submissions = join(dir, 'posted'), preload = join(dir, 'fixture.mjs');
  const csvArgs = ['image', '--ledger', 'usage.csv', ...args], explicit = ['image', '--profile', selected, ...args];
  const run = (argv: string[], mode = 'normal') => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...argv], {
    cwd: dir, encoding: 'utf8', timeout: 65_000, env: { ...process.env, LOCALAPPDATA: local, IMAGE_FIXTURE: mode },
  });
  const posted = () => existsSync(submissions) ? readFileSync(submissions, 'utf8').trimEnd().split('\n') : [];
  try {
    renameSync(createProfile(profiles).path, selected);
    renameSync(createProfile(profiles).path, other);
    writeFileSync(ledger, csv);
    writeFileSync(join(dir, args[1]!), '\ufeff' + brief + '\n');
    writeFileSync(preload, `
      import ${JSON.stringify(new URL('./fixtures/send-lock.mjs', import.meta.url).href)};
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      import { serveImageFixture } from ${JSON.stringify(new URL('./fixtures/image.ts', import.meta.url).href)};
      const connect = chromium.connectOverCDP.bind(chromium);
      chromium.connectOverCDP = async (...args) => {
        const browser = await connect(...args);
        await serveImageFixture(browser.contexts()[0], process.env.IMAGE_FIXTURE, text => {
          appendFileSync(${JSON.stringify(submissions)}, JSON.stringify(text) + '\\n');
          if (process.env.IMAGE_FIXTURE === 'race') writeFileSync(${JSON.stringify(output)}, 'other writer', {flag:'wx'});
        });
        return browser;
      };
    `);

    await t.test('help and invalid input or ambiguous selection never launch Edge', () => {
      const help = run(['image', '--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--prompt-file FILE --output NEW.png.*--reference IMAGE/);
      assert.doesNotMatch(help.stdout, /5 loops/);
      for (const argv of [['image', ...args], [...csvArgs, '--profile', selected], [...explicit, '--profile', other],
        [...csvArgs, '--dry-run'], ['inspect', '--profile', selected, ...args]]) {
        const r = run(argv); assert.equal(r.status, 1, r.stderr); assert.equal(r.stdout, '');
      }
      for (const state of ['なし', 'plus']) {
        writeFileSync(ledger, state === 'なし' ? csv.replace(',plus\n', ',なし\n') : csv.replace('無料', 'plus'));
        assert.match(run(csvArgs).stderr, /Not sent: Found (?:0|2) matching Plus profiles/);
      }
      writeFileSync(ledger, csv);
      for (const contents of [Buffer.from('  \n'), Buffer.from([0xff, 0xfe, 0x41])]) {
        writeFileSync(join(dir, args[1]!), contents);
        assert.match(run(csvArgs).stderr, /Not sent: .*UTF-8/);
      }
      writeFileSync(join(dir, args[1]!), brief);
      assert.match(run([...explicit, '--reference', 'missing.jpg']).stderr, /Not sent: .*--reference/);
      assert.match(run([...explicit, '--reference', args[1]!]).stderr, /Not sent: .*--reference/);
      mkdirSync(join(dir, 'out'), { recursive: true }); writeFileSync(output, 'keep');
      assert.match(run(explicit).stderr, /Not sent: .*new writable .png/);
      assert.equal(readFileSync(output, 'utf8'), 'keep'); rmSync(output);
      assert.match(run(explicit).stderr, /Not sent: Select an existing dedicated Edge user-data directory/);
      assert.deepEqual(readdirSync(selected), ['.gpt-usage-id']);
      assert.deepEqual(readdirSync(other), ['.gpt-usage-id']);
      assert.deepEqual(posted(), []);
    });

    // Initialize the disposable user-data directory exactly as a prior manual login would.
    const seeded = await launchProfile({ name: 'selected', path: selected });
    await seeded.close();
    await t.test('caller-relative paths, read-only ledger, exactly one request, path-only stdout', () => {
      const r = run(csvArgs);
      assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
      assert.equal(r.stdout.trimEnd(), output); assert.deepEqual(readFileSync(output), Buffer.from(fixturePng, 'base64'));
      assert.deepEqual(posted().map(line => JSON.parse(line).replace(/\s+/g, ' ')), ['Generate exactly one image from this brief: ' + brief]);
      assert.equal(readFileSync(ledger, 'utf8'), csv); assert.deepEqual(readdirSync(other), ['.gpt-usage-id']);
      assert.equal(existsSync(join(local, 'chatgpt-cli/logs')), false);
      rmSync(output);
    });

    await t.test('attaches both local references to the same image request', () => {
      const files = ['ロッカー reference.png', 'pouch.png'];
      for (const file of files) writeFileSync(join(dir, file), Buffer.from(fixturePng, 'base64'));
      const r = run([...explicit, ...files.flatMap(file => ['--reference', file])], 'image-refs');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trimEnd(), output);
      const last = JSON.parse(JSON.parse(posted().at(-1)!));
      assert.deepEqual(last.selected, files);
      assert.match(last.text, /Generate exactly one image from this brief:/);
      rmSync(output);
    });

    await t.test('wrong account, free plan, manual login and draft stop before submission', () => {
      for (const [mode, pattern] of [['wrong', /Account changed/], ['free', /Personal Plus/], ['login', /manual login/],
        ['draft', /draft/]] as const) {
        const before = posted().length, r = run(explicit, mode);
        assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /Not sent:/); assert.match(r.stderr, pattern);
        assert.equal(r.stdout, ''); assert.doesNotMatch(r.stderr, /example\.test|非公開/); assert.equal(posted().length, before);
      }
    });

    await t.test('suggests another Plus profile only for Cloudflare before submission', () => {
      const before = posted().length;
      for (const mode of ['cloudflare', 'blocked']) {
        const r = run(csvArgs, mode);
        assert.equal(r.status, 1, r.stderr); assert.equal(r.stdout, '');
        if (mode === 'cloudflare') {
          assert.match(r.stderr, /Not sent: Cloudflare verification did not clear.*--profile DIR.*another signed-in Plus profile/);
        } else {
          assert.match(r.stderr, /Not sent: Access is restricted/);
          assert.doesNotMatch(r.stderr, /--profile DIR/);
        }
        assert.doesNotMatch(r.stderr, /Check chat history|example\.test|非公開/);
        assert.equal(posted().length, before); assert.equal(existsSync(output), false);
      }
    });

    await t.test('never kills a busy selected profile', async () => {
      const edge = await launchProfile({ name: 'selected', path: selected });
      try {
        const r = run(explicit); assert.equal(r.status, 1); assert.match(r.stderr, /Not sent: Close the selected/);
        assert.equal(await edge.context.pages()[0]!.title(), '');
      } finally { await edge.close(); }
    });

    await t.test('failed or restricted replies never resubmit, overwrite, or publish a partial file', () => {
      for (const mode of ['quota', 'submission-cloudflare', 'invalid', 'text', 'race']) {
        const before = posted().length, r = run(explicit, mode);
        assert.equal(r.status, 1, r.stderr); assert.equal(r.stdout, '');
        assert.match(r.stderr, mode === 'quota' || mode === 'submission-cloudflare'
          ? /Submission unconfirmed: Access is restricted/ : /Sent:/);
        if (mode === 'invalid') assert.match(r.stderr, /not an intact PNG/);
        assert.match(r.stderr, /Check chat history/); assert.doesNotMatch(r.stderr, /--profile DIR|example\.test|非公開/);
        assert.equal(posted().length, before + 1);
        if (mode === 'race') assert.equal(readFileSync(output, 'utf8'), 'other writer');
        else assert.equal(existsSync(output), false);
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test('Plus image verifies identity and plan at click time and never replays a timed-out answer', async () => {
  const dir = mkdtempSync('C:/dev/tmp/chatgpt-plus-guard-');
  const edge = await launchProfile({ name: 'fixture', path: dir });
  try {
    const origin = 'http://image-fixture.invalid';
    const references = ['locker.png', 'pouch.png'].map(file => join(dir, file));
    for (const file of references) writeFileSync(file, Buffer.from(fixturePng, 'base64'));
    for (const mode of ['switch', 'downgrade', 'pending', 'image-refs-missing']) {
      const posted: string[] = [];
      const page = await edge.context.newPage();
      await serveImageFixture(edge.context, mode, text => posted.push(text), origin);
      await assert.rejects(runChat(page, { prompt: { id: 'image', text: 'offline image brief' },
        ...(mode === 'image-refs-missing' && { references }),
        save: () => assert.fail('must not download') }, {
        url: origin + '/', readyTimeoutMs: 2500, answerTimeoutMs: 300, pollMs: 20,
        beforeSend: async () => {
          if (mode === 'switch') await page.evaluate(async () => { await (await fetch('/backend-api/me')).text(); });
          if (mode === 'downgrade') await Promise.all([page.waitForRequest(request => request.url().endsWith(accountCheck)),
            page.evaluate(path => { void fetch(path); }, accountCheck)]);
        },
      }), mode === 'pending' ? /Assistant answer timed out/ : mode === 'switch' ? /Account changed/
        : mode === 'image-refs-missing' ? /Could not confirm all reference images/ : /plan is no longer confirmed|Personal Plus/);
      assert.equal(posted.length, mode === 'pending' ? 1 : 0);
      await edge.context.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
  } finally { await edge.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
