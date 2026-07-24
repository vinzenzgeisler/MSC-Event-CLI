import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type Base64URLString,
  type PublicKeyCredentialRequestOptionsJSON,
  type Uint8Array_,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import type { FreshAuthContext, FreshAuthVerifier, VerifiedFreshAuth } from './approval.js';

export interface RegisteredWebAuthnCredential {
  credentialId: Base64URLString;
  actor: string;
  publicKey: Uint8Array_;
  counter: number;
  revision: number;
  transports?: AuthenticatorTransportFuture[];
}

export interface WebAuthnCredentialRepository {
  listByActor(actor: string): Promise<RegisteredWebAuthnCredential[]>;
  findById(credentialId: string): Promise<RegisteredWebAuthnCredential | undefined>;
  /**
   * Must compare and update in one transaction, including when both counters are
   * zero (the common case for synced passkeys).
   */
  updateCounter(
    credentialId: string,
    expectedCounter: number,
    expectedRevision: number,
    newCounter: number,
  ): Promise<void>;
}

export interface WebAuthnChallenge {
  challengeId: string;
  challenge: string;
  actor: string;
  context: FreshAuthContext;
  issuedAt: string;
  expiresAt: string;
}

export interface WebAuthnChallengeStore {
  save(challenge: WebAuthnChallenge): Promise<void>;
  /** Atomically removes and returns the challenge so every ceremony is single-use. */
  take(challengeId: string): Promise<WebAuthnChallenge | undefined>;
}

export interface WebAuthnAssertion {
  challengeId: string;
  response: AuthenticationResponseJSON;
}

export interface BeginWebAuthnResult {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  expiresAt: string;
}

type VerifyAuthentication = (options: Parameters<typeof verifyAuthenticationResponse>[0]) => Promise<VerifiedAuthenticationResponse>;

export interface WebAuthnFreshAuthOptions {
  rpId: string;
  expectedOrigins: string[];
  credentials: WebAuthnCredentialRepository;
  challenges: WebAuthnChallengeStore;
  challengeTtlSeconds?: number;
  now?: () => Date;
  verifyAuthentication?: VerifyAuthentication;
}

export const validateWebAuthnRelyingPartyConfiguration = (options: {
  rpId: string;
  expectedOrigins: string[];
  challengeTtlSeconds?: number;
}): void => {
  if (!options.rpId || options.rpId.includes('://') || options.rpId.includes('/') || options.rpId.includes(':')) {
    throw new Error('rpId must be a hostname without scheme, path, or port');
  }
  if (options.expectedOrigins.length === 0) throw new Error('at least one expected origin is required');
  for (const origin of options.expectedOrigins) {
    const parsed = new URL(origin);
    const localDevelopment = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if ((parsed.protocol !== 'https:' && !localDevelopment) || parsed.origin !== origin) {
      throw new Error('expected origins must be exact HTTPS origins');
    }
  }
  const ttl = options.challengeTtlSeconds ?? 120;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) {
    throw new Error('challengeTtlSeconds must be between 30 and 300');
  }
};

const parseAssertion = (assertion: unknown): WebAuthnAssertion => {
  if (!assertion || typeof assertion !== 'object') throw new Error('WebAuthn assertion is required');
  const value = assertion as Partial<WebAuthnAssertion>;
  if (!value.challengeId || typeof value.challengeId !== 'string' || !value.response || typeof value.response !== 'object') {
    throw new Error('WebAuthn assertion is malformed');
  }
  const credentialId = (value.response as Partial<AuthenticationResponseJSON>).id;
  if (!credentialId || typeof credentialId !== 'string') throw new Error('WebAuthn credential id is missing');
  return value as WebAuthnAssertion;
};

/**
 * Fresh-auth boundary for the approval queue. The trusted server starts a
 * ceremony for an authenticated reviewer; the browser never supplies actor
 * identity, RP ID, origin, challenge, or credential ownership.
 */
export class WebAuthnFreshAuthVerifier implements FreshAuthVerifier {
  private readonly now: () => Date;
  private readonly verifyAuthentication: VerifyAuthentication;
  private readonly challengeTtlSeconds: number;

  constructor(private readonly options: WebAuthnFreshAuthOptions) {
    validateWebAuthnRelyingPartyConfiguration(options);
    this.now = options.now ?? (() => new Date());
    this.verifyAuthentication = options.verifyAuthentication ?? verifyAuthenticationResponse;
    this.challengeTtlSeconds = options.challengeTtlSeconds ?? 120;
  }

  async begin(actor: string, context: FreshAuthContext): Promise<BeginWebAuthnResult> {
    if (!actor.trim()) throw new Error('authenticated reviewer identity is required');
    const credentials = await this.options.credentials.listByActor(actor);
    if (credentials.length === 0) throw new Error('reviewer has no registered WebAuthn credential');
    if (credentials.some((credential) => credential.actor !== actor)) {
      throw new Error('credential repository returned a credential owned by another reviewer');
    }

    const options = await generateAuthenticationOptions({
      rpID: this.options.rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        ...(credential.transports ? { transports: credential.transports } : {}),
      })),
      timeout: this.challengeTtlSeconds * 1000,
      userVerification: 'required',
    });
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.challengeTtlSeconds * 1000).toISOString();
    const challengeId = randomUUID();
    await this.options.challenges.save({
      challengeId,
      challenge: options.challenge,
      actor,
      context,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
    });
    return { challengeId, options, expiresAt };
  }

  async verify(assertionValue: unknown, context: FreshAuthContext): Promise<VerifiedFreshAuth> {
    const assertion = parseAssertion(assertionValue);
    const challenge = await this.options.challenges.take(assertion.challengeId);
    if (!challenge) throw new Error('WebAuthn challenge is unknown or already used');
    if (Date.parse(challenge.expiresAt) <= this.now().getTime()) throw new Error('WebAuthn challenge has expired');
    if (
      challenge.context.actionId !== context.actionId ||
      challenge.context.payloadHash !== context.payloadHash ||
      challenge.context.decision !== context.decision
    ) {
      throw new Error('WebAuthn challenge does not match the approval decision');
    }

    const credential = await this.options.credentials.findById(assertion.response.id);
    if (!credential || credential.actor !== challenge.actor) {
      throw new Error('WebAuthn credential is not owned by the authenticated reviewer');
    }
    const verification = await this.verifyAuthentication({
      response: assertion.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.options.expectedOrigins,
      expectedRPID: this.options.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        ...(credential.transports ? { transports: credential.transports } : {}),
      },
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new Error('WebAuthn user verification failed');
    }
    await this.options.credentials.updateCounter(
      credential.credentialId,
      credential.counter,
      credential.revision,
      verification.authenticationInfo.newCounter,
    );
    return {
      actor: credential.actor,
      authenticatedAt: this.now().toISOString(),
      method: 'passkey',
      assertionId: assertion.challengeId,
    };
  }
}

/** Test/development only. Production needs a transactional, shared store. */
export class InMemoryWebAuthnChallengeStore implements WebAuthnChallengeStore {
  private readonly records = new Map<string, WebAuthnChallenge>();

  async save(challenge: WebAuthnChallenge): Promise<void> {
    if (this.records.has(challenge.challengeId)) throw new Error('duplicate WebAuthn challenge id');
    this.records.set(challenge.challengeId, structuredClone(challenge));
  }

  async take(challengeId: string): Promise<WebAuthnChallenge | undefined> {
    const challenge = this.records.get(challengeId);
    if (!challenge) return undefined;
    this.records.delete(challengeId);
    return structuredClone(challenge);
  }
}
