import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createInitialPasskeyBootstrapAuthorizer,
  InMemoryPasskeyBootstrapGrantStore,
  PasskeyBootstrapService,
} from '../src/passkey-bootstrap.js';
import { SqliteWebAuthnStore } from '../src/webauthn-sqlite.js';

const fixture = () => {
  let now = new Date('2026-07-23T16:00:00.000Z');
  const service = new PasskeyBootstrapService({
    grants: new InMemoryPasskeyBootstrapGrantStore(),
    now: () => now,
    ttlSeconds: 60,
  });
  return {
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
};

const operator = {
  operatorId: 'uid:1000',
  authenticationMethod: 'local-os-user' as const,
};

test('issues an opaque actor-bound code and consumes it exactly once', async () => {
  const { service } = fixture();
  const issued = await service.issue('vinzenz', operator);
  assert.equal(issued.actor, 'vinzenz');
  assert.match(
    issued.code,
    /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
  );
  await service.consume('vinzenz', issued.code);
  await assert.rejects(
    service.consume('vinzenz', issued.code),
    /unknown or already used/,
  );
});

test('burns actor-mismatched, modified and expired codes', async () => {
  const actorMismatch = fixture();
  const actorCode = await actorMismatch.service.issue('vinzenz', operator);
  await assert.rejects(
    actorMismatch.service.consume('mallory', actorCode.code),
    /invalid or expired/,
  );
  await assert.rejects(
    actorMismatch.service.consume('vinzenz', actorCode.code),
    /unknown or already used/,
  );

  const modified = fixture();
  const modifiedCode = await modified.service.issue('vinzenz', operator);
  const last = modifiedCode.code.at(-1);
  const replacement = last === 'A' ? 'B' : 'A';
  await assert.rejects(
    modified.service.consume(
      'vinzenz',
      `${modifiedCode.code.slice(0, -1)}${replacement}`,
    ),
    /invalid or expired/,
  );

  const expired = fixture();
  const expiredCode = await expired.service.issue('vinzenz', operator);
  expired.advance(60_001);
  await assert.rejects(
    expired.service.consume('vinzenz', expiredCode.code),
    /invalid or expired/,
  );
});

test('initial registration authorizer rejects browser-only and later enrollment', async () => {
  const { service } = fixture();
  const authorize = createInitialPasskeyBootstrapAuthorizer(service);
  await assert.rejects(
    authorize('vinzenz', 0, undefined),
    /separately issued bootstrap/,
  );
  const issued = await service.issue('vinzenz', operator);
  await assert.rejects(
    authorize('vinzenz', 1, { type: 'bootstrap', code: issued.code }),
    /already exists/,
  );
  await authorize('vinzenz', 0, { type: 'bootstrap', code: issued.code });
});

test('SQLite grants are atomically consumed across service connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'passkey-bootstrap-'));
  const path = join(directory, 'state.sqlite');
  const issuerStore = new SqliteWebAuthnStore(path);
  const consumerStore = new SqliteWebAuthnStore(path);
  try {
    const issuer = new PasskeyBootstrapService({
      grants: issuerStore,
      ttlSeconds: 60,
    });
    const consumer = new PasskeyBootstrapService({
      grants: consumerStore,
      ttlSeconds: 60,
    });
    const issued = await issuer.issue('vinzenz', operator);
    const results = await Promise.allSettled([
      issuer.consume('vinzenz', issued.code),
      consumer.consume('vinzenz', issued.code),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    const audit = issuerStore.bootstrapAuditEvents();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.operatorId, operator.operatorId);
    assert.equal(JSON.stringify(audit).includes(issued.code), false);
    await assert.rejects(
      issuer.issue('vinzenz', operator),
      /UNIQUE constraint failed/,
    );
  } finally {
    issuerStore.close();
    consumerStore.close();
  }
});

test('records issuance audit without storing the plaintext bootstrap code', async () => {
  const grants = new InMemoryPasskeyBootstrapGrantStore();
  const service = new PasskeyBootstrapService({ grants, ttlSeconds: 60 });
  const issued = await service.issue('vinzenz', operator);
  const events = grants.bootstrapAuditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor, 'vinzenz');
  assert.equal(events[0]!.operatorId, operator.operatorId);
  assert.equal(events[0]!.authenticationMethod, 'local-os-user');
  assert.equal(JSON.stringify(events).includes(issued.code), false);
  assert.equal(JSON.stringify(events).includes(issued.code.split('.')[1]!), false);
});

test('allows only one initial bootstrap grant per actor even after consumption', async () => {
  const grants = new InMemoryPasskeyBootstrapGrantStore();
  const service = new PasskeyBootstrapService({ grants, ttlSeconds: 60 });
  const issued = await service.issue('vinzenz', operator);
  await assert.rejects(
    service.issue('vinzenz', operator),
    /already exists/,
  );
  await service.consume('vinzenz', issued.code);
  await assert.rejects(
    service.issue('vinzenz', operator),
    /already exists/,
  );
});

test('cleans only expired unused bootstrap grants and keeps consumed trust locks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'passkey-cleanup-'));
  const store = new SqliteWebAuthnStore(join(directory, 'state.sqlite'));
  try {
    let now = new Date('2026-07-23T16:00:00.000Z');
    const bootstrap = new PasskeyBootstrapService({
      grants: store,
      ttlSeconds: 60,
      now: () => now,
    });
    const unused = await bootstrap.issue('unused', operator);
    const consumed = await bootstrap.issue('consumed', operator);
    await bootstrap.consume('consumed', consumed.code);
    now = new Date('2026-07-23T16:01:01.000Z');
    assert.deepEqual(store.cleanupExpiredEphemeral(now.toISOString()), {
      authenticationChallenges: 0,
      registrationChallenges: 0,
      unusedBootstrapGrants: 1,
    });
    await assert.rejects(bootstrap.consume('unused', unused.code));
    await assert.rejects(
      bootstrap.issue('consumed', operator),
      /UNIQUE constraint failed/,
    );
    assert.equal(
      (await bootstrap.issue('unused', operator)).actor,
      'unused',
    );
  } finally {
    store.close();
  }
});
