import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MailOutboxReconciliationComposition,
  type MailActionKind,
  type MailOutboxReconciliationCompositionOptions,
  type MailOutboxReviewerPolicy,
} from './mail-outbox-reconciliation-composition.js';
import { mscMailAccountSchema, type MscMailAccount } from './mail-approved-action.js';
import { validateWebAuthnRelyingPartyConfiguration } from './webauthn.js';

const mailActionKindSchema = z.enum(['mail.send', 'mail.reply']);
const runtimeConfigSchema = z.object({
  version: z.literal(1),
  outboxPath: z.string().min(1),
  webauthnPath: z.string().min(1),
  publicOrigin: z.string().min(1),
  rpId: z.string().min(1),
  expectedOrigins: z.array(z.string().min(1)).min(1).max(10),
  reviewerPolicy: z.record(
    z.string().trim().min(1).max(128),
    z.object({
      accounts: z.array(mscMailAccountSchema).min(1).max(3),
      actionKinds: z.array(mailActionKindSchema).min(1).max(2),
    }).strict(),
  ),
  challengeTtlSeconds: z.number().int().min(30).max(300).default(120),
  maxFreshAuthAgeSeconds: z.number().int().min(1).max(900).default(300),
}).strict().superRefine((config, context) => {
  for (const field of ['outboxPath', 'webauthnPath'] as const) {
    if (!isAbsolute(config[field])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be absolute`,
      });
    }
  }
  if (Object.keys(config.reviewerPolicy).length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewerPolicy'],
      message: 'at least one reconciliation reviewer is required',
    });
  }
  if (config.outboxPath === config.webauthnPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['webauthnPath'],
      message: 'outboxPath and webauthnPath must differ',
    });
  }
});

export type MailOutboxReconciliationRuntimeConfig = z.infer<
  typeof runtimeConfigSchema
>;

export interface MailOutboxReconciliationReadiness {
  ready: true;
  inactive: true;
  version: 1;
  publicOrigin: string;
  rpId: string;
  expectedOriginCount: number;
  reviewerCount: number;
  accountCoverage: MscMailAccount[];
  actionKindCoverage: MailActionKind[];
  statePathsConfigured: 2;
  encryptionKey: 'injected-32-byte-key';
}

const parseRuntimeConfig = (
  value: unknown,
): MailOutboxReconciliationRuntimeConfig => {
  const config = runtimeConfigSchema.parse(value);
  const publicOrigin = new URL(config.publicOrigin);
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.origin !== config.publicOrigin
  ) {
    throw new Error('publicOrigin must be an exact HTTPS origin');
  }
  validateWebAuthnRelyingPartyConfiguration({
    rpId: config.rpId,
    expectedOrigins: config.expectedOrigins,
    challengeTtlSeconds: config.challengeTtlSeconds,
  });
  if (!config.expectedOrigins.includes(config.publicOrigin)) {
    throw new Error('expectedOrigins must include publicOrigin');
  }
  if (
    publicOrigin.hostname !== config.rpId &&
    !publicOrigin.hostname.endsWith(`.${config.rpId}`)
  ) {
    throw new Error('rpId must equal or be a registrable suffix of publicOrigin');
  }
  return config;
};

/**
 * Loads operational policy through one verified descriptor. The configuration
 * contains no encryption key, credential or session secret.
 */
export const loadTrustedMailOutboxReconciliationConfig = async (
  path: string,
  options: { expectedOwnerUid?: number } = {},
): Promise<MailOutboxReconciliationRuntimeConfig> => {
  if (!isAbsolute(path)) throw new Error('reconciliation config path must be absolute');
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('reconciliation config must be a regular file');
    }
    const expectedOwnerUid = options.expectedOwnerUid ?? 0;
    if (stat.uid !== expectedOwnerUid) {
      throw new Error(`reconciliation config must be owned by uid ${expectedOwnerUid}`);
    }
    if ((stat.mode & 0o037) !== 0) {
      throw new Error(
        'reconciliation config may be group-readable but must not be group-writable or world-accessible',
      );
    }
    return parseRuntimeConfig(
      JSON.parse(await handle.readFile({ encoding: 'utf8' })),
    );
  } finally {
    await handle.close();
  }
};

/**
 * Pure readiness check. It opens no database, listener, worker or transport and
 * returns no actor identifiers, filesystem paths or key bytes.
 */
export const checkMailOutboxReconciliationReadiness = (
  configValue: unknown,
  outboxEncryptionKey: Uint8Array,
): MailOutboxReconciliationReadiness => {
  const config = parseRuntimeConfig(configValue);
  if (outboxEncryptionKey.byteLength !== 32) {
    throw new Error('outbox encryption key must contain exactly 32 bytes');
  }
  const rules = Object.values(config.reviewerPolicy);
  return {
    ready: true,
    inactive: true,
    version: 1,
    publicOrigin: config.publicOrigin,
    rpId: config.rpId,
    expectedOriginCount: config.expectedOrigins.length,
    reviewerCount: rules.length,
    accountCoverage: [...new Set(rules.flatMap((rule) => rule.accounts))].sort(),
    actionKindCoverage: [
      ...new Set(rules.flatMap((rule) => rule.actionKinds)),
    ].sort(),
    statePathsConfigured: 2,
    encryptionKey: 'injected-32-byte-key',
  };
};

export const reconciliationCompositionOptions = (
  configValue: unknown,
  outboxEncryptionKey: Uint8Array,
): Omit<
  MailOutboxReconciliationCompositionOptions,
  'now' | 'verifyAuthentication'
> => {
  const config = parseRuntimeConfig(configValue);
  checkMailOutboxReconciliationReadiness(config, outboxEncryptionKey);
  return {
    outboxPath: config.outboxPath,
    webauthnPath: config.webauthnPath,
    outboxEncryptionKey,
    publicOrigin: config.publicOrigin,
    rpId: config.rpId,
    expectedOrigins: config.expectedOrigins,
    reviewerPolicy: config.reviewerPolicy as MailOutboxReviewerPolicy,
    challengeTtlSeconds: config.challengeTtlSeconds,
    maxFreshAuthAgeSeconds: config.maxFreshAuthAgeSeconds,
  };
};

const inspectExistingSqliteState = async (
  path: string,
  expectedOwnerUid: number,
  requiredTable: string,
): Promise<void> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let database: DatabaseSync | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error('reconciliation state must be a regular file');
    }
    if (before.uid !== expectedOwnerUid) {
      throw new Error(
        `reconciliation state must be owned by uid ${expectedOwnerUid}`,
      );
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error(
        'reconciliation state must not be group- or world-accessible',
      );
    }
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new Error('reconciliation state failed SQLite integrity check');
    }
    const schema = database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `).get(requiredTable) as { name?: unknown } | undefined;
    if (schema?.name !== requiredTable) {
      throw new Error('reconciliation state has unexpected SQLite schema');
    }
    const after = await stat(path);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('reconciliation state changed during validation');
    }
  } finally {
    database?.close();
    await handle.close();
  }
};

/**
 * Existing state is accepted only as a complete, private and intact pair.
 * Two absent paths are the sole fresh-install state; a partial restore never
 * reaches constructors that could silently initialize the missing database.
 */
export const validateInactiveMailOutboxReconciliationState = async (
  configValue: unknown,
  options: { expectedOwnerUid?: number } = {},
): Promise<'fresh' | 'existing'> => {
  const config = parseRuntimeConfig(configValue);
  const expectedOwnerUid = options.expectedOwnerUid ?? process.getuid?.();
  if (expectedOwnerUid === undefined) {
    throw new Error('reconciliation state owner uid is required');
  }
  const existence = await Promise.all(
    [config.outboxPath, config.webauthnPath].map(async (path) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }),
  );
  if (!existence[0] && !existence[1]) return 'fresh';
  if (!existence[0] || !existence[1]) {
    throw new Error(
      'reconciliation state is incomplete; outbox and WebAuthn databases must be restored together',
    );
  }
  await inspectExistingSqliteState(
    config.outboxPath,
    expectedOwnerUid,
    'durable_outbox',
  );
  await inspectExistingSqliteState(
    config.webauthnPath,
    expectedOwnerUid,
    'webauthn_credentials',
  );
  return 'existing';
};

export interface OpenInactiveMailOutboxReconciliationOptions {
  configPath: string;
  outboxEncryptionKey: Uint8Array;
  expectedConfigOwnerUid?: number;
  expectedStateOwnerUid?: number;
  now?: () => Date;
  verifyAuthentication?: MailOutboxReconciliationCompositionOptions[
    'verifyAuthentication'
  ];
}

export interface OpenInactiveMailOutboxReconciliationResult {
  composition: MailOutboxReconciliationComposition;
  readiness: MailOutboxReconciliationReadiness;
}

/**
 * Complete but still inactive local start path. Configuration is authenticated
 * and fully validated before SQLite files are opened. The returned composition
 * remains inert until a separately approved host explicitly binds its HTTP
 * contract and session adapter.
 */
export const openInactiveMailOutboxReconciliation = async (
  options: OpenInactiveMailOutboxReconciliationOptions,
): Promise<OpenInactiveMailOutboxReconciliationResult> => {
  const config = await loadTrustedMailOutboxReconciliationConfig(
    options.configPath,
    options.expectedConfigOwnerUid === undefined
      ? {}
      : { expectedOwnerUid: options.expectedConfigOwnerUid },
  );
  const readiness = checkMailOutboxReconciliationReadiness(
    config,
    options.outboxEncryptionKey,
  );
  await validateInactiveMailOutboxReconciliationState(
    config,
    options.expectedStateOwnerUid === undefined
      ? {}
      : { expectedOwnerUid: options.expectedStateOwnerUid },
  );
  const composition = new MailOutboxReconciliationComposition({
    ...reconciliationCompositionOptions(
      config,
      options.outboxEncryptionKey,
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.verifyAuthentication === undefined
      ? {}
      : { verifyAuthentication: options.verifyAuthentication }),
  });
  return { composition, readiness };
};
