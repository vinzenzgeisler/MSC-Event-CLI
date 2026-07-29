import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { z } from 'zod';
import {
  mscMailAccountSchema,
  type MscMailAccount,
} from './mail-approved-action.js';
import type {
  MailTransport,
  MailTransportEnvelope,
  MailTransportResult,
} from './mail-outbox-transport.js';

const emailSchema = z.string().trim().email().max(320).refine(
  (value) => !/[\r\n<>]/.test(value),
  'plain email address required',
);
const smtpHostSchema = z.string().trim().min(1).max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i);
const smtpAccountSchema = z.object({
  account: mscMailAccountSchema,
  host: smtpHostSchema,
  port: z.union([z.literal(465), z.literal(587)]),
  secure: z.boolean(),
  username: emailSchema,
  password: z.string().min(1).max(4_096),
  senderIdentity: emailSchema,
}).strict().superRefine((config, context) => {
  if ((config.port === 465) !== config.secure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'port 465 requires implicit TLS; port 587 requires STARTTLS',
    });
  }
  if (config.username !== config.senderIdentity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SMTP username and sender identity must match',
    });
  }
});

export type SmtpMailAccountConfig = z.infer<typeof smtpAccountSchema>;

interface SmtpClient {
  sendMail(message: {
    envelope: { from: string; to: string[] };
    from: string;
    to: string;
    subject: string;
    text: string;
    messageId: string;
    inReplyTo?: string;
    disableFileAccess: true;
    disableUrlAccess: true;
  }): Promise<{
    accepted?: unknown[];
    rejected?: unknown[];
    pending?: unknown[];
    messageId?: string;
  }>;
}

export type SmtpClientFactory = (options: SMTPTransport.Options) => SmtpClient;

const defaultFactory: SmtpClientFactory = (options) =>
  nodemailer.createTransport(options) as SmtpClient;

const normalizedAddress = (value: unknown): string => {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { address?: unknown }).address === 'string'
  ) {
    return (value as { address: string }).address.trim().toLowerCase();
  }
  return '';
};

/**
 * SMTP implementation for the already approval-gated outbox. Construction is
 * inert. It exposes no verify/test command and cannot select a default account.
 * Every exception is ambiguous and therefore quarantined by the worker.
 */
export class SmtpMailTransport implements MailTransport {
  private readonly clients = new Map<
    MscMailAccount,
    { config: SmtpMailAccountConfig; client: SmtpClient }
  >();

  constructor(
    configs: SmtpMailAccountConfig[],
    createClient: SmtpClientFactory = defaultFactory,
  ) {
    if (configs.length === 0) throw new Error('at least one SMTP account is required');
    for (const value of configs) {
      const config = smtpAccountSchema.parse(value);
      if (this.clients.has(config.account)) {
        throw new Error(`duplicate SMTP account ${config.account}`);
      }
      this.clients.set(config.account, {
        config,
        client: createClient({
          host: config.host,
          port: config.port,
          secure: config.secure,
          requireTLS: config.port === 587,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
          auth: {
            user: config.username,
            pass: config.password,
          },
          tls: {
            rejectUnauthorized: true,
            servername: config.host,
            minVersion: 'TLSv1.2',
          },
          disableFileAccess: true,
          disableUrlAccess: true,
          logger: false,
          debug: false,
        }),
      });
    }
  }

  async deliver(
    envelope: MailTransportEnvelope,
  ): Promise<MailTransportResult> {
    const selected = this.clients.get(envelope.account);
    if (!selected) {
      return { status: 'not-submitted', reasonCode: 'account-not-configured' };
    }
    if (selected.config.senderIdentity !== envelope.from) {
      return { status: 'not-submitted', reasonCode: 'sender-policy-mismatch' };
    }

    const info = await selected.client.sendMail({
      envelope: { from: envelope.from, to: [envelope.to] },
      from: envelope.from,
      to: envelope.to,
      subject: envelope.subject,
      text: envelope.bodyText,
      messageId: envelope.messageId,
      ...(envelope.inReplyToMessageId
        ? { inReplyTo: envelope.inReplyToMessageId }
        : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const recipient = envelope.to.toLowerCase();
    const accepted = (info.accepted ?? []).map(normalizedAddress);
    const rejected = (info.rejected ?? []).map(normalizedAddress);
    if (
      info.messageId === envelope.messageId &&
      accepted.includes(recipient) &&
      !rejected.includes(recipient) &&
      (info.pending?.length ?? 0) === 0
    ) {
      return { status: 'accepted' };
    }
    return {
      status: 'unknown',
      reasonCode: 'provider-acceptance-not-confirmed',
    };
  }
}
