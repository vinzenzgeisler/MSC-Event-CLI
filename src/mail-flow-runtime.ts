import {
  ApprovalHttpContract,
  type AuthenticatedApprovalSession,
} from './approval-http.js';
import { ApprovalQueue } from './approval.js';
import { MscMailFlow } from './mail-flow.js';
import type { MailDispatchResult } from './mail-outbox-transport.js';

export interface MailFlowWorkerResult {
  actionId: string;
  status: MailDispatchResult['status'] | 'failed';
}

/**
 * Inert application runtime boundary. It binds the authenticated mobile
 * approval contract to the mail flow and an explicit one-shot worker cycle,
 * but owns no HTTP listener, timer, scheduler, session store or secret loader.
 */
export class InactiveMscMailFlowRuntime {
  private workerRunning = false;

  constructor(
    readonly flow: MscMailFlow,
    readonly approvals: ApprovalHttpContract,
    private readonly queue: ApprovalQueue,
  ) {}

  handleApprovalRequest(
    request: Request,
    session?: AuthenticatedApprovalSession,
  ): Promise<Response> {
    return this.approvals.handle(request, session);
  }

  async runWorkerOnce(): Promise<MailFlowWorkerResult[]> {
    if (this.workerRunning) {
      throw new Error('mail flow worker cycle is already running');
    }
    this.workerRunning = true;
    try {
      const approved = await this.queue.approved();
      const results: MailFlowWorkerResult[] = [];
      for (const record of approved) {
        if (record.intent.kind !== 'mail.reply' &&
            record.intent.kind !== 'mail.send') {
          continue;
        }
        try {
          const dispatched = await this.flow.dispatchApproved(record.actionId);
          results.push({
            actionId: record.actionId,
            status: dispatched.status,
          });
        } catch {
          results.push({
            actionId: record.actionId,
            status: 'failed',
          });
        }
      }
      return results;
    } finally {
      this.workerRunning = false;
    }
  }
}
