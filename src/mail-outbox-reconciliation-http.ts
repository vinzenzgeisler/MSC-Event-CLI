import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { OutboxRecord } from './durable-outbox.js';
import {
  MailOutboxReconciliationService,
  type ReconciliationAuthContext,
  type ReconciliationFreshAuth,
} from './mail-outbox-reconciliation.js';

const actionIdSchema = z.string().trim().min(1).max(200);
const attemptIdSchema = z.string().uuid();
const decisionSchema = z.enum(['accepted', 'not-accepted']);
const evidenceSchema = z.object({
  source: z.enum([
    'provider-message-log',
    'provider-search',
    'mailbox-observation',
  ]),
  referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  conclusionCode: z.string().trim().min(1).max(100)
    .regex(/^[a-z][a-z0-9-]*$/),
}).strict();

export interface AuthenticatedReconciliationSession {
  /** Supplied by trusted server middleware, never parsed from request input. */
  actor: string;
  csrfToken: string;
}

export interface ReconciliationPageModel {
  actionId: string;
  attemptId: string;
  status: 'dispatching' | 'uncertain';
  kind: string;
  createdAt: string;
  claimedAt?: string;
  uncertainAt?: string;
  uncertaintyCode?: string;
  decisions: ['accepted', 'not-accepted'];
}

export interface MailOutboxReconciliationHttpOptions {
  publicOrigin: string;
  service: MailOutboxReconciliationService;
  freshAuth: ReconciliationFreshAuth;
  authorizeReviewer(actor: string, record: OutboxRecord): Promise<boolean>;
}

const json = (status: number, body: unknown): Response => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    },
  },
);

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
};

/**
 * Framework-independent, inactive API contract for manually resolving an
 * ambiguous mail attempt. It has no listener, transport or runtime binding.
 */
export class MailOutboxReconciliationHttpContract {
  private readonly publicOrigin: string;

  constructor(private readonly options: MailOutboxReconciliationHttpOptions) {
    const origin = new URL(options.publicOrigin);
    const local = origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1';
    if (
      (origin.protocol !== 'https:' && !local) ||
      origin.origin !== options.publicOrigin
    ) {
      throw new Error('publicOrigin must be an exact HTTPS origin');
    }
    this.publicOrigin = origin.origin;
  }

  async handle(
    request: Request,
    session?: AuthenticatedReconciliationSession,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== this.publicOrigin || url.search) {
        return json(400, { error: 'invalid_request' });
      }
      if (!session?.actor.trim() || !session.csrfToken) {
        return json(401, { error: 'authentication_required' });
      }
      const match = /^\/api\/outbox-reconciliations\/([^/]+)\/([^/]+)(?:\/(webauthn|decision))?$/
        .exec(url.pathname);
      if (!match) return json(404, { error: 'not_found' });

      const actionId = actionIdSchema.parse(decodeURIComponent(match[1]!));
      const attemptId = attemptIdSchema.parse(decodeURIComponent(match[2]!));
      const record = await this.authorizedRecord(
        session.actor,
        actionId,
        attemptId,
      );

      if (request.method === 'GET' && !match[3]) {
        return json(200, this.pageModel(record));
      }

      if (request.method === 'POST' && match[3] === 'webauthn') {
        this.assertMutationRequest(request, session);
        const context = await this.parseContext(request, actionId, attemptId);
        return json(
          200,
          await this.options.freshAuth.begin(session.actor, context),
        );
      }

      if (request.method === 'POST' && match[3] === 'decision') {
        this.assertMutationRequest(request, session);
        const body = await this.parseJson(
          request,
          z.object({
            decision: decisionSchema,
            evidence: evidenceSchema,
            assertion: z.unknown(),
          }).strict(),
        );
        const result = await this.options.service.reconcile({
          actionId,
          attemptId,
          decision: body.decision,
          evidence: body.evidence,
          assertion: body.assertion,
          expectedReviewer: session.actor,
        });
        return json(200, {
          actionId,
          attemptId,
          status: result.status,
          dispatchAvailable: result.status === 'queued',
        });
      }

      return json(404, { error: 'not_found' });
    } catch {
      return json(400, { error: 'invalid_request' });
    }
  }

  private async authorizedRecord(
    actor: string,
    actionId: string,
    attemptId: string,
  ): Promise<OutboxRecord> {
    const record = this.options.service.review(actionId, attemptId);
    if (!await this.options.authorizeReviewer(actor, record)) {
      throw new Error('reviewer is not authorized for this outbox action');
    }
    return record;
  }

  private pageModel(record: OutboxRecord): ReconciliationPageModel {
    if (
      (record.status !== 'dispatching' && record.status !== 'uncertain') ||
      !record.attemptId
    ) {
      throw new Error('record does not require reconciliation');
    }
    return {
      actionId: record.actionId,
      attemptId: record.attemptId,
      status: record.status,
      kind: record.kind,
      createdAt: record.createdAt,
      ...(record.claimedAt ? { claimedAt: record.claimedAt } : {}),
      ...(record.uncertainAt ? { uncertainAt: record.uncertainAt } : {}),
      ...(record.uncertaintyCode
        ? { uncertaintyCode: record.uncertaintyCode }
        : {}),
      decisions: ['accepted', 'not-accepted'],
    };
  }

  private async parseContext(
    request: Request,
    actionId: string,
    attemptId: string,
  ): Promise<ReconciliationAuthContext> {
    const body = await this.parseJson(
      request,
      z.object({
        decision: decisionSchema,
        evidence: evidenceSchema,
      }).strict(),
    );
    return {
      actionId,
      attemptId,
      decision: body.decision,
      evidence: body.evidence,
    };
  }

  private assertMutationRequest(
    request: Request,
    session: AuthenticatedReconciliationSession,
  ): void {
    if (request.headers.get('origin') !== this.publicOrigin) {
      throw new Error('request origin does not match');
    }
    const suppliedCsrf = request.headers.get('x-csrf-token');
    if (!suppliedCsrf ||
      !constantTimeEqual(suppliedCsrf, session.csrfToken)) {
      throw new Error('CSRF token does not match');
    }
    if (!request.headers.get('content-type')
      ?.toLowerCase().startsWith('application/json')) {
      throw new Error('JSON content type is required');
    }
  }

  private async parseJson<T>(
    request: Request,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
      throw new Error('request body exceeds 64 KiB');
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
      throw new Error('request body exceeds 64 KiB');
    }
    return schema.parse(JSON.parse(text));
  }
}
