import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ActionPreview, JsonValue } from './action.js';
import { jsonValueSchema } from './action.js';
import { SqliteApprovalStore } from './approval-sqlite.js';
import { ApprovalQueue, type ApprovalRecord } from './approval.js';
import {
  createEventEntryChangeIntent,
  EventEntryChangePreviewRenderer,
  type EventEntryOperation,
} from './event-approved-action.js';
import type { MscEventReadonlyProvider } from './event-readonly-provider.js';
import {
  createMailReplyIntent,
  MailReplyPreviewRenderer,
  mscMailAccountPolicySchema,
  type MscMailAccount,
  type MscMailAccountPolicy,
} from './mail-approved-action.js';
import type {
  MscMailProviderEnvelope,
  MscMailReadonlyProvider,
} from './mail-readonly-provider.js';
import { parseMailPreviewSource } from './mail-preview-source.js';

const exactHttpsOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'publicOrigin must be an exact HTTPS origin',
    });
  }
});

const configSchema = z.object({
  version: z.literal(1),
  stateDatabasePath: z.string().min(1),
  encryptionKeyFile: z.string().min(1),
  signingKeyFile: z.string().min(1),
  publicOrigin: exactHttpsOriginSchema,
  basePath: z.union([
    z.literal(''),
    z.string().regex(
      /^\/[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/,
    ).max(200),
  ]).default(''),
  mailPolicy: mscMailAccountPolicySchema,
}).strict().superRefine((config, context) => {
  for (const field of [
    'stateDatabasePath',
    'encryptionKeyFile',
    'signingKeyFile',
  ] as const) {
    if (!isAbsolute(config[field])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be absolute`,
      });
    }
  }
});

export type MscApprovalProposalConfig = z.infer<typeof configSchema>;

export interface ApprovalProposalResult {
  actionId: string;
  status: 'pending';
  expiresAt: string;
  approvalUrl: string;
  payloadReference: string;
  preview: ActionPreview;
}

export interface EventEntryProposalInput {
  entryId: string;
  label?: string;
  operation: EventEntryOperation;
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface MailReplyProposalInput {
  account: MscMailAccount;
  folder: string;
  messageId: string;
  bodyText: string;
  sources: string[];
  uncertainties?: string[];
  idempotencyKey: string;
  ttlSeconds?: number;
}

const safeFile = async (
  path: string,
  expectedOwnerUid: number,
  maxBytes: number,
  secret: boolean,
): Promise<Buffer> => {
  if (!isAbsolute(path)) throw new Error('trusted file path must be absolute');
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('trusted file must be regular');
    if (stat.uid !== expectedOwnerUid) {
      throw new Error(`trusted file must be owned by uid ${expectedOwnerUid}`);
    }
    const forbiddenMode = secret ? 0o077 : 0o037;
    if ((stat.mode & forbiddenMode) !== 0) {
      throw new Error(secret
        ? 'secret file must not be accessible by group or world'
        : 'config file must not be group-writable or world-accessible');
    }
    if (stat.size > maxBytes) throw new Error('trusted file is too large');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const loadMscApprovalProposalConfig = async (
  path: string,
  expectedOwnerUid = 0,
): Promise<MscApprovalProposalConfig> => configSchema.parse(JSON.parse(
  (await safeFile(path, expectedOwnerUid, 64 * 1024, false)).toString('utf8'),
));

const decodeKey = (value: Buffer): Buffer => {
  const text = value.toString('utf8').trim();
  const decoded = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64url');
  if (decoded.byteLength !== 32) {
    throw new Error('key file must contain one 32-byte hex or base64url key');
  }
  return decoded;
};

export const loadPrivateMscApprovalKey = async (
  path: string,
  expectedOwnerUid = 0,
): Promise<Buffer> => decodeKey(
  await safeFile(path, expectedOwnerUid, 256, true),
);

const sourceFromEnvelope = (
  envelope: MscMailProviderEnvelope,
  expectedMessageId: string,
): { from: string; subject: string } => {
  const source = parseMailPreviewSource(envelope.data, expectedMessageId);
  return { from: source.from, subject: source.subject };
};

const proposal = (
  record: ApprovalRecord,
  approvalBaseUrl: string,
  preview: ActionPreview,
): ApprovalProposalResult => ({
  actionId: record.actionId,
  status: 'pending',
  expiresAt: record.expiresAt,
  approvalUrl: `${approvalBaseUrl}/approve/${record.actionId}`,
  payloadReference: record.payloadHash.slice(0, 12),
  preview,
});

/**
 * Shared persistent proposal boundary for the operator CLI. It can read only
 * through the fixed providers and can write only encrypted approval records.
 * It owns no executor, mutation transport, SMTP transport, listener or worker.
 */
export class MscApprovalProposalWriter {
  private readonly eventRenderer = new EventEntryChangePreviewRenderer();
  private readonly mailRenderer = new MailReplyPreviewRenderer();

  constructor(
    private readonly event: MscEventReadonlyProvider,
    private readonly mail: MscMailReadonlyProvider,
    private readonly queue: ApprovalQueue,
    private readonly approvalBaseUrl: string,
    private readonly mailPolicy: MscMailAccountPolicy,
  ) {}

  async proposeEventEntryChange(
    input: EventEntryProposalInput,
  ): Promise<ApprovalProposalResult> {
    const snapshot = jsonValueSchema.parse(
      await this.event.detail(input.entryId),
    ) as JsonValue;
    const intent = createEventEntryChangeIntent({
      entryId: input.entryId,
      ...(input.label ? { label: input.label } : {}),
      currentSnapshot: snapshot,
      operation: input.operation,
    });
    const record = await this.queue.propose(
      intent,
      input.idempotencyKey,
      input.ttlSeconds,
    );
    return proposal(
      record,
      this.approvalBaseUrl,
      this.eventRenderer.render(intent),
    );
  }

  async proposeMailReply(
    input: MailReplyProposalInput,
  ): Promise<ApprovalProposalResult> {
    const envelope = await this.mail.preview(
      input.account,
      input.folder,
      input.messageId,
    );
    const source = sourceFromEnvelope(envelope, input.messageId);
    const intent = createMailReplyIntent(this.mailPolicy, {
      source: {
        account: input.account,
        folder: input.folder,
        messageId: input.messageId,
        from: source.from,
        subject: source.subject,
      },
      bodyText: input.bodyText,
      triageStatus: 'READY_TO_DRAFT',
      sources: input.sources,
      uncertainties: input.uncertainties ?? [],
      deliveryMode: 'approved-send',
    });
    const record = await this.queue.propose(
      intent,
      input.idempotencyKey,
      input.ttlSeconds,
    );
    return proposal(
      record,
      this.approvalBaseUrl,
      this.mailRenderer.render(intent),
    );
  }
}

export interface OpenMscApprovalProposalWriterOptions {
  /** @deprecated Use configOwnerUid and secretOwnerUid for new callers. */
  expectedOwnerUid?: number;
  configOwnerUid?: number;
  secretOwnerUid?: number;
  event: MscEventReadonlyProvider;
  mail: MscMailReadonlyProvider;
}

export const openMscApprovalProposalWriter = async (
  configPath: string,
  options: OpenMscApprovalProposalWriterOptions,
): Promise<{ writer: MscApprovalProposalWriter; close(): void }> => {
  const configOwnerUid = options.configOwnerUid ??
    options.expectedOwnerUid ?? 0;
  const secretOwnerUid = options.secretOwnerUid ??
    options.expectedOwnerUid ?? process.getuid?.() ?? 0;
  const config = await loadMscApprovalProposalConfig(
    configPath,
    configOwnerUid,
  );
  const [encryptionKey, signingKey] = await Promise.all([
    loadPrivateMscApprovalKey(config.encryptionKeyFile, secretOwnerUid),
    loadPrivateMscApprovalKey(config.signingKeyFile, secretOwnerUid),
  ]);
  const store = new SqliteApprovalStore(config.stateDatabasePath, {
    encryptionKey,
  });
  const queue = new ApprovalQueue({
    store,
    signingKey,
    freshAuthVerifier: {
      async verify() {
        throw new Error('proposal-only CLI cannot verify passkeys');
      },
    },
  });
  return {
    writer: new MscApprovalProposalWriter(
      options.event,
      options.mail,
      queue,
      `${config.publicOrigin}${config.basePath}`,
      config.mailPolicy,
    ),
    close: () => store.close(),
  };
};

export const readOperatorDraftFile = async (
  path: string,
  maxBytes = 256 * 1024,
): Promise<string> => {
  if (!isAbsolute(path)) throw new Error('draft file path must be absolute');
  const content = await readFile(path);
  if (content.byteLength > maxBytes) throw new Error('draft file is too large');
  return content.toString('utf8');
};
