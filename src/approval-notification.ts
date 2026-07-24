import type { ActionIntent } from './action.js';
import {
  ApprovalQueue,
  type ApprovalRecord,
} from './approval.js';

export interface ApprovalNotification {
  notificationId: string;
  actionId: string;
  approvalUrl: string;
  expiresAt: string;
  text: string;
}

export interface ApprovalNotificationSink {
  notify(notification: ApprovalNotification): Promise<void>;
}

export interface ApprovalProposalServiceOptions {
  queue: ApprovalQueue;
  approvalUrl(actionId: string): string;
  notifications: ApprovalNotificationSink;
}

const kindLabel = (kind: string): string => {
  if (kind === 'mail.send') return 'neue MSC-E-Mail';
  if (kind === 'mail.reply') return 'MSC-E-Mail-Antwort';
  return 'wichtige MSC-Aktion';
};

/**
 * Creates the durable action first and then emits one privacy-minimized link
 * notification. Mail subject, recipient, body and source metadata never enter
 * the notification surface.
 */
export class ApprovalProposalService {
  constructor(private readonly options: ApprovalProposalServiceOptions) {}

  async propose(
    intent: ActionIntent,
    idempotencyKey: string,
    ttlSeconds?: number,
  ): Promise<ApprovalRecord> {
    const record = await this.options.queue.propose(
      intent,
      idempotencyKey,
      ttlSeconds,
    );
    const approvalUrl = this.options.approvalUrl(record.actionId);
    const notificationId = `approval:${record.actionId}`;
    await this.options.notifications.notify({
      notificationId,
      actionId: record.actionId,
      approvalUrl,
      expiresAt: record.expiresAt,
      text: [
        `MSC-Freigabe erforderlich: ${kindLabel(record.intent.kind)}.`,
        `Gültig bis: ${record.expiresAt}`,
        `Prüfen und mit Passkey entscheiden: ${approvalUrl}`,
        `Referenz: ${record.payloadHash.slice(0, 12)}`,
      ].join('\n'),
    });
    return record;
  }
}
