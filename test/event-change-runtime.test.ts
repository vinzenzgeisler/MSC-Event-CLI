import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovedActionExecutionCoordinator } from '../src/approval-execution.js';
import { SqliteApprovalStore } from '../src/approval-sqlite.js';
import {
  ApprovalQueue,
  type FreshAuthContext,
} from '../src/approval.js';
import { InactiveMscEventChangeRuntime } from '../src/event-change-runtime.js';
import {
  createEventEntryChangeIntent,
  EventEntryChangeAdapter,
} from '../src/event-approved-action.js';

test('executes one freshly approved Nennung change exactly once', async () => {
  const now = new Date('2026-07-25T23:30:00.000Z');
  const store = new SqliteApprovalStore(':memory:', {
    encryptionKey: Buffer.alloc(32, 61),
  });
  const assertions = new Map<string, FreshAuthContext>();
  const queue = new ApprovalQueue({
    store,
    signingKey: Buffer.alloc(32, 62),
    now: () => now,
    freshAuthVerifier: {
      async verify(assertion, context) {
        assert.deepEqual(assertions.get(String(assertion)), context);
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: String(assertion),
        };
      },
    },
  });
  try {
    const entryId = '10000000-0000-4000-8000-000000000001';
    const snapshot = { acceptanceStatus: 'pending' };
    const intent = createEventEntryChangeIntent({
      entryId,
      currentSnapshot: snapshot,
      operation: {
        type: 'acceptance-status',
        acceptanceStatus: 'accepted',
        sendLifecycleMail: false,
      },
    });
    const record = await queue.propose(intent, 'event-runtime:accept:1');
    const context: FreshAuthContext = {
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      decision: 'approve',
    };
    assertions.set('event-passkey', context);
    await queue.decide(record.actionId, 'approve', 'event-passkey', 'vinzenz');

    const mutations: unknown[] = [];
    const coordinator = new ApprovedActionExecutionCoordinator(queue, [
      new EventEntryChangeAdapter(
        async () => snapshot,
        {
          async apply(id, operation, executionContext) {
            mutations.push({ id, operation, executionContext });
            return {
              externalId: 'local-fake-change-1',
              result: { ok: true },
            };
          },
        },
      ),
    ]);
    const runtime = new InactiveMscEventChangeRuntime(queue, coordinator);
    const first = await runtime.runWorkerOnce();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.status, 'executed');
    assert.equal(first[0]!.execution?.result.externalId, 'local-fake-change-1');
    assert.equal(mutations.length, 1);
    assert.deepEqual(await runtime.runWorkerOnce(), []);
    assert.equal(mutations.length, 1);
  } finally {
    store.close();
  }
});
