import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovalQueue, type ActionIntent, type FreshAuthContext, type FreshAuthVerifier, type VerifiedFreshAuth } from '../src/approval.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'event.update',
  summary: 'Teilnahme von Eintrag 123 annehmen',
  target: { type: 'registration', id: 'entry/123/acceptance', label: 'Eintrag 123' },
  before: { status: 'pending' },
  after: { status: 'accepted' },
  expectedState: { status: 'pending', version: 7 },
};

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-approval-'));
  let now = new Date('2026-07-22T15:00:00.000Z');
  const assertions = new Map<string, VerifiedFreshAuth & { context: FreshAuthContext }>();
  const freshAuthVerifier: FreshAuthVerifier = {
    async verify(assertion, context) {
      if (typeof assertion !== 'string') throw new Error('fresh re-authentication is required');
      const verified = assertions.get(assertion);
      if (!verified) throw new Error('fresh re-authentication is invalid or already used');
      assertions.delete(assertion);
      assert.deepEqual(verified.context, context);
      return verified;
    },
  };
  const queue = new ApprovalQueue({
    storePath: join(directory, 'queue.json'),
    auditPath: join(directory, 'audit.jsonl'),
    signingKey: Buffer.alloc(32, 7),
    freshAuthVerifier,
    now: () => now,
  });
  const authenticate = (record: { actionId: string; payloadHash: string }, decision: 'approve' | 'reject' = 'approve', authenticatedAt = now.toISOString()) => {
    const token = `assertion-${assertions.size + 1}-${record.actionId}`;
    assertions.set(token, {
      actor: 'vinzenz',
      authenticatedAt,
      method: 'webauthn',
      assertionId: token,
      context: { actionId: record.actionId, payloadHash: record.payloadHash, decision },
    });
    return token;
  };
  return { directory, queue, authenticate, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
};

test('requires re-authentication, binds approval to state, and consumes exactly once', async () => {
  const { queue, authenticate } = await fixture();
  const proposed = await queue.propose(intent, 'ticket-123');
  assert.deepEqual(proposed.intent.before, { status: 'pending' });
  assert.deepEqual(proposed.intent.after, { status: 'accepted' });
  await assert.rejects(queue.decide(proposed.actionId, 'approve', false), /re-authentication/);
  const token = await queue.decide(proposed.actionId, 'approve', authenticate(proposed));
  assert.ok(token);
  assert.deepEqual(await queue.consume(token, intent.expectedState), intent);
  await assert.rejects(queue.consume(token, intent.expectedState), /consumed, not approved/);
});

test('rejects stale state, expired actions, rejected actions, and tampered proofs', async () => {
  const stale = await fixture();
  const staleRecord = await stale.queue.propose(intent, 'stale');
  const staleToken = await stale.queue.decide(staleRecord.actionId, 'approve', stale.authenticate(staleRecord));
  await assert.rejects(stale.queue.consume(staleToken!, { status: 'accepted', version: 8 }), /state changed/);

  const expired = await fixture();
  const expiredRecord = await expired.queue.propose(intent, 'expired', 1);
  expired.advance(1001);
  await assert.rejects(expired.queue.decide(expiredRecord.actionId, 'approve', expired.authenticate(expiredRecord)), /expired/);

  const rejected = await fixture();
  const rejectedRecord = await rejected.queue.propose(intent, 'rejected');
  assert.equal(await rejected.queue.decide(rejectedRecord.actionId, 'reject', rejected.authenticate(rejectedRecord, 'reject')), undefined);
  await assert.rejects(rejected.queue.decide(rejectedRecord.actionId, 'approve', rejected.authenticate(rejectedRecord)), /rejected, not pending/);

  const tampered = await fixture();
  const tamperedRecord = await tampered.queue.propose(intent, 'tampered');
  const token = await tampered.queue.decide(tamperedRecord.actionId, 'approve', tampered.authenticate(tamperedRecord));
  await assert.rejects(tampered.queue.consume(`${token}x`, intent.expectedState), /signature/);
});

test('enforces idempotency and writes an append-only lifecycle audit', async () => {
  const { queue, directory, authenticate } = await fixture();
  const first = await queue.propose(intent, 'same-request');
  const replay = await queue.propose({ ...intent }, 'same-request');
  assert.equal(replay.actionId, first.actionId);
  await assert.rejects(queue.propose({ ...intent, after: { status: 'rejected' } }, 'same-request'), /different payload/);
  const token = await queue.decide(first.actionId, 'approve', authenticate(first));
  await queue.consume(token!, intent.expectedState);
  const events = (await readFile(join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepEqual(events, ['proposed', 'approved', 'consumed']);
});

test('binds fresh authentication to action, payload and decision and rejects stale or replayed assertions', async () => {
  const wrongDecision = await fixture();
  const record = await wrongDecision.queue.propose(intent, 'bound-auth');
  await assert.rejects(
    wrongDecision.queue.decide(record.actionId, 'reject', wrongDecision.authenticate(record, 'approve')),
    /Expected values to be strictly deep-equal/,
  );

  const stale = await fixture();
  const staleRecord = await stale.queue.propose(intent, 'stale-auth');
  const assertion = stale.authenticate(staleRecord, 'approve', '2026-07-22T14:54:59.999Z');
  await assert.rejects(stale.queue.decide(staleRecord.actionId, 'approve', assertion), /re-authentication is stale/);

  const replay = await fixture();
  const replayRecord = await replay.queue.propose(intent, 'replayed-auth');
  const replayAssertion = replay.authenticate(replayRecord);
  const proof = await replay.queue.decide(replayRecord.actionId, 'approve', replayAssertion);
  assert.ok(proof);
  const secondRecord = await replay.queue.propose({ ...intent, target: { ...intent.target, id: 'entry/456/acceptance' } }, 'second-action');
  await assert.rejects(replay.queue.decide(secondRecord.actionId, 'approve', replayAssertion), /invalid or already used/);
});
