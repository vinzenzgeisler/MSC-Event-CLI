import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { MscMailAccountPolicy } from '../src/mail-approved-action.js';
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
