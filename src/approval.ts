import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalizeJson, jsonValueSchema, parseActionIntent, type ActionIntent, type JsonValue } from './action.js';

export type { ActionIntent } from './action.js';
export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

export interface ApprovalRecord {
  actionId: string;
  idempotencyKey: string;
  intent: ActionIntent;
  payloadHash: string;
  expectedStateHash: string;
  createdAt: string;
  expiresAt: string;
  status: ActionStatus;
  decidedAt?: string;
  decidedBy?: string;
  consumedAt?: string;
}

interface Store {
  version: 1;
  records: ApprovalRecord[];
}

interface ExecutionProof {
  version: 1;
  actionId: string;
  payloadHash: string;
  expiresAt: string;
}

export interface QueueOptions {
  store?: ApprovalStore;
  storePath?: string;
  auditPath?: string;
  signingKey: Buffer;
  freshAuthVerifier: FreshAuthVerifier;
  maxFreshAuthAgeSeconds?: number;
  now?: () => Date;
}

export interface FreshAuthContext {
  actionId: string;
  payloadHash: string;
  decision: 'approve' | 'reject';
}

export interface VerifiedFreshAuth {
  actor: string;
  authenticatedAt: string;
  method: 'webauthn' | 'passkey' | 'oidc-max-age';
  assertionId: string;
}

/**
 * Security boundary implemented by the authenticated UI/backend integration.
 * The queue never accepts a client-provided boolean or actor identity.
 */
export interface FreshAuthVerifier {
  verify(assertion: unknown, context: FreshAuthContext): Promise<VerifiedFreshAuth>;
}

export interface ApprovalStore {
  propose(
    record: ApprovalRecord,
    auditAt: string,
  ): Promise<{ record: ApprovalRecord; created: boolean }>;
  pending(now: string): Promise<ApprovalRecord[]>;
  approved(now: string): Promise<ApprovalRecord[]>;
  get(actionId: string): Promise<ApprovalRecord>;
  decide(options: {
    actionId: string;
    decision: 'approve' | 'reject';
    decidedAt: string;
    decidedBy: string;
    expiresAfter: string;
    authenticationMethod: VerifiedFreshAuth['method'];
    assertionId: string;
  }): Promise<ApprovalRecord>;
  consume(options: {
    actionId: string;
    payloadHash: string;
    expiresAt: string;
    expectedStateHash: string;
    consumedAt: string;
  }): Promise<ApprovalRecord>;
  consumeToOutbox?(options: {
    actionId: string;
    payloadHash: string;
    expiresAt: string;
    expectedStateHash: string;
    consumedAt: string;
  }): Promise<ApprovalRecord>;
}

export const hashJson = (value: JsonValue): string =>
  createHash('sha256').update(canonicalizeJson(value)).digest('hex');

export const hashActionIntent = (intent: ActionIntent): string =>
  createHash('sha256').update(canonicalizeJson(parseActionIntent(intent))).digest('hex');

export class ApprovalQueue {
  private readonly now: () => Date;
  private readonly store: ApprovalStore;

  constructor(private readonly options: QueueOptions) {
    if (options.signingKey.length < 32) throw new Error('signingKey must contain at least 32 bytes');
    this.now = options.now ?? (() => new Date());
    if (options.store) {
      this.store = options.store;
    } else {
      if (!options.storePath || !options.auditPath) {
        throw new Error('store or both storePath and auditPath are required');
      }
      this.store = new JsonFileApprovalStore(options.storePath, options.auditPath);
    }
  }

  async propose(intent: ActionIntent, idempotencyKey: string, ttlSeconds = 900): Promise<ApprovalRecord> {
    if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('ttlSeconds must be between 1 and 3600');
    const validatedIntent = parseActionIntent(intent);
    const payloadHash = hashActionIntent(validatedIntent);
    const createdAt = this.now();
    const record: ApprovalRecord = {
      actionId: randomUUID(),
      idempotencyKey,
      intent: validatedIntent,
      payloadHash,
      expectedStateHash: hashJson(validatedIntent.expectedState),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString(),
      status: 'pending',
    };
    const stored = await this.store.propose(record, this.now().toISOString());
    if (stored.record.payloadHash !== payloadHash) {
      throw new Error('idempotency key reused for different payload');
    }
    return stored.record;
  }

  async pending(): Promise<ApprovalRecord[]> {
    return this.store.pending(this.now().toISOString());
  }

  async approved(): Promise<ApprovalRecord[]> {
    return this.store.approved(this.now().toISOString());
  }

  async review(actionId: string): Promise<ApprovalRecord> {
    const record = await this.store.get(actionId);
    this.assertPendingAndFresh(record);
    return structuredClone(record);
  }

  async decide(
    actionId: string,
    decision: 'approve' | 'reject',
    assertion: unknown,
    expectedActor?: string,
  ): Promise<string | undefined> {
    const record = await this.store.get(actionId);
    this.assertPendingAndFresh(record);
    const verified = await this.options.freshAuthVerifier.verify(assertion, {
      actionId,
      payloadHash: record.payloadHash,
      decision,
    });
    if (!verified.actor.trim() || !verified.assertionId.trim()) throw new Error('fresh re-authentication returned incomplete identity');
    if (expectedActor !== undefined && verified.actor !== expectedActor) {
      throw new Error('fresh re-authentication actor does not match the authenticated session');
    }
    const authenticatedAt = Date.parse(verified.authenticatedAt);
    const maxAgeMs = (this.options.maxFreshAuthAgeSeconds ?? 300) * 1000;
    const ageMs = this.now().getTime() - authenticatedAt;
    if (!Number.isFinite(authenticatedAt) || ageMs < 0 || ageMs > maxAgeMs) throw new Error('fresh re-authentication is stale');
    const decidedAt = this.now().toISOString();
    const decided = await this.store.decide({
      actionId,
      decision,
      decidedAt,
      decidedBy: verified.actor,
      expiresAfter: decidedAt,
      authenticationMethod: verified.method,
      assertionId: verified.assertionId,
    });
    if (decision === 'reject') return undefined;
    return this.sign({
      version: 1,
      actionId,
      payloadHash: decided.payloadHash,
      expiresAt: decided.expiresAt,
    });
  }

  async executionProofForApproved(actionId: string): Promise<string> {
    const record = await this.store.get(actionId);
    if (record.status !== 'approved') {
      throw new Error(`action is ${record.status}, not approved`);
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new Error('action has expired');
    }
    return this.sign({
      version: 1,
      actionId,
      payloadHash: record.payloadHash,
      expiresAt: record.expiresAt,
    });
  }

  async consume(proofToken: string, currentState: unknown): Promise<ActionIntent> {
    const proof = this.verify(proofToken);
    const consumed = await this.store.consume({
      actionId: proof.actionId,
      payloadHash: proof.payloadHash,
      expiresAt: proof.expiresAt,
      expectedStateHash: hashJson(jsonValueSchema.parse(currentState)),
      consumedAt: this.now().toISOString(),
    });
    return consumed.intent;
  }

  async consumeToOutbox(
    proofToken: string,
    currentState: unknown,
  ): Promise<ActionIntent> {
    if (!this.store.consumeToOutbox) {
      throw new Error('approval store does not support atomic outbox consumption');
    }
    const proof = this.verify(proofToken);
    const consumed = await this.store.consumeToOutbox({
      actionId: proof.actionId,
      payloadHash: proof.payloadHash,
      expiresAt: proof.expiresAt,
      expectedStateHash: hashJson(jsonValueSchema.parse(currentState)),
      consumedAt: this.now().toISOString(),
    });
    return consumed.intent;
  }

  private assertPendingAndFresh(record: ApprovalRecord): void {
    if (record.status !== 'pending') throw new Error(`action is ${record.status}, not pending`);
    if (Date.parse(record.expiresAt) <= this.now().getTime()) throw new Error('action has expired');
  }

  private sign(proof: ExecutionProof): string {
    const payload = Buffer.from(canonicalizeJson(proof as unknown as JsonValue)).toString('base64url');
    const signature = createHmac('sha256', this.options.signingKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private verify(token: string): ExecutionProof {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw new Error('invalid proof format');
    const expected = createHmac('sha256', this.options.signingKey).update(payload).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('invalid proof signature'); }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invalid proof signature');
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ExecutionProof;
    if (proof.version !== 1 || !proof.actionId || !proof.payloadHash || !proof.expiresAt) throw new Error('invalid proof payload');
    return proof;
  }
}

export class JsonFileApprovalStore implements ApprovalStore {
  constructor(
    private readonly storePath: string,
    private readonly auditPath: string,
  ) {}

  async propose(
    record: ApprovalRecord,
    auditAt: string,
  ): Promise<{ record: ApprovalRecord; created: boolean }> {
    const store = await this.load();
    const existing = store.records.find(
      (candidate) => candidate.idempotencyKey === record.idempotencyKey,
    );
    if (existing) return { record: existing, created: false };
    store.records.push(record);
    await this.save(store);
    await this.audit(auditAt, 'proposed', record, {
      idempotencyKey: record.idempotencyKey,
    });
    return { record, created: true };
  }

  async pending(now: string): Promise<ApprovalRecord[]> {
    const timestamp = Date.parse(now);
    return (await this.load()).records.filter(
      (record) => record.status === 'pending' && Date.parse(record.expiresAt) > timestamp,
    );
  }

  async approved(now: string): Promise<ApprovalRecord[]> {
    const timestamp = Date.parse(now);
    return (await this.load()).records.filter(
      (record) => record.status === 'approved' && Date.parse(record.expiresAt) > timestamp,
    );
  }

  async get(actionId: string): Promise<ApprovalRecord> {
    return this.find(await this.load(), actionId);
  }

  async decide(options: {
    actionId: string;
    decision: 'approve' | 'reject';
    decidedAt: string;
    decidedBy: string;
    expiresAfter: string;
    authenticationMethod: VerifiedFreshAuth['method'];
    assertionId: string;
  }): Promise<ApprovalRecord> {
    const store = await this.load();
    const record = this.find(store, options.actionId);
    if (record.status !== 'pending') {
      throw new Error(`action is ${record.status}, not pending`);
    }
    if (record.expiresAt <= options.expiresAfter) throw new Error('action has expired');
    record.status = options.decision === 'approve' ? 'approved' : 'rejected';
    record.decidedAt = options.decidedAt;
    record.decidedBy = options.decidedBy;
    await this.save(store);
    await this.audit(
      options.decidedAt,
      options.decision === 'approve' ? 'approved' : 'rejected',
      record,
      {
        actor: options.decidedBy,
        authenticationMethod: options.authenticationMethod,
        assertionId: options.assertionId,
      },
    );
    return record;
  }

  async consume(options: {
    actionId: string;
    payloadHash: string;
    expiresAt: string;
    expectedStateHash: string;
    consumedAt: string;
  }): Promise<ApprovalRecord> {
    const store = await this.load();
    const record = this.find(store, options.actionId);
    if (record.status !== 'approved') {
      throw new Error(`action is ${record.status}, not approved`);
    }
    if (record.payloadHash !== options.payloadHash || record.expiresAt !== options.expiresAt) {
      throw new Error('proof does not match queued action');
    }
    if (record.expiresAt <= options.consumedAt) throw new Error('action has expired');
    if (record.expectedStateHash !== options.expectedStateHash) {
      throw new Error('target state changed since preview');
    }
    record.status = 'consumed';
    record.consumedAt = options.consumedAt;
    await this.save(store);
    await this.audit(options.consumedAt, 'consumed', record, {});
    return record;
  }

  private async load(): Promise<Store> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8')) as Store;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error('unsupported approval store');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }

  private async save(store: Store): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.storePath);
    await chmod(this.storePath, 0o600);
  }

  private async audit(
    at: string,
    event: string,
    record: ApprovalRecord,
    details: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
    const entry = {
      at,
      event,
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      ...details,
    };
    await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(this.auditPath, 0o600);
  }

  private find(store: Store, actionId: string): ApprovalRecord {
    const record = store.records.find((candidate) => candidate.actionId === actionId);
    if (!record) throw new Error('unknown action');
    return record;
  }
}
