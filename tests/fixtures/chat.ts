export const accountCheck = '/backend-api/accounts/check/v4-2023-04-27';
export const featurePath = '/backend-api/bazaar/obi/sync-token';

export function challengeFixture(delayMs?: number): string {
  return `<!doctype html><title>Just a moment...</title><body>Verify you are human.
    ${delayMs === undefined ? '' : `<script>setTimeout(() => location.replace('/?challenge=cleared'), ${delayMs});</script>`}
  </body>`;
}

export function fixture(mode: string): string {
  return `<!doctype html><html><head><title>Local chat fixture</title></head><body>
  ${['login', 'conflicting-login'].includes(mode) ? '<button>ログイン</button>' : mode === 'collapsed' ? '' : mode === 'modern'
    ? '<button aria-label="プロフィールメニューを開く">プロフィールを読み込み中</button><button aria-label="プロフィールメニューを開く"></button>'
    : `<button data-testid="accounts-profile-button">${mode === 'plan-plus-ui-free' ? 'Free' : mode === 'plan-free-ui-plus' ? 'Plus' : 'Account'}</button>`}
  ${mode === 'modern' ? '<div id="prompt-textarea" contenteditable="true" style="display:none"></div>' : ''}
  <div ${mode === 'modern' ? '' : 'id="prompt-textarea"'} contenteditable="true" role="textbox" aria-label="ChatGPT に聞く">${mode === 'draft' ? 'Existing draft' : ''}</div>
  <button aria-label="送信" disabled>Send</button>
  <main></main>
  <script>
    const mode = ${JSON.stringify(mode)};
    if (mode !== 'identity-missing') fetch('/backend-api/me');
    if (mode !== 'plan-missing') fetch('${accountCheck}?timezone_offset_min=0');
    if (['identity-challenge', 'multiple-challenges'].includes(mode)) setTimeout(() => fetch('/backend-api/me'), 600);
    if (['plan-challenge', 'multiple-challenges'].includes(mode)) {
      setTimeout(() => fetch('${accountCheck}'), mode === 'multiple-challenges' ? 150 : 600);
    }
    if (mode === 'feature-failure') fetch('${featurePath}');
    const composer = document.querySelector('[role="textbox"]');
    if (mode === 'modern') composer.addEventListener('input', () => {
      const paragraphs = composer.innerText.split('\\n').map(line => {
        const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph;
      });
      composer.replaceChildren(...paragraphs);
    });
    const send = document.querySelector('[aria-label="送信"]');
    composer.addEventListener('input', () => {
      if (mode !== 'send-disabled') setTimeout(() => { send.disabled = false; }, mode === 'delayed-send' ? 150 : 0);
    });
    let inFlight = false;
    send.addEventListener('click', async () => {
      if (inFlight) throw new Error('A second prompt arrived before the answer completed.');
      inFlight = true;
      send.disabled = true;
      const text = composer.innerText;
      if (mode === 'feature-failure') await fetch('${featurePath}');
      const submission = fetch('/backend-api/f/conversation', {method: 'POST', body: text});
      if (mode === 'no-dom-ack') return;
      const turn = document.createElement('div');
      turn.dataset.talvtTurnState = 'streaming';
      const user = document.createElement('div');
      user.dataset.userMessageBubble = 'true';
      user.textContent = text;
      turn.append(user);
      document.querySelector('main').append(turn);
      composer.textContent = '';
      const stop = document.createElement('button');
      stop.dataset.testid = 'stop-button';
      stop.setAttribute('aria-label', 'Stop generating');
      document.body.append(stop);
      const response = await submission;
      if (!response.ok) return;
      if (mode === 'no-answer') {
        turn.dataset.talvtTurnState = 'complete';
        stop.remove();
        return;
      }
      const assistant = document.createElement('h4');
      assistant.dataset.conversationRole = 'assistant';
      assistant.textContent = 'ChatGPT:';
      turn.append(assistant);
      if (mode === 'partial-answer') { stop.remove(); return; }
      if (mode === 'generating') return;
      await response.text();
      await new Promise(resolve => setTimeout(resolve, mode === 'delayed-answer' ? 200 : 40));
      if (mode === 'image-only') {
        turn.insertAdjacentHTML('beforeend',
          '<button data-testid="generated-image-preview"><img alt="生成画像1" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E"></button>');
      } else {
        const answer = document.createElement('p');
        answer.textContent = mode === 'quoted-access-text'
          ? "You've reached the usage limit. Verify you are human." : 'Local fixture answer';
        turn.append(answer);
      }
      if (mode === 'identity-expires') await (await fetch('/backend-api/me')).text();
      if (mode === 'plan-expires') await (await fetch('${accountCheck}')).text();
      if (mode === 'limit') document.body.append("You've reached the usage limit");
      turn.dataset.talvtTurnState = 'complete';
      if (mode === 'complete-while-stopping') return;
      stop.remove();
      inFlight = false;
      history.replaceState({}, '', '/c/fixture-conversation');
    });
  </script></body></html>`;
}

