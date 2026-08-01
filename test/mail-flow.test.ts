import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovedActionOutboxCoordinator } from '../src/approval-execution.js';
import { SqliteApprovalStore } from '../src/approval-sqlite.js';
import {
  ApprovalQueue,
  type FreshAuthContext,
  type FreshAuthVerifier,
} from '../src/approval.js';
import { SqliteDurableOutbox } from '../src/durable-outbox.js';
import {
  createMailReplyOutboxAdapter,
  MscMailFlow,
} from '../src/mail-flow.js';
import type { MscMailAccountPolicy } from '../src/mail-approved-action.js';
import { MscMailReadonlyProvider } from '../src/mail-readonly-provider.js';
import {
  MailOutboxDispatchWorker,
  type MailTransportEnvelope,
} from '../src/mail-outbox-transport.js';

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

test('connects read, complete reply preview, fresh approval, outbox and one dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-flow-'));
  const databasePath = join(directory, 'flow.sqlite');
  const key = Buffer.alloc(32, 73);
  const now = new Date('2026-07-25T21:45:00.000Z');
  const assertions = new Map<string, FreshAuthContext>();
  const verifier: FreshAuthVerifier = {
    async verify(assertion, context) {
      assert.deepEqual(assertions.get(String(assertion)), context);
      assertions.delete(String(assertion));
      return {
        actor: 'vinzenz',
        authenticatedAt: now.toISOString(),
        method: 'passkey',
        assertionId: String(assertion),
      };
    },
  };
  const store = new SqliteApprovalStore(databasePath, { encryptionKey: key });
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 19),
    freshAuthVerifier: verifier,
    now: () => now,
  });
  const outbox = new SqliteDurableOutbox(databasePath, { encryptionKey: key });
  const coordinator = new ApprovedActionOutboxCoordinator(queue, [
    createMailReplyOutboxAdapter(policy),
  ]);
  const delivered: MailTransportEnvelope[] = [];
  const worker = new MailOutboxDispatchWorker(
    outbox,
    {
      async deliver(envelope) {
        delivered.push(envelope);
        return { status: 'accepted' };
      },
    },
    {
      workerId: 'flow-test-worker',
      messageIdDomain: 'mail.msc.example',
      now: () => now,
    },
  );
  const provider = new MscMailReadonlyProvider(async (args) => ({
    stdout: JSON.stringify({
      schema: 'msc.mail-provider.v1',
      provider: 'himalaya',
      operation: args[0],
      source: { mailbox: 'MSC Info', account: 'msc-info', folder: 'INBOX' },
      data: {
        id: '7',
        from: { addr: 'fahrerin@example.org' },
        subject: 'Frage zur Veranstaltung',
        text: 'Hallo, wann ist die Dokumentenabnahme?',
      },
    }),
  }));
  const flow = new MscMailFlow({
    provider,
    policy,
    queue,
    outboxCoordinator: coordinator,
    dispatchWorker: worker,
    approvalUrl: (actionId) => `https://approval.example/approve/${actionId}`,
  });

  const message = await flow.read('msc-info', 'INBOX', '7');
  assert.equal((message.data as { subject: string }).subject, 'Frage zur Veranstaltung');

  const proposal = await flow.proposeReply({
    source: {
      account: 'msc-info',
      folder: 'INBOX',
      messageId: '7',
      from: 'fahrerin@example.org',
      subject: 'Frage zur Veranstaltung',
    },
    bodyText: 'Guten Tag,\n\ndie Dokumentenabnahme beginnt um 08:00 Uhr.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/event-2026.md'],
    uncertainties: [],
  }, 'reply:msc-info:INBOX:7:v1');
  assert.equal(proposal.status, 'pending');
  assert.match(proposal.approvalUrl, /\/approve\//);
  assert.ok(proposal.preview.changes.some(
    (change) => change.field === 'Antwort' &&
      change.after === 'Guten Tag,\n\ndie Dokumentenabnahme beginnt um 08:00 Uhr.',
  ));

  const pending = await queue.review(proposal.actionId);
  const context: FreshAuthContext = {
    actionId: pending.actionId,
    payloadHash: pending.payloadHash,
    decision: 'approve',
  };
  assertions.set('passkey-assertion-1', context);
  await queue.decide(
    pending.actionId,
    'approve',
    'passkey-assertion-1',
    'vinzenz',
  );

  const result = await flow.dispatchApproved(pending.actionId);
  assert.equal(result.status, 'accepted');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.to, 'fahrerin@example.org');
  assert.equal(delivered[0]!.inReplyToMessageId, '7');
  assert.equal(outbox.get(pending.actionId).status, 'accepted');
  await assert.rejects(
    flow.dispatchApproved(pending.actionId),
    /not approved|consumed/,
  );
  assert.equal(delivered.length, 1);

  outbox.close();
  store.close();
});

test('creates a proposal from the exact read-only source returned by the provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-source-proposal-'));
  const databasePath = join(directory, 'flow.sqlite');
  const store = new SqliteApprovalStore(databasePath, {
    encryptionKey: Buffer.alloc(32, 81),
  });
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 82),
    freshAuthVerifier: {
      async verify() {
        throw new Error('must not approve');
      },
    },
  });
  const outbox = new SqliteDurableOutbox(databasePath, {
    encryptionKey: Buffer.alloc(32, 81),
  });
  const provider = new MscMailReadonlyProvider(async () => ({
    stdout: JSON.stringify({
      schema: 'msc.mail-provider.v1',
      provider: 'himalaya',
      operation: 'preview',
      source: { mailbox: 'MSC Info', account: 'msc-info', folder: 'INBOX' },
      data: [
        'Message-ID: <provider-message@example.org>',
        'From: Fahrer <driver@example.org>',
        'To: info@msc-oberlausitzer-dreilaendereck.eu',
        'Subject: Rückfrage',
        '',
        'Untrusted message body.',
      ].join('\r\n'),
    }),
  }));
  const flow = new MscMailFlow({
    provider,
    policy,
    queue,
    outboxCoordinator: new ApprovedActionOutboxCoordinator(queue, [
      createMailReplyOutboxAdapter(policy),
    ]),
    dispatchWorker: new MailOutboxDispatchWorker(
      outbox,
      { async deliver() { throw new Error('must not send'); } },
      { workerId: 'source-test', messageIdDomain: 'mail.msc.example' },
    ),
    approvalUrl: (actionId) => `https://approval.example/approve/${actionId}`,
  });

  const result = await flow.proposeReplyFromSource({
    account: 'msc-info',
    folder: 'INBOX',
    messageId: '44',
    bodyText: 'Guten Tag,\n\nhier ist die geprüfte Antwort.',
    sources: ['msc/faq.md'],
  }, 'reply:msc-info:44:v1');

  assert.equal(result.status, 'pending');
  assert.ok(result.preview.changes.some(
    (change) => change.field === 'An' &&
      change.after === 'driver@example.org',
  ));
  assert.throws(() => outbox.get(result.actionId), /unknown outbox action/i);
  outbox.close();
  store.close();
});

test('creates a contact-form proposal for the validated form address', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-contact-form-proposal-'));
  const databasePath = join(directory, 'flow.sqlite');
  const store = new SqliteApprovalStore(databasePath, {
    encryptionKey: Buffer.alloc(32, 83),
  });
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 84),
    freshAuthVerifier: {
      async verify() {
        throw new Error('must not approve');
      },
    },
  });
  const outbox = new SqliteDurableOutbox(databasePath, {
    encryptionKey: Buffer.alloc(32, 83),
  });
  const provider = new MscMailReadonlyProvider(async () => ({
    stdout: JSON.stringify({
      schema: 'msc.mail-provider.v1',
      provider: 'himalaya',
      operation: 'preview',
      source: { mailbox: 'MSC Info', account: 'msc-info', folder: 'INBOX' },
      data: [
        'Message-ID: <contact-form@example.org>',
        'From: MSC Oberlausitzer Dreiländereck <info@msc-oberlausitzer-dreilaendereck.eu>',
        'To: info@msc-oberlausitzer-dreilaendereck.eu',
        'Subject: Neue Nachricht: Nennung Oberlausitzer Dreieck',
        '',
        'Name: Patrick Krause',
        'E-Mail: patkra147@gmail.com',
        'Nachricht:',
        'Darf ich teilnehmen?',
      ].join('\r\n'),
    }),
  }));
  const flow = new MscMailFlow({
    provider,
    policy,
    queue,
    outboxCoordinator: new ApprovedActionOutboxCoordinator(queue, [
      createMailReplyOutboxAdapter(policy),
    ]),
    dispatchWorker: new MailOutboxDispatchWorker(
      outbox,
      { async deliver() { throw new Error('must not send'); } },
      { workerId: 'contact-form-test', messageIdDomain: 'mail.msc.example' },
    ),
    approvalUrl: (actionId) => `https://approval.example/approve/${actionId}`,
  });

  const result = await flow.proposeReplyFromSource({
    account: 'msc-info',
    folder: 'INBOX',
    messageId: '6883',
    bodyText: 'Guten Tag Herr Krause,\n\nIhre Nennung ist angenommen.',
    sources: ['MSC Event RegistrationProvider'],
  }, 'reply:msc-info:6883:v1');

  assert.ok(result.preview.changes.some(
    (change) => change.field === 'An' &&
      change.after === 'patkra147@gmail.com',
  ));
  outbox.close();
  store.close();
});
