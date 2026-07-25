import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { jsonValueSchema, type JsonValue } from './action.js';

const outboxStatusSchema = z.enum([
  'queued',
  'dispatching',
  'accepted',
  'uncertain',
  'cancelled',
]);

export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

const outboxCommandSchema = z.object({
  actionId: z.string().trim().min(1).max(200),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.string().min(3).max(100).regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
  ),
  payload: jsonValueSchema,
  createdAt: z.string().datetime(),
}).strict();

export interface OutboxCommand {
  actionId: string;
  payloadHash: string;
  kind: string;
  payload: JsonValue;
  createdAt: string;
}

export interface OutboxRecord extends OutboxCommand {
  status: OutboxStatus;
  attemptId?: string;
  workerId?: string;
  claimedAt?: string;
  acceptedAt?: string;
  uncertainAt?: string;
  uncertaintyCode?: string;
  cancelledAt?: string;
}

type OutboxRow = {
  action_id: string;
  payload_hash: string;
  kind: string;
  payload_nonce: Uint8Array;
  payload_ciphertext: Uint8Array;
  payload_auth_tag: Uint8Array;
  created_at: string;
  status: OutboxStatus;
  attempt_id: string | null;
  worker_id: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  uncertain_at: string | null;
  uncertainty_code: string | null;
  cancelled_at: string | null;
};

const SELECT_RECORD = `
  SELECT
    action_id, payload_hash, kind, payload_nonce, payload_ciphertext,
    payload_auth_tag, created_at, status, attempt_id, worker_id, claimed_at,
    accepted_at, uncertain_at, uncertainty_code, cancelled_at
  FROM durable_outbox
`;

const ENCRYPTION_AAD_PREFIX = 'approved-actions/outbox/v1\0';
const workerIdSchema = z.string().trim().min(1).max(200)
  .refine((value) => !/[\r\n\0]/.test(value), 'worker id contains a forbidden character');
const uncertaintyCodeSchema = z.string().trim().min(1).max(100)
  .regex(/^[a-z][a-z0-9-]*$/);
const reconciliationEvidenceSchema = z.object({
  reviewer: z.string().trim().min(1).max(128),
  authenticationMethod: z.enum(['webauthn', 'passkey', 'local-os-user']),
  assertionId: z.string().trim().min(1).max(500),
  source: z.enum([
    'provider-message-log',
    'provider-search',
    'mailbox-observation',
  ]),
  referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  conclusionCode: uncertaintyCodeSchema,
}).strict();

export type ReconciliationEvidence = z.infer<typeof reconciliationEvidenceSchema>;

const validTimestamp = (value: string, field: string): string => {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a valid timestamp`);
  return value;
};

export const initializeDurableOutboxTables = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_outbox (
      action_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_nonce BLOB NOT NULL,
      payload_ciphertext BLOB NOT NULL,
      payload_auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'dispatching', 'accepted', 'uncertain', 'cancelled')
      ),
      attempt_id TEXT,
      worker_id TEXT,
      claimed_at TEXT,
      accepted_at TEXT,
      uncertain_at TEXT,
      uncertainty_code TEXT,
      cancelled_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_outbox_pending
      ON durable_outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS durable_outbox_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      action_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      details_json TEXT NOT NULL
    ) STRICT;
  `);
};

export const encryptOutboxPayload = (
  encryptionKey: Uint8Array,
  commandValue: OutboxCommand,
): { command: OutboxCommand; nonce: Buffer; ciphertext: Buffer; authTag: Buffer } => {
  const command = outboxCommandSchema.parse(commandValue) as OutboxCommand;
  if (encryptionKey.byteLength !== 32) {
    throw new Error('outbox encryption key must contain exactly 32 bytes');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey),
    nonce,
  );
  cipher.setAAD(Buffer.from(
    `${ENCRYPTION_AAD_PREFIX}${command.actionId}\0${command.payloadHash}`,
  ));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(command.payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    command,
    nonce,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
};

/**
 * Durable local hand-off for approved non-idempotent actions.
 *
 * Claiming is exactly-once inside SQLite. External SMTP delivery is not:
 * anything that may have reached the transport must end in `accepted` or
 * `uncertain`. Dispatching and uncertain records are never retried
 * automatically and require explicit reconciliation.
 */
export class SqliteDurableOutbox {
  private readonly database: DatabaseSync;
  private readonly encryptionKey: Buffer;

  constructor(path: string, options: { encryptionKey: Uint8Array }) {
    if (options.encryptionKey.byteLength !== 32) {
      throw new Error('outbox encryption key must contain exactly 32 bytes');
    }
    this.encryptionKey = Buffer.from(options.encryptionKey);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    initializeDurableOutboxTables(this.database);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  close(): void {
    this.database.close();
  }

  enqueue(value: OutboxCommand): { record: OutboxRecord; created: boolean } {
    const command = outboxCommandSchema.parse(value) as OutboxCommand;
    return this.transaction(() => {
      const existing = this.getRow(command.actionId);
      if (existing) {
        if (
          existing.payload_hash !== command.payloadHash ||
          existing.kind !== command.kind
        ) {
          throw new Error('action id reused for a different outbox payload');
        }
        return { record: this.recordFromRow(existing), created: false };
      }
      const encrypted = encryptOutboxPayload(this.encryptionKey, command);
      this.database.prepare(`
        INSERT INTO durable_outbox (
          action_id, payload_hash, kind, payload_nonce, payload_ciphertext,
          payload_auth_tag, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
      `).run(
        command.actionId,
        command.payloadHash,
        command.kind,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        command.createdAt,
      );
      this.audit(command.createdAt, 'queued', command, {});
      return {
        record: { ...command, status: 'queued' },
        created: true,
      };
    });
  }

  queued(): OutboxRecord[] {
    return this.rowsForStatus('queued').map((row) => this.recordFromRow(row));
  }

  requiringReconciliation(): OutboxRecord[] {
    const rows = this.database.prepare(`
      ${SELECT_RECORD}
      WHERE status IN ('dispatching', 'uncertain')
      ORDER BY COALESCE(uncertain_at, claimed_at, created_at)
    `).all() as OutboxRow[];
    return rows.map((row) => this.recordFromRow(row));
  }

  get(actionId: string): OutboxRecord {
    const row = this.getRow(actionId);
    if (!row) throw new Error('unknown outbox action');
    return this.recordFromRow(row);
  }

  claim(actionId: string, workerIdValue: string, claimedAtValue: string): OutboxRecord {
    const workerId = workerIdSchema.parse(workerIdValue);
    const claimedAt = validTimestamp(claimedAtValue, 'claimedAt');
    return this.transaction(() => {
      const attemptId = randomUUID();
      const result = this.database.prepare(`
        UPDATE durable_outbox
        SET status = 'dispatching', attempt_id = ?, worker_id = ?, claimed_at = ?
        WHERE action_id = ? AND status = 'queued'
      `).run(attemptId, workerId, claimedAt, actionId);
      if (result.changes !== 1) {
        const current = this.getRow(actionId);
        if (!current) throw new Error('unknown outbox action');
        throw new Error(`outbox action is ${current.status}, not queued`);
      }
      const row = this.requiredRow(actionId);
      this.audit(claimedAt, 'claimed', this.recordFromRow(row), {
        attemptId,
        workerId,
      });
      return this.recordFromRow(row);
    });
  }

  markAccepted(
    actionId: string,
    attemptId: string,
    acceptedAtValue: string,
  ): OutboxRecord {
    const acceptedAt = validTimestamp(acceptedAtValue, 'acceptedAt');
    return this.finishAttempt({
      actionId,
      attemptId,
      status: 'accepted',
      at: acceptedAt,
    });
  }

  markUncertain(
    actionId: string,
    attemptId: string,
    uncertainAtValue: string,
    uncertaintyCodeValue: string,
  ): OutboxRecord {
    const uncertainAt = validTimestamp(uncertainAtValue, 'uncertainAt');
    const uncertaintyCode = uncertaintyCodeSchema.parse(uncertaintyCodeValue);
    return this.finishAttempt({
      actionId,
      attemptId,
      status: 'uncertain',
      at: uncertainAt,
      uncertaintyCode,
    });
  }

  releaseBeforeHandoff(
    actionId: string,
    attemptId: string,
    releasedAtValue: string,
    reasonCodeValue: string,
  ): OutboxRecord {
    const releasedAt = validTimestamp(releasedAtValue, 'releasedAt');
    const reasonCode = uncertaintyCodeSchema.parse(reasonCodeValue);
    return this.transaction(() => {
      const current = this.requiredRow(actionId);
      const result = this.database.prepare(`
        UPDATE durable_outbox
        SET
          status = 'queued',
          attempt_id = NULL,
          worker_id = NULL,
          claimed_at = NULL
        WHERE action_id = ? AND status = 'dispatching' AND attempt_id = ?
      `).run(actionId, attemptId);
      if (result.changes !== 1) {
        throw new Error('outbox attempt is no longer dispatching or does not match');
      }
      this.audit(releasedAt, 'released-before-handoff', this.recordFromRow(current), {
        attemptId,
        reasonCode,
      });
      return this.recordFromRow(this.requiredRow(actionId));
    });
  }

  reconcileAccepted(
    actionId: string,
    attemptId: string,
    reconciledAtValue: string,
    evidenceValue: ReconciliationEvidence,
  ): OutboxRecord {
    const reconciledAt = validTimestamp(reconciledAtValue, 'reconciledAt');
    const evidence = reconciliationEvidenceSchema.parse(evidenceValue);
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE durable_outbox
        SET status = 'accepted', accepted_at = ?
        WHERE action_id = ?
          AND status IN ('dispatching', 'uncertain')
          AND attempt_id = ?
      `).run(reconciledAt, actionId, attemptId);
      if (result.changes !== 1) {
        throw new Error('outbox action does not require reconciliation or attempt does not match');
      }
      const record = this.recordFromRow(this.requiredRow(actionId));
      this.audit(reconciledAt, 'reconciled-accepted', record, {
        attemptId,
        ...evidence,
      });
      return record;
    });
  }

  reconcileNotAccepted(
    actionId: string,
    attemptId: string,
    reconciledAtValue: string,
    evidenceValue: ReconciliationEvidence,
  ): OutboxRecord {
    const reconciledAt = validTimestamp(reconciledAtValue, 'reconciledAt');
    const evidence = reconciliationEvidenceSchema.parse(evidenceValue);
    return this.transaction(() => {
      const current = this.requiredRow(actionId);
      const result = this.database.prepare(`
        UPDATE durable_outbox
        SET
          status = 'queued',
          attempt_id = NULL,
          worker_id = NULL,
          claimed_at = NULL,
          uncertain_at = NULL,
          uncertainty_code = NULL
        WHERE action_id = ?
          AND status IN ('dispatching', 'uncertain')
          AND attempt_id = ?
      `).run(actionId, attemptId);
      if (result.changes !== 1) {
        throw new Error('outbox action does not require reconciliation or attempt does not match');
      }
      this.audit(
        reconciledAt,
        'reconciled-not-accepted',
        this.recordFromRow(current),
        { attemptId, ...evidence },
      );
      return this.recordFromRow(this.requiredRow(actionId));
    });
  }

  cancelQueued(actionId: string, cancelledAtValue: string): OutboxRecord {
    const cancelledAt = validTimestamp(cancelledAtValue, 'cancelledAt');
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE durable_outbox
        SET status = 'cancelled', cancelled_at = ?
        WHERE action_id = ? AND status = 'queued'
      `).run(cancelledAt, actionId);
      if (result.changes !== 1) {
        const current = this.getRow(actionId);
        if (!current) throw new Error('unknown outbox action');
        throw new Error(`outbox action is ${current.status}, not queued`);
      }
      const record = this.recordFromRow(this.requiredRow(actionId));
      this.audit(cancelledAt, 'cancelled', record, {});
      return record;
    });
  }

  private finishAttempt(options: {
    actionId: string;
    attemptId: string;
    status: 'accepted' | 'uncertain';
    at: string;
    uncertaintyCode?: string;
  }): OutboxRecord {
    if (!options.attemptId.trim()) throw new Error('attemptId is required');
    return this.transaction(() => {
      const result = options.status === 'accepted'
        ? this.database.prepare(`
            UPDATE durable_outbox
            SET status = 'accepted', accepted_at = ?
            WHERE action_id = ? AND status = 'dispatching' AND attempt_id = ?
          `).run(options.at, options.actionId, options.attemptId)
        : this.database.prepare(`
            UPDATE durable_outbox
            SET status = 'uncertain', uncertain_at = ?, uncertainty_code = ?
            WHERE action_id = ? AND status = 'dispatching' AND attempt_id = ?
          `).run(
            options.at,
            options.uncertaintyCode!,
            options.actionId,
            options.attemptId,
          );
      if (result.changes !== 1) {
        throw new Error('outbox attempt is no longer dispatching or does not match');
      }
      const record = this.recordFromRow(this.requiredRow(options.actionId));
      this.audit(options.at, options.status, record, {
        attemptId: options.attemptId,
        ...(options.uncertaintyCode
          ? { uncertaintyCode: options.uncertaintyCode }
          : {}),
      });
      return record;
    });
  }

  private rowsForStatus(status: OutboxStatus): OutboxRow[] {
    return this.database.prepare(`
      ${SELECT_RECORD}
      WHERE status = ?
      ORDER BY created_at
    `).all(status) as OutboxRow[];
  }

  private getRow(actionId: string): OutboxRow | undefined {
    return this.database.prepare(`${SELECT_RECORD} WHERE action_id = ?`)
      .get(actionId) as OutboxRow | undefined;
  }

  private requiredRow(actionId: string): OutboxRow {
    const row = this.getRow(actionId);
    if (!row) throw new Error('unknown outbox action');
    return row;
  }

  private recordFromRow(row: OutboxRow): OutboxRecord {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(row.payload_nonce),
    );
    decipher.setAAD(Buffer.from(
      `${ENCRYPTION_AAD_PREFIX}${row.action_id}\0${row.payload_hash}`,
    ));
    decipher.setAuthTag(Buffer.from(row.payload_auth_tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.payload_ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    return {
      actionId: row.action_id,
      payloadHash: row.payload_hash,
      kind: row.kind,
      payload: jsonValueSchema.parse(JSON.parse(plaintext)),
      createdAt: row.created_at,
      status: outboxStatusSchema.parse(row.status),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
      ...(row.uncertain_at ? { uncertainAt: row.uncertain_at } : {}),
      ...(row.uncertainty_code ? { uncertaintyCode: row.uncertainty_code } : {}),
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    };
  }

  private audit(
    at: string,
    event: string,
    record: Pick<OutboxRecord, 'actionId' | 'payloadHash'>,
    details: Record<string, unknown>,
  ): void {
    this.database.prepare(`
      INSERT INTO durable_outbox_audit (
        at, event, action_id, payload_hash, details_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      at,
      event,
      record.actionId,
      record.payloadHash,
      JSON.stringify(details),
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
