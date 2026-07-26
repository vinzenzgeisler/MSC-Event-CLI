const escapeAttribute = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const safeBasePath = (value: string): string => value === '' ||
  /^\/[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/.test(value)
  ? value
  : (() => { throw new Error('invalid approval UI base path'); })();

export const renderApprovalHtml = (
  csrfToken: string,
  basePath = '',
): string => `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <meta name="approval-csrf" content="${escapeAttribute(csrfToken)}">
  <title>MSC-Aktion freigeben</title>
  <link rel="stylesheet" href="${safeBasePath(basePath)}/assets/approval.css">
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">MSC Sicherheitsfreigabe</p>
      <h1 id="title">Aktion wird geladen</h1>
      <p id="summary" class="summary" aria-live="polite"></p>
    </header>
    <section id="meta" class="meta" aria-label="Freigabedetails"></section>
    <section>
      <h2>Vollständige Vorschau</h2>
      <dl id="changes" class="changes"></dl>
    </section>
    <p id="status" class="status" role="status" aria-live="assertive"></p>
    <div class="actions">
      <button id="reject" type="button" class="secondary">Ablehnen</button>
      <button id="approve" type="button" class="primary">Mit Passkey freigeben</button>
    </div>
    <p class="notice">Jede Entscheidung gilt nur für die oben angezeigte Aktion.</p>
  </main>
  <script src="${safeBasePath(basePath)}/assets/approval.js" defer></script>
</body>
</html>`;

export const APPROVAL_CSS = `
:root {
  color-scheme: light;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f3f5f2;
  color: #17211b;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; }
main {
  width: min(100%, 42rem);
  min-height: 100vh;
  margin: 0 auto;
  padding: max(1.25rem, env(safe-area-inset-top)) 1rem max(1.5rem, env(safe-area-inset-bottom));
  background: #fff;
}
header { border-bottom: 1px solid #d7ddd8; padding-bottom: 1rem; }
.eyebrow { margin: 0 0 .45rem; color: #4d6355; font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(1.5rem, 7vw, 2.15rem); line-height: 1.1; overflow-wrap: anywhere; }
h2 { margin: 1.4rem 0 .75rem; font-size: 1rem; }
.summary { margin: .75rem 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.meta { display: grid; gap: .55rem; margin-top: 1rem; font-size: .9rem; }
.meta p { margin: 0; overflow-wrap: anywhere; }
.changes { margin: 0; display: grid; gap: .8rem; }
.change { border: 1px solid #d7ddd8; border-radius: .75rem; padding: .8rem; background: #fafbf9; }
.change dt { font-size: .78rem; font-weight: 700; color: #4d6355; }
.change dd { margin: .35rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.status { min-height: 1.5rem; margin: 1rem 0; font-weight: 650; }
.status.error { color: #a32222; }
.actions {
  position: sticky;
  bottom: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: .65rem;
  padding: .8rem 0 max(.25rem, env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, rgba(255,255,255,0), #fff 20%);
}
button {
  min-height: 3rem;
  border-radius: .7rem;
  border: 1px solid #1c5c38;
  padding: .7rem 1rem;
  font: inherit;
  font-weight: 750;
}
button:disabled { opacity: .55; }
.primary { background: #1c5c38; color: #fff; }
.secondary { background: #fff; color: #8a2626; border-color: #bd8a8a; }
.notice { margin: .7rem 0 0; color: #5c6b61; font-size: .8rem; line-height: 1.4; }
@media (min-width: 34rem) {
  main { min-height: auto; margin-block: 2rem; border-radius: 1rem; box-shadow: 0 1rem 3rem rgba(23,33,27,.08); padding-inline: 1.5rem; }
  .actions { grid-template-columns: 1fr 1.5fr; }
}
`;

export const renderApprovalJavascript = (basePath = ''): string => `
(() => {
  'use strict';
  const basePath = ${JSON.stringify(safeBasePath(basePath))};
  const relativePath = location.pathname.slice(basePath.length);
  const parts = relativePath.split('/').filter(Boolean);
  const actionId = parts.length === 2 && parts[0] === 'approve' ? parts[1] : '';
  const csrf = document.querySelector('meta[name="approval-csrf"]')?.content ?? '';
  const title = document.getElementById('title');
  const summary = document.getElementById('summary');
  const meta = document.getElementById('meta');
  const changes = document.getElementById('changes');
  const status = document.getElementById('status');
  const approve = document.getElementById('approve');
  const reject = document.getElementById('reject');

  const text = (value) => value === null ? '–' :
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const appendText = (parent, tag, value, className) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.append(element);
    return element;
  };
  const setBusy = (busy) => {
    approve.disabled = busy;
    reject.disabled = busy;
  };
  const showStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const requestJson = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
    });
    if (!response.ok) throw new Error('request_failed');
    return response.json();
  };
  const decode = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  };
  const encode = (value) => {
    if (value === null) return null;
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  };
  const publicKeyOptions = (options) => ({
    ...options,
    challenge: decode(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      ...credential,
      id: decode(credential.id),
    })),
  });
  const serializeAssertion = (credential) => ({
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: encode(credential.response.clientDataJSON),
      authenticatorData: encode(credential.response.authenticatorData),
      signature: encode(credential.response.signature),
      userHandle: encode(credential.response.userHandle),
    },
  });
  const decide = async (decision) => {
    setBusy(true);
    showStatus('Passkey-Prüfung wird vorbereitet …');
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('passkey_unavailable');
      }
      const ceremony = await requestJson(
        basePath + '/api/approvals/' + encodeURIComponent(actionId) + '/webauthn',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ decision }),
        },
      );
      const credential = await navigator.credentials.get({
        publicKey: publicKeyOptions(ceremony.options),
      });
      if (!credential) throw new Error('passkey_cancelled');
      const result = await requestJson(
        basePath + '/api/approvals/' + encodeURIComponent(actionId) + '/decision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({
            decision,
            assertion: {
              challengeId: ceremony.challengeId,
              response: serializeAssertion(credential),
            },
          }),
        },
      );
      showStatus(
        result.status === 'approved'
          ? 'Freigabe geprüft. Die Aktion wird sicher verarbeitet.'
          : 'Aktion wurde abgelehnt.',
      );
    } catch {
      showStatus('Die Passkey-Prüfung ist fehlgeschlagen oder wurde abgebrochen.', true);
      setBusy(false);
    }
  };

  if (!actionId || !csrf) {
    showStatus('Ungültiger Freigabelink.', true);
    setBusy(true);
    return;
  }
  approve.addEventListener('click', () => void decide('approve'));
  reject.addEventListener('click', () => void decide('reject'));
  requestJson(basePath + '/api/approvals/' + encodeURIComponent(actionId))
    .then((model) => {
      title.textContent = model.preview.title;
      summary.textContent = model.preview.summary;
      appendText(meta, 'p', 'Ziel: ' + model.preview.target);
      appendText(meta, 'p', 'Risiko: ' + model.preview.risk);
      appendText(meta, 'p', 'Gültig bis: ' + new Date(model.expiresAt).toLocaleString());
      for (const change of model.preview.changes) {
        const wrapper = document.createElement('div');
        wrapper.className = 'change';
        appendText(wrapper, 'dt', change.field);
        appendText(wrapper, 'dd', text(change.after));
        changes.append(wrapper);
      }
      showStatus('Vorschau vollständig geladen.');
    })
    .catch(() => {
      showStatus('Die Aktion ist unbekannt, abgelaufen oder nicht für dich bestimmt.', true);
      setBusy(true);
    });
})();
`;

export const APPROVAL_JAVASCRIPT = renderApprovalJavascript();
