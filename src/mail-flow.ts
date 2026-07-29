import type { ActionPreview } from './action.js';
import {
  ApprovedActionOutboxCoordinator,
} from './approval-execution.js';
import {
  ApprovalQueue,
  type ApprovalRecord,
} from './approval.js';
import {
  MailSendDryRunAdapter,
  createMailReplyIntent,
  MailReplyDryRunAdapter,
  MailReplyPreviewRenderer,
  parseMailReplyIntent,
  type MailReplyDraft,
  type MscMailAccountPolicy,
} from './mail-approved-action.js';
import type { MailOutboxDispatchWorker, MailDispatchResult } from './mail-outbox-transport.js';
import type { MscMailReadonlyProvider, MscMailProviderEnvelope } from './mail-readonly-provider.js';
import { z } from 'zod';

export interface ProposedMailReply {
  actionId: string;
  status: 'pending';
  approvalUrl: string;
  expiresAt: string;
  preview: ActionPreview;
}

export interface MailReplyFromSourceInput {
  account: MailReplyDraft['source']['account'];
  folder: string;
  messageId: string;
  bodyText: string;
  sources: string[];
  uncertainties?: string[];
}

const mailSourceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  from: z.union([
    z.string().email(),
    z.object({ addr: z.string().email() }).passthrough()
      .transform((value) => value.addr),
  ]),
  subject: z.string().trim().min(1).max(200),
}).passthrough();

export interface MscMailFlowOptions {
  provider: MscMailReadonlyProvider;
  policy: MscMailAccountPolicy;
  queue: ApprovalQueue;
  outboxCoordinator: ApprovedActionOutboxCoordinator;
  dispatchWorker: MailOutboxDispatchWorker;
  approvalUrl(actionId: string): string;
}

/**
 * One cohesive application boundary for the operator flow. Reading stays on
 * the installed read-only provider. A reply becomes dispatchable only after it
 * has been persisted, freshly approved, atomically consumed into the outbox
 * and claimed by the dispatch worker.
 */
export class MscMailFlow {
  private readonly renderer = new MailReplyPreviewRenderer();

  constructor(private readonly options: MscMailFlowOptions) {}

  read(
    account: MailReplyDraft['source']['account'],
    folder: string,
    messageId: string,
  ): Promise<MscMailProviderEnvelope> {
    return this.options.provider.preview(account, folder, messageId);
  }

  async proposeReply(
    draftValue: MailReplyDraft,
    idempotencyKey: string,
    ttlSeconds = 900,
  ): Promise<ProposedMailReply> {
    const intent = createMailReplyIntent(this.options.policy, {
      ...draftValue,
      deliveryMode: 'approved-send',
    });
    const record = await this.options.queue.propose(
      intent,
      idempotencyKey,
      ttlSeconds,
    );
    return this.proposal(record);
  }

  async proposeReplyFromSource(
    input: MailReplyFromSourceInput,
    idempotencyKey: string,
    ttlSeconds = 900,
  ): Promise<ProposedMailReply> {
    const envelope = await this.read(
      input.account,
      input.folder,
      input.messageId,
    );
    const source = mailSourceSchema.parse(envelope.data);
    if (source.id !== input.messageId) {
      throw new Error('mail provider returned a mismatched source message');
    }
    return this.proposeReply({
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
    }, idempotencyKey, ttlSeconds);
  }

  async dispatchApproved(actionId: string): Promise<MailDispatchResult> {
    await this.options.outboxCoordinator.enqueue(actionId);
    return this.options.dispatchWorker.dispatch(actionId);
  }

  private proposal(record: ApprovalRecord): ProposedMailReply {
    return {
      actionId: record.actionId,
      status: 'pending',
      approvalUrl: this.options.approvalUrl(record.actionId),
      expiresAt: record.expiresAt,
      preview: this.renderer.render(parseMailReplyIntent(record.intent)),
    };
  }
}

export const createMailReplyOutboxAdapter = (
  policy: MscMailAccountPolicy,
): MailReplyDryRunAdapter => new MailReplyDryRunAdapter(async (source) => ({
  policyVersion: policy.version,
  account: source.account,
  senderIdentity: policy.accounts[source.account].senderIdentity,
  allowedFolders: policy.accounts[source.account].allowedFolders,
  source,
}));

export const createMailSendOutboxAdapter = (
  policy: MscMailAccountPolicy,
): MailSendDryRunAdapter => new MailSendDryRunAdapter(async (account) => ({
  policyVersion: policy.version,
  account,
  senderIdentity: policy.accounts[account].senderIdentity,
  allowedFolders: policy.accounts[account].allowedFolders,
}));
