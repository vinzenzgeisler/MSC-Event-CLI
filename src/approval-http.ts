import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  actionPreviewSchema,
  type ActionIntent,
  type ActionPreview,
  type PreviewRenderer,
} from './action.js';
import {
  ApprovalQueue,
  type ApprovalRecord,
  type FreshAuthContext,
} from './approval.js';
import type { BeginWebAuthnResult } from './webauthn.js';
import {
  APPROVAL_CSS,
  APPROVAL_JAVASCRIPT,
  renderApprovalHtml,
} from './approval-ui.js';

const actionIdSchema = z.string().uuid();
const decisionSchema = z.enum(['approve', 'reject']);

export interface AuthenticatedApprovalSession {
  /** Supplied by trusted server middleware, never parsed from request input. */
  actor: string;
  csrfToken: string;
}

export interface ApprovalPageModel {
  actionId: string;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  preview: ActionPreview;
}

export interface ApprovalHttpContractOptions {
  publicOrigin: string;
  queue: ApprovalQueue;
  renderers: PreviewRenderer[];
  authorizeReviewer(actor: string, record: ApprovalRecord): Promise<boolean>;
  beginFreshAuth(
    actor: string,
    context: FreshAuthContext,
  ): Promise<BeginWebAuthnResult>;
}

const response = (
  status: number,
  body: string,
  contentType: string,
  contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'",
): Response => new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': contentSecurityPolicy,
      'referrer-policy': 'no-referrer',
    },
  });

const json = (status: number, body: unknown): Response => response(
  status,
  JSON.stringify(body),
  'application/json; charset=utf-8',
);

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

/**
 * Framework-independent, inert HTTP contract for a future mobile approval UI.
 * The host must inject an authenticated session. This class starts WebAuthn
 * ceremonies and records decisions, but deliberately discards execution proofs
 * and cannot execute an approved action.
 */
export class ApprovalHttpContract {
  private readonly publicOrigin: string;
  private readonly renderers = new Map<string, PreviewRenderer>();

  constructor(private readonly options: ApprovalHttpContractOptions) {
    const origin = new URL(options.publicOrigin);
    const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if ((origin.protocol !== 'https:' && !local) || origin.origin !== options.publicOrigin) {
      throw new Error('publicOrigin must be an exact HTTPS origin');
    }
    this.publicOrigin = origin.origin;
    for (const renderer of options.renderers) {
      if (this.renderers.has(renderer.kind)) {
        throw new Error(`duplicate preview renderer for ${renderer.kind}`);
      }
      this.renderers.set(renderer.kind, renderer);
    }
  }

  approvalUrl(actionId: string): string {
    return `${this.publicOrigin}/approve/${actionIdSchema.parse(actionId)}`;
  }

  async handle(
    request: Request,
    session?: AuthenticatedApprovalSession,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== this.publicOrigin || url.search) {
        return json(400, { error: 'invalid_request' });
      }
      if (!session?.actor.trim() || !session.csrfToken) {
        return json(401, { error: 'authentication_required' });
      }

      if (request.method === 'GET' && url.pathname === '/assets/approval.css') {
        return response(200, APPROVAL_CSS, 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/assets/approval.js') {
        return response(
          200,
          APPROVAL_JAVASCRIPT,
          'text/javascript; charset=utf-8',
        );
      }

      const reviewMatch = /^\/approve\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && reviewMatch) {
        await this.authorizedRecord(
          session.actor,
          actionIdSchema.parse(decodeURIComponent(reviewMatch[1]!)),
        );
        return response(
          200,
          renderApprovalHtml(session.csrfToken),
          'text/html; charset=utf-8',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
      }

      const modelMatch = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && modelMatch) {
        const record = await this.authorizedRecord(
          session.actor,
          actionIdSchema.parse(decodeURIComponent(modelMatch[1]!)),
        );
        return json(200, this.pageModel(record));
      }

      const beginMatch = /^\/api\/approvals\/([^/]+)\/webauthn$/.exec(url.pathname);
      if (request.method === 'POST' && beginMatch) {
        this.assertMutationRequest(request, session);
        const actionId = actionIdSchema.parse(decodeURIComponent(beginMatch[1]!));
        const body = await this.parseJson(
          request,
          z.object({ decision: decisionSchema }).strict(),
        );
        const record = await this.authorizedRecord(session.actor, actionId);
        const ceremony = await this.options.beginFreshAuth(session.actor, {
          actionId,
          payloadHash: record.payloadHash,
          decision: body.decision,
        });
        return json(200, ceremony);
      }

      const decisionMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
      if (request.method === 'POST' && decisionMatch) {
        this.assertMutationRequest(request, session);
        const actionId = actionIdSchema.parse(decodeURIComponent(decisionMatch[1]!));
        const body = await this.parseJson(
          request,
          z.object({
            decision: decisionSchema,
            assertion: z.unknown(),
          }).strict(),
        );
        await this.authorizedRecord(session.actor, actionId);
        await this.options.queue.decide(
          actionId,
          body.decision,
          body.assertion,
          session.actor,
        );
        return json(200, {
          actionId,
          status: body.decision === 'approve' ? 'approved' : 'rejected',
          executionAvailable: false,
        });
      }

      return json(404, { error: 'not_found' });
    } catch {
      return json(400, { error: 'invalid_request' });
    }
  }

  private pageModel(record: ApprovalRecord): ApprovalPageModel {
    const renderer = this.renderers.get(record.intent.kind);
    if (!renderer) throw new Error(`no preview renderer for ${record.intent.kind}`);
    return {
      actionId: record.actionId,
      payloadHash: record.payloadHash,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      preview: actionPreviewSchema.parse(
        renderer.render(record.intent as ActionIntent),
      ),
    };
  }

  private async authorizedRecord(
    actor: string,
    actionId: string,
  ): Promise<ApprovalRecord> {
    const record = await this.options.queue.review(actionId);
    if (!await this.options.authorizeReviewer(actor, record)) {
      throw new Error('reviewer is not authorized for this action');
    }
    return record;
  }

  private assertMutationRequest(
    request: Request,
    session: AuthenticatedApprovalSession,
  ): void {
    if (request.headers.get('origin') !== this.publicOrigin) {
      throw new Error('request origin does not match');
    }
    const suppliedCsrf = request.headers.get('x-csrf-token');
    if (!suppliedCsrf || !constantTimeEqual(suppliedCsrf, session.csrfToken)) {
      throw new Error('CSRF token does not match');
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
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
