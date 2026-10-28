import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { launchProfile } from '../src/browser/edge.ts';
import { createProfile } from '../src/browser/profiles.ts';

function assertNoUserBookmarks(node: Record<string, unknown>): void {
  if (node.type === 'url') assert.equal(node.source, 'oem_preload', 'Fresh profiles must not import user bookmarks.');
  for (const child of (node.children ?? []) as Record<string, unknown>[]) assertNoUserBookmarks(child);
}

test('factory OEM bookmarks are allowed but nested imported bookmarks are rejected', () => {
  assertNoUserBookmarks({ type: 'folder', children: [{ type: 'url', source: 'oem_preload' }] });
  for (const source of [undefined, '', 'sync', 'user', 'unknown', 'import']) {
    assert.throws(() => assertNoUserBookmarks({ type: 'folder', source: 'oem_preload',
      children: [{ type: 'folder', children: [{ type: 'url', source }] }] }));
  }
});

test('standard persistent Edge contexts isolate and retain cookies localStorage IndexedDB and caches', async () => {
  const temporary = mkdtempSync('C:/dev/tmp/gpt-edge-isolation-');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Storage isolation fixture</title><body>Local only</body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const first = createProfile(join(temporary, 'profile collection 日本語'));
    const fresh = createProfile(join(temporary, 'profile collection 日本語'));
    for (const [profile, expected, value] of [
      [first, null, 'original'], [fresh, null, 'fresh'], [first, 'original', null], [fresh, 'fresh', null],
    ] as const) {
      const context = await launchProfile(profile);
      try {
        const page = context.pages()[0]!;
        await page.goto(origin);
        assert.deepEqual((await context.cookies(origin)).filter(cookie => cookie.name === 'identity').map(cookie => cookie.value),
          expected === null ? [] : [expected]);
        assert.deepEqual(await page.evaluate(async () => ({
          local: localStorage.getItem('identity'),
          databases: (await indexedDB.databases()).map(database => database.name),
          caches: await caches.keys(),
          cached: await caches.match('/storage').then(item => item?.text() ?? null),
        })), { local: expected, databases: expected === null ? [] : ['profile-db'],
          caches: expected === null ? [] : ['profile-cache'], cached: expected });
        if (value !== null) {
          await context.addCookies([{ name: 'identity', value, url: origin, httpOnly: true, expires: Date.now() / 1000 + 3600 }]);
          await page.evaluate(async value => {
            localStorage.setItem('identity', value);
            await (await caches.open('profile-cache')).put('/storage', new Response(value));
            await new Promise<void>((resolve, reject) => {
              const request = indexedDB.open('profile-db', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('data');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('data', 'readwrite');
                transaction.objectStore('data').put(value, 'identity');
                transaction.oncomplete = () => { database.close(); resolve(); };
                transaction.onerror = () => reject(transaction.error);
              };
            });
          }, value);
        }
      } finally { await context.close(); }
    }
    const preferences = JSON.parse(readFileSync(join(fresh.path, 'Default/Preferences'), 'utf8'));
    assert.equal(Boolean(preferences.account_info?.length), false);
    const state = JSON.parse(readFileSync(join(fresh.path, 'Local State'), 'utf8'));
    for (const entry of Object.values(state.profile.info_cache) as { user_name?: string }[]) assert.ok(!entry.user_name);
    const bookmarks = join(fresh.path, 'Default/Bookmarks');
    if (existsSync(bookmarks)) {
      for (const node of Object.values(JSON.parse(readFileSync(bookmarks, 'utf8')).roots)) {
        assertNoUserBookmarks(node as Record<string, unknown>);
      }
    }
    for (const name of ['Login Data', 'Login Data For Account', 'History']) {
      const path = join(fresh.path, 'Default', name);
      if (!existsSync(path)) continue;
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        if (name === 'History') {
          assert.ok(database.prepare('SELECT url FROM urls').all().every(row => String(row.url).startsWith(origin + '/')));
        } else {
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM logins').get()!.count, 0);
        }
      } finally { database.close(); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
