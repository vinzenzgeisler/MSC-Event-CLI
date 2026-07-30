import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import {
  createMailSendIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';
import { MscMailProductionComposition } from '../src/msc-mail-production-composition.js';

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

test('builds a complete but inert mail production composition', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-production-'));
  const lifecycleCalls: string[] = [];
  let smtpCalls = 0;
  const composition = new MscMailProductionComposition({
    stateDatabasePath: join(directory, 'state.sqlite'),
    encryptionKey: Buffer.alloc(32, 101),
    signingKey: Buffer.alloc(32, 102),
    sessionCsrfKey: Buffer.alloc(32, 103),
    publicOrigin: 'https://openclaw.example',
    basePath: '/msc-approval',
    rpId: 'openclaw.example',
    reviewerActor: 'vinzenz',
    trustedProxyAddresses: ['172.20.0.2'],
    bindAddress: '127.0.0.1',
    port: 18443,
    workerIntervalMs: 60_000,
    workerId: 'production-test',
    messageIdDomain: 'mail.msc.example',
    mailPolicy: policy,
    smtpAccounts: [{
      account: 'msc-info',
      host: 'smtp.example.org',
      port: 465,
      secure: true,
      username: 'info@msc.example',
      password: 'injected',
      senderIdentity: 'info@msc.example',
    }],
    smtpClientFactory() {
      return {
        async verify() {
          return true;
        },
        async sendMail() {
          smtpCalls += 1;
          throw new Error('must not send');
        },
      };
    },
    async providerRunner() {
      throw new Error('must not read');
    },
    lifecycle: {
      async listen(_server: Server, binding) {
        lifecycleCalls.push(`listen:${binding.address}:${binding.port}`);
      },
      async close() {
        lifecycleCalls.push('close');
      },
    },
  });
  t.after(async () => composition.close());
  assert.equal(composition.host.status, 'inactive');
  assert.equal(smtpCalls, 0);
  assert.equal(
    composition.review.http.approvalUrl(
      '10000000-0000-4000-8000-000000000001',
    ),
    'https://openclaw.example/msc-approval/approve/10000000-0000-4000-8000-000000000001',
  );
  await composition.start();
  assert.equal(composition.host.status, 'running');
  assert.deepEqual(lifecycleCalls, ['listen:127.0.0.1:18443']);
  assert.equal(smtpCalls, 0);
  await composition.close();
  assert.deepEqual(lifecycleCalls, [
    'listen:127.0.0.1:18443',
    'close',
  ]);
  assert.equal(composition.host.status, 'inactive');
});

test('fails closed before listener activation on mismatched SMTP policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-production-bad-'));
  assert.throws(() => new MscMailProductionComposition({
    stateDatabasePath: join(directory, 'state.sqlite'),
    encryptionKey: Buffer.alloc(32, 111),
    signingKey: Buffer.alloc(32, 112),
    sessionCsrfKey: Buffer.alloc(32, 113),
    publicOrigin: 'https://openclaw.example',
    basePath: '/msc-approval',
    rpId: 'openclaw.example',
    reviewerActor: 'vinzenz',
    trustedProxyAddresses: ['172.20.0.2'],
    bindAddress: '127.0.0.1',
    port: 18443,
    workerIntervalMs: 60_000,
    workerId: 'production-test',
    messageIdDomain: 'mail.msc.example',
    mailPolicy: policy,
    smtpAccounts: [{
      account: 'msc-info',
      host: 'smtp.example.org',
      port: 465,
      secure: true,
      username: 'wrong@msc.example',
      password: 'injected',
      senderIdentity: 'info@msc.example',
    }],
  }), /must match/);
});

test('binds one Telegram operator approval to one exact mail proposal and SMTP attempt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-telegram-'));
  const sessionKey = 'agent:main:telegram:direct:8261978945';
  let smtpCalls = 0;
  const composition = new MscMailProductionComposition({
    stateDatabasePath: join(directory, 'state.sqlite'),
    encryptionKey: Buffer.alloc(32, 121),
    signingKey: Buffer.alloc(32, 122),
    sessionCsrfKey: Buffer.alloc(32, 123),
    publicOrigin: 'https://openclaw.example',
    basePath: '/msc-approval',
    rpId: 'openclaw.example',
    reviewerActor: 'vinzenz',
    operatorSessionKey: sessionKey,
    trustedProxyAddresses: ['172.20.0.2'],
    bindAddress: '127.0.0.1',
    port: 18443,
    workerIntervalMs: 60_000,
    workerId: 'production-test',
    messageIdDomain: 'mail.msc.example',
    mailPolicy: policy,
    smtpAccounts: [{
      account: 'msc-info',
      host: 'smtp.example.org',
      port: 465,
      secure: true,
      username: 'info@msc.example',
      password: 'injected',
      senderIdentity: 'info@msc.example',
    }],
    smtpClientFactory() {
      return {
        async verify() {
          return true;
        },
        async sendMail(message) {
          smtpCalls += 1;
          return {
            accepted: [message.to],
            rejected: [],
            pending: [],
            messageId: message.messageId,
          };
        },
      };
    },
    async providerRunner(args) {
      assert.deepEqual(args, [
        'preview',
        '--account', 'msc-info',
        '--folder', 'INBOX',
        '--message-id', '42',
      ]);
      return {
        stdout: JSON.stringify({
          schema: 'msc.mail-provider.v1',
          provider: 'himalaya',
          operation: 'preview',
          source: {},
          data: {
            id: '42',
            from: 'recipient@example.net',
            subject: 'Frage zur Veranstaltung',
          },
        }),
      };
    },
  });
  t.after(async () => composition.close());

  const proposed = await composition.flow.proposeReplyFromSource({
    account: 'msc-info',
    folder: 'INBOX',
    messageId: '42',
    bodyText: 'Guten Tag,\n\nvielen Dank für die Anfrage.',
    sources: ['MSC FAQ'],
  }, 'telegram-approval-test');
  const record = await composition.review.queue.review(proposed.actionId);
  const payloadReference = record.payloadHash.slice(0, 12);

  await assert.rejects(
    composition.gatewayApprovalPreview(
      proposed.actionId,
      payloadReference,
      'agent:main:telegram:direct:999',
    ),
    /not enabled for this session/,
  );
  await assert.rejects(
    composition.gatewayApprovalPreview(
      proposed.actionId,
      '0'.repeat(12),
      sessionKey,
    ),
    /payload reference does not match/,
  );
  assert.equal(
    (await composition.gatewayApprovalPreview(
      proposed.actionId,
      payloadReference,
      sessionKey,
    )).title,
    'Auf MSC-E-Mail antworten',
  );
  await composition.assertGatewaySmtpReady(
    proposed.actionId,
    payloadReference,
    sessionKey,
  );

  const dispatched = await composition.approveAndDispatchFromGateway({
    actionId: proposed.actionId,
    payloadReference,
    sessionKey,
    toolCallId: 'tool-call-1',
  });
  assert.equal(dispatched.status, 'accepted');
  assert.equal(smtpCalls, 1);
  assert.equal(
    (await composition.review.approvals.get(proposed.actionId)).decidedBy,
    'vinzenz',
  );
  await assert.rejects(
    composition.approveAndDispatchFromGateway({
      actionId: proposed.actionId,
      payloadReference,
      sessionKey,
      toolCallId: 'tool-call-2',
    }),
    /consumed, not pending/,
  );
  assert.equal(smtpCalls, 1);

  const sendRecord = await composition.review.queue.propose(
    createMailSendIntent(policy, {
      account: 'msc-info',
      to: 'nennung@msc.example',
      subject: '[TEST] Eingangswächter',
      bodyText: 'Technische Testmail.',
      triageStatus: 'READY_TO_DRAFT',
      sources: ['Telegram-Testauftrag'],
      uncertainties: [],
      deliveryMode: 'approved-send',
    }),
    'telegram-send-approval-test',
  );
  const sendPayloadReference = sendRecord.payloadHash.slice(0, 12);
  assert.equal(
    (await composition.gatewayApprovalPreview(
      sendRecord.actionId,
      sendPayloadReference,
      sessionKey,
    )).title,
    'MSC-E-Mail senden',
  );
  await composition.assertGatewaySmtpReady(
    sendRecord.actionId,
    sendPayloadReference,
    sessionKey,
  );
  assert.equal(
    (await composition.approveAndDispatchFromGateway({
      actionId: sendRecord.actionId,
      payloadReference: sendPayloadReference,
      sessionKey,
      toolCallId: 'tool-call-send-1',
    })).status,
    'accepted',
  );
  assert.equal(smtpCalls, 2);
  await assert.rejects(
    composition.approveAndDispatchFromGateway({
      actionId: sendRecord.actionId,
      payloadReference: sendPayloadReference,
      sessionKey,
      toolCallId: 'tool-call-send-2',
    }),
    /consumed, not pending/,
  );
  assert.equal(smtpCalls, 2);
});
