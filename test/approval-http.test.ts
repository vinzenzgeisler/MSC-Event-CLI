import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { ApprovalHttpContract } from '../src/approval-http.js';
import {
  ApprovalQueue,
  type ActionIntent,
  type FreshAuthContext,
  type FreshAuthVerifier,
} from '../src/approval.js';
import { MailSendPreviewRenderer } from '../src/mail-approved-action.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'mail.send',
  summary: 'Reviewed MSC test email',
  target: { type: 'mailbox', id: 'msc-info', label: 'MSC Info' },
  before: null,
  after: {
    account: 'msc-info',
    from: 'info@msc-oberlausitzer-dreilaendereck.eu',
    to: 'recipient@example.invalid',
    subject: 'Test',
    bodyText: 'Test body',
  },
  expectedState: {
    policyVersion: 1,
    account: 'msc-info',
    senderIdentity: 'info@msc-oberlausitzer-dreilaendereck.eu',
    allowedFolders: ['INBOX'],
  },
  parameters: {
    dryRun: true,
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/faq.md'],
    uncertainties: [],
  },
};

const session = { actor: 'vinzenz', csrfToken: 'csrf-secret-value' };
const origin = 'https://approval.example.invalid';

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-approval-http-'));
  const assertions = new Map<string, { actor: string; context: FreshAuthContext }>();
  const verifier: FreshAuthVerifier = {
    async verify(value, context) {
      const assertion = assertions.get(String(value));
      if (!assertion) throw new Error('invalid assertion');
      assertions.delete(String(value));
      assert.deepEqual(assertion.context, context);
      return {
        actor: assertion.actor,
        authenticatedAt: '2026-07-23T15:00:00.000Z',
        method: 'passkey',
        assertionId: String(value),
      };
    },
  };
  const queue = new ApprovalQueue({
    storePath: join(directory, 'queue.json'),
    auditPath: join(directory, 'audit.jsonl'),
    signingKey: Buffer.alloc(32, 8),
    freshAuthVerifier: verifier,
    now: () => new Date('2026-07-23T15:00:00.000Z'),
  });
  const begun: Array<{ actor: string; context: FreshAuthContext }> = [];
  const contract = new ApprovalHttpContract({
    publicOrigin: origin,
    queue,
    renderers: [new MailSendPreviewRenderer()],
    async authorizeReviewer(actor) {
      return actor === 'vinzenz';
    },
    async beginFreshAuth(actor, context) {
      begun.push({ actor, context });
      return {
        challengeId: 'challenge-1',
        options: {
          challenge: 'challenge',
          timeout: 120_000,
          rpId: 'approval.example.invalid',
          allowCredentials: [],
          userVerification: 'required',
        } as PublicKeyCredentialRequestOptionsJSON,
        expiresAt: '2026-07-23T15:02:00.000Z',
      };
    },
  });
  const record = await queue.propose(intent, 'http-test');
  const mutationRequest = (path: string, body: unknown, csrf = session.csrfToken) =>
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify(body),
    });
  return { queue, contract, record, assertions, begun, mutationRequest };
};

test('creates an opaque authenticated mobile page and returns a no-store complete preview API', async () => {
  const { contract, record } = await fixture();
  assert.equal(contract.approvalUrl(record.actionId), `${origin}/approve/${record.actionId}`);
  const page = await contract.handle(
    new Request(contract.approvalUrl(record.actionId)),
    session,
  );
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'no-store, max-age=0');
  assert.match(await page.text(), /viewport-fit=cover/);

  const model = await contract.handle(
    new Request(`${origin}/api/approvals/${record.actionId}`),
    session,
  );
  const body = await model.json() as {
    actionId: string;
    payloadHash: string;
    preview: { changes: Array<{ field: string }> };
  };
  assert.equal(body.actionId, record.actionId);
  assert.equal(body.payloadHash, record.payloadHash);
  assert.ok(body.preview.changes.some((change) => change.field === 'Nachricht'));

  const script = await contract.handle(
    new Request(`${origin}/assets/approval.js`),
    session,
  );
  const javascript = await script.text();
  assert.match(javascript, /navigator\.credentials\.get/);
  assert.doesNotMatch(javascript, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('binds WebAuthn begin and completion to server session, action and decision', async () => {
  const { contract, record, assertions, begun, mutationRequest } = await fixture();
  const begin = await contract.handle(
    mutationRequest(`/api/approvals/${record.actionId}/webauthn`, {
      decision: 'approve',
    }),
    session,
  );
  assert.equal(begin.status, 200);
  assert.deepEqual(begun, [{
    actor: session.actor,
    context: {
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      decision: 'approve',
    },
  }]);

  assertions.set('assertion-1', {
    actor: session.actor,
    context: begun[0]!.context,
  });
  const decision = await contract.handle(
    mutationRequest(`/api/approvals/${record.actionId}/decision`, {
      decision: 'approve',
      assertion: 'assertion-1',
    }),
    session,
  );
  assert.equal(decision.status, 200);
  assert.deepEqual(await decision.json(), {
    actionId: record.actionId,
    status: 'approved',
    executionAvailable: false,
  });
  assert.equal((await contract.handle(
    new Request(contract.approvalUrl(record.actionId)),
    session,
  )).status, 400);
});

test('fails closed without session, exact origin, CSRF token or matching passkey actor', async () => {
  const { contract, record, assertions, begun, mutationRequest } = await fixture();
  assert.equal((await contract.handle(
    new Request(contract.approvalUrl(record.actionId)),
  )).status, 401);
  assert.equal((await contract.handle(
    mutationRequest(`/api/approvals/${record.actionId}/webauthn`, {
      decision: 'approve',
    }, 'wrong'),
    session,
  )).status, 400);
  assert.equal((await contract.handle(
    new Request(`https://attacker.example/approve/${record.actionId}`),
    session,
  )).status, 400);
  assert.equal((await contract.handle(
    new Request(contract.approvalUrl(record.actionId)),
    { actor: 'someone-else', csrfToken: session.csrfToken },
  )).status, 400);

  const begin = await contract.handle(
    mutationRequest(`/api/approvals/${record.actionId}/webauthn`, {
      decision: 'approve',
    }),
    session,
  );
  assert.equal(begin.status, 200);
  assertions.set('other-actor', {
    actor: 'someone-else',
    context: begun[0]!.context,
  });
  assert.equal((await contract.handle(
    mutationRequest(`/api/approvals/${record.actionId}/decision`, {
      decision: 'approve',
      assertion: 'other-actor',
    }),
    session,
  )).status, 400);
});

test('serves the complete contract below a non-reserved production base path', async () => {
  const { queue, record } = await fixture();
  const contract = new ApprovalHttpContract({
    publicOrigin: origin,
    basePath: '/msc-approval',
    queue,
    renderers: [new MailSendPreviewRenderer()],
    async authorizeReviewer(actor) {
      return actor === 'vinzenz';
    },
    async beginFreshAuth() {
      throw new Error('not used');
    },
  });
  assert.equal(
    contract.approvalUrl(record.actionId),
    `${origin}/msc-approval/approve/${record.actionId}`,
  );
  const page = await contract.handle(
    new Request(contract.approvalUrl(record.actionId)),
    session,
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="\/msc-approval\/assets\/approval\.css"/);
  assert.match(html, /src="\/msc-approval\/assets\/approval\.js"/);
  const script = await contract.handle(
    new Request(`${origin}/msc-approval/assets/approval.js`),
    session,
  );
  assert.equal(script.status, 200);
  assert.match(await script.text(), /const basePath = "\/msc-approval"/);
  assert.equal((await contract.handle(
    new Request(`${origin}/approve/${record.actionId}`),
    session,
  )).status, 404);
  assert.throws(() => new ApprovalHttpContract({
    publicOrigin: origin,
    basePath: '/msc-approval/',
    queue,
    renderers: [],
    async authorizeReviewer() {
      return true;
    },
    async beginFreshAuth() {
      throw new Error('not used');
    },
  }), /basePath/);
});
