import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseActionIntent } from './action.js';
import type {
  ApprovalRecord,
  ApprovalStore,
  VerifiedFreshAuth,
} from './approval.js';

type ApprovalRow = {
  action_id: string;
  idempotency_key: string;
  intent_nonce: Uint8Array;
  intent_ciphertext: Uint8Array;
  intent_auth_tag: Uint8Array;
  payload_hash: string;
  expected_state_hash: string;
  created_at: string;
  expires_at: string;
  status: ApprovalRecord['status'];
  decided_at: string | null;
  decided_by: string | null;
  consumed_at: string | null;
};

const SELECT_RECORD = `
  SELECT
    action_id, idempotency_key, intent_nonce, intent_ciphertext, intent_auth_tag,
    payload_hash, expected_state_hash,
    created_at, expires_at, status, decided_at, decided_by, consumed_at
  FROM approval_records
`;

const ENCRYPTION_AAD_PREFIX = 'approved-actions/intent/v1\0';

export interface SqliteApprovalStoreOptions {
  encryptionKey: Uint8Array;
}

export interface ApprovalCleanupResult {
  expiredPendingOrApproved: number;
  retainedDecisionRecords: number;
}

/**
 * Transactional approval queue and audit store. The complete intent remains in
 * the queue record; audit rows contain only the action id, payload hash and
 * bounded lifecycle metadata.
 */
export class SqliteApprovalStore implements ApprovalStore {
  private readonly database: DatabaseSync;
  private readonly encryptionKey: Buffer;

  constructor(path: string, options: SqliteApprovalStoreOptions) {
    if (options.encryptionKey.byteLength !== 32) {
      throw new Error('approval intent encryption key must contain exactly 32 bytes');
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

      CREATE TABLE IF NOT EXISTS approval_records (
        action_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_nonce BLOB NOT NULL,
        intent_ciphertext BLOB NOT NULL,
        intent_auth_tag BLOB NOT NULL,
        payload_hash TEXT NOT NULL,
        expected_state_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
        decided_at TEXT,
        decided_by TEXT,
        consumed_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS approval_records_pending
        ON approval_records(status, expires_at);

      CREATE TABLE IF NOT EXISTS approval_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        action_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        details_json TEXT NOT NULL
      ) STRICT;
    `);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  close(): void {
    this.database.close();
  }

  async propose(
    record: ApprovalRecord,
    auditAt: string,
  ): Promise<{ record: ApprovalRecord; created: boolean }> {
    return this.transaction(() => {
      const existing = this.database
        .prepare(`${SELECT_RECORD} WHERE idempotency_key = ?`)
        .get(record.idempotencyKey) as ApprovalRow | undefined;
      if (existing) return { record: this.recordFromRow(existing), created: false };

      const encryptedIntent = this.encryptIntent(record);
      this.database.prepare(`
        INSERT INTO approval_records (
          action_id, idempotency_key, intent_nonce, intent_ciphertext,
          intent_auth_tag, payload_hash,
          expected_state_hash, created_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.actionId,
        record.idempotencyKey,
        encryptedIntent.nonce,
        encryptedIntent.ciphertext,
        encryptedIntent.authTag,
        record.payloadHash,
        record.expectedStateHash,
        record.createdAt,
        record.expiresAt,
        record.status,
      );
      this.audit(auditAt, 'proposed', record, {
        idempotencyKey: record.idempotencyKey,
      });
      return { record, created: true };
    });
  }

  async pending(now: string): Promise<ApprovalRecord[]> {
    const rows = this.database
      .prepare(`${SELECT_RECORD} WHERE status = 'pending' AND expires_at > ? ORDER BY created_at`)
      .all(now) as ApprovalRow[];
    return rows.map((row) => this.recordFromRow(row));
  }

  async approved(now: string): Promise<ApprovalRecord[]> {
    const rows = this.database
      .prepare(`${SELECT_RECORD} WHERE status = 'approved' AND expires_at > ? ORDER BY decided_at`)
      .all(now) as ApprovalRow[];
    return rows.map((row) => this.recordFromRow(row));
  }

  async get(actionId: string): Promise<ApprovalRecord> {
    const row = this.database
      .prepare(`${SELECT_RECORD} WHERE action_id = ?`)
      .get(actionId) as ApprovalRow | undefined;
    if (!row) throw new Error('unknown action');
    return this.recordFromRow(row);
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
    return this.transaction(() => {
      const record = this.getSync(options.actionId);
      if (record.status !== 'pending') {
        throw new Error(`action is ${record.status}, not pending`);
      }
      if (record.expiresAt <= options.expiresAfter) throw new Error('action has expired');
      const status: ApprovalRecord['status'] =
        options.decision === 'approve' ? 'approved' : 'rejected';
      const result = this.database.prepare(`
        UPDATE approval_records
        SET status = ?, decided_at = ?, decided_by = ?
        WHERE action_id = ? AND status = 'pending' AND expires_at > ?
      `).run(
        status,
        options.decidedAt,
        options.decidedBy,
        options.actionId,
        options.expiresAfter,
      );
      if (result.changes !== 1) throw new Error('approval decision changed concurrently');
      const decided = {
        ...record,
        status,
        decidedAt: options.decidedAt,
        decidedBy: options.decidedBy,
      };
      this.audit(
        options.decidedAt,
        options.decision === 'approve' ? 'approved' : 'rejected',
        decided,
        {
          actor: options.decidedBy,
          authenticationMethod: options.authenticationMethod,
          assertionId: options.assertionId,
        },
      );
      return decided;
    });
  }

  async consume(options: {
    actionId: string;
    payloadHash: string;
    expiresAt: string;
    expectedStateHash: string;
    consumedAt: string;
  }): Promise<ApprovalRecord> {
    return this.transaction(() => {
      const record = this.getSync(options.actionId);
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
      const result = this.database.prepare(`
        UPDATE approval_records
        SET status = 'consumed', consumed_at = ?
        WHERE action_id = ? AND status = 'approved'
          AND payload_hash = ? AND expires_at = ? AND expected_state_hash = ?
          AND expires_at > ?
      `).run(
        options.consumedAt,
        options.actionId,
        options.payloadHash,
        options.expiresAt,
        options.expectedStateHash,
        options.consumedAt,
      );
      if (result.changes !== 1) throw new Error('approval consumption changed concurrently');
      const consumed = {
        ...record,
        status: 'consumed' as const,
        consumedAt: options.consumedAt,
      };
      this.audit(options.consumedAt, 'consumed', consumed, {});
      return consumed;
    });
  }

  async cleanup(
    now: string,
    retainDecisionsAfter: string,
  ): Promise<ApprovalCleanupResult> {
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(retainDecisionsAfter))) {
      throw new Error('cleanup timestamps must be valid ISO dates');
    }
    if (retainDecisionsAfter > now) {
      throw new Error('decision retention threshold cannot be in the future');
    }
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT action_id, payload_hash, status
        FROM approval_records
        WHERE
          (status IN ('pending', 'approved') AND expires_at <= ?)
          OR
          (
            status IN ('rejected', 'consumed')
            AND COALESCE(consumed_at, decided_at, created_at) <= ?
          )
      `).all(now, retainDecisionsAfter) as Array<{
        action_id: string;
        payload_hash: string;
        status: ApprovalRecord['status'];
      }>;
      for (const row of rows) {
        this.database.prepare(`
          INSERT INTO approval_audit (
            at, event, action_id, payload_hash, details_json
          ) VALUES (?, 'purged', ?, ?, ?)
        `).run(
          now,
          row.action_id,
          row.payload_hash,
          JSON.stringify({ priorStatus: row.status }),
        );
      }
      if (rows.length > 0) {
        const ids = rows.map((row) => row.action_id);
        const placeholders = ids.map(() => '?').join(',');
        this.database.prepare(`
          DELETE FROM approval_records
          WHERE action_id IN (${placeholders})
        `).run(...ids);
      }
      return {
        expiredPendingOrApproved: rows.filter(
          (row) => row.status === 'pending' || row.status === 'approved',
        ).length,
        retainedDecisionRecords: rows.filter(
          (row) => row.status === 'rejected' || row.status === 'consumed',
        ).length,
      };
    });
  }

  private getSync(actionId: string): ApprovalRecord {
    const row = this.database
      .prepare(`${SELECT_RECORD} WHERE action_id = ?`)
      .get(actionId) as ApprovalRow | undefined;
    if (!row) throw new Error('unknown action');
    return this.recordFromRow(row);
  }

  private encryptIntent(record: ApprovalRecord): {
    nonce: Buffer;
    ciphertext: Buffer;
    authTag: Buffer;
  } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${record.actionId}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record.intent), 'utf8'),
      cipher.final(),
    ]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  private recordFromRow(row: ApprovalRow): ApprovalRecord {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(row.intent_nonce),
    );
    decipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${row.action_id}`));
    decipher.setAuthTag(Buffer.from(row.intent_auth_tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.intent_ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    return {
      actionId: row.action_id,
      idempotencyKey: row.idempotency_key,
      intent: parseActionIntent(JSON.parse(plaintext)),
      payloadHash: row.payload_hash,
      expectedStateHash: row.expected_state_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    };
  }

  private audit(
    at: string,
    event: string,
    record: ApprovalRecord,
    details: Record<string, unknown>,
  ): void {
    this.database.prepare(`
      INSERT INTO approval_audit (at, event, action_id, payload_hash, details_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(at, event, record.actionId, record.payloadHash, JSON.stringify(details));
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
