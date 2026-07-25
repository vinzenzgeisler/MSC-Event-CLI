import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AuthenticationResponseJSON,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { hashActionIntent } from '../src/approval.js';
import {
  MailOutboxReconciliationComposition,
  createMailOutboxReviewerAuthorizer,
  type MailOutboxReviewerPolicy,
} from '../src/mail-outbox-reconciliation-composition.js';
import {
  createMailSendIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';
import type { RegisteredWebAuthnCredential } from '../src/webauthn.js';

const origin = 'https://approval.example.invalid';
const now = new Date('2026-07-25T22:00:00.000Z');
const accountPolicy: MscMailAccountPolicy = {
  version: 1,
  accounts: {
    'msc-nennung': {
      active: true,
      senderIdentity: 'nennung@example.invalid',
      displayName: 'MSC Nennung',
      allowedFolders: ['INBOX'],
    },
    'msc-info': {
      active: true,
      senderIdentity: 'info@example.invalid',
      displayName: 'MSC Info',
      allowedFolders: ['INBOX'],
    },
    'msc-vorstand': {
      active: true,
      senderIdentity: 'vorstand@example.invalid',
      displayName: 'MSC Vorstand',
      allowedFolders: ['INBOX'],
    },
  },
};
const reviewerPolicy: MailOutboxReviewerPolicy = {
  vinzenz: {
    accounts: ['msc-info'],
    actionKinds: ['mail.send'],
  },
};
const intent = createMailSendIntent(accountPolicy, {
  account: 'msc-info',
  to: 'recipient@example.invalid',
  subject: 'Composition test',
  bodyText: 'No listener and no transport exist.',
  triageStatus: 'READY_TO_DRAFT',
  sources: ['test'],
  uncertainties: [],
});
const credential: RegisteredWebAuthnCredential = {
  credentialId: 'credential-vinzenz',
  actor: 'vinzenz',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  revision: 0,
  transports: ['internal'],
};
const response = (): AuthenticationResponseJSON => ({
  id: credential.credentialId,
  rawId: credential.credentialId,
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
  type: 'public-key',
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
});
const verified = (): VerifiedAuthenticationResponse => ({
  verified: true,
  authenticationInfo: {
    credentialID: credential.credentialId,
    newCounter: 0,
    userVerified: true,
    credentialDeviceType: 'multiDevice',
    credentialBackedUp: true,
    origin,
    rpID: 'approval.example.invalid',
  },
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'msc-reconciliation-composition-'));
  const options = {
    outboxPath: join(directory, 'outbox.sqlite'),
    webauthnPath: join(directory, 'webauthn.sqlite'),
    outboxEncryptionKey: Buffer.alloc(32, 51),
    publicOrigin: origin,
    rpId: 'approval.example.invalid',
    expectedOrigins: [origin],
    reviewerPolicy,
    now: () => now,
    verifyAuthentication: async () => verified(),
  };
  const first = new MailOutboxReconciliationComposition(options);
  const second = new MailOutboxReconciliationComposition(options);
  return { first, second };
};

const prepareUncertain = (
  composition: MailOutboxReconciliationComposition,
): { actionId: string; attemptId: string } => {
  const actionId = 'composition-action';
  composition.outbox.enqueue({
    actionId,
    payloadHash: hashActionIntent(intent),
    kind: intent.kind,
    payload: JSON.parse(JSON.stringify(intent)),
    createdAt: now.toISOString(),
  });
  const claimed = composition.outbox.claim(
    actionId,
    'fake-worker',
    now.toISOString(),
  );
  composition.outbox.markUncertain(
    actionId,
    claimed.attemptId!,
    now.toISOString(),
    'acknowledgement-timeout',
  );
  return { actionId, attemptId: claimed.attemptId! };
};

test('applies explicit reviewer account and action-kind policy', async () => {
  const authorize = createMailOutboxReviewerAuthorizer(reviewerPolicy);
  const record = {
    actionId: 'policy-action',
    payloadHash: hashActionIntent(intent),
    kind: intent.kind,
    payload: JSON.parse(JSON.stringify(intent)),
    createdAt: now.toISOString(),
    status: 'uncertain' as const,
  };
  assert.equal(await authorize('vinzenz', record), true);
  assert.equal(await authorize('unknown-reviewer', record), false);
  assert.equal(await authorize('vinzenz', {
    ...record,
    kind: 'calendar.delete',
  }), false);
  const otherAccount = createMailSendIntent(accountPolicy, {
    account: 'msc-vorstand',
    to: 'recipient@example.invalid',
    subject: 'Unauthorized account',
    bodyText: 'Must fail closed.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['test'],
    uncertainties: [],
  });
  assert.equal(await authorize('vinzenz', {
    ...record,
    payloadHash: hashActionIntent(otherAccount),
    payload: JSON.parse(JSON.stringify(otherAccount)),
  }), false);
});

test('shares passkey and outbox state across workers and burns replay once', async (t) => {
  const { first, second } = fixture();
  t.after(() => {
    first.close();
    second.close();
  });
  await first.webauthnStore.registerCredential(credential);
  const { actionId, attemptId } = prepareUncertain(first);
  const context = {
    actionId,
    attemptId,
    decision: 'not-accepted' as const,
    evidence: {
      source: 'provider-search' as const,
      referenceHash: 'c'.repeat(64),
      conclusionCode: 'provider-search-confirms-absent',
    },
  };
  const begun = await first.freshAuth.begin('vinzenz', context);
  const assertion = {
    challengeId: begun.challengeId,
    response: response(),
  };
  const request = {
    ...context,
    assertion,
    expectedReviewer: 'vinzenz',
  };
  const outcomes = await Promise.allSettled([
    first.service.reconcile(request),
    second.service.reconcile(request),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'rejected').length,
    1,
  );
  assert.equal(first.outbox.get(actionId).status, 'queued');
  await assert.rejects(
    second.freshAuth.verify(assertion, context),
    /unknown or already used/,
  );
});

test('constructs no listener, worker or transport capability', () => {
  const { first, second } = fixture();
  try {
    assert.deepEqual(
      Object.keys(first).sort(),
      ['closed', 'freshAuth', 'http', 'outbox', 'service', 'webauthnStore'],
    );
    first.close();
    first.close();
  } finally {
    second.close();
  }
});
