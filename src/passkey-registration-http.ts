import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedApprovalSession } from './approval-http.js';
import type { WebAuthnRegistrationService } from './webauthn-registration.js';

const response = (
  status: number,
  body: string,
  contentType: string,
  csp = "default-src 'none'; frame-ancestors 'none'",
): Response => new Response(body, {
  status,
  headers: {
    'content-type': contentType,
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
  },
});

const json = (status: number, body: unknown): Response =>
  response(status, JSON.stringify(body), 'application/json; charset=utf-8');

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const registrationHtml = (basePath: string, csrf: string): string => `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="approval-csrf" content="${csrf.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">
  <title>MSC-Passkey einrichten</title>
  <link rel="stylesheet" href="${basePath}/assets/approval.css">
</head>
<body>
  <main>
    <p class="eyebrow">Einmalige Einrichtung</p>
    <h1>MSC-Passkey einrichten</h1>
    <p class="summary">Gib den kurzlebigen Code aus dem lokalen Bootstrap-Befehl ein.</p>
    <label for="code">Bootstrap-Code</label>
    <input id="code" type="password" autocomplete="one-time-code">
    <p id="status" class="status" role="status"></p>
    <button id="register" type="button" class="primary">Passkey erstellen</button>
  </main>
  <script src="${basePath}/assets/register.js" defer></script>
</body>
</html>`;

const registrationJavascript = (basePath: string): string => `
(() => {
  'use strict';
  const basePath = ${JSON.stringify(basePath)};
  const csrf = document.querySelector('meta[name="approval-csrf"]')?.content ?? '';
  const code = document.getElementById('code');
  const button = document.getElementById('register');
  const status = document.getElementById('status');
  const decode = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  };
  const encode = (value) => {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  };
  const request = async (path, body) => {
    const result = await fetch(basePath + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'content-type': 'application/json', 'x-csrf-token': csrf},
      body: JSON.stringify(body),
    });
    if (!result.ok) throw new Error('request_failed');
    return result.json();
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Passkey-Einrichtung wird vorbereitet …';
    try {
      const begun = await request('/api/registration/begin', {code: code.value});
      const options = {
        ...begun.options,
        challenge: decode(begun.options.challenge),
        user: {...begun.options.user, id: decode(begun.options.user.id)},
        excludeCredentials: (begun.options.excludeCredentials ?? []).map(
          (item) => ({...item, id: decode(item.id)}),
        ),
      };
      const credential = await navigator.credentials.create({publicKey: options});
      if (!credential) throw new Error('registration_cancelled');
      const result = await request('/api/registration/complete', {
        challengeId: begun.challengeId,
        response: {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            clientDataJSON: encode(credential.response.clientDataJSON),
            attestationObject: encode(credential.response.attestationObject),
            transports: credential.response.getTransports?.() ?? [],
          },
        },
      });
      code.value = '';
      status.textContent = result.status === 'registered'
        ? 'Passkey wurde eingerichtet.'
        : 'Einrichtung fehlgeschlagen.';
    } catch {
      status.textContent = 'Passkey-Einrichtung fehlgeschlagen oder abgebrochen.';
      status.classList.add('error');
      button.disabled = false;
    }
  });
})();
`;

export class PasskeyRegistrationHttpContract {
  constructor(
    private readonly publicOrigin: string,
    private readonly basePath: string,
    private readonly registration: WebAuthnRegistrationService,
  ) {}

  async handle(
    request: Request,
    session?: AuthenticatedApprovalSession,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== this.publicOrigin || url.search ||
          !session?.actor.trim() || !session.csrfToken) {
        return json(401, { error: 'authentication_required' });
      }
      if (request.method === 'GET' &&
          url.pathname === `${this.basePath}/register`) {
        return response(
          200,
          registrationHtml(this.basePath, session.csrfToken),
          'text/html; charset=utf-8',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
      }
      if (request.method === 'GET' &&
          url.pathname === `${this.basePath}/assets/register.js`) {
        return response(
          200,
          registrationJavascript(this.basePath),
          'text/javascript; charset=utf-8',
        );
      }
      if (request.method === 'POST' &&
          url.pathname === `${this.basePath}/api/registration/begin`) {
        this.assertMutation(request, session);
        const body = z.object({ code: z.string().min(1).max(200) }).strict()
          .parse(await request.json());
        return json(200, await this.registration.begin(
          session.actor,
          session.actor,
          { type: 'bootstrap', code: body.code },
        ));
      }
      if (request.method === 'POST' &&
          url.pathname === `${this.basePath}/api/registration/complete`) {
        this.assertMutation(request, session);
        const credential = await this.registration.complete(await request.json());
        return json(200, {
          status: 'registered',
          credentialReference: credential.credentialId.slice(0, 12),
        });
      }
      return json(404, { error: 'not_found' });
    } catch {
      return json(400, { error: 'invalid_request' });
    }
  }

  private assertMutation(
    request: Request,
    session: AuthenticatedApprovalSession,
  ): void {
    if (request.headers.get('origin') !== this.publicOrigin ||
        !request.headers.get('content-type')?.toLowerCase()
          .startsWith('application/json')) {
      throw new Error('same-origin JSON required');
    }
    const csrf = request.headers.get('x-csrf-token');
    if (!csrf || !equal(csrf, session.csrfToken)) {
      throw new Error('CSRF token mismatch');
    }
  }
}
