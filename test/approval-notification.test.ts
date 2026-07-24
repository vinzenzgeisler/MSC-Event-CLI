import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ApprovalProposalService,
  type ApprovalNotification,
} from '../src/approval-notification.js';
import { ApprovalQueue } from '../src/approval.js';
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

test('sends only a privacy-minimized, idempotently identifiable approval link notice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-notification-'));
  const queue = new ApprovalQueue({
    storePath: join(directory, 'queue.json'),
    auditPath: join(directory, 'audit.jsonl'),
    signingKey: Buffer.alloc(32, 41),
    now: () => new Date('2026-07-23T18:00:00.000Z'),
    freshAuthVerifier: {
      async verify() {
        throw new Error('not used');
      },
    },
  });
  const notifications: ApprovalNotification[] = [];
  const service = new ApprovalProposalService({
    queue,
    approvalUrl: (actionId) => `https://approval.example.invalid/approve/${actionId}`,
    notifications: {
      async notify(notification) {
        notifications.push(notification);
      },
    },
  });
  const privateBody = 'Private answer for person@example.invalid';
  const privateSubject = 'Private subject';
  const record = await service.propose(
    createMailSendIntent(policy, {
      account: 'msc-info',
      to: 'person@example.invalid',
      subject: privateSubject,
      bodyText: privateBody,
      triageStatus: 'READY_TO_DRAFT',
      sources: ['msc/faq.md'],
      uncertainties: [],
    }),
    'notification-test',
  );
  assert.equal(notifications.length, 1);
  const notification = notifications[0]!;
  assert.equal(notification.notificationId, `approval:${record.actionId}`);
  assert.match(notification.text, /MSC-Freigabe erforderlich/);
  assert.match(notification.text, new RegExp(record.actionId));
  assert.doesNotMatch(
    notification.text,
    /person@example\.invalid|Private subject|Private answer/,
  );
});
