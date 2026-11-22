import type { BrowserContext } from 'playwright';
import { setTimeout } from 'node:timers/promises';
import { accountCheck, challengeFixture, fixture, fixturePng } from './chat.ts';

function savedReply(text: string, mode: string): string {
  const bytes = Buffer.from(fixturePng, 'base64');
  if (mode === 'invalid') bytes[44] = bytes[44]! ^ 1; // Corrupt IDAT, keep the signature and IEND.
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><button>Download image</button><main data-talvt-turn-state="complete">
    <div data-user-message-bubble>${escape(mode === 'changed-reply' ? 'A different brief' : text)}</div>
    ${mode === 'text' ? '<h4 data-conversation-role="assistant">Text reply</h4>' : `<div data-testid="generated-image-gallery">
      <button data-testid="generated-image-preview" onclick="document.querySelector('dialog').showModal()"><img alt="Generated image" src="data:image/png;base64,${fixturePng}"></button>
    </div>`}</main>
    <dialog><a download="fixture.png" href="data:image/png;base64,${bytes.toString('base64')}">Download image</a></dialog>
    <script>fetch('/backend-api/me'); fetch('${accountCheck}');</script>`;
}

/** All page requests are local fixtures, including the download. No requests are forwarded. */
export async function serveImageFixture(context: BrowserContext, mode: string, submitted: (text: string) => void, origin = 'https://chatgpt.com'): Promise<void> {
  let plans = 0, identities = 0;
  let saved: string | undefined;
  const cloudflare = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
  // Four fixture responses plus the challenged navigation or submission hit the streak limit.
  const sentinelRequests = `for (let i = 0; i < 4; i++) void fetch('/backend-api/sentinel/fixture?i=' + i);`;
  const html = fixture(mode === 'login' || mode === 'draft' ? mode : mode === 'pending' ? 'image-pending'
    : mode === 'text' ? 'normal' : mode === 'invalid' ? 'image-invalid-download' : mode.startsWith('image-refs') ? mode : 'image-download');
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/backend-api/me') return route.fulfill({ status: mode === 'login' ? 401 : 200,
      json: { email: mode === 'wrong' || (++identities > 1 && (mode === 'switch' || mode === 'saved-switch')) ? 'other@example.test' : 'plus@example.test' } });
    if (url.pathname === accountCheck) {
      const changed = ++plans > 1 && mode === 'downgrade';
      if (changed) await setTimeout(500); // A pending refresh must invalidate the earlier Plus response.
      return route.fulfill({ json: { accounts: { default: { account: { structure: 'personal', is_deactivated: false,
        plan_type: mode === 'free' || changed ? 'free' : 'plus' } } } } });
    }
    if (url.pathname === '/backend-api/sentinel/fixture') return route.fulfill(cloudflare);
    if (url.pathname === '/backend-api/f/conversation' && request.method() === 'POST') {
      const body = request.postData() ?? '';
      submitted(body);
      saved = mode.startsWith('image-refs') ? JSON.parse(body).text : body;
      if (mode === 'submission-cloudflare') return route.fulfill(cloudflare);
      return route.fulfill({ status: mode === 'quota' ? 429 : 200, body: 'fixture' });
    }
    if (url.pathname === '/c/fixture-conversation' && request.isNavigationRequest() && request.method() === 'GET' && saved !== undefined) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: savedReply(saved, mode) });
    }
    if (url.pathname === '/' && request.isNavigationRequest()) {
      const contentType = 'text/html; charset=utf-8';
      if (mode === 'blocked') return route.fulfill({ status: 403, body: 'Forbidden' });
      if (mode === 'cloudflare') return route.fulfill({ ...cloudflare, contentType,
        body: `${challengeFixture()}<script>${sentinelRequests}</script>` });
      const body = mode === 'submission-cloudflare' ? `${html}<script>
        document.querySelector('form button').addEventListener('click', () => { ${sentinelRequests} });
      </script>` : html;
      return route.fulfill({ contentType, body });
    }
    return route.abort();
  });
}
