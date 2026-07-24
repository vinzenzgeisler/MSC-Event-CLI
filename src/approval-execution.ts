import {
  type ActionIntent,
  type ExecutionResult,
  type ExecutorAdapter,
} from './action.js';
import { ApprovalQueue } from './approval.js';

export interface ApprovedActionExecution {
  actionId: string;
  kind: string;
  result: ExecutionResult;
}

/**
 * Trusted internal worker boundary. It never receives an execution proof from
 * the browser. Two workers may race, but only the one that atomically consumes
 * the approved action can invoke the adapter.
 *
 * This coordinator is suitable for inert dry-runs. A productive non-idempotent
 * transport needs a durable outbox/dispatch state and uncertain-outcome
 * reconciliation before it may be registered here.
 */
export class ApprovedActionExecutionCoordinator {
  private readonly adapters = new Map<string, ExecutorAdapter>();

  constructor(
    private readonly queue: ApprovalQueue,
    adapters: ExecutorAdapter[],
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new Error(`duplicate executor adapter for ${adapter.kind}`);
      }
      this.adapters.set(adapter.kind, adapter);
    }
  }

  async pendingApprovedActionIds(): Promise<string[]> {
    return (await this.queue.approved()).map((record) => record.actionId);
  }

  async execute(actionId: string): Promise<ApprovedActionExecution> {
    const approved = (await this.queue.approved()).find(
      (record) => record.actionId === actionId,
    );
    if (!approved) throw new Error('action is not approved or has expired');
    const adapter = this.adapters.get(approved.intent.kind);
    if (!adapter) {
      throw new Error(`no executor adapter registered for ${approved.intent.kind}`);
    }
    const intent = adapter.intentSchema.parse(approved.intent) as ActionIntent;
    const currentState = await adapter.readCurrentState(intent);
    const proof = await this.queue.executionProofForApproved(actionId);
    const consumed = await this.queue.consume(proof, currentState);
    const validated = adapter.intentSchema.parse(consumed) as ActionIntent;
    const result = await adapter.execute(validated, {
      actionId,
      payloadHash: approved.payloadHash,
      approvedBy: approved.decidedBy ?? 'unknown',
      approvedAt: approved.decidedAt ?? approved.createdAt,
    });
    return {
      actionId,
      kind: approved.intent.kind,
      result,
    };
  }
}
