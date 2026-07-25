import assert from 'node:assert/strict';
import test from 'node:test';
import { hashActionIntent } from '../src/approval.js';
import { SqliteDurableOutbox } from '../src/durable-outbox.js';
import {
  deterministicMessageId,
  MailOutboxDispatchWorker,
  type MailTransport,
  type MailTransportEnvelope,
  type MailTransportResult,
} from '../src/mail-outbox-transport.js';
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
  subject: 'Local transport test',
  bodyText: 'This must remain inside the fake transport.',
  triageStatus: 'READY_TO_DRAFT',
  sources: ['msc/faq.md'],
  uncertainties: [],
  deliveryMode: 'approved-send',
});

const fixture = (
  result: MailTransportResult | Error,
): {
  outbox: SqliteDurableOutbox;
  worker: MailOutboxDispatchWorker;
  envelopes: MailTransportEnvelope[];
} => {
  const outbox = new SqliteDurableOutbox(':memory:', {
    encryptionKey: Buffer.alloc(32, 55),
  });
  const actionId = 'approved-action-1';
  outbox.enqueue({
    actionId,
    payloadHash: hashActionIntent(intent),
    kind: intent.kind,
    payload: JSON.parse(JSON.stringify(intent)),
    createdAt: '2026-07-25T21:15:00.000Z',
  });
  const envelopes: MailTransportEnvelope[] = [];
  const transport: MailTransport = {
    async deliver(envelope) {
      envelopes.push(envelope);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const times = [
    new Date('2026-07-25T21:15:01.000Z'),
    new Date('2026-07-25T21:15:02.000Z'),
  ];
  const worker = new MailOutboxDispatchWorker(outbox, transport, {
    workerId: 'local-fake-worker',
    messageIdDomain: 'approval.msc.example',
    now: () => times.shift() ?? new Date('2026-07-25T21:15:03.000Z'),
  });
  return { outbox, worker, envelopes };
};

test('creates a stable opaque RFC-style Message-ID', () => {
  const first = deterministicMessageId(
    'action-1',
    'a'.repeat(64),
    'Approval.MSC.Example',
  );
  const replay = deterministicMessageId(
    'action-1',
    'a'.repeat(64),
    'approval.msc.example',
  );
  assert.equal(first, replay);
  assert.match(
    first,
    /^<msc-approved-[a-f0-9]{64}@approval\.msc\.example>$/,
  );
  assert.doesNotMatch(first, /action-1/);
  assert.throws(
    () => deterministicMessageId('action-1', 'a'.repeat(64), 'localhost'),
    /fully qualified/,
  );
});

test('refuses to hand a dry-run intent to a transport', async (t) => {
  const dryRunIntent = createMailSendIntent(policy, {
    account: 'msc-info',
    to: 'recipient@example.invalid',
    subject: 'Dry-run only',
    bodyText: 'This must never reach the transport.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/faq.md'],
    uncertainties: [],
  });
  const outbox = new SqliteDurableOutbox(':memory:', {
    encryptionKey: Buffer.alloc(32, 55),
  });
  t.after(() => outbox.close());
  outbox.enqueue({
    actionId: 'dry-run-action',
    payloadHash: hashActionIntent(dryRunIntent),
    kind: dryRunIntent.kind,
    payload: JSON.parse(JSON.stringify(dryRunIntent)),
    createdAt: '2026-07-25T21:15:00.000Z',
  });
  const worker = new MailOutboxDispatchWorker(
    outbox,
    { async deliver() { throw new Error('must not be called'); } },
    {
      workerId: 'local-fake-worker',
      messageIdDomain: 'approval.msc.example',
    },
  );
  await assert.rejects(
    worker.dispatch('dry-run-action'),
    /refuses a dry-run intent/,
  );
  assert.equal(outbox.get('dry-run-action').status, 'queued');
});

test('records only provider acceptance, not final recipient delivery', async (t) => {
  const { outbox, worker, envelopes } = fixture({ status: 'accepted' });
  t.after(() => outbox.close());
  const result = await worker.dispatch('approved-action-1');
  assert.equal(result.status, 'accepted');
  assert.equal(outbox.get('approved-action-1').status, 'accepted');
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]!.account, 'msc-info');
  assert.equal(envelopes[0]!.to, 'recipient@example.invalid');
  assert.equal(envelopes[0]!.messageId, result.messageId);
});

test('requeues only an explicit failure before transport handoff', async (t) => {
  const { outbox, worker } = fixture({
    status: 'not-submitted',
    reasonCode: 'connection-refused-before-write',
  });
  t.after(() => outbox.close());
  const result = await worker.dispatch('approved-action-1');
  assert.equal(result.status, 'queued');
  const record = outbox.get('approved-action-1');
  assert.equal(record.status, 'queued');
  assert.equal(record.attemptId, undefined);
});

test('quarantines an ambiguous result and never retries it automatically', async (t) => {
  const { outbox, worker } = fixture({
    status: 'unknown',
    reasonCode: 'acknowledgement-timeout',
  });
  t.after(() => outbox.close());
  const result = await worker.dispatch('approved-action-1');
  assert.equal(result.status, 'uncertain');
  assert.equal(outbox.get('approved-action-1').status, 'uncertain');
  await assert.rejects(
    worker.dispatch('approved-action-1'),
    /uncertain, not queued/,
  );
});

test('treats an unexpected transport exception as an uncertain outcome', async (t) => {
  const { outbox, worker } = fixture(new Error('sensitive provider failure'));
  t.after(() => outbox.close());
  const result = await worker.dispatch('approved-action-1');
  assert.equal(result.status, 'uncertain');
  assert.equal(
    outbox.get('approved-action-1').uncertaintyCode,
    'transport-threw',
  );
});

test('requires explicit evidence before an uncertain action can be retried', async (t) => {
  const { outbox, worker } = fixture({
    status: 'unknown',
    reasonCode: 'connection-lost-after-write',
  });
  t.after(() => outbox.close());
  const dispatched = await worker.dispatch('approved-action-1');
  const uncertain = outbox.get('approved-action-1');
  assert.equal(uncertain.status, 'uncertain');

  const reconciled = outbox.reconcileNotAccepted(
    'approved-action-1',
    dispatched.attemptId,
    '2026-07-25T21:20:00.000Z',
    {
      reviewer: 'vinzenz',
      authenticationMethod: 'passkey',
      assertionId: 'assertion-1',
      source: 'provider-message-log',
      referenceHash: 'b'.repeat(64),
      conclusionCode: 'provider-log-confirms-absent',
    },
  );
  assert.equal(reconciled.status, 'queued');
  assert.equal(reconciled.attemptId, undefined);
});

test('can reconcile an uncertain action as provider-accepted without a retry', async (t) => {
  const { outbox, worker } = fixture({
    status: 'unknown',
    reasonCode: 'acknowledgement-timeout',
  });
  t.after(() => outbox.close());
  const dispatched = await worker.dispatch('approved-action-1');
  const reconciled = outbox.reconcileAccepted(
    'approved-action-1',
    dispatched.attemptId,
    '2026-07-25T21:20:00.000Z',
    {
      reviewer: 'vinzenz',
      authenticationMethod: 'passkey',
      assertionId: 'assertion-2',
      source: 'provider-search',
      referenceHash: 'c'.repeat(64),
      conclusionCode: 'provider-log-confirms-accepted',
    },
  );
  assert.equal(reconciled.status, 'accepted');
  assert.equal(reconciled.acceptedAt, '2026-07-25T21:20:00.000Z');
});
