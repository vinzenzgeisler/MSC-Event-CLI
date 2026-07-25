import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { ApprovedActionOutboxCoordinator } from '../src/approval-execution.js';
import { ApprovalHttpContract } from '../src/approval-http.js';
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
import { InactiveMscMailFlowRuntime } from '../src/mail-flow-runtime.js';
import {
  MailReplyPreviewRenderer,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';
import { MscMailReadonlyProvider } from '../src/mail-readonly-provider.js';
import { MailOutboxDispatchWorker } from '../src/mail-outbox-transport.js';

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

test('connects authenticated mobile approval to one explicit worker cycle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-flow-runtime-'));
  const path = join(directory, 'runtime.sqlite');
  const key = Buffer.alloc(32, 44);
  const now = new Date('2026-07-25T22:40:00.000Z');
  const assertions = new Map<string, FreshAuthContext>();
  const verifier: FreshAuthVerifier = {
    async verify(assertion, context) {
      assert.deepEqual(assertions.get(String(assertion)), context);
      return {
        actor: 'vinzenz',
        authenticatedAt: now.toISOString(),
        method: 'passkey',
        assertionId: String(assertion),
      };
    },
  };
  const store = new SqliteApprovalStore(path, { encryptionKey: key });
  const outbox = new SqliteDurableOutbox(path, { encryptionKey: key });
  t.after(() => {
    outbox.close();
    store.close();
  });
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 45),
    freshAuthVerifier: verifier,
    now: () => now,
  });
  let deliveries = 0;
  const flow = new MscMailFlow({
    provider: new MscMailReadonlyProvider(async (args) => ({
      stdout: JSON.stringify({
        schema: 'msc.mail-provider.v1',
        provider: 'himalaya',
        operation: args[0],
        source: { mailbox: 'MSC Info', account: 'msc-info' },
        data: {},
      }),
    })),
    policy,
    queue,
    outboxCoordinator: new ApprovedActionOutboxCoordinator(queue, [
      createMailReplyOutboxAdapter(policy),
    ]),
    dispatchWorker: new MailOutboxDispatchWorker(
      outbox,
      {
        async deliver() {
          deliveries += 1;
          return { status: 'accepted' };
        },
      },
      {
        workerId: 'runtime-test',
        messageIdDomain: 'runtime.msc.example',
        now: () => now,
      },
    ),
    approvalUrl: (actionId) => `https://approval.example/approve/${actionId}`,
  });
  const approvals = new ApprovalHttpContract({
    publicOrigin: 'https://approval.example',
    queue,
    renderers: [new MailReplyPreviewRenderer()],
    async authorizeReviewer(actor) {
      return actor === 'vinzenz';
    },
    async beginFreshAuth() {
      return {
        challengeId: 'challenge-1',
        options: {
          challenge: 'challenge',
          timeout: 120_000,
          rpId: 'approval.example',
          allowCredentials: [],
          userVerification: 'required',
        } as PublicKeyCredentialRequestOptionsJSON,
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      };
    },
  });
  const runtime = new InactiveMscMailFlowRuntime(flow, approvals, queue);
  const proposal = await flow.proposeReply({
    source: {
      account: 'msc-info',
      folder: 'INBOX',
      messageId: '7',
      from: 'fahrerin@example.org',
      subject: 'Frage',
    },
    bodyText: 'Guten Tag,\n\nvielen Dank für Ihre Nachricht.',
    triageStatus: 'READY_TO_DRAFT',
    sources: ['msc/faq.md'],
    uncertainties: [],
  }, 'runtime-reply-7');
  const session = { actor: 'vinzenz', csrfToken: 'csrf-runtime-test' };
  const model = await runtime.handleApprovalRequest(
    new Request(
      `https://approval.example/api/approvals/${proposal.actionId}`,
    ),
    session,
  );
  assert.equal(model.status, 200);
  const pending = await queue.review(proposal.actionId);
  const context: FreshAuthContext = {
    actionId: proposal.actionId,
    payloadHash: pending.payloadHash,
    decision: 'approve',
  };
  assertions.set('runtime-passkey', context);
  const decision = await runtime.handleApprovalRequest(
    new Request(
      `https://approval.example/api/approvals/${proposal.actionId}/decision`,
      {
        method: 'POST',
        headers: {
          origin: 'https://approval.example',
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
          decision: 'approve',
          assertion: 'runtime-passkey',
        }),
      },
    ),
    session,
  );
  assert.equal(decision.status, 200);
  assert.deepEqual(await runtime.runWorkerOnce(), [{
    actionId: proposal.actionId,
    status: 'accepted',
  }]);
  assert.deepEqual(await runtime.runWorkerOnce(), []);
  assert.equal(deliveries, 1);
});
