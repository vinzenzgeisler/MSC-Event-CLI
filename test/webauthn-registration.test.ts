import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  RegistrationResponseJSON,
  VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import {
  InMemoryWebAuthnRegistrationChallengeStore,
  WebAuthnRegistrationService,
} from '../src/webauthn-registration.js';
import type {
  RegisteredWebAuthnCredential,
  WebAuthnCredentialRepository,
} from '../src/webauthn.js';

const registrationResponse = (id = 'credential-new'): RegistrationResponseJSON => ({
  id,
  rawId: id,
  response: {
    clientDataJSON: 'client-data',
    attestationObject: 'attestation-object',
    transports: ['internal'],
  },
  type: 'public-key',
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
});

const verifiedRegistration = (
  id = 'credential-new',
  userVerified = true,
): VerifiedRegistrationResponse => ({
  verified: true,
  registrationInfo: {
    fmt: 'none',
    aaguid: '00000000-0000-0000-0000-000000000000',
    credential: {
      id,
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 0,
      transports: ['internal'],
    },
    credentialType: 'public-key',
    attestationObject: new Uint8Array([1]),
    userVerified,
    credentialDeviceType: 'multiDevice',
    credentialBackedUp: true,
    origin: 'https://approve.example.test',
    rpID: 'approve.example.test',
  },
});

const fixture = () => {
  let now = new Date('2026-07-23T14:00:00.000Z');
  const credentials: RegisteredWebAuthnCredential[] = [{
    credentialId: 'credential-existing',
    actor: 'vinzenz',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 7,
    revision: 2,
    transports: ['internal'],
  }];
  let verification = verifiedRegistration();
  const verificationCalls: Array<
    Parameters<NonNullable<ConstructorParameters<typeof WebAuthnRegistrationService>[0]['verifyRegistration']>>[0]
  > = [];
  const repository: WebAuthnCredentialRepository & {
    registerCredential(credential: RegisteredWebAuthnCredential): Promise<void>;
  } = {
    async listByActor(actor) {
      return credentials.filter((credential) => credential.actor === actor).map((credential) => structuredClone(credential));
    },
    async findById(id) {
      const credential = credentials.find((item) => item.credentialId === id);
      return credential ? structuredClone(credential) : undefined;
    },
    async updateCounter() {
      throw new Error('not used by registration');
    },
    async registerCredential(credential) {
      if (credentials.some((item) => item.credentialId === credential.credentialId)) {
        throw new Error('duplicate credential');
      }
      credentials.push(structuredClone(credential));
    },
  };
  const service = new WebAuthnRegistrationService({
    rpName: 'MSC Approval',
    rpId: 'approve.example.test',
    expectedOrigins: ['https://approve.example.test'],
    credentials: repository,
    challenges: new InMemoryWebAuthnRegistrationChallengeStore(),
    authorizeRegistration: async (actor, existingCredentialCount, authorization) => {
      assert.equal(actor, 'vinzenz');
      assert.equal(existingCredentialCount, 1);
      assert.deepEqual(authorization, { type: 'test-authorized' });
    },
    userIdForActor: async (actor) => {
      assert.equal(actor, 'vinzenz');
      return new Uint8Array([9, 8, 7]);
    },
    now: () => now,
    verifyRegistration: async (options) => {
      verificationCalls.push(options);
      return verification;
    },
  });
  return {
    service,
    credentials,
    verificationCalls,
    setVerification(value: VerifiedRegistrationResponse) {
      verification = value;
    },
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
};

test('creates a discoverable UV-required ceremony and excludes existing credentials', async () => {
  const { service } = fixture();
  const begun = await service.begin('vinzenz', 'Vinzenz', { type: 'test-authorized' });
  assert.equal(begun.options.rp.id, 'approve.example.test');
  assert.equal(begun.options.user.name, 'vinzenz');
  assert.equal(begun.options.user.id, 'CQgH');
  assert.equal(begun.options.user.displayName, 'Vinzenz');
  assert.equal(begun.options.authenticatorSelection?.residentKey, 'required');
  assert.equal(begun.options.authenticatorSelection?.userVerification, 'required');
  assert.equal(begun.options.attestation, 'none');
  assert.equal(begun.options.excludeCredentials?.[0]?.id, 'credential-existing');
});

test('verifies origin, RP, challenge and UV before storing the credential for the server actor', async () => {
  const { service, credentials, verificationCalls } = fixture();
  const begun = await service.begin('vinzenz', 'vinzenz', { type: 'test-authorized' });
  const registered = await service.complete({
    challengeId: begun.challengeId,
    response: registrationResponse(),
  });
  assert.deepEqual(registered, {
    credentialId: 'credential-new',
    actor: 'vinzenz',
    publicKey: new Uint8Array([4, 5, 6]),
    counter: 0,
    revision: 0,
    transports: ['internal'],
  });
  assert.equal(credentials.length, 2);
  assert.equal(verificationCalls[0]?.expectedChallenge, begun.options.challenge);
  assert.deepEqual(verificationCalls[0]?.expectedOrigin, ['https://approve.example.test']);
  assert.equal(verificationCalls[0]?.expectedRPID, 'approve.example.test');
  assert.equal(verificationCalls[0]?.requireUserVerification, true);
});

test('burns expired, failed-UV and mismatched-credential registration challenges', async () => {
  const expired = fixture();
  const expiredChallenge = await expired.service.begin('vinzenz', 'vinzenz', { type: 'test-authorized' });
  expired.advance(120_001);
  await assert.rejects(
    expired.service.complete({
      challengeId: expiredChallenge.challengeId,
      response: registrationResponse(),
    }),
    /expired/,
  );

  const noUv = fixture();
  noUv.setVerification(verifiedRegistration('credential-new', false));
  const noUvChallenge = await noUv.service.begin('vinzenz', 'vinzenz', { type: 'test-authorized' });
  await assert.rejects(
    noUv.service.complete({
      challengeId: noUvChallenge.challengeId,
      response: registrationResponse(),
    }),
    /user verification failed/,
  );

  const mismatch = fixture();
  mismatch.setVerification(verifiedRegistration('credential-other'));
  const mismatchChallenge = await mismatch.service.begin('vinzenz', 'vinzenz', { type: 'test-authorized' });
  await assert.rejects(
    mismatch.service.complete({
      challengeId: mismatchChallenge.challengeId,
      response: registrationResponse(),
    }),
    /credential id mismatch/,
  );
  await assert.rejects(
    mismatch.service.complete({
      challengeId: mismatchChallenge.challengeId,
      response: registrationResponse(),
    }),
    /unknown or already used/,
  );
});
