import type { ApprovedActionExecution } from './approval-execution.js';
import { ApprovedActionExecutionCoordinator } from './approval-execution.js';
import { ApprovalQueue } from './approval.js';

export interface EventChangeWorkerResult {
  actionId: string;
  status: 'executed' | 'failed';
  execution?: ApprovedActionExecution;
}

/**
 * Inactive, explicit worker boundary for approved Nennung changes. It owns no
 * listener, timer, credentials or mutation transport. A host must inject the
 * already configured coordinator and call one cycle deliberately.
 */
export class InactiveMscEventChangeRuntime {
  private workerRunning = false;

  constructor(
    private readonly queue: ApprovalQueue,
    private readonly coordinator: ApprovedActionExecutionCoordinator,
  ) {}

  async runWorkerOnce(): Promise<EventChangeWorkerResult[]> {
    if (this.workerRunning) {
      throw new Error('event change worker cycle is already running');
    }
    this.workerRunning = true;
    try {
      const approved = await this.queue.approved();
      const results: EventChangeWorkerResult[] = [];
      for (const record of approved) {
        if (record.intent.kind !== 'event.entry.update') continue;
        try {
          const execution = await this.coordinator.execute(record.actionId);
          results.push({
            actionId: record.actionId,
            status: 'executed',
            execution,
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
