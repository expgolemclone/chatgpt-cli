import type { BrowserContext } from 'playwright';
import { setTimeout } from 'node:timers/promises';
import { accountCheck, fixture } from './chat.ts';

/** All page requests are local fixtures, including the download. No requests are forwarded. */
export async function serveImageFixture(context: BrowserContext, mode: string, submitted: (text: string) => void, origin = 'https://chatgpt.com'): Promise<void> {
  let plans = 0, identities = 0;
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
    if (url.pathname === '/backend-api/f/conversation' && request.method() === 'POST') {
      submitted(request.postData() ?? '');
      return route.fulfill({ status: mode === 'quota' ? 429 : 200, body: 'fixture' });
    }
    if (url.pathname === '/' && request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    return route.abort();
  });
}
