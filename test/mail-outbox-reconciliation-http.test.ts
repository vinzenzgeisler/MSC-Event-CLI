import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashActionIntent } from '../src/approval.js';
import { SqliteDurableOutbox } from '../src/durable-outbox.js';
import {
  MailOutboxReconciliationHttpContract,
} from '../src/mail-outbox-reconciliation-http.js';
import {
  MailOutboxReconciliationService,
  type ReconciliationAuthContext,
  type ReconciliationFreshAuth,
} from '../src/mail-outbox-reconciliation.js';
import {
  createMailSendIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';

const origin = 'https://approval.example.invalid';
const session = { actor: 'vinzenz', csrfToken: 'csrf-secret-value' };
const evidence = {
  source: 'provider-search' as const,
  referenceHash: 'b'.repeat(64),
  conclusionCode: 'provider-search-confirms-absent',
};
const policy: MscMailAccountPolicy = {
  version: 1,
  accounts: {
    'msc-nennung': {
      active: true,
      senderIdentity: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Nennung',
      allowedFolders: ['INBOX'],
    },
    'msc-info': {
      active: true,
      senderIdentity: 'info@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Info',
      allowedFolders: ['INBOX'],
    },
    'msc-vorstand': {
      active: true,
      senderIdentity: 'admin@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Vorstand',
      allowedFolders: ['INBOX'],
    },
  },
};
const intent = createMailSendIntent(policy, {
  account: 'msc-info',
  to: 'recipient@example.invalid',
  subject: 'Must not appear in reconciliation API',
  bodyText: 'Private body must remain encrypted.',
  triageStatus: 'READY_TO_DRAFT',
  sources: ['msc/faq.md'],
  uncertainties: [],
});

const fixture = () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'msc-reconciliation-http-')),
    'outbox.sqlite',
  );
  const outbox = new SqliteDurableOutbox(path, {
    encryptionKey: Buffer.alloc(32, 91),
  });
  const actionId = 'reconciliation-http-action';
  outbox.enqueue({
    actionId,
    payloadHash: hashActionIntent(intent),
    kind: intent.kind,
    payload: JSON.parse(JSON.stringify(intent)),
    createdAt: '2026-07-25T21:30:00.000Z',
  });
  const claimed = outbox.claim(
    actionId,
    'fake-worker',
    '2026-07-25T21:30:01.000Z',
  );
  outbox.markUncertain(
    actionId,
    claimed.attemptId!,
    '2026-07-25T21:30:02.000Z',
    'acknowledgement-timeout',
  );
  const contexts: ReconciliationAuthContext[] = [];
  const assertions = new Map<string, ReconciliationAuthContext>();
  const freshAuth: ReconciliationFreshAuth = {
    async begin(actor, context) {
      assert.equal(actor, session.actor);
      contexts.push(structuredClone(context));
      return {
        challengeId: 'reconciliation-challenge',
        options: {
          challenge: 'challenge',
          timeout: 120_000,
          rpId: 'approval.example.invalid',
          allowCredentials: [],
          userVerification: 'required',
        },
        expiresAt: '2026-07-25T21:33:00.000Z',
      };
    },
    async verify(assertion, context) {
      const expected = assertions.get(String(assertion));
      if (!expected) throw new Error('unknown assertion');
      assertions.delete(String(assertion));
      assert.deepEqual(context, expected);
      return {
        reviewer: session.actor,
        authenticatedAt: '2026-07-25T21:31:00.000Z',
        authenticationMethod: 'passkey',
        assertionId: String(assertion),
      };
    },
  };
  const service = new MailOutboxReconciliationService(outbox, freshAuth, {
    now: () => new Date('2026-07-25T21:31:00.000Z'),
  });
  const contract = new MailOutboxReconciliationHttpContract({
    publicOrigin: origin,
    service,
    freshAuth,
    async authorizeReviewer(actor) {
      return actor === session.actor;
    },
  });
  const basePath = `/api/outbox-reconciliations/${actionId}/${claimed.attemptId}`;
  const mutationRequest = (
    suffix: string,
    body: unknown,
    csrf = session.csrfToken,
  ) => new Request(`${origin}${basePath}${suffix}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
  return {
    outbox,
    contract,
    actionId,
    attemptId: claimed.attemptId!,
    basePath,
    mutationRequest,
    contexts,
    assertions,
  };
};

test('shows only bounded metadata for the exact ambiguous attempt', async (t) => {
  const value = fixture();
  t.after(() => value.outbox.close());
  const response = await value.contract.handle(
    new Request(`${origin}${value.basePath}`),
    session,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const text = await response.text();
  const model = JSON.parse(text) as {
    actionId: string;
    attemptId: string;
    status: string;
    uncertaintyCode: string;
    decisions: string[];
  };
  assert.equal(model.actionId, value.actionId);
  assert.equal(model.attemptId, value.attemptId);
  assert.equal(model.status, 'uncertain');
  assert.equal(model.uncertaintyCode, 'acknowledgement-timeout');
  assert.deepEqual(model.decisions, ['accepted', 'not-accepted']);
  assert.doesNotMatch(text, /recipient@example|Private body|Must not appear/);
});

test('binds passkey begin and decision to session, attempt and evidence', async (t) => {
  const value = fixture();
  t.after(() => value.outbox.close());
  const begin = await value.contract.handle(
    value.mutationRequest('/webauthn', {
      decision: 'not-accepted',
      evidence,
    }),
    session,
  );
  assert.equal(begin.status, 200);
  assert.deepEqual(value.contexts, [{
    actionId: value.actionId,
    attemptId: value.attemptId,
    decision: 'not-accepted',
    evidence,
  }]);
  value.assertions.set('passkey-assertion', value.contexts[0]!);
  const decision = await value.contract.handle(
    value.mutationRequest('/decision', {
      decision: 'not-accepted',
      evidence,
      assertion: 'passkey-assertion',
    }),
    session,
  );
  assert.equal(decision.status, 200);
  assert.deepEqual(await decision.json(), {
    actionId: value.actionId,
    attemptId: value.attemptId,
    status: 'queued',
    dispatchAvailable: true,
  });
});

test('fails closed without trusted session, authorization, CSRF or matching evidence', async (t) => {
  const value = fixture();
  t.after(() => value.outbox.close());
  assert.equal((await value.contract.handle(
    new Request(`${origin}${value.basePath}`),
  )).status, 401);
  assert.equal((await value.contract.handle(
    value.mutationRequest('/webauthn', {
      decision: 'accepted',
      evidence,
    }, 'wrong-csrf'),
    session,
  )).status, 400);
  assert.equal((await value.contract.handle(
    new Request(`${origin}${value.basePath}`),
    { actor: 'other-reviewer', csrfToken: session.csrfToken },
  )).status, 400);

  const expected: ReconciliationAuthContext = {
    actionId: value.actionId,
    attemptId: value.attemptId,
    decision: 'accepted',
    evidence,
  };
  value.assertions.set('mismatched-evidence', expected);
  const mismatch = await value.contract.handle(
    value.mutationRequest('/decision', {
      decision: 'accepted',
      evidence: {
        ...evidence,
        referenceHash: 'c'.repeat(64),
      },
      assertion: 'mismatched-evidence',
    }),
    session,
  );
  assert.equal(mismatch.status, 400);
  assert.equal(value.outbox.get(value.actionId).status, 'uncertain');
});

test('rejects cross-origin, raw-evidence and oversized mutation requests', async (t) => {
  const value = fixture();
  t.after(() => value.outbox.close());
  assert.equal((await value.contract.handle(
    new Request(
      `https://attacker.example${value.basePath}`,
    ),
    session,
  )).status, 400);
  assert.equal((await value.contract.handle(
    value.mutationRequest('/webauthn', {
      decision: 'accepted',
      evidence: {
        ...evidence,
        rawProviderLog: 'must never enter the API contract',
      },
    }),
    session,
  )).status, 400);
  const oversized = new Request(`${origin}${value.basePath}/webauthn`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
      'content-length': String(65 * 1024),
    },
    body: '{}',
  });
  assert.equal(
    (await value.contract.handle(oversized, session)).status,
    400,
  );
  assert.equal(value.outbox.get(value.actionId).status, 'uncertain');
});
