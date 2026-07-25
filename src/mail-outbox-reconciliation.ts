import { z } from 'zod';
import { canonicalizeJson, type JsonValue } from './action.js';
import {
  hashJson,
  type FreshAuthContext,
  type FreshAuthVerifier,
} from './approval.js';
import {
  SqliteDurableOutbox,
  type OutboxRecord,
  type ReconciliationEvidence,
} from './durable-outbox.js';
import type { BeginWebAuthnResult } from './webauthn.js';

export interface ReconciliationAuthContext {
  actionId: string;
  attemptId: string;
  decision: 'accepted' | 'not-accepted';
  evidence: Pick<
    ReconciliationEvidence,
    'source' | 'referenceHash' | 'conclusionCode'
  >;
}

export interface VerifiedReconciliationAuth {
  reviewer: string;
  authenticatedAt: string;
  authenticationMethod: ReconciliationEvidence['authenticationMethod'];
  assertionId: string;
}

export interface ReconciliationAuthVerifier {
  verify(
    assertion: unknown,
    context: ReconciliationAuthContext,
  ): Promise<VerifiedReconciliationAuth>;
}

export interface ReconciliationFreshAuth extends ReconciliationAuthVerifier {
  begin(
    reviewer: string,
    context: ReconciliationAuthContext,
  ): Promise<BeginWebAuthnResult>;
}

export interface MailOutboxReconciliationRequest {
  actionId: string;
  attemptId: string;
  decision: ReconciliationAuthContext['decision'];
  evidence: ReconciliationAuthContext['evidence'];
  assertion: unknown;
  expectedReviewer?: string;
}

const reconciliationRequestSchema = z.object({
  actionId: z.string().trim().min(1).max(200),
  attemptId: z.string().uuid(),
  decision: z.enum(['accepted', 'not-accepted']),
  evidence: z.object({
    source: z.enum([
      'provider-message-log',
      'provider-search',
      'mailbox-observation',
    ]),
    referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    conclusionCode: z.string().trim().min(1).max(100)
      .regex(/^[a-z][a-z0-9-]*$/),
  }).strict(),
  assertion: z.unknown(),
  expectedReviewer: z.string().trim().min(1).max(128).optional(),
}).strict();

/**
 * Maps reconciliation onto the existing approval WebAuthn challenge without
 * weakening either contract. The domain-separated hash binds the attempt,
 * decision and complete bounded evidence reference; approve/reject is only the
 * legacy challenge slot and is never interpreted as an action approval.
 */
export const reconciliationFreshAuthContext = (
  context: ReconciliationAuthContext,
): FreshAuthContext => ({
  actionId: context.actionId,
  payloadHash: hashJson({
    purpose: 'mail-outbox-reconciliation',
    version: 1,
    actionId: context.actionId,
    attemptId: context.attemptId,
    decision: context.decision,
    evidence: context.evidence,
  }),
  decision: context.decision === 'accepted' ? 'approve' : 'reject',
});

/**
 * Reuses the concrete passkey ceremony while preserving a distinct
 * reconciliation verifier boundary for the outbox service.
 */
export class WebAuthnReconciliationAuth implements ReconciliationFreshAuth {
  constructor(
    private readonly freshAuth: FreshAuthVerifier & {
      begin(
        actor: string,
        context: FreshAuthContext,
      ): Promise<BeginWebAuthnResult>;
    },
  ) {}

  begin(
    reviewer: string,
    context: ReconciliationAuthContext,
  ): Promise<BeginWebAuthnResult> {
    return this.freshAuth.begin(
      reviewer,
      reconciliationFreshAuthContext(context),
    );
  }

  async verify(
    assertion: unknown,
    context: ReconciliationAuthContext,
  ): Promise<VerifiedReconciliationAuth> {
    const verified = await this.freshAuth.verify(
      assertion,
      reconciliationFreshAuthContext(context),
    );
    if (verified.method !== 'webauthn' && verified.method !== 'passkey') {
      throw new Error('reconciliation requires WebAuthn fresh authentication');
    }
    return {
      reviewer: verified.actor,
      authenticatedAt: verified.authenticatedAt,
      authenticationMethod: verified.method,
      assertionId: verified.assertionId,
    };
  }
}

/**
 * Manual reconciliation boundary for ambiguous transport attempts. It accepts
 * no raw provider response or mail content: only a bounded conclusion and a
 * SHA-256 reference to evidence retained in the operator's approved system.
 */
export class MailOutboxReconciliationService {
  private readonly now: () => Date;

  constructor(
    private readonly outbox: SqliteDurableOutbox,
    private readonly verifier: ReconciliationAuthVerifier,
    options: {
      now?: () => Date;
      maxFreshAuthAgeSeconds?: number;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxFreshAuthAgeSeconds = options.maxFreshAuthAgeSeconds ?? 300;
    if (
      !Number.isInteger(this.maxFreshAuthAgeSeconds) ||
      this.maxFreshAuthAgeSeconds < 1 ||
      this.maxFreshAuthAgeSeconds > 900
    ) {
      throw new Error('maxFreshAuthAgeSeconds must be between 1 and 900');
    }
  }

  private readonly maxFreshAuthAgeSeconds: number;

  review(actionId: string, attemptId: string): OutboxRecord {
    const current = this.outbox.get(actionId);
    if (
      (current.status !== 'dispatching' && current.status !== 'uncertain') ||
      current.attemptId !== attemptId
    ) {
      throw new Error('outbox action does not require matching-attempt reconciliation');
    }
    return current;
  }

  async reconcile(
    requestValue: MailOutboxReconciliationRequest,
  ): Promise<OutboxRecord> {
    const request = reconciliationRequestSchema.parse(requestValue);
    this.review(request.actionId, request.attemptId);
    const context: ReconciliationAuthContext = {
      actionId: request.actionId,
      attemptId: request.attemptId,
      decision: request.decision,
      evidence: request.evidence,
    };
    // Canonicalization rejects undefined, functions, and other non-JSON values
    // before any authentication or state mutation.
    canonicalizeJson(context as unknown as JsonValue);
    const verified = await this.verifier.verify(request.assertion, context);
    if (
      !verified.reviewer.trim() ||
      !verified.assertionId.trim()
    ) {
      throw new Error('reconciliation authentication returned incomplete identity');
    }
    if (
      request.expectedReviewer !== undefined &&
      verified.reviewer !== request.expectedReviewer
    ) {
      throw new Error('reconciliation reviewer does not match authenticated session');
    }
    const authenticatedAt = Date.parse(verified.authenticatedAt);
    const ageMs = this.now().getTime() - authenticatedAt;
    if (
      !Number.isFinite(authenticatedAt) ||
      ageMs < 0 ||
      ageMs > this.maxFreshAuthAgeSeconds * 1000
    ) {
      throw new Error('reconciliation authentication is stale');
    }
    const evidence: ReconciliationEvidence = {
      reviewer: verified.reviewer,
      authenticationMethod: verified.authenticationMethod,
      assertionId: verified.assertionId,
      source: request.evidence.source,
      referenceHash: request.evidence.referenceHash,
      conclusionCode: request.evidence.conclusionCode,
    };
    const reconciledAt = this.now().toISOString();
    return request.decision === 'accepted'
      ? this.outbox.reconcileAccepted(
        request.actionId,
        request.attemptId,
        reconciledAt,
        evidence,
      )
      : this.outbox.reconcileNotAccepted(
        request.actionId,
        request.attemptId,
        reconciledAt,
        evidence,
      );
  }
}
