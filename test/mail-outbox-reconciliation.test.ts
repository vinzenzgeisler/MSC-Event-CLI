import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashActionIntent } from '../src/approval.js';
import { SqliteDurableOutbox } from '../src/durable-outbox.js';
import {
  MailOutboxReconciliationService,
  WebAuthnReconciliationAuth,
  reconciliationFreshAuthContext,
  type ReconciliationAuthContext,
} from '../src/mail-outbox-reconciliation.js';
import {
  createMailSendIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';

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
  subject: 'Reconciliation test',
  bodyText: 'Sensitive evidence must not enter the audit.',
  triageStatus: 'READY_TO_DRAFT',
  sources: ['msc/faq.md'],
  uncertainties: [],
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'msc-reconciliation-'));
  const path = join(directory, 'outbox.sqlite');
  const outbox = new SqliteDurableOutbox(path, {
    encryptionKey: Buffer.alloc(32, 77),
  });
  const actionId = 'reconciliation-action';
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
  const now = new Date('2026-07-25T21:31:00.000Z');
  const contexts: ReconciliationAuthContext[] = [];
  const service = new MailOutboxReconciliationService(
    outbox,
    {
      async verify(assertion, context) {
        assert.equal(assertion, 'fresh-passkey');
        contexts.push(context);
        return {
          reviewer: 'vinzenz',
          authenticatedAt: now.toISOString(),
          authenticationMethod: 'passkey',
          assertionId: 'reconciliation-assertion',
        };
      },
    },
    { now: () => now },
  );
  return { path, outbox, service, contexts, actionId, attemptId: claimed.attemptId! };
};

test('binds fresh authentication to decision, attempt and hashed evidence', async (t) => {
  const fixtureValue = fixture();
  t.after(() => fixtureValue.outbox.close());
  const evidence = {
    source: 'provider-message-log' as const,
    referenceHash: 'd'.repeat(64),
    conclusionCode: 'provider-log-confirms-accepted',
  };
  const result = await fixtureValue.service.reconcile({
    actionId: fixtureValue.actionId,
    attemptId: fixtureValue.attemptId,
    decision: 'accepted',
    evidence,
    assertion: 'fresh-passkey',
    expectedReviewer: 'vinzenz',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(fixtureValue.contexts, [{
    actionId: fixtureValue.actionId,
    attemptId: fixtureValue.attemptId,
    decision: 'accepted',
    evidence,
  }]);
});

test('stores only bounded evidence metadata, never raw evidence content', async (t) => {
  const fixtureValue = fixture();
  t.after(() => fixtureValue.outbox.close());
  await fixtureValue.service.reconcile({
    actionId: fixtureValue.actionId,
    attemptId: fixtureValue.attemptId,
    decision: 'not-accepted',
    evidence: {
      source: 'provider-search',
      referenceHash: 'e'.repeat(64),
      conclusionCode: 'provider-search-confirms-absent',
    },
    assertion: 'fresh-passkey',
  });
  const database = new DatabaseSync(fixtureValue.path, { readOnly: true });
  t.after(() => database.close());
  const audit = JSON.stringify(
    database.prepare(`
      SELECT event, details_json
      FROM durable_outbox_audit
      ORDER BY sequence
    `).all(),
  );
  assert.match(audit, /provider-search-confirms-absent/);
  assert.match(audit, new RegExp('e{64}'));
  assert.doesNotMatch(audit, /recipient@example|Sensitive evidence/);
});

test('rejects stale authentication or a mismatched reviewer before mutation', async (t) => {
  const fixtureValue = fixture();
  t.after(() => fixtureValue.outbox.close());
  const stale = new MailOutboxReconciliationService(
    fixtureValue.outbox,
    {
      async verify() {
        return {
          reviewer: 'vinzenz',
          authenticatedAt: '2026-07-25T21:20:00.000Z',
          authenticationMethod: 'passkey',
          assertionId: 'stale-assertion',
        };
      },
    },
    { now: () => new Date('2026-07-25T21:31:00.000Z') },
  );
  const request = {
    actionId: fixtureValue.actionId,
    attemptId: fixtureValue.attemptId,
    decision: 'accepted' as const,
    evidence: {
      source: 'provider-search' as const,
      referenceHash: 'f'.repeat(64),
      conclusionCode: 'provider-log-confirms-accepted',
    },
    assertion: 'fresh-passkey',
  };
  await assert.rejects(stale.reconcile(request), /authentication is stale/);
  await assert.rejects(
    fixtureValue.service.reconcile({
      ...request,
      expectedReviewer: 'other-reviewer',
    }),
    /does not match/,
  );
  assert.equal(
    fixtureValue.outbox.get(fixtureValue.actionId).status,
    'uncertain',
  );
});

test('domain-separates the complete reconciliation context in the existing WebAuthn ceremony', async () => {
  const contexts: Array<{
    actor?: string;
    context: ReturnType<typeof reconciliationFreshAuthContext>;
  }> = [];
  const freshAuth = new WebAuthnReconciliationAuth({
    async begin(actor, context) {
      contexts.push({ actor, context });
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
      assert.equal(assertion, 'passkey-assertion');
      contexts.push({ context });
      return {
        actor: 'vinzenz',
        authenticatedAt: '2026-07-25T21:31:00.000Z',
        method: 'passkey',
        assertionId: 'reconciliation-challenge',
      };
    },
  });
  const context: ReconciliationAuthContext = {
    actionId: 'reconciliation-action',
    attemptId: '64588520-2163-4daf-80f4-03ea445d8472',
    decision: 'not-accepted',
    evidence: {
      source: 'provider-search',
      referenceHash: 'a'.repeat(64),
      conclusionCode: 'provider-search-confirms-absent',
    },
  };
  const begun = await freshAuth.begin('vinzenz', context);
  const verified = await freshAuth.verify('passkey-assertion', context);
  assert.equal(begun.challengeId, 'reconciliation-challenge');
  assert.equal(verified.reviewer, 'vinzenz');
  assert.equal(verified.authenticationMethod, 'passkey');
  assert.equal(contexts[0]!.actor, 'vinzenz');
  assert.deepEqual(contexts[0]!.context, contexts[1]!.context);
  assert.equal(contexts[0]!.context.actionId, context.actionId);
  assert.equal(contexts[0]!.context.decision, 'reject');
  assert.match(contexts[0]!.context.payloadHash, /^[a-f0-9]{64}$/);

  assert.notEqual(
    reconciliationFreshAuthContext({
      ...context,
      evidence: {
        ...context.evidence,
        conclusionCode: 'different-evidence-conclusion',
      },
    }).payloadHash,
    contexts[0]!.context.payloadHash,
  );
  assert.notEqual(
    reconciliationFreshAuthContext({
      ...context,
      attemptId: 'b2647407-40d3-473f-99d9-979e2322e7b1',
    }).payloadHash,
    contexts[0]!.context.payloadHash,
  );
});
