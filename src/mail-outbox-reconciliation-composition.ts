import { z } from 'zod';
import type { OutboxRecord } from './durable-outbox.js';
import { SqliteDurableOutbox } from './durable-outbox.js';
import {
  MailOutboxReconciliationHttpContract,
} from './mail-outbox-reconciliation-http.js';
import {
  MailOutboxReconciliationService,
  WebAuthnReconciliationAuth,
} from './mail-outbox-reconciliation.js';
import {
  mscMailAccountSchema,
  parseMailReplyIntent,
  parseMailSendIntent,
  type MscMailAccount,
} from './mail-approved-action.js';
import { SqliteWebAuthnStore } from './webauthn-sqlite.js';
import {
  WebAuthnFreshAuthVerifier,
  type WebAuthnFreshAuthOptions,
} from './webauthn.js';

const mailActionKindSchema = z.enum(['mail.send', 'mail.reply']);
export type MailActionKind = z.infer<typeof mailActionKindSchema>;

const reviewerRuleSchema = z.object({
  accounts: z.array(mscMailAccountSchema).min(1).max(3),
  actionKinds: z.array(mailActionKindSchema).min(1).max(2),
}).strict();

const reviewerPolicySchema = z.record(
  z.string().trim().min(1).max(128),
  reviewerRuleSchema,
).refine(
  (policy) => Object.keys(policy).length > 0,
  'at least one reconciliation reviewer is required',
);

export type MailOutboxReviewerPolicy = Record<
  string,
  {
    accounts: MscMailAccount[];
    actionKinds: MailActionKind[];
  }
>;

export interface MailOutboxReconciliationCompositionOptions {
  outboxPath: string;
  webauthnPath: string;
  outboxEncryptionKey: Uint8Array;
  publicOrigin: string;
  rpId: string;
  expectedOrigins: string[];
  reviewerPolicy: MailOutboxReviewerPolicy;
  challengeTtlSeconds?: number;
  maxFreshAuthAgeSeconds?: number;
  now?: () => Date;
  verifyAuthentication?: WebAuthnFreshAuthOptions['verifyAuthentication'];
}

const mailAccountFromRecord = (record: OutboxRecord): MscMailAccount => {
  if (record.kind === 'mail.send') {
    return parseMailSendIntent(record.payload).after.account;
  }
  if (record.kind === 'mail.reply') {
    return parseMailReplyIntent(record.payload).after.account;
  }
  throw new Error('outbox action kind is not eligible for mail reconciliation');
};

/**
 * Explicit reviewer authorization over both the action kind and encrypted
 * mailbox payload. Unknown actors, action kinds and mailbox accounts fail
 * closed.
 */
export const createMailOutboxReviewerAuthorizer = (
  policyValue: MailOutboxReviewerPolicy,
): ((actor: string, record: OutboxRecord) => Promise<boolean>) => {
  const policy = reviewerPolicySchema.parse(policyValue);
  return async (actor, record) => {
    const rule = policy[actor];
    if (!rule || !mailActionKindSchema.safeParse(record.kind).success) {
      return false;
    }
    try {
      const account = mailAccountFromRecord(record);
      return rule.actionKinds.includes(record.kind as MailActionKind) &&
        rule.accounts.includes(account);
    } catch {
      return false;
    }
  };
};

/**
 * Inactive composition root for manual mail-attempt reconciliation.
 *
 * It opens only local SQLite stores and constructs an in-memory HTTP contract.
 * It deliberately has no listener, plugin registration, scheduler, worker or
 * mail transport, so constructing it cannot expose an endpoint or send mail.
 */
export class MailOutboxReconciliationComposition {
  readonly outbox: SqliteDurableOutbox;
  readonly webauthnStore: SqliteWebAuthnStore;
  readonly freshAuth: WebAuthnReconciliationAuth;
  readonly service: MailOutboxReconciliationService;
  readonly http: MailOutboxReconciliationHttpContract;
  private closed = false;

  constructor(options: MailOutboxReconciliationCompositionOptions) {
    const authorizeReviewer = createMailOutboxReviewerAuthorizer(
      options.reviewerPolicy,
    );
    this.outbox = new SqliteDurableOutbox(options.outboxPath, {
      encryptionKey: options.outboxEncryptionKey,
    });
    try {
      this.webauthnStore = new SqliteWebAuthnStore(options.webauthnPath);
    } catch (error) {
      this.outbox.close();
      throw error;
    }
    try {
      const webauthn = new WebAuthnFreshAuthVerifier({
        rpId: options.rpId,
        expectedOrigins: options.expectedOrigins,
        credentials: this.webauthnStore,
        challenges: this.webauthnStore,
        ...(options.challengeTtlSeconds === undefined
          ? {}
          : { challengeTtlSeconds: options.challengeTtlSeconds }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.verifyAuthentication === undefined
          ? {}
          : { verifyAuthentication: options.verifyAuthentication }),
      });
      this.freshAuth = new WebAuthnReconciliationAuth(webauthn);
      this.service = new MailOutboxReconciliationService(
        this.outbox,
        this.freshAuth,
        {
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.maxFreshAuthAgeSeconds === undefined
            ? {}
            : { maxFreshAuthAgeSeconds: options.maxFreshAuthAgeSeconds }),
        },
      );
      this.http = new MailOutboxReconciliationHttpContract({
        publicOrigin: options.publicOrigin,
        service: this.service,
        freshAuth: this.freshAuth,
        authorizeReviewer,
      });
    } catch (error) {
      this.webauthnStore.close();
      this.outbox.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.webauthnStore.close();
    this.outbox.close();
  }
}
