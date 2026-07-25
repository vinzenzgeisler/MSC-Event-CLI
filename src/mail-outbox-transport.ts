import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  parseMailReplyIntent,
  parseMailSendIntent,
  type MscMailAccount,
} from './mail-approved-action.js';
import {
  SqliteDurableOutbox,
  type OutboxRecord,
} from './durable-outbox.js';

const messageIdDomainSchema = z.string().trim().min(1).max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    'message id domain must be a fully qualified DNS name',
  );

const deliveryCodeSchema = z.string().trim().min(1).max(100)
  .regex(/^[a-z][a-z0-9-]*$/);

export interface MailTransportEnvelope {
  actionId: string;
  payloadHash: string;
  account: MscMailAccount;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  messageId: string;
  inReplyToMessageId?: string;
}

export type MailTransportResult =
  | {
    status: 'accepted';
  }
  | {
    status: 'not-submitted';
    reasonCode: string;
  }
  | {
    status: 'unknown';
    reasonCode: string;
  };

/**
 * Transport implementations must not return `not-submitted` after bytes may
 * have crossed the provider boundary. Timeouts, connection loss after write,
 * and ambiguous acknowledgements are always `unknown`.
 */
export interface MailTransport {
  deliver(envelope: MailTransportEnvelope): Promise<MailTransportResult>;
}

export const deterministicMessageId = (
  actionId: string,
  payloadHash: string,
  domainValue: string,
): string => {
  const domain = messageIdDomainSchema.parse(domainValue).toLowerCase();
  const digest = createHash('sha256')
    .update('msc-approved-mail/v1\0')
    .update(actionId)
    .update('\0')
    .update(payloadHash)
    .digest('hex');
  return `<msc-approved-${digest}@${domain}>`;
};

const transportEnvelope = (
  record: OutboxRecord,
  messageIdDomain: string,
): MailTransportEnvelope => {
  if (record.kind === 'mail.send') {
    const intent = parseMailSendIntent(record.payload);
    if (intent.parameters.dryRun) {
      throw new Error('mail transport refuses a dry-run intent');
    }
    return {
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      account: intent.after.account,
      from: intent.after.from,
      to: intent.after.to,
      subject: intent.after.subject,
      bodyText: intent.after.bodyText,
      messageId: deterministicMessageId(
        record.actionId,
        record.payloadHash,
        messageIdDomain,
      ),
    };
  }
  if (record.kind === 'mail.reply') {
    const intent = parseMailReplyIntent(record.payload);
    if (intent.parameters.dryRun) {
      throw new Error('mail transport refuses a dry-run intent');
    }
    return {
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      account: intent.after.account,
      from: intent.after.from,
      to: intent.after.to,
      subject: intent.after.subject,
      bodyText: intent.after.bodyText,
      messageId: deterministicMessageId(
        record.actionId,
        record.payloadHash,
        messageIdDomain,
      ),
      inReplyToMessageId: intent.after.inReplyToMessageId,
    };
  }
  throw new Error(`unsupported mail outbox kind ${record.kind}`);
};

export interface MailDispatchResult {
  actionId: string;
  attemptId: string;
  messageId: string;
  status: 'accepted' | 'queued' | 'uncertain';
}

/**
 * Dispatches only through an injected transport. The production repository
 * intentionally provides no SMTP, Himalaya, process, or network transport.
 */
export class MailOutboxDispatchWorker {
  constructor(
    private readonly outbox: SqliteDurableOutbox,
    private readonly transport: MailTransport,
    private readonly options: {
      workerId: string;
      messageIdDomain: string;
      now?: () => Date;
    },
  ) {
    messageIdDomainSchema.parse(options.messageIdDomain);
  }

  async dispatch(actionId: string): Promise<MailDispatchResult> {
    const queued = this.outbox.get(actionId);
    if (queued.status !== 'queued') {
      throw new Error(`outbox action is ${queued.status}, not queued`);
    }
    const envelope = transportEnvelope(queued, this.options.messageIdDomain);
    const claimedAt = this.now();
    const claimed = this.outbox.claim(
      actionId,
      this.options.workerId,
      claimedAt,
    );
    const attemptId = claimed.attemptId!;
    try {
      const result = await this.transport.deliver(envelope);
      if (result.status === 'accepted') {
        this.outbox.markAccepted(actionId, attemptId, this.now());
        return {
          actionId,
          attemptId,
          messageId: envelope.messageId,
          status: 'accepted',
        };
      }
      const reasonCode = deliveryCodeSchema.parse(result.reasonCode);
      if (result.status === 'not-submitted') {
        this.outbox.releaseBeforeHandoff(
          actionId,
          attemptId,
          this.now(),
          reasonCode,
        );
        return {
          actionId,
          attemptId,
          messageId: envelope.messageId,
          status: 'queued',
        };
      }
      this.outbox.markUncertain(
        actionId,
        attemptId,
        this.now(),
        reasonCode,
      );
      return {
        actionId,
        attemptId,
        messageId: envelope.messageId,
        status: 'uncertain',
      };
    } catch {
      this.outbox.markUncertain(
        actionId,
        attemptId,
        this.now(),
        'transport-threw',
      );
      return {
        actionId,
        attemptId,
        messageId: envelope.messageId,
        status: 'uncertain',
      };
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}
