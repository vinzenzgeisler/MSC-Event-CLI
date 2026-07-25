import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableOutbox, type OutboxCommand } from '../src/durable-outbox.js';

const key = Buffer.alloc(32, 41);
const now = '2026-07-25T20:15:00.000Z';

const command = (actionId = 'action-1'): OutboxCommand => ({
  actionId,
  payloadHash: 'a'.repeat(64),
  kind: 'mail.send',
  payload: {
    account: 'msc-info',
    from: 'info@example.invalid',
    to: 'recipient@example.invalid',
    subject: 'Verbindlicher Test',
    bodyText: 'Sensitive message body',
  },
  createdAt: now,
});

test('enqueues idempotently while rejecting action-id payload conflicts', () => {
  const outbox = new SqliteDurableOutbox(':memory:', { encryptionKey: key });
  const first = outbox.enqueue(command());
  const replay = outbox.enqueue(command());
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.record, first.record);
  assert.throws(
    () => outbox.enqueue({
      ...command(),
      payloadHash: 'b'.repeat(64),
    }),
    /different outbox payload/,
  );
  outbox.close();
});

test('allows only one worker to claim a queued action', () => {
  const directory = mkdtempSync(join(tmpdir(), 'msc-outbox-claim-'));
  const path = join(directory, 'outbox.sqlite');
  const first = new SqliteDurableOutbox(path, { encryptionKey: key });
  const second = new SqliteDurableOutbox(path, { encryptionKey: key });
  first.enqueue(command());

  const claimed = first.claim('action-1', 'worker-a', now);
  assert.equal(claimed.status, 'dispatching');
  assert.equal(claimed.workerId, 'worker-a');
  assert.ok(claimed.attemptId);
  assert.throws(
    () => second.claim('action-1', 'worker-b', now),
    /dispatching, not queued/,
  );
  first.close();
  second.close();
});

test('binds provider acceptance state to the active attempt', () => {
  const outbox = new SqliteDurableOutbox(':memory:', { encryptionKey: key });
  outbox.enqueue(command());
  const claimed = outbox.claim('action-1', 'worker-a', now);
  assert.throws(
    () => outbox.markAccepted('action-1', 'wrong-attempt', now),
    /does not match/,
  );
  const accepted = outbox.markAccepted(
    'action-1',
    claimed.attemptId!,
    '2026-07-25T20:15:01.000Z',
  );
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.acceptedAt, '2026-07-25T20:15:01.000Z');
  assert.deepEqual(outbox.queued(), []);
  outbox.close();
});

test('quarantines uncertain outcomes instead of retrying automatically', () => {
  const outbox = new SqliteDurableOutbox(':memory:', { encryptionKey: key });
  outbox.enqueue(command());
  const claimed = outbox.claim('action-1', 'worker-a', now);
  const uncertain = outbox.markUncertain(
    'action-1',
    claimed.attemptId!,
    '2026-07-25T20:15:10.000Z',
    'connection-lost',
  );
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.uncertaintyCode, 'connection-lost');
  assert.deepEqual(
    outbox.requiringReconciliation().map((record) => record.actionId),
    ['action-1'],
  );
  assert.throws(
    () => outbox.claim('action-1', 'worker-b', '2026-07-25T20:16:00.000Z'),
    /uncertain, not queued/,
  );
  outbox.close();
});

test('cancels only actions that have not entered dispatch', () => {
  const outbox = new SqliteDurableOutbox(':memory:', { encryptionKey: key });
  outbox.enqueue(command('queued-action'));
  assert.equal(
    outbox.cancelQueued('queued-action', '2026-07-25T20:15:05.000Z').status,
    'cancelled',
  );
  outbox.enqueue(command('claimed-action'));
  outbox.claim('claimed-action', 'worker-a', now);
  assert.throws(
    () => outbox.cancelQueued('claimed-action', '2026-07-25T20:15:05.000Z'),
    /dispatching, not queued/,
  );
  outbox.close();
});

test('encrypts sensitive payload fields at rest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msc-outbox-encryption-'));
  const path = join(directory, 'outbox.sqlite');
  const outbox = new SqliteDurableOutbox(path, { encryptionKey: key });
  outbox.enqueue(command());
  outbox.close();

  const databaseBytes = await readFile(path);
  const raw = databaseBytes.toString('utf8');
  assert.equal(raw.includes('recipient@example.invalid'), false);
  assert.equal(raw.includes('Sensitive message body'), false);

  const reopened = new SqliteDurableOutbox(path, { encryptionKey: key });
  assert.deepEqual(reopened.get('action-1').payload, command().payload);
  reopened.close();
});
