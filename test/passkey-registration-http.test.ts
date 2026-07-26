import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedApprovalSession } from '../src/approval-http.js';
import { PasskeyRegistrationHttpContract } from '../src/passkey-registration-http.js';
import type { WebAuthnRegistrationService } from '../src/webauthn-registration.js';

const origin = 'https://openclaw.example';
const basePath = '/msc-approval';
const session: AuthenticatedApprovalSession = {
  actor: 'vinzenz',
  csrfToken: 'server-derived-csrf',
};

test('serves authenticated passkey registration below the production base path', async () => {
  const calls: unknown[] = [];
  const registration = {
    async begin(actor: string, displayName: string, authorization: unknown) {
      calls.push({ actor, displayName, authorization });
      return {
        challengeId: 'challenge-id',
        options: { challenge: 'challenge' },
        expiresAt: '2030-01-01T00:00:00.000Z',
      };
    },
    async complete(value: unknown) {
      calls.push(value);
      return { credentialId: 'credential-reference-longer-than-twelve' };
    },
  } as unknown as WebAuthnRegistrationService;
  const contract = new PasskeyRegistrationHttpContract(
    origin,
    basePath,
    registration,
  );

  const page = await contract.handle(
    new Request(`${origin}${basePath}/register`),
    session,
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /MSC-Passkey einrichten/);
  assert.match(html, /server-derived-csrf/);
  assert.match(html, /\/msc-approval\/assets\/register\.js/);

  const begun = await contract.handle(new Request(
    `${origin}${basePath}/api/registration/begin`,
    {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({ code: 'one-time-code' }),
    },
  ), session);
  assert.equal(begun.status, 200);
  assert.deepEqual(calls[0], {
    actor: 'vinzenz',
    displayName: 'vinzenz',
    authorization: { type: 'bootstrap', code: 'one-time-code' },
  });

  const completed = await contract.handle(new Request(
    `${origin}${basePath}/api/registration/complete`,
    {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        challengeId: 'challenge-id',
        response: { id: 'credential' },
      }),
    },
  ), session);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), {
    status: 'registered',
    credentialReference: 'credential-r',
  });
});

test('registration fails closed without session, same origin or CSRF', async () => {
  let calls = 0;
  const registration = {
    async begin() {
      calls += 1;
    },
  } as unknown as WebAuthnRegistrationService;
  const contract = new PasskeyRegistrationHttpContract(
    origin,
    basePath,
    registration,
  );
  const url = `${origin}${basePath}/api/registration/begin`;
  assert.equal((await contract.handle(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"code":"test"}',
  }))).status, 401);
  assert.equal((await contract.handle(new Request(url, {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example',
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
    },
    body: '{"code":"test"}',
  }), session)).status, 400);
  assert.equal((await contract.handle(new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-csrf-token': 'wrong',
    },
    body: '{"code":"test"}',
  }), session)).status, 400);
  assert.equal(calls, 0);
});
