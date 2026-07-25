import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteApprovalStore } from '../src/approval-sqlite.js';
import { ApprovalQueue } from '../src/approval.js';
import { MscEventReadonlyProvider } from '../src/event-readonly-provider.js';
import type { MscMailAccountPolicy } from '../src/mail-approved-action.js';
import { MscMailReadonlyProvider } from '../src/mail-readonly-provider.js';
import { MscApprovalProposalWriter } from '../src/msc-approval-proposal.js';

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

const entryId = '10000000-0000-4000-8000-000000000001';

const fixture = () => {
  const store = new SqliteApprovalStore(':memory:', {
    encryptionKey: Buffer.alloc(32, 51),
  });
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 52),
    freshAuthVerifier: {
      async verify() {
        throw new Error('not used');
      },
    },
    now: () => new Date('2026-07-25T23:20:00.000Z'),
  });
  const eventCalls: readonly string[][] = [];
  const event = new MscEventReadonlyProvider(async (args) => {
    (eventCalls as string[][]).push([...args]);
    return {
      stdout: JSON.stringify({
        id: entryId,
        acceptanceStatus: 'pending',
        paidAmountCents: 0,
      }),
    };
  });
  const mailCalls: readonly string[][] = [];
  const mail = new MscMailReadonlyProvider(async (args) => {
    (mailCalls as string[][]).push([...args]);
    return {
      stdout: JSON.stringify({
        schema: 'msc.mail-provider.v1',
        provider: 'himalaya',
        operation: 'preview',
        source: {
          mailbox: 'MSC Info',
          account: 'msc-info',
          folder: 'INBOX',
        },
        data: {
          id: '7',
          from: { addr: 'fahrerin@example.org', name: 'Eine Fahrerin' },
          subject: 'Frage zur Veranstaltung',
          text: 'Wann beginnt die Abnahme?',
        },
      }),
    };
  });
  return {
    store,
    queue,
    eventCalls,
    mailCalls,
    writer: new MscApprovalProposalWriter(
      event,
      mail,
      queue,
      'https://approval.example',
      policy,
    ),
  };
};

test('reads the current Nennung and persists one exact change proposal', async () => {
  const { store, queue, eventCalls, writer } = fixture();
  try {
    const result = await writer.proposeEventEntryChange({
      entryId,
      label: 'Max Musterfahrer',
      operation: {
        type: 'acceptance-status',
        acceptanceStatus: 'accepted',
        sendLifecycleMail: false,
      },
      idempotencyKey: 'entry:1:accept:v1',
    });
    assert.deepEqual(eventCalls, [['detail', '--id', entryId]]);
    assert.equal(result.status, 'pending');
    assert.match(result.approvalUrl, /^https:\/\/approval\.example\/approve\//);
    assert.ok(result.preview.changes.some(
      (change) => change.field === 'acceptanceStatus' &&
        change.after === 'accepted',
    ));
    const persisted = await queue.review(result.actionId);
    assert.equal(persisted.intent.kind, 'event.entry.update');
    assert.deepEqual(persisted.intent.before, persisted.intent.expectedState);
  } finally {
    store.close();
  }
});

test('reads the source mail and persists the edited body for passkey review', async () => {
  const { store, queue, mailCalls, writer } = fixture();
  try {
    const first = await writer.proposeMailReply({
      account: 'msc-info',
      folder: 'INBOX',
      messageId: '7',
      bodyText: 'Erster Entwurf.',
      sources: ['MSC-Ablaufplan 2026'],
      idempotencyKey: 'reply:7:draft:1',
    });
    const edited = await writer.proposeMailReply({
      account: 'msc-info',
      folder: 'INBOX',
      messageId: '7',
      bodyText: 'Überarbeiteter Entwurf mit vollständiger Antwort.',
      sources: ['MSC-Ablaufplan 2026'],
      idempotencyKey: 'reply:7:draft:2',
    });
    assert.deepEqual(mailCalls, [
      ['preview', '--account', 'msc-info', '--folder', 'INBOX', '--message-id', '7'],
      ['preview', '--account', 'msc-info', '--folder', 'INBOX', '--message-id', '7'],
    ]);
    assert.notEqual(first.actionId, edited.actionId);
    assert.ok(edited.preview.changes.some(
      (change) => change.field === 'Antwort' &&
        change.after === 'Überarbeiteter Entwurf mit vollständiger Antwort.',
    ));
    const persisted = await queue.review(edited.actionId);
    assert.equal(persisted.intent.kind, 'mail.reply');
    assert.equal(
      (persisted.intent.after as { bodyText: string }).bodyText,
      'Überarbeiteter Entwurf mit vollständiger Antwort.',
    );
  } finally {
    store.close();
  }
});

test('rejects a mismatched source message before creating an approval', async () => {
  const { store, queue, writer } = fixture();
  try {
    await assert.rejects(
      writer.proposeMailReply({
        account: 'msc-info',
        folder: 'INBOX',
        messageId: '8',
        bodyText: 'Antwort.',
        sources: ['MSC-Ablaufplan 2026'],
        idempotencyKey: 'reply:8',
      }),
      /mismatched source message/,
    );
    assert.deepEqual(await queue.pending(), []);
  } finally {
    store.close();
  }
});
