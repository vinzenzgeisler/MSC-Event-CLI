import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export interface PasskeyBootstrapGrant {
  grantId: string;
  actor: string;
  secretHash: Uint8Array;
  issuedAt: string;
  expiresAt: string;
}

export interface PasskeyBootstrapAuditEvent {
  eventId: string;
  grantId: string;
  actor: string;
  operatorId: string;
  authenticationMethod: 'local-os-user';
  issuedAt: string;
  expiresAt: string;
}

export interface PasskeyBootstrapGrantStore {
  saveBootstrapGrant(
    grant: PasskeyBootstrapGrant,
    audit: PasskeyBootstrapAuditEvent,
  ): Promise<void>;
  takeBootstrapGrant(grantId: string): Promise<PasskeyBootstrapGrant | undefined>;
}

export interface IssuedPasskeyBootstrap {
  actor: string;
  code: string;
  expiresAt: string;
}

export interface PasskeyBootstrapServiceOptions {
  grants: PasskeyBootstrapGrantStore;
  ttlSeconds?: number;
  now?: () => Date;
}

export interface AuthenticatedBootstrapOperator {
  operatorId: string;
  authenticationMethod: 'local-os-user';
}

const MAX_TTL_SECONDS = 15 * 60;
const CODE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const validateActor = (actor: string): string => {
  const normalized = actor.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error('bootstrap actor must contain between 1 and 128 characters');
  }
  return normalized;
};

const hashSecret = (grantId: string, secret: string): Uint8Array =>
  createHash('sha256')
    .update('approved-actions/passkey-bootstrap/v1\0')
    .update(grantId)
    .update('\0')
    .update(secret)
    .digest();

/**
 * One-time, actor-bound bootstrap grants for the first trusted passkey.
 *
 * `issue` is deliberately not exposed by any HTTP or plugin route. A production
 * host must invoke it only from a separately authenticated local operator
 * boundary and show the returned code once. Browser sessions may only consume
 * a previously issued code.
 */
export class PasskeyBootstrapService {
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(private readonly options: PasskeyBootstrapServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? 10 * 60;
    if (
      !Number.isSafeInteger(this.ttlSeconds) ||
      this.ttlSeconds < 30 ||
      this.ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error(`bootstrap TTL must be between 30 and ${MAX_TTL_SECONDS} seconds`);
    }
  }

  async issue(
    actorInput: string,
    operator: AuthenticatedBootstrapOperator,
  ): Promise<IssuedPasskeyBootstrap> {
    const actor = validateActor(actorInput);
    const operatorId = operator.operatorId.trim();
    if (!operatorId || operatorId.length > 128) {
      throw new Error('authenticated bootstrap operator id is required');
    }
    if (operator.authenticationMethod !== 'local-os-user') {
      throw new Error('bootstrap requires local OS-user authentication');
    }
    const issuedAt = this.now();
    const expiresAt = new Date(
      issuedAt.getTime() + this.ttlSeconds * 1000,
    ).toISOString();
    const grantId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const grant: PasskeyBootstrapGrant = {
      grantId,
      actor,
      secretHash: hashSecret(grantId, secret),
      issuedAt: issuedAt.toISOString(),
      expiresAt,
    };
    await this.options.grants.saveBootstrapGrant(grant, {
      eventId: randomUUID(),
      grantId,
      actor,
      operatorId,
      authenticationMethod: operator.authenticationMethod,
      issuedAt: grant.issuedAt,
      expiresAt,
    });
    return {
      actor,
      code: `${grantId}.${secret}`,
      expiresAt,
    };
  }

  async consume(actorInput: string, code: unknown): Promise<void> {
    const actor = validateActor(actorInput);
    if (typeof code !== 'string') throw new Error('bootstrap code is required');
    const parsed = CODE_PATTERN.exec(code);
    if (!parsed) throw new Error('bootstrap code is malformed');
    const [, grantId, secret] = parsed;
    const grant = await this.options.grants.takeBootstrapGrant(grantId!);
    if (!grant) throw new Error('bootstrap code is unknown or already used');

    const actualHash = hashSecret(grantId!, secret!);
    const validHash =
      actualHash.byteLength === grant.secretHash.byteLength &&
      timingSafeEqual(actualHash, grant.secretHash);
    const validActor = grant.actor === actor;
    const unexpired = Date.parse(grant.expiresAt) > this.now().getTime();
    if (!validHash || !validActor || !unexpired) {
      throw new Error('bootstrap code is invalid or expired');
    }
  }
}

export class InMemoryPasskeyBootstrapGrantStore
  implements PasskeyBootstrapGrantStore
{
  private readonly records = new Map<string, PasskeyBootstrapGrant>();
  private readonly consumedGrantIds = new Set<string>();
  private readonly auditEvents: PasskeyBootstrapAuditEvent[] = [];

  async saveBootstrapGrant(
    grant: PasskeyBootstrapGrant,
    audit: PasskeyBootstrapAuditEvent,
  ): Promise<void> {
    if (this.records.has(grant.grantId)) {
      throw new Error('duplicate passkey bootstrap grant id');
    }
    if ([...this.records.values()].some((existing) => existing.actor === grant.actor)) {
      throw new Error('initial bootstrap grant already exists for actor');
    }
    if (audit.grantId !== grant.grantId || audit.actor !== grant.actor) {
      throw new Error('bootstrap audit does not match grant');
    }
    this.records.set(grant.grantId, structuredClone(grant));
    this.auditEvents.push(structuredClone(audit));
  }

  async takeBootstrapGrant(
    grantId: string,
  ): Promise<PasskeyBootstrapGrant | undefined> {
    const grant = this.records.get(grantId);
    if (!grant || this.consumedGrantIds.has(grantId)) return undefined;
    this.consumedGrantIds.add(grantId);
    return structuredClone(grant);
  }

  bootstrapAuditEvents(): PasskeyBootstrapAuditEvent[] {
    return structuredClone(this.auditEvents);
  }
}

export const createInitialPasskeyBootstrapAuthorizer = (
  bootstrap: PasskeyBootstrapService,
): ((actor: string, existingCredentialCount: number, authorization: unknown) => Promise<void>) =>
  async (actor, existingCredentialCount, authorization) => {
    if (existingCredentialCount !== 0) {
      throw new Error(
        'initial bootstrap cannot add credentials after a passkey already exists',
      );
    }
    if (
      !authorization ||
      typeof authorization !== 'object' ||
      (authorization as { type?: unknown }).type !== 'bootstrap'
    ) {
      throw new Error('separately issued bootstrap authorization is required');
    }
    await bootstrap.consume(
      actor,
      (authorization as { code?: unknown }).code,
    );
  };
