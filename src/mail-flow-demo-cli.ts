#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApprovedActionOutboxCoordinator } from './approval-execution.js';
import { SqliteApprovalStore } from './approval-sqlite.js';
import {
  ApprovalQueue,
  type FreshAuthContext,
  type FreshAuthVerifier,
} from './approval.js';
import { SqliteDurableOutbox } from './durable-outbox.js';
import {
  createMailReplyOutboxAdapter,
  MscMailFlow,
} from './mail-flow.js';
import type { MscMailAccountPolicy } from './mail-approved-action.js';
import { MscMailReadonlyProvider } from './mail-readonly-provider.js';
import {
  MailOutboxDispatchWorker,
  type MailTransportEnvelope,
} from './mail-outbox-transport.js';

const demoPolicy: MscMailAccountPolicy = {
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

export interface MailFlowDemoResult {
  demo: true;
  networkUsed: false;
  stages: Array<{
    step: number;
    title: string;
    status: string;
    detail: string;
  }>;
  deliveryCount: 1;
  finalStatus: 'accepted';
}

/**
 * Executable acceptance demo. Every external boundary is a local fake; the
 * production read-only provider, passkey verifier and SMTP transport are
 * tested separately and are never contacted by this command.
 */
export const runMailFlowDemo = async (): Promise<MailFlowDemoResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-mail-flow-demo-'));
  const databasePath = join(directory, 'demo.sqlite');
  const encryptionKey = randomBytes(32);
  const now = new Date('2026-07-25T22:30:00.000Z');
  const assertionContexts = new Map<string, FreshAuthContext>();
  const verifier: FreshAuthVerifier = {
    async verify(assertion, context) {
      const assertionId = String(assertion);
      const expected = assertionContexts.get(assertionId);
      if (JSON.stringify(expected) !== JSON.stringify(context)) {
        throw new Error('demo passkey assertion context mismatch');
      }
      assertionContexts.delete(assertionId);
      return {
        actor: 'vinzenz',
        authenticatedAt: now.toISOString(),
        method: 'passkey',
        assertionId,
      };
    },
  };
  const store = new SqliteApprovalStore(databasePath, {
    encryptionKey,
  });
  const outbox = new SqliteDurableOutbox(databasePath, {
    encryptionKey,
  });
  try {
    const queue = new ApprovalQueue({
      store,
      signingKey: randomBytes(32),
      freshAuthVerifier: verifier,
      now: () => now,
    });
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
        workerId: 'demo-worker',
        messageIdDomain: 'demo.msc.example',
        now: () => now,
      },
    );
    const provider = new MscMailReadonlyProvider(async (args) => ({
      stdout: JSON.stringify({
        schema: 'msc.mail-provider.v1',
        provider: 'himalaya',
        operation: args[0],
        source: {
          mailbox: 'MSC Info',
          account: 'msc-info',
          folder: 'INBOX',
        },
        data: {
          id: '7',
          from: { addr: 'fahrerin@example.org' },
          subject: 'Frage zur Veranstaltung',
          text: 'Hallo, wann beginnt die Dokumentenabnahme?',
        },
      }),
    }));
    const flow = new MscMailFlow({
      provider,
      policy: demoPolicy,
      queue,
      outboxCoordinator: new ApprovedActionOutboxCoordinator(queue, [
        createMailReplyOutboxAdapter(demoPolicy),
      ]),
      dispatchWorker: worker,
      approvalUrl: (actionId) =>
        `https://approval.demo.invalid/approve/${actionId}`,
    });

    const source = await flow.read('msc-info', 'INBOX', '7');
    const proposal = await flow.proposeReply({
      source: {
        account: 'msc-info',
        folder: 'INBOX',
        messageId: '7',
        from: 'fahrerin@example.org',
        subject: 'Frage zur Veranstaltung',
      },
      bodyText:
        'Guten Tag,\n\nvielen Dank für Ihre Nachricht. Die Dokumentenabnahme beginnt um 08:00 Uhr.\n\nFreundliche Grüße',
      triageStatus: 'READY_TO_DRAFT',
      sources: ['msc/event-2026.md'],
      uncertainties: [],
    }, 'demo-reply-7');
    const pending = await queue.review(proposal.actionId);
    const assertionId = 'demo-passkey-assertion';
    assertionContexts.set(assertionId, {
      actionId: pending.actionId,
      payloadHash: pending.payloadHash,
      decision: 'approve',
    });
    await queue.decide(
      pending.actionId,
      'approve',
      assertionId,
      'vinzenz',
    );
    const dispatched = await flow.dispatchApproved(pending.actionId);
    if (dispatched.status !== 'accepted' || delivered.length !== 1) {
      throw new Error('demo did not reach one accepted delivery');
    }
    return {
      demo: true,
      networkUsed: false,
      stages: [
        {
          step: 1,
          title: 'Mail lesen',
          status: 'ok',
          detail: `${(source.source as { mailbox: string }).mailbox} / INBOX / #7`,
        },
        {
          step: 2,
          title: 'Antwort entwerfen',
          status: 'ok',
          detail: 'READY_TO_DRAFT mit bestätigter MSC-Quelle',
        },
        {
          step: 3,
          title: 'Vollständige Vorschau',
          status: 'ok',
          detail: `${proposal.preview.changes.length} gebundene Vorschaufelder`,
        },
        {
          step: 4,
          title: 'Passkey-Freigabe',
          status: 'approved',
          detail: 'Vinzenz / einmalig / aktionsgebunden',
        },
        {
          step: 5,
          title: 'Versandstatus',
          status: 'accepted',
          detail: 'Ein Provider-Aufruf, stabiler Message-ID-Bezug',
        },
      ],
      deliveryCount: 1,
      finalStatus: 'accepted',
    };
  } finally {
    outbox.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const invokedAsScript = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  try {
    process.stdout.write(`${JSON.stringify(await runMailFlowDemo(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : 'demo failed',
    })}\n`);
    process.exitCode = 1;
  }
}
