import type { ActionPreview } from './action.js';
import {
  ApprovedActionOutboxCoordinator,
} from './approval-execution.js';
import {
  ApprovalQueue,
  type ApprovalRecord,
} from './approval.js';
import {
  createMailReplyIntent,
  MailReplyDryRunAdapter,
  MailReplyPreviewRenderer,
  parseMailReplyIntent,
  type MailReplyDraft,
  type MscMailAccountPolicy,
} from './mail-approved-action.js';
import type { MailOutboxDispatchWorker, MailDispatchResult } from './mail-outbox-transport.js';
import type { MscMailReadonlyProvider, MscMailProviderEnvelope } from './mail-readonly-provider.js';

export interface ProposedMailReply {
  actionId: string;
  status: 'pending';
  approvalUrl: string;
  expiresAt: string;
  preview: ActionPreview;
}

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
