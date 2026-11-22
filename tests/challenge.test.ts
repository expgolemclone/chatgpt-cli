import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { AccessBlockedError, CloudflareChallengeError, assertAccess, observeAccount, type ChallengeEvent } from '../src/browser/account.ts';
import { runChat } from '../src/chat.ts';

const challengeLimit = (error: unknown) => error instanceof CloudflareChallengeError && /5 consecutive times/.test(error.message);

function observedPage() {
  const frame = {};
  const locator = {
    or() { return this; }, filter() { return this; }, first() { return this; },
    async evaluateAll() { return []; },
  };
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    isClosed: () => false, mainFrame: () => frame, frames: () => [], title: async () => 'ChatGPT',
    getByText: () => locator, getByRole: () => locator, getByTestId: () => locator, locator: () => locator,
  }) as unknown as Page;
  const events: ChallengeEvent[] = [];
  const observation = observeAccount(page, 'https://chatgpt.com', event => events.push(event));
  const respond = (path = '/', status = 403, challenge = true) => emitter.emit('response', {
    url: () => new URL(path, 'https://chatgpt.com').href,
    request: () => ({ isNavigationRequest: () => path.startsWith('/') && new URL(path, 'https://chatgpt.com').pathname === '/' }),
    frame: () => frame, status: () => status, ok: () => status >= 200 && status < 300,
    headers: () => challenge ? { 'cf-mitigated': 'challenge' } : {}, json: async () => ({}),
  });
  return { page, respond, events, ...observation };
}

test('Cloudflare streaks count responses, not polls, and stop on the fifth response', async () => {
  const { page, account, respond, events, dispose } = observedPage();
  try {
    for (let count = 0; count < 4; count++) respond();
    await assert.rejects(assertAccess(page, account, { pollMs: 1, challengeTimeoutMs: 20 }),
      (error: unknown) => error instanceof CloudflareChallengeError && /timed out/.test(error.message));
    assert.equal(account.challengeLimit, undefined);
    respond();
    assert.equal(events.length, 5);
    await assert.rejects(assertAccess(page, account), challengeLimit);
    respond('/', 200, false);
    await assert.rejects(assertAccess(page, account), challengeLimit, 'The fifth response stops the batch even if access clears.');
  } finally { dispose(); }
});

test('normal document or API recovery resets the consecutive Cloudflare count', async () => {
  for (const path of ['/', '/backend-api/me', '/backend-api/accounts/check/test',
    '/backend-api/f/conversation', '/backend-api/sentinel/test']) {
    const { page, account, respond, dispose } = observedPage();
    try {
      for (let count = 0; count < 4; count++) respond(path);
      respond(path, 200, false);
      for (let count = 0; count < 4; count++) respond(path);
      assert.equal(account.challengeLimit, undefined, path);
      respond(path);
      await assert.rejects(assertAccess(page, account), challengeLimit, path);
    } finally { dispose(); }
  }
});

test('unrelated successes and partial recovery do not reset an unresolved Cloudflare streak', async () => {
  const { page, account, respond, dispose } = observedPage();
  try {
    respond('/backend-api/me');
    for (let count = 0; count < 3; count++) respond('/backend-api/accounts/check/test');
    respond('/backend-api/me', 200, false);
    respond('/asset.js', 200, false);
    for (let count = 0; count < 5; count++) respond('https://other.test/backend-api/me');
    assert.equal(account.challengeLimit, undefined);
    respond('/backend-api/accounts/check/test');
    await assert.rejects(assertAccess(page, account), challengeLimit);
    respond('/backend-api/f/conversation', 429, false);
    await assert.rejects(assertAccess(page, account), (error: unknown) =>
      error instanceof AccessBlockedError && /HTTP 429/.test(error.message));
  } finally { dispose(); }
});

test('Cloudflare streaks are isolated between accounts', async () => {
  const first = observedPage();
  const second = observedPage();
  try {
    for (let count = 0; count < 4; count++) first.respond();
    second.respond();
    assert.equal(first.account.challengeLimit, undefined);
    assert.equal(second.account.challengeLimit, undefined);
    first.respond();
    await assert.rejects(assertAccess(first.page, first.account), challengeLimit);
    second.respond('/', 200, false);
    assert.equal(await assertAccess(second.page, second.account), 0);
  } finally { first.dispose(); second.dispose(); }
});

test('a navigation failure after the fifth Cloudflare response preserves the access block', async () => {
  const { page, respond, dispose } = observedPage();
  dispose();
  page.goto = async () => {
    for (let count = 0; count < 5; count++) respond();
    throw new Error('Navigation interrupted by Cloudflare');
  };
  await assert.rejects(runChat(page, []), challengeLimit);
});

test('a tab closing during readiness does not hide an unresolved access challenge', async () => {
  const { page, respond, dispose } = observedPage();
  dispose();
  page.goto = async () => { respond('/backend-api/me'); return null; };
  page.isClosed = () => true;
  await assert.rejects(runChat(page, [{ id: 'test', text: 'test' }]), (error: unknown) =>
    error instanceof CloudflareChallengeError && /prevented readiness/.test(error.message));
});

