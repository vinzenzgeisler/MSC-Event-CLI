import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticationResponseJSON, VerifiedAuthenticationResponse } from '@simplewebauthn/server';
import type { FreshAuthContext } from '../src/approval.js';
import {
  InMemoryWebAuthnChallengeStore,
  WebAuthnFreshAuthVerifier,
  type RegisteredWebAuthnCredential,
  type WebAuthnCredentialRepository,
} from '../src/webauthn.js';

const context: FreshAuthContext = {
  actionId: 'action-123',
  payloadHash: 'abc123',
  decision: 'approve',
};

const response = (id = 'credential-vinzenz'): AuthenticationResponseJSON => ({
  id,
  rawId: id,
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
  type: 'public-key',
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
});

const verified = (newCounter = 8, userVerified = true): VerifiedAuthenticationResponse => ({
  verified: true,
  authenticationInfo: {
    credentialID: 'credential-vinzenz',
    newCounter,
    userVerified,
    credentialDeviceType: 'singleDevice',
    credentialBackedUp: false,
    origin: 'https://approve.example.test',
    rpID: 'approve.example.test',
  },
});

const fixture = (overrides: { credential?: RegisteredWebAuthnCredential; now?: Date } = {}) => {
  let now = overrides.now ?? new Date('2026-07-23T13:00:00.000Z');
  const credential: RegisteredWebAuthnCredential = overrides.credential ?? {
    credentialId: 'credential-vinzenz',
    actor: 'vinzenz',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 7,
    revision: 3,
    transports: ['internal'],
  };
  const updates: Array<{ id: string; expected: number; revision: number; next: number }> = [];
  let beforeCounterUpdate: (() => void) | undefined;
  const repository: WebAuthnCredentialRepository = {
    async listByActor(actor) {
      return credential.actor === actor ? [structuredClone(credential)] : [];
    },
    async findById(id) {
      return credential.credentialId === id ? structuredClone(credential) : undefined;
    },
    async updateCounter(id, expected, revision, next) {
      beforeCounterUpdate?.();
      beforeCounterUpdate = undefined;
      if (credential.counter !== expected || credential.revision !== revision) {
        throw new Error('credential counter changed concurrently');
      }
      updates.push({ id, expected, revision, next });
      credential.counter = next;
      credential.revision += 1;
    },
  };
  const verificationCalls: Array<Parameters<NonNullable<ConstructorParameters<typeof WebAuthnFreshAuthVerifier>[0]['verifyAuthentication']>>[0]> = [];
  let verificationResult = verified();
  const verifier = new WebAuthnFreshAuthVerifier({
    rpId: 'approve.example.test',
    expectedOrigins: ['https://approve.example.test'],
    credentials: repository,
    challenges: new InMemoryWebAuthnChallengeStore(),
    now: () => now,
    verifyAuthentication: async (options) => {
      verificationCalls.push(options);
      return verificationResult;
    },
  });
  return {
    verifier,
    credential,
    updates,
    verificationCalls,
    setVerificationResult: (value: VerifiedAuthenticationResponse) => {
      verificationResult = value;
    },
    setBeforeCounterUpdate: (callback: () => void) => {
      beforeCounterUpdate = callback;
    },
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
};

test('requires registered reviewer credential and creates a UV-required RP-bound ceremony', async () => {
  const { verifier } = fixture();
  await assert.rejects(verifier.begin('another-reviewer', context), /no registered/);
  const begun = await verifier.begin('vinzenz', context);
  assert.equal(begun.options.rpId, 'approve.example.test');
  assert.equal(begun.options.userVerification, 'required');
  assert.equal(begun.options.allowCredentials?.[0]?.id, 'credential-vinzenz');
  assert.equal(begun.options.timeout, 120_000);
});

test('binds action, payload, decision, RP ID, origin, credential ownership, UV and counter update', async () => {
  const { verifier, updates, verificationCalls } = fixture();
  const begun = await verifier.begin('vinzenz', context);
  const freshAuth = await verifier.verify({ challengeId: begun.challengeId, response: response() }, context);
  assert.equal(freshAuth.actor, 'vinzenz');
  assert.equal(freshAuth.method, 'passkey');
  assert.deepEqual(updates, [{ id: 'credential-vinzenz', expected: 7, revision: 3, next: 8 }]);
  const call = verificationCalls[0]!;
  assert.equal(call.expectedChallenge, begun.options.challenge);
  assert.equal(call.expectedRPID, 'approve.example.test');
  assert.deepEqual(call.expectedOrigin, ['https://approve.example.test']);
  assert.equal(call.requireUserVerification, true);
  assert.equal(call.credential.counter, 7);
});

test('burns challenges on mismatch, expiry, failed ownership and replay', async () => {
  const mismatch = fixture();
  const mismatched = await mismatch.verifier.begin('vinzenz', context);
  await assert.rejects(
    mismatch.verifier.verify(
      { challengeId: mismatched.challengeId, response: response() },
      { ...context, decision: 'reject' },
    ),
    /does not match/,
  );
  await assert.rejects(
    mismatch.verifier.verify({ challengeId: mismatched.challengeId, response: response() }, context),
    /unknown or already used/,
  );

  const expired = fixture();
  const expiredChallenge = await expired.verifier.begin('vinzenz', context);
  expired.advance(120_001);
  await assert.rejects(
    expired.verifier.verify({ challengeId: expiredChallenge.challengeId, response: response() }, context),
    /expired/,
  );

  const ownership = fixture();
  const ownedChallenge = await ownership.verifier.begin('vinzenz', context);
  await assert.rejects(
    ownership.verifier.verify({ challengeId: ownedChallenge.challengeId, response: response('credential-other') }, context),
    /not owned/,
  );
});

test('rejects missing UV and concurrent signature-counter reuse', async () => {
  const noUv = fixture();
  noUv.setVerificationResult(verified(8, false));
  const noUvChallenge = await noUv.verifier.begin('vinzenz', context);
  await assert.rejects(
    noUv.verifier.verify({ challengeId: noUvChallenge.challengeId, response: response() }, context),
    /user verification failed/,
  );

  const counterRace = fixture();
  const challenge = await counterRace.verifier.begin('vinzenz', context);
  counterRace.setBeforeCounterUpdate(() => {
    counterRace.credential.counter = 9;
  });
  await assert.rejects(
    counterRace.verifier.verify({ challengeId: challenge.challengeId, response: response() }, context),
    /counter changed concurrently/,
  );

  const syncedPasskeyRace = fixture({
    credential: {
      credentialId: 'credential-vinzenz',
      actor: 'vinzenz',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      revision: 11,
      transports: ['internal'],
    },
  });
  syncedPasskeyRace.setVerificationResult(verified(0));
  const syncedChallenge = await syncedPasskeyRace.verifier.begin('vinzenz', context);
  syncedPasskeyRace.setBeforeCounterUpdate(() => {
    syncedPasskeyRace.credential.revision += 1;
  });
  await assert.rejects(
    syncedPasskeyRace.verifier.verify(
      { challengeId: syncedChallenge.challengeId, response: response() },
      context,
    ),
    /counter changed concurrently/,
  );
});

test('rejects unsafe RP and origin configuration', () => {
  const base = fixture();
  const options = {
    credentials: {} as WebAuthnCredentialRepository,
    challenges: new InMemoryWebAuthnChallengeStore(),
  };
  assert.throws(
    () => new WebAuthnFreshAuthVerifier({ ...options, rpId: 'https://approve.example.test', expectedOrigins: ['https://approve.example.test'] }),
    /rpId/,
  );
  assert.throws(
    () => new WebAuthnFreshAuthVerifier({ ...options, rpId: 'approve.example.test', expectedOrigins: ['http://approve.example.test'] }),
    /HTTPS/,
  );
  assert.ok(base.verifier);
});
