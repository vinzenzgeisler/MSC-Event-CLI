import { parseActionIntent, type ActionIntent } from './action.js';
import { hashActionIntent } from './approval.js';

export const INERT_APPROVAL_TOOL_NAME = 'approved_action_preview';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny' | 'timeout' | 'cancelled';

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity: 'warning';
    timeoutMs: number;
    allowedDecisions: ['allow-once', 'deny'];
    onResolution?: (decision: ApprovalDecision) => Promise<void> | void;
  };
}

export interface InertApprovalHookOptions {
  timeoutMs?: number;
  onResolution?: (event: {
    decision: ApprovalDecision;
    payloadHash: string;
    intent: ActionIntent;
  }) => Promise<void> | void;
}

/**
 * Creates the policy hook for the inert approval-preview seam.
 *
 * This module intentionally does not register a tool or executor. An
 * `allow-once` decision can therefore approve only the exact normalized
 * preview payload; it cannot perform a mutation.
 */
export const createInertApprovalHook = (
  options: InertApprovalHookOptions = {},
): ((event: BeforeToolCallEvent) => Promise<BeforeToolCallResult | undefined>) => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error('timeoutMs must be between 1 and 600000');
  }

  return async (event) => {
    if (event.toolName !== INERT_APPROVAL_TOOL_NAME) return undefined;

    let intent: ActionIntent;
    try {
      intent = parseActionIntent(event.params.intent);
    } catch {
      return {
        block: true,
        blockReason: 'Invalid approved-action intent; request blocked before approval.',
      };
    }

    const payloadHash = hashActionIntent(intent);
    const target = intent.target.label ?? `${intent.target.type}:${intent.target.id}`;
    return {
      params: { intent, payloadHash },
      requireApproval: {
        title: `Approve ${intent.kind}`.slice(0, 80),
        description: `Intent SHA-256: ${payloadHash}. This preview performs no mutation. Target: ${target}. Summary: ${intent.summary}`.slice(0, 512),
        severity: 'warning',
        timeoutMs,
        allowedDecisions: ['allow-once', 'deny'],
        ...(options.onResolution
          ? { onResolution: async (decision: ApprovalDecision) => options.onResolution?.({ decision, payloadHash, intent }) }
          : {}),
      },
    };
  };
};
