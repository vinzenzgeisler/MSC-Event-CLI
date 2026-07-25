import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ActionIntent } from '../src/action.js';
import {
  ApprovalQueue,
  hashActionIntent,
  hashJson,
  type ApprovalRecord,
} from '../src/approval.js';
import { SqliteApprovalStore } from '../src/approval-sqlite.js';
import { SqliteDurableOutbox } from '../src/durable-outbox.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'mail.send',
  summary: 'Send a reviewed test message',
  target: { type: 'mailbox', id: 'msc-test' },
  before: null,
  after: { subject: 'Test' },
  expectedState: null,
};

const record = (actionId: string): ApprovalRecord => ({
  actionId,
  idempotencyKey: 'same-request',
  intent,
  payloadHash: hashActionIntent(intent),
  expectedStateHash: hashJson(intent.expectedState),
  createdAt: '2026-07-23T14:00:00.000Z',
  expiresAt: '2026-07-23T14:15:00.000Z',
  status: 'pending',
});

const stores = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-approval-sqlite-'));
  const path = join(directory, 'approval.sqlite');
  const encryptionKey = Buffer.alloc(32, 17);
  return {
    path,
    first: new SqliteApprovalStore(path, { encryptionKey }),
    second: new SqliteApprovalStore(path, { encryptionKey }),
  };
};

test('atomically enforces idempotency, decision and one-time consumption across connections', async (t) => {
  const { path, first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });

  const proposed = await Promise.all([
    first.propose(record('action-1'), '2026-07-23T14:00:00.000Z'),
    second.propose(record('action-2'), '2026-07-23T14:00:00.001Z'),
  ]);
  assert.equal(new Set(proposed.map((result) => result.record.actionId)).size, 1);
  assert.equal(proposed.filter((result) => result.created).length, 1);

  const actionId = proposed[0]!.record.actionId;
  const decisions = await Promise.allSettled([
    first.decide({
      actionId,
      decision: 'approve',
      decidedAt: '2026-07-23T14:01:00.000Z',
      decidedBy: 'vinzenz',
      expiresAfter: '2026-07-23T14:01:00.000Z',
      authenticationMethod: 'passkey',
      assertionId: 'assertion-1',
    }),
    second.decide({
      actionId,
      decision: 'approve',
      decidedAt: '2026-07-23T14:01:00.001Z',
      decidedBy: 'vinzenz',
      expiresAfter: '2026-07-23T14:01:00.001Z',
      authenticationMethod: 'passkey',
      assertionId: 'assertion-2',
    }),
  ]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);

  const consumptions = await Promise.allSettled([
    first.consume({
      actionId,
      payloadHash: record(actionId).payloadHash,
      expiresAt: record(actionId).expiresAt,
      expectedStateHash: record(actionId).expectedStateHash,
      consumedAt: '2026-07-23T14:02:00.000Z',
    }),
    second.consume({
      actionId,
      payloadHash: record(actionId).payloadHash,
      expiresAt: record(actionId).expiresAt,
      expectedStateHash: record(actionId).expectedStateHash,
      consumedAt: '2026-07-23T14:02:00.001Z',
    }),
  ]);
  assert.equal(consumptions.filter((result) => result.status === 'fulfilled').length, 1);

  const audit = new DatabaseSync(path, { readOnly: true });
  t.after(() => audit.close());
  const events = audit
    .prepare('SELECT event FROM approval_audit ORDER BY sequence')
    .all()
    .map((row) => row.event);
  assert.deepEqual(events, ['proposed', 'approved', 'consumed']);
});

test('keeps personal intent data out of lifecycle audit rows', async (t) => {
  const { path, first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });
  await first.propose(record('action-private'), '2026-07-23T14:00:00.000Z');

  const audit = new DatabaseSync(path, { readOnly: true });
  t.after(() => audit.close());
  const serialized = JSON.stringify(
    audit.prepare('SELECT * FROM approval_audit').all(),
  );
  assert.doesNotMatch(serialized, /Send a reviewed test message|subject/);
  assert.match(serialized, /same-request/);
});

test('encrypts complete intents at rest and binds ciphertext to the action id', async (t) => {
  const { path, first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });
  const stored = record('action-encrypted');
  await first.propose(stored, stored.createdAt);
  assert.deepEqual((await second.get(stored.actionId)).intent, stored.intent);

  const database = new DatabaseSync(path);
  t.after(() => database.close());
  const row = database.prepare(`
    SELECT intent_nonce, intent_ciphertext, intent_auth_tag
    FROM approval_records
    WHERE action_id = ?
  `).get(stored.actionId) as {
    intent_nonce: Uint8Array;
    intent_ciphertext: Uint8Array;
    intent_auth_tag: Uint8Array;
  };
  assert.equal(row.intent_nonce.byteLength, 12);
  assert.equal(row.intent_auth_tag.byteLength, 16);
  assert.doesNotMatch(
    Buffer.from(row.intent_ciphertext).toString('utf8'),
    /Send a reviewed test message|subject/,
  );

  database.prepare(`
    UPDATE approval_records
    SET action_id = 'action-swapped'
    WHERE action_id = ?
  `).run(stored.actionId);
  await assert.rejects(second.get('action-swapped'));
});

test('runs the complete proof lifecycle through the transactional store', async (t) => {
  const { first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });
  const now = new Date('2026-07-23T14:00:00.000Z');
  const queue = new ApprovalQueue({
    store: first,
    signingKey: Buffer.alloc(32, 7),
    now: () => now,
    freshAuthVerifier: {
      async verify(assertion, context) {
        assert.equal(assertion, 'passkey-assertion');
        assert.equal(context.decision, 'approve');
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: 'assertion-1',
        };
      },
    },
  });

  const proposed = await queue.propose(intent, 'full-lifecycle');
  const proof = await queue.decide(
    proposed.actionId,
    'approve',
    'passkey-assertion',
  );
  assert.ok(proof);
  assert.deepEqual(await queue.consume(proof, intent.expectedState), intent);
  await assert.rejects(queue.consume(proof, intent.expectedState), /consumed, not approved/);
});

test('atomically consumes an approval into the encrypted outbox', async (t) => {
  const { path, first, second } = await stores();
  const now = new Date('2026-07-23T14:00:00.000Z');
  const queue = new ApprovalQueue({
    store: first,
    signingKey: Buffer.alloc(32, 19),
    now: () => now,
    freshAuthVerifier: {
      async verify() {
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: 'outbox-assertion',
        };
      },
    },
  });
  const proposed = await queue.propose(intent, 'atomic-outbox');
  const proof = await queue.decide(proposed.actionId, 'approve', {});
  assert.ok(proof);

  const consumed = await queue.consumeToOutbox(proof, intent.expectedState);
  assert.deepEqual(consumed, intent);
  assert.equal((await first.get(proposed.actionId)).status, 'consumed');

  const outbox = new SqliteDurableOutbox(path, {
    encryptionKey: Buffer.alloc(32, 17),
  });
  t.after(() => {
    outbox.close();
    first.close();
    second.close();
  });
  const queued = outbox.get(proposed.actionId);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.kind, intent.kind);
  assert.equal(queued.payloadHash, hashActionIntent(intent));
  assert.deepEqual(queued.payload, intent);
});

test('rolls back outbox insertion when approval state validation fails', async (t) => {
  const { path, first, second } = await stores();
  const now = new Date('2026-07-23T14:00:00.000Z');
  const queue = new ApprovalQueue({
    store: first,
    signingKey: Buffer.alloc(32, 20),
    now: () => now,
    freshAuthVerifier: {
      async verify() {
        return {
          actor: 'vinzenz',
          authenticatedAt: now.toISOString(),
          method: 'passkey',
          assertionId: 'rollback-assertion',
        };
      },
    },
  });
  const proposed = await queue.propose(intent, 'atomic-outbox-rollback');
  const proof = await queue.decide(proposed.actionId, 'approve', {});
  assert.ok(proof);
  await assert.rejects(
    queue.consumeToOutbox(proof, { changed: true }),
    /state changed/,
  );
  assert.equal((await first.get(proposed.actionId)).status, 'approved');

  const database = new DatabaseSync(path, { readOnly: true });
  t.after(() => {
    database.close();
    first.close();
    second.close();
  });
  assert.equal(
    (
      database.prepare('SELECT COUNT(*) AS count FROM durable_outbox')
        .get() as { count: number }
    ).count,
    0,
  );
});

test('purges expired or retention-ended encrypted records but preserves audit history', async (t) => {
  const { path, first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });
  await first.propose(record('expired-pending'), '2026-07-23T14:00:00.000Z');
  const result = await first.cleanup(
    '2026-07-23T14:16:00.000Z',
    '2026-07-22T14:16:00.000Z',
  );
  assert.deepEqual(result, {
    expiredPendingOrApproved: 1,
    retainedDecisionRecords: 0,
  });
  await assert.rejects(first.get('expired-pending'), /unknown action/);

  const audit = new DatabaseSync(path, { readOnly: true });
  t.after(() => audit.close());
  assert.deepEqual(
    audit.prepare(`
      SELECT event, action_id, details_json
      FROM approval_audit
      ORDER BY sequence
    `).all().map((row) => ({ ...row })),
    [
      {
        event: 'proposed',
        action_id: 'expired-pending',
        details_json: '{"idempotencyKey":"same-request"}',
      },
      {
        event: 'purged',
        action_id: 'expired-pending',
        details_json: '{"priorStatus":"pending"}',
      },
    ],
  );
});
