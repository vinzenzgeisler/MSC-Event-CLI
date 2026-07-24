import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovedActionExecutionCoordinator } from '../src/approval-execution.js';
import { ApprovalQueue } from '../src/approval.js';
import {
  createMailSendIntent,
  MailSendDryRunAdapter,
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

test('internally consumes an approved action once before invoking its dry-run adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-execution-'));
  const now = new Date('2026-07-23T18:00:00.000Z');
  const queue = new ApprovalQueue({
    storePath: join(directory, 'queue.json'),
    auditPath: join(directory, 'audit.jsonl'),
    signingKey: Buffer.alloc(32, 31),
    now: () => now,
    freshAuthVerifier: {
      async verify() {
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: 'assertion',
        };
      },
    },
  });
  const intent = createMailSendIntent(policy, {
    account: 'msc-info',
    to: 'recipient@example.invalid',
    subject: 'Dry-run',
    bodyText: 'This must not leave the process.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/faq.md'],
    uncertainties: [],
  });
  const record = await queue.propose(intent, 'execution-test');
  await queue.decide(record.actionId, 'approve', {});
  const coordinator = new ApprovedActionExecutionCoordinator(queue, [
    new MailSendDryRunAdapter(async (account) => ({
      policyVersion: 1,
      account,
      senderIdentity: policy.accounts[account].senderIdentity,
      allowedFolders: policy.accounts[account].allowedFolders,
    })),
  ]);
  assert.deepEqual(
    await coordinator.pendingApprovedActionIds(),
    [record.actionId],
  );
  const executed = await coordinator.execute(record.actionId);
  assert.equal(executed.actionId, record.actionId);
  assert.equal(executed.kind, 'mail.send');
  assert.deepEqual(executed.result.result, {
    dryRun: true,
    wouldSend: intent.after,
  });
  await assert.rejects(
    coordinator.execute(record.actionId),
    /not approved/,
  );
});

test('two workers cannot invoke the same adapter twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-execution-race-'));
  const now = new Date('2026-07-23T18:00:00.000Z');
  const queue = new ApprovalQueue({
    storePath: join(directory, 'queue.json'),
    auditPath: join(directory, 'audit.jsonl'),
    signingKey: Buffer.alloc(32, 32),
    now: () => now,
    freshAuthVerifier: {
      async verify() {
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: 'assertion',
        };
      },
    },
  });
  const intent = createMailSendIntent(policy, {
    account: 'msc-info',
    to: 'recipient@example.invalid',
    subject: 'Race',
    bodyText: 'Exactly once.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/faq.md'],
    uncertainties: [],
  });
  const record = await queue.propose(intent, 'execution-race');
  await queue.decide(record.actionId, 'approve', {});
  let invocations = 0;
  const adapter = new MailSendDryRunAdapter(async (account) => {
    await new Promise((resolve) => setImmediate(resolve));
    return {
      policyVersion: 1,
      account,
      senderIdentity: policy.accounts[account].senderIdentity,
      allowedFolders: policy.accounts[account].allowedFolders,
    };
  });
  const originalExecute = adapter.execute.bind(adapter);
  adapter.execute = async (...arguments_) => {
    invocations += 1;
    return originalExecute(...arguments_);
  };
  const coordinator = new ApprovedActionExecutionCoordinator(queue, [adapter]);
  const results = await Promise.allSettled([
    coordinator.execute(record.actionId),
    coordinator.execute(record.actionId),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(invocations, 1);
});
