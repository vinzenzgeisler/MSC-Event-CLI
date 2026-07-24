import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import {
  validateWebAuthnRelyingPartyConfiguration,
  type RegisteredWebAuthnCredential,
  type WebAuthnCredentialRepository,
} from './webauthn.js';

export interface WebAuthnRegistrationChallenge {
  challengeId: string;
  challenge: string;
  actor: string;
  issuedAt: string;
  expiresAt: string;
}

export interface WebAuthnRegistrationChallengeStore {
  saveRegistration(challenge: WebAuthnRegistrationChallenge): Promise<void>;
  takeRegistration(challengeId: string): Promise<WebAuthnRegistrationChallenge | undefined>;
}

export interface CompleteWebAuthnRegistration {
  challengeId: string;
  response: RegistrationResponseJSON;
}

export interface BeginWebAuthnRegistrationResult {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  expiresAt: string;
}

type VerifyRegistration = (
  options: Parameters<typeof verifyRegistrationResponse>[0],
) => Promise<VerifiedRegistrationResponse>;

export interface WebAuthnRegistrationOptions {
  rpName: string;
  rpId: string;
  expectedOrigins: string[];
  credentials: WebAuthnCredentialRepository & {
    registerCredential(credential: RegisteredWebAuthnCredential): Promise<void>;
  };
  challenges: WebAuthnRegistrationChallengeStore;
  userIdForActor(actor: string): Promise<Uint8Array>;
  authorizeRegistration(
    actor: string,
    existingCredentialCount: number,
    authorization: unknown,
  ): Promise<void>;
  challengeTtlSeconds?: number;
  now?: () => Date;
  verifyRegistration?: VerifyRegistration;
}

const parseCompletion = (value: unknown): CompleteWebAuthnRegistration => {
  if (!value || typeof value !== 'object') throw new Error('WebAuthn registration response is required');
  const completion = value as Partial<CompleteWebAuthnRegistration>;
  if (
    !completion.challengeId ||
    typeof completion.challengeId !== 'string' ||
    !completion.response ||
    typeof completion.response !== 'object' ||
    typeof completion.response.id !== 'string'
  ) {
    throw new Error('WebAuthn registration response is malformed');
  }
  return completion as CompleteWebAuthnRegistration;
};

/**
 * Registration boundary for a reviewer identity already authenticated by the
 * trusted server. Initial enrollment still needs an out-of-band bootstrap or
 * an existing strong credential in production.
 */
export class WebAuthnRegistrationService {
  private readonly now: () => Date;
  private readonly challengeTtlSeconds: number;
  private readonly verifyRegistration: VerifyRegistration;

  constructor(private readonly options: WebAuthnRegistrationOptions) {
    validateWebAuthnRelyingPartyConfiguration(options);
    if (!options.rpName.trim()) throw new Error('rpName is required');
    if (typeof options.userIdForActor !== 'function') {
      throw new Error('server-side WebAuthn user id resolver is required');
    }
    if (typeof options.authorizeRegistration !== 'function') {
      throw new Error('separate WebAuthn registration authorizer is required');
    }
    this.now = options.now ?? (() => new Date());
    this.challengeTtlSeconds = options.challengeTtlSeconds ?? 120;
    this.verifyRegistration = options.verifyRegistration ?? verifyRegistrationResponse;
  }

  async begin(
    actor: string,
    displayName = actor,
    authorization?: unknown,
  ): Promise<BeginWebAuthnRegistrationResult> {
    if (!actor.trim()) throw new Error('authenticated reviewer identity is required');
    if (!displayName.trim()) throw new Error('reviewer display name is required');
    const existing = await this.options.credentials.listByActor(actor);
    await this.options.authorizeRegistration(
      actor,
      existing.length,
      authorization,
    );
    const userID = await this.options.userIdForActor(actor);
    if (!(userID instanceof Uint8Array) || userID.byteLength < 1 || userID.byteLength > 64) {
      throw new Error('server-side WebAuthn user id must contain between 1 and 64 bytes');
    }
    const options = await generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: this.options.rpId,
      userName: actor,
      userID: Uint8Array.from(userID),
      userDisplayName: displayName,
      timeout: this.challengeTtlSeconds * 1000,
      attestationType: 'none',
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        ...(credential.transports ? { transports: credential.transports } : {}),
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.challengeTtlSeconds * 1000).toISOString();
    const challengeId = randomUUID();
    await this.options.challenges.saveRegistration({
      challengeId,
      challenge: options.challenge,
      actor,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
    });
    return { challengeId, options, expiresAt };
  }

  async complete(value: unknown): Promise<RegisteredWebAuthnCredential> {
    const completion = parseCompletion(value);
    const challenge = await this.options.challenges.takeRegistration(completion.challengeId);
    if (!challenge) throw new Error('WebAuthn registration challenge is unknown or already used');
    if (Date.parse(challenge.expiresAt) <= this.now().getTime()) {
      throw new Error('WebAuthn registration challenge has expired');
    }

    const verification = await this.verifyRegistration({
      response: completion.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.options.expectedOrigins,
      expectedRPID: this.options.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo.userVerified) {
      throw new Error('WebAuthn registration user verification failed');
    }
    if (verification.registrationInfo.credential.id !== completion.response.id) {
      throw new Error('WebAuthn registration credential id mismatch');
    }

    const credential: RegisteredWebAuthnCredential = {
      credentialId: verification.registrationInfo.credential.id,
      actor: challenge.actor,
      publicKey: verification.registrationInfo.credential.publicKey,
      counter: verification.registrationInfo.credential.counter,
      revision: 0,
      ...(verification.registrationInfo.credential.transports
        ? { transports: verification.registrationInfo.credential.transports }
        : {}),
    };
    await this.options.credentials.registerCredential(credential);
    return credential;
  }
}

export class InMemoryWebAuthnRegistrationChallengeStore
  implements WebAuthnRegistrationChallengeStore
{
  private readonly records = new Map<string, WebAuthnRegistrationChallenge>();

  async saveRegistration(challenge: WebAuthnRegistrationChallenge): Promise<void> {
    if (this.records.has(challenge.challengeId)) {
      throw new Error('duplicate WebAuthn registration challenge id');
    }
    this.records.set(challenge.challengeId, structuredClone(challenge));
  }

  async takeRegistration(
    challengeId: string,
  ): Promise<WebAuthnRegistrationChallenge | undefined> {
    const challenge = this.records.get(challengeId);
    if (!challenge) return undefined;
    this.records.delete(challengeId);
    return structuredClone(challenge);
  }
}
