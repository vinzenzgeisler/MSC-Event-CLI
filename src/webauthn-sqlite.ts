import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import type {
  RegisteredWebAuthnCredential,
  WebAuthnChallenge,
  WebAuthnChallengeStore,
  WebAuthnCredentialRepository,
} from './webauthn.js';
import type {
  WebAuthnRegistrationChallenge,
  WebAuthnRegistrationChallengeStore,
} from './webauthn-registration.js';
import type {
  PasskeyBootstrapGrant,
  PasskeyBootstrapGrantStore,
  PasskeyBootstrapAuditEvent,
} from './passkey-bootstrap.js';

type CredentialRow = {
  credential_id: string;
  actor: string;
  public_key: Uint8Array;
  signature_counter: number;
  revision: number;
  transports_json: string | null;
};

type ChallengeRow = {
  challenge_id: string;
  challenge: string;
  actor: string;
  action_id: string;
  payload_hash: string;
  decision: 'approve' | 'reject';
  issued_at: string;
  expires_at: string;
};

type RegistrationChallengeRow = {
  challenge_id: string;
  challenge: string;
  actor: string;
  issued_at: string;
  expires_at: string;
};

type BootstrapGrantRow = {
  grant_id: string;
  actor: string;
  secret_hash: Uint8Array;
  issued_at: string;
  expires_at: string;
};

const asNumber = (value: SQLOutputValue, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${field} in WebAuthn store`);
  }
  return value;
};

const parseTransports = (value: string | null): AuthenticatorTransportFuture[] | undefined => {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid transports in WebAuthn store');
  }
  return parsed as AuthenticatorTransportFuture[];
};

const credentialFromRow = (row: CredentialRow): RegisteredWebAuthnCredential => {
  const transports = parseTransports(row.transports_json);
  return {
    credentialId: row.credential_id,
    actor: row.actor,
    publicKey: new Uint8Array(row.public_key),
    counter: asNumber(row.signature_counter, 'signature counter'),
    revision: asNumber(row.revision, 'credential revision'),
    ...(transports ? { transports } : {}),
  };
};

const challengeFromRow = (row: ChallengeRow): WebAuthnChallenge => ({
  challengeId: row.challenge_id,
  challenge: row.challenge,
  actor: row.actor,
  context: {
    actionId: row.action_id,
    payloadHash: row.payload_hash,
    decision: row.decision,
  },
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
});

/**
 * Shared transactional store for WebAuthn challenges and credentials.
 *
 * Node's built-in SQLite driver keeps the dependency surface small. Every
 * challenge is consumed with one DELETE ... RETURNING statement. Credential
 * counter updates compare both the authenticator counter and an internal
 * revision, so synced passkeys whose counter remains zero still fail closed on
 * a stale concurrent snapshot.
 */
export class SqliteWebAuthnStore
  implements
    WebAuthnChallengeStore,
    WebAuthnCredentialRepository,
    WebAuthnRegistrationChallengeStore,
    PasskeyBootstrapGrantStore
{
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        public_key BLOB NOT NULL,
        signature_counter INTEGER NOT NULL CHECK (signature_counter >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        transports_json TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS webauthn_credentials_actor
        ON webauthn_credentials(actor);

      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        challenge_id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        actor TEXT NOT NULL,
        action_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS webauthn_registration_challenges (
        challenge_id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        actor TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS passkey_bootstrap_grants (
        grant_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        secret_hash BLOB NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS passkey_bootstrap_audit (
        event_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        authentication_method TEXT NOT NULL CHECK (
          authentication_method = 'local-os-user'
        ),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `);
    const bootstrapColumns = this.database.prepare(
      'PRAGMA table_info(passkey_bootstrap_grants)',
    ).all() as Array<{ name: string }>;
    if (!bootstrapColumns.some((column) => column.name === 'consumed')) {
      this.database.exec(`
        ALTER TABLE passkey_bootstrap_grants
        ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1));
      `);
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS passkey_bootstrap_grants_actor
      ON passkey_bootstrap_grants(actor);
    `);
  }

  close(): void {
    this.database.close();
  }

  async registerCredential(credential: RegisteredWebAuthnCredential): Promise<void> {
    this.database.prepare(`
      INSERT INTO webauthn_credentials (
        credential_id, actor, public_key, signature_counter, revision, transports_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      credential.credentialId,
      credential.actor,
      credential.publicKey,
      credential.counter,
      credential.revision,
      credential.transports ? JSON.stringify(credential.transports) : null,
    );
  }

  async listByActor(actor: string): Promise<RegisteredWebAuthnCredential[]> {
    const rows = this.database.prepare(`
      SELECT credential_id, actor, public_key, signature_counter, revision, transports_json
      FROM webauthn_credentials
      WHERE actor = ?
      ORDER BY credential_id
    `).all(actor) as CredentialRow[];
    return rows.map(credentialFromRow);
  }

  async findById(credentialId: string): Promise<RegisteredWebAuthnCredential | undefined> {
    const row = this.database.prepare(`
      SELECT credential_id, actor, public_key, signature_counter, revision, transports_json
      FROM webauthn_credentials
      WHERE credential_id = ?
    `).get(credentialId) as CredentialRow | undefined;
    return row ? credentialFromRow(row) : undefined;
  }

  async updateCounter(
    credentialId: string,
    expectedCounter: number,
    expectedRevision: number,
    newCounter: number,
  ): Promise<void> {
    const result = this.database.prepare(`
      UPDATE webauthn_credentials
      SET signature_counter = ?, revision = revision + 1
      WHERE credential_id = ? AND signature_counter = ? AND revision = ?
    `).run(newCounter, credentialId, expectedCounter, expectedRevision);
    if (result.changes !== 1) throw new Error('credential counter or revision changed concurrently');
  }

  async save(challenge: WebAuthnChallenge): Promise<void> {
    this.database.prepare(`
      INSERT INTO webauthn_challenges (
        challenge_id, challenge, actor, action_id, payload_hash, decision, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      challenge.challengeId,
      challenge.challenge,
      challenge.actor,
      challenge.context.actionId,
      challenge.context.payloadHash,
      challenge.context.decision,
      challenge.issuedAt,
      challenge.expiresAt,
    );
  }

  async take(challengeId: string): Promise<WebAuthnChallenge | undefined> {
    const row = this.database.prepare(`
      DELETE FROM webauthn_challenges
      WHERE challenge_id = ?
      RETURNING challenge_id, challenge, actor, action_id, payload_hash, decision, issued_at, expires_at
    `).get(challengeId) as ChallengeRow | undefined;
    return row ? challengeFromRow(row) : undefined;
  }

  async saveRegistration(challenge: WebAuthnRegistrationChallenge): Promise<void> {
    this.database.prepare(`
      INSERT INTO webauthn_registration_challenges (
        challenge_id, challenge, actor, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      challenge.challengeId,
      challenge.challenge,
      challenge.actor,
      challenge.issuedAt,
      challenge.expiresAt,
    );
  }

  async takeRegistration(
    challengeId: string,
  ): Promise<WebAuthnRegistrationChallenge | undefined> {
    const row = this.database.prepare(`
      DELETE FROM webauthn_registration_challenges
      WHERE challenge_id = ?
      RETURNING challenge_id, challenge, actor, issued_at, expires_at
    `).get(challengeId) as RegistrationChallengeRow | undefined;
    return row
      ? {
          challengeId: row.challenge_id,
          challenge: row.challenge,
          actor: row.actor,
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        }
      : undefined;
  }

  async saveBootstrapGrant(
    grant: PasskeyBootstrapGrant,
    audit: PasskeyBootstrapAuditEvent,
  ): Promise<void> {
    if (audit.grantId !== grant.grantId || audit.actor !== grant.actor) {
      throw new Error('bootstrap audit does not match grant');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO passkey_bootstrap_grants (
          grant_id, actor, secret_hash, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        grant.grantId,
        grant.actor,
        grant.secretHash,
        grant.issuedAt,
        grant.expiresAt,
      );
      this.database.prepare(`
        INSERT INTO passkey_bootstrap_audit (
          event_id, grant_id, actor, operator_id, authentication_method,
          issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        audit.eventId,
        audit.grantId,
        audit.actor,
        audit.operatorId,
        audit.authenticationMethod,
        audit.issuedAt,
        audit.expiresAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  bootstrapAuditEvents(): PasskeyBootstrapAuditEvent[] {
    return this.database.prepare(`
      SELECT
        event_id AS eventId,
        grant_id AS grantId,
        actor,
        operator_id AS operatorId,
        authentication_method AS authenticationMethod,
        issued_at AS issuedAt,
        expires_at AS expiresAt
      FROM passkey_bootstrap_audit
      ORDER BY issued_at, event_id
    `).all() as unknown as PasskeyBootstrapAuditEvent[];
  }

  async takeBootstrapGrant(
    grantId: string,
  ): Promise<PasskeyBootstrapGrant | undefined> {
    const row = this.database.prepare(`
      UPDATE passkey_bootstrap_grants
      SET consumed = 1
      WHERE grant_id = ? AND consumed = 0
      RETURNING grant_id, actor, secret_hash, issued_at, expires_at
    `).get(grantId) as BootstrapGrantRow | undefined;
    return row
      ? {
          grantId: row.grant_id,
          actor: row.actor,
          secretHash: new Uint8Array(row.secret_hash),
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        }
      : undefined;
  }

  cleanupExpiredEphemeral(now: string): {
    authenticationChallenges: number;
    registrationChallenges: number;
    unusedBootstrapGrants: number;
  } {
    if (!Number.isFinite(Date.parse(now))) {
      throw new Error('cleanup timestamp must be a valid ISO date');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const authenticationChallenges = Number(this.database.prepare(`
        DELETE FROM webauthn_challenges
        WHERE expires_at <= ?
      `).run(now).changes);
      const registrationChallenges = Number(this.database.prepare(`
        DELETE FROM webauthn_registration_challenges
        WHERE expires_at <= ?
      `).run(now).changes);
      const unusedBootstrapGrants = Number(this.database.prepare(`
        DELETE FROM passkey_bootstrap_grants
        WHERE consumed = 0 AND expires_at <= ?
      `).run(now).changes);
      this.database.exec('COMMIT');
      return {
        authenticationChallenges,
        registrationChallenges,
        unusedBootstrapGrants,
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
