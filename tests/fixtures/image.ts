import type { BrowserContext } from 'playwright';
import { setTimeout } from 'node:timers/promises';
import { accountCheck, challengeFixture, fixture } from './chat.ts';

/** All page requests are local fixtures, including the download. No requests are forwarded. */
export async function serveImageFixture(context: BrowserContext, mode: string, submitted: (text: string) => void, origin = 'https://chatgpt.com'): Promise<void> {
  let plans = 0, identities = 0;
  const cloudflare = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
  // Four fixture responses plus the challenged navigation or submission hit the streak limit.
  const sentinelRequests = `for (let i = 0; i < 4; i++) void fetch('/backend-api/sentinel/fixture?i=' + i);`;
  const html = fixture(mode === 'login' || mode === 'draft' ? mode : mode === 'pending' ? 'image-pending'
    : mode === 'text' ? 'normal' : mode === 'invalid' ? 'image-invalid-download' : mode.startsWith('image-refs') ? mode : 'image-download');
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/backend-api/me') return route.fulfill({ status: mode === 'login' ? 401 : 200,
      json: { email: mode === 'wrong' || (++identities > 1 && mode === 'switch') ? 'other@example.test' : 'plus@example.test' } });
    if (url.pathname === accountCheck) {
      const changed = ++plans > 1 && mode === 'downgrade';
      if (changed) await setTimeout(500); // A pending refresh must invalidate the earlier Plus response.
      return route.fulfill({ json: { accounts: { default: { account: { structure: 'personal', is_deactivated: false,
        plan_type: mode === 'free' || changed ? 'free' : 'plus' } } } } });
    }
    if (url.pathname === '/backend-api/sentinel/fixture') return route.fulfill(cloudflare);
    if (url.pathname === '/backend-api/f/conversation' && request.method() === 'POST') {
      submitted(request.postData() ?? '');
      if (mode === 'submission-cloudflare') return route.fulfill(cloudflare);
      return route.fulfill({ status: mode === 'quota' ? 429 : 200, body: 'fixture' });
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
