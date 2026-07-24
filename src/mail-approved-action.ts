import { z } from 'zod';
import {
  actionPreviewSchema,
  parseActionIntent,
  type ActionIntent,
  type ActionPreview,
  type ExecutionContext,
  type ExecutionResult,
  type ExecutorAdapter,
  type JsonValue,
  type PreviewRenderer,
} from './action.js';

export const mscMailAccountSchema = z.enum([
  'msc-nennung',
  'msc-info',
  'msc-vorstand',
]);
export type MscMailAccount = z.infer<typeof mscMailAccountSchema>;

const plainAddressSchema = z.string().trim().email().max(320).refine(
  (value) => !/[\r\n<>]/.test(value),
  'plain email address without display name or line breaks required',
);

const mailAfterSchema = z.object({
  account: mscMailAccountSchema,
  from: plainAddressSchema,
  to: plainAddressSchema,
  subject: z.string().trim().min(1).max(200).refine(
    (value) => !/[\r\n]/.test(value),
    'subject line breaks are forbidden',
  ),
  bodyText: z.string().trim().min(1).max(20_000).refine(
    (value) => !value.includes('\0'),
    'body contains a forbidden null byte',
  ),
}).strict();

const mailStateSchema = z.object({
  policyVersion: z.literal(1),
  account: mscMailAccountSchema,
  senderIdentity: plainAddressSchema,
  allowedFolders: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
}).strict();

const mailParametersSchema = z.object({
  dryRun: z.literal(true),
  triageStatus: z.literal('READY_TO_DRAFT'),
  sources: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(50),
}).strict();

export type MailSendIntent = Omit<
  ActionIntent,
  'kind' | 'target' | 'before' | 'after' | 'expectedState' | 'parameters'
> & {
  kind: 'mail.send';
  target: {
    type: 'mailbox';
    id: MscMailAccount;
    label?: string;
  };
  before: null;
  after: z.infer<typeof mailAfterSchema>;
  expectedState: z.infer<typeof mailStateSchema>;
  parameters: z.infer<typeof mailParametersSchema>;
};

export interface MscMailAccountPolicy {
  version: 1;
  accounts: Record<
    MscMailAccount,
    {
      active: boolean;
      senderIdentity: string;
      displayName: string;
      allowedFolders: string[];
    }
  >;
}

export interface MailSendDraft {
  account: MscMailAccount;
  to: string;
  subject: string;
  bodyText: string;
  triageStatus: 'READY_TO_DRAFT';
  sources: string[];
  uncertainties: string[];
}

export const parseMailSendIntent = (input: unknown): MailSendIntent => {
  const intent = parseActionIntent(input);
  if (intent.kind !== 'mail.send') throw new Error('expected mail.send intent');
  const target = z.object({
    type: z.literal('mailbox'),
    id: mscMailAccountSchema,
    label: z.string().trim().min(1).max(500).optional(),
  }).strict().parse(intent.target);
  if (intent.before !== null) throw new Error('mail.send before state must be null');
  const after = mailAfterSchema.parse(intent.after);
  const expectedState = mailStateSchema.parse(intent.expectedState);
  const parameters = mailParametersSchema.parse(intent.parameters);
  if (
    target.id !== after.account ||
    target.id !== expectedState.account ||
    after.from !== expectedState.senderIdentity
  ) {
    throw new Error('mail account, target and sender identity must match');
  }
  const normalizedTarget: MailSendIntent['target'] = {
    type: 'mailbox',
    id: target.id,
    ...(target.label ? { label: target.label } : {}),
  };
  return {
    ...intent,
    kind: 'mail.send',
    target: normalizedTarget,
    before: null,
    after,
    expectedState,
    parameters,
  };
};

export const createMailSendIntent = (
  policy: MscMailAccountPolicy,
  draft: MailSendDraft,
): MailSendIntent => {
  const account = mscMailAccountSchema.parse(draft.account);
  const accountPolicy = policy.accounts[account];
  if (!accountPolicy.active) throw new Error(`MSC mail account ${account} is inactive`);
  if (accountPolicy.senderIdentity.trim().toUpperCase() === 'TBD') {
    throw new Error(`MSC mail account ${account} has no confirmed sender identity`);
  }
  const from = plainAddressSchema.parse(accountPolicy.senderIdentity);
  return parseMailSendIntent({
    version: 1,
    kind: 'mail.send',
    summary: `Send reviewed MSC email from ${account} to ${draft.to}`,
    target: {
      type: 'mailbox',
      id: account,
      label: accountPolicy.displayName,
    },
    before: null,
    after: {
      account,
      from,
      to: draft.to,
      subject: draft.subject,
      bodyText: draft.bodyText,
    },
    expectedState: {
      policyVersion: policy.version,
      account,
      senderIdentity: from,
      allowedFolders: accountPolicy.allowedFolders,
    },
    parameters: {
      dryRun: true,
      triageStatus: draft.triageStatus,
      sources: draft.sources,
      uncertainties: draft.uncertainties,
    },
  });
};

export class MailSendPreviewRenderer implements PreviewRenderer<MailSendIntent> {
  readonly kind = 'mail.send' as const;

  render(intentValue: MailSendIntent): ActionPreview {
    const intent = parseMailSendIntent(intentValue);
    return actionPreviewSchema.parse({
      title: 'MSC-E-Mail senden',
      summary: intent.summary,
      target: `${intent.target.label ?? intent.target.id} → ${intent.after.to}`,
      risk: 'high',
      changes: [
        { field: 'Absenderkonto', before: null, after: intent.after.account },
        { field: 'Von', before: null, after: intent.after.from },
        { field: 'An', before: null, after: intent.after.to },
        { field: 'Betreff', before: null, after: intent.after.subject },
        { field: 'Nachricht', before: null, after: intent.after.bodyText },
      ],
    });
  }
}

const sourceFieldSchema = z.string().trim().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  'source field contains a forbidden control character',
);

const mailReplySourceSchema = z.object({
  account: mscMailAccountSchema,
  folder: sourceFieldSchema,
  messageId: sourceFieldSchema,
  from: plainAddressSchema,
  subject: z.string().trim().min(1).max(200).refine(
    (value) => !/[\r\n]/.test(value),
    'subject line breaks are forbidden',
  ),
}).strict();

const mailReplyAfterSchema = mailAfterSchema.extend({
  sourceFolder: sourceFieldSchema,
  inReplyToMessageId: sourceFieldSchema,
}).strict();

const mailReplyStateSchema = mailStateSchema.extend({
  source: mailReplySourceSchema,
}).strict();

const mailReplyParametersSchema = mailParametersSchema.extend({
  conversationContext: z.literal('not-available'),
}).strict();

export type MailReplyIntent = Omit<
  ActionIntent,
  'kind' | 'target' | 'before' | 'after' | 'expectedState' | 'parameters'
> & {
  kind: 'mail.reply';
  target: {
    type: 'mail-message';
    id: string;
    label?: string;
  };
  before: z.infer<typeof mailReplySourceSchema>;
  after: z.infer<typeof mailReplyAfterSchema>;
  expectedState: z.infer<typeof mailReplyStateSchema>;
  parameters: z.infer<typeof mailReplyParametersSchema>;
};

export interface MailReplyDraft {
  source: z.infer<typeof mailReplySourceSchema>;
  bodyText: string;
  triageStatus: 'READY_TO_DRAFT';
  sources: string[];
  uncertainties: string[];
}

const replyTargetId = (
  source: z.infer<typeof mailReplySourceSchema>,
): string => `${source.account}/${source.folder}/${source.messageId}`;

export const parseMailReplyIntent = (input: unknown): MailReplyIntent => {
  const intent = parseActionIntent(input);
  if (intent.kind !== 'mail.reply') throw new Error('expected mail.reply intent');
  const target = z.object({
    type: z.literal('mail-message'),
    id: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(500).optional(),
  }).strict().parse(intent.target);
  const before = mailReplySourceSchema.parse(intent.before);
  const after = mailReplyAfterSchema.parse(intent.after);
  const expectedState = mailReplyStateSchema.parse(intent.expectedState);
  const parameters = mailReplyParametersSchema.parse(intent.parameters);
  if (
    target.id !== replyTargetId(before) ||
    before.account !== after.account ||
    before.account !== expectedState.account ||
    after.from !== expectedState.senderIdentity ||
    after.to !== before.from ||
    after.sourceFolder !== before.folder ||
    after.inReplyToMessageId !== before.messageId ||
    JSON.stringify(expectedState.source) !== JSON.stringify(before)
  ) {
    throw new Error('reply account, source message, sender and recipient must match');
  }
  if (!expectedState.allowedFolders.includes(before.folder)) {
    throw new Error('source folder is not allowed by the account policy');
  }
  const normalizedTarget: MailReplyIntent['target'] = {
    type: 'mail-message',
    id: target.id,
    ...(target.label ? { label: target.label } : {}),
  };
  return {
    ...intent,
    kind: 'mail.reply',
    target: normalizedTarget,
    before,
    after,
    expectedState,
    parameters,
  };
};

const replySubject = (subject: string): string => (
  /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`
);

export const createMailReplyIntent = (
  policy: MscMailAccountPolicy,
  draft: MailReplyDraft,
): MailReplyIntent => {
  const source = mailReplySourceSchema.parse(draft.source);
  const accountPolicy = policy.accounts[source.account];
  if (!accountPolicy.active) {
    throw new Error(`MSC mail account ${source.account} is inactive`);
  }
  if (accountPolicy.senderIdentity.trim().toUpperCase() === 'TBD') {
    throw new Error(`MSC mail account ${source.account} has no confirmed sender identity`);
  }
  if (!accountPolicy.allowedFolders.includes(source.folder)) {
    throw new Error(`source folder ${source.folder} is not allowed for ${source.account}`);
  }
  const from = plainAddressSchema.parse(accountPolicy.senderIdentity);
  const allowedFolders = z.array(sourceFieldSchema).min(1).max(20).parse(
    accountPolicy.allowedFolders,
  );
  return parseMailReplyIntent({
    version: 1,
    kind: 'mail.reply',
    summary: `Reply from ${source.account} to source message ${source.messageId}`,
    target: {
      type: 'mail-message',
      id: replyTargetId(source),
      label: `${accountPolicy.displayName}: ${source.subject}`,
    },
    before: source,
    after: {
      account: source.account,
      from,
      to: source.from,
      subject: replySubject(source.subject),
      bodyText: draft.bodyText,
      sourceFolder: source.folder,
      inReplyToMessageId: source.messageId,
    },
    expectedState: {
      policyVersion: policy.version,
      account: source.account,
      senderIdentity: from,
      allowedFolders,
      source,
    },
    parameters: {
      dryRun: true,
      triageStatus: draft.triageStatus,
      sources: draft.sources,
      uncertainties: draft.uncertainties,
      conversationContext: 'not-available',
    },
  });
};

export class MailReplyPreviewRenderer implements PreviewRenderer<MailReplyIntent> {
  readonly kind = 'mail.reply' as const;

  render(intentValue: MailReplyIntent): ActionPreview {
    const intent = parseMailReplyIntent(intentValue);
    return actionPreviewSchema.parse({
      title: 'Auf MSC-E-Mail antworten',
      summary: intent.summary,
      target: `${intent.target.label ?? intent.target.id} → ${intent.after.to}`,
      risk: 'high',
      changes: [
        { field: 'Quellkonto', before: intent.before.account, after: intent.after.account },
        { field: 'Quellordner', before: intent.before.folder, after: intent.after.sourceFolder },
        { field: 'Quellnachricht', before: intent.before.messageId, after: intent.after.inReplyToMessageId },
        { field: 'Von', before: null, after: intent.after.from },
        { field: 'An', before: intent.before.from, after: intent.after.to },
        { field: 'Betreff', before: intent.before.subject, after: intent.after.subject },
        { field: 'Antwort', before: null, after: intent.after.bodyText },
        {
          field: 'Konversationskontext',
          before: null,
          after: intent.parameters.conversationContext,
        },
      ],
    });
  }
}

/**
 * Deliberately inert reply adapter. It accepts only a source-state reader,
 * never a mail transport, process runner or network client.
 */
export class MailReplyDryRunAdapter implements ExecutorAdapter<MailReplyIntent> {
  readonly kind = 'mail.reply' as const;
  readonly intentSchema = { parse: parseMailReplyIntent };

  constructor(
    private readonly readSourceState: (
      source: z.infer<typeof mailReplySourceSchema>,
    ) => Promise<z.infer<typeof mailReplyStateSchema>>,
  ) {}

  async readCurrentState(intentValue: MailReplyIntent): Promise<JsonValue> {
    const intent = parseMailReplyIntent(intentValue);
    return mailReplyStateSchema.parse(await this.readSourceState(intent.before));
  }

  async execute(
    intentValue: MailReplyIntent,
    _context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const intent = parseMailReplyIntent(intentValue);
    return {
      result: {
        dryRun: true,
        wouldReply: {
          account: intent.after.account,
          from: intent.after.from,
          to: intent.after.to,
          subject: intent.after.subject,
          bodyText: intent.after.bodyText,
          sourceFolder: intent.after.sourceFolder,
          inReplyToMessageId: intent.after.inReplyToMessageId,
        },
      },
    };
  }
}

/**
 * Deliberately inert adapter. It accepts no transport dependency and performs
 * no process, network, filesystem or mail operation.
 */
export class MailSendDryRunAdapter implements ExecutorAdapter<MailSendIntent> {
  readonly kind = 'mail.send' as const;
  readonly intentSchema = { parse: parseMailSendIntent };

  constructor(
    private readonly readPolicyState: (
      account: MscMailAccount,
    ) => Promise<z.infer<typeof mailStateSchema>>,
  ) {}

  async readCurrentState(intentValue: MailSendIntent): Promise<JsonValue> {
    const intent = parseMailSendIntent(intentValue);
    return mailStateSchema.parse(await this.readPolicyState(intent.after.account));
  }

  async execute(
    intentValue: MailSendIntent,
    _context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const intent = parseMailSendIntent(intentValue);
    return {
      result: {
        dryRun: true,
        wouldSend: {
          account: intent.after.account,
          from: intent.after.from,
          to: intent.after.to,
          subject: intent.after.subject,
          bodyText: intent.after.bodyText,
        },
      },
    };
  }
}
