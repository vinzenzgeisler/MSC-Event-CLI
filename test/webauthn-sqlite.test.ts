import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteWebAuthnStore } from '../src/webauthn-sqlite.js';
import type { WebAuthnRegistrationChallenge } from '../src/webauthn-registration.js';
import type { RegisteredWebAuthnCredential, WebAuthnChallenge } from '../src/webauthn.js';

const credential: RegisteredWebAuthnCredential = {
  credentialId: 'credential-vinzenz',
  actor: 'vinzenz',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  revision: 0,
  transports: ['internal', 'hybrid'],
};

const challenge: WebAuthnChallenge = {
  challengeId: 'challenge-1',
  challenge: 'random-challenge',
  actor: 'vinzenz',
  context: {
    actionId: 'action-123',
    payloadHash: 'abc123',
    decision: 'approve',
  },
  issuedAt: '2026-07-23T14:00:00.000Z',
  expiresAt: '2026-07-23T14:02:00.000Z',
};

const registrationChallenge: WebAuthnRegistrationChallenge = {
  challengeId: 'registration-1',
  challenge: 'registration-challenge',
  actor: 'vinzenz',
  issuedAt: '2026-07-23T14:00:00.000Z',
  expiresAt: '2026-07-23T14:02:00.000Z',
};

const stores = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'msc-webauthn-sqlite-'));
  const path = join(directory, 'webauthn.sqlite');
  return {
    first: new SqliteWebAuthnStore(path),
    second: new SqliteWebAuthnStore(path),
  };
};

test('round-trips credentials and atomically consumes a challenge across connections', async (t) => {
  const { first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });

  await first.registerCredential(credential);
  assert.deepEqual(await second.findById(credential.credentialId), credential);
  assert.deepEqual(await second.listByActor('vinzenz'), [credential]);

  await first.save(challenge);
  const consumed = await Promise.all([first.take(challenge.challengeId), second.take(challenge.challengeId)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  assert.deepEqual(consumed.find(Boolean), challenge);

  await first.saveRegistration(registrationChallenge);
  const registrationConsumed = await Promise.all([
    first.takeRegistration(registrationChallenge.challengeId),
    second.takeRegistration(registrationChallenge.challengeId),
  ]);
  assert.equal(registrationConsumed.filter(Boolean).length, 1);
  assert.deepEqual(registrationConsumed.find(Boolean), registrationChallenge);
});

test('revision compare-and-update rejects stale synced-passkey snapshots even when counters stay zero', async (t) => {
  const { first, second } = await stores();
  t.after(() => {
    first.close();
    second.close();
  });

  await first.registerCredential(credential);
  const stale = await first.findById(credential.credentialId);
  const concurrent = await second.findById(credential.credentialId);
  assert.ok(stale);
  assert.ok(concurrent);

  await second.updateCounter(
    concurrent.credentialId,
    concurrent.counter,
    concurrent.revision,
    0,
  );
  await assert.rejects(
    first.updateCounter(stale.credentialId, stale.counter, stale.revision, 0),
    /changed concurrently/,
  );

  assert.deepEqual(await first.findById(credential.credentialId), {
    ...credential,
    revision: 1,
  });
});
