import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEventEntryChangeIntent } from '../src/event-approved-action.js';
import {
  createMailReplyIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';
import { MscApprovalReviewComposition } from '../src/msc-approval-review-composition.js';

const policy: MscMailAccountPolicy = {
  version: 1,
  accounts: {
    'msc-nennung': {
      active: true,
      senderIdentity: 'nennung@msc.example',
      displayName: 'MSC Nennung',
      allowedFolders: ['INBOX'],
    },
    'msc-info': {
      active: true,
      senderIdentity: 'info@msc.example',
      displayName: 'MSC Info',
      allowedFolders: ['INBOX'],
    },
    'msc-vorstand': {
      active: true,
      senderIdentity: 'admin@msc.example',
      displayName: 'MSC Vorstand',
      allowedFolders: ['INBOX'],
    },
  },
};

test('serves Nennung and mail previews from one inactive passkey page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-shared-approval-'));
  const composition = new MscApprovalReviewComposition({
    stateDatabasePath: join(directory, 'shared.sqlite'),
    encryptionKey: Buffer.alloc(32, 71),
    signingKey: Buffer.alloc(32, 72),
    publicOrigin: 'https://approval.example',
    rpId: 'approval.example',
    expectedOrigins: ['https://approval.example'],
    async authorizeReviewer(actor) {
      return actor === 'vinzenz';
    },
  });
  try {
    const event = await composition.queue.propose(
      createEventEntryChangeIntent({
        entryId: '10000000-0000-4000-8000-000000000001',
        currentSnapshot: { acceptanceStatus: 'pending' },
        operation: {
          type: 'acceptance-status',
          acceptanceStatus: 'accepted',
          sendLifecycleMail: false,
        },
      }),
      'shared:event:1',
    );
    const mail = await composition.queue.propose(
      createMailReplyIntent(policy, {
        source: {
          account: 'msc-info',
          folder: 'INBOX',
          messageId: '7',
          from: 'fahrerin@example.org',
          subject: 'Frage',
        },
        bodyText: 'Guten Tag,\n\nhier ist die geprüfte Antwort.',
        triageStatus: 'READY_TO_DRAFT',
        sources: ['MSC-Ablaufplan 2026'],
        uncertainties: [],
        deliveryMode: 'approved-send',
      }),
      'shared:mail:1',
    );
    const session = { actor: 'vinzenz', csrfToken: 'csrf-shared' };
    const eventModel = await composition.http.handle(
      new Request(`https://approval.example/api/approvals/${event.actionId}`),
      session,
    );
    const mailModel = await composition.http.handle(
      new Request(`https://approval.example/api/approvals/${mail.actionId}`),
      session,
    );
    assert.equal(eventModel.status, 200);
    assert.equal(mailModel.status, 200);
    assert.equal((await eventModel.json()).preview.title, 'Nennung ändern');
    assert.equal(
      (await mailModel.json()).preview.title,
      'Auf MSC-E-Mail antworten',
    );
    assert.equal(composition.http.approvalUrl(event.actionId),
      `https://approval.example/approve/${event.actionId}`);
  } finally {
    composition.close();
  }
});
