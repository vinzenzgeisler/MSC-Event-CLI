import { z } from 'zod';
import type { ExecutionContext, JsonValue } from './action.js';
import type {
  EventEntryMutationTransport,
  EventEntryOperation,
} from './event-approved-action.js';

type FetchLike = typeof fetch;
type TokenProvider = (scope: string) => Promise<string>;
export type EventMutationScopePrefix =
  | 'msc-automation/'
  | 'msc-support/';

const uuid = z.string().uuid();
const responseSchema = z.record(z.unknown());
type RequestSpec = {
  method: 'PATCH' | 'POST' | 'DELETE';
  path: string;
  scope: string;
  body?: Record<string, unknown>;
};

const requestForOperation = (
  entryId: string,
  operation: EventEntryOperation,
  scopePrefix: EventMutationScopePrefix,
): RequestSpec => {
  const id = encodeURIComponent(uuid.parse(entryId));
  switch (operation.type) {
    case 'acceptance-status':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/status`,
        scope: `${scopePrefix}entries.status.write`,
        body: {
          acceptanceStatus: operation.acceptanceStatus,
          sendLifecycleMail: false,
        },
      };
    case 'payment-amounts':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/payment-amounts`,
        scope: `${scopePrefix}entries.payment.write`,
        body: {
          ...(operation.totalCents === undefined
            ? {}
            : { totalCents: operation.totalCents }),
          ...(operation.paidAmountCents === undefined
            ? {}
            : { paidAmountCents: operation.paidAmountCents }),
          ...(operation.note === undefined ? {} : { note: operation.note }),
        },
      };
    case 'payment-status':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/payment-status`,
        scope: `${scopePrefix}entries.payment.write`,
        body: {
          paymentStatus: operation.paymentStatus,
          ...(operation.paidAt === undefined ? {} : { paidAt: operation.paidAt }),
          ...(operation.note === undefined ? {} : { note: operation.note }),
        },
      };
    case 'technical-status':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/tech-status`,
        scope: `${scopePrefix}entries.checkin.write`,
        body: { techStatus: operation.techStatus },
      };
    case 'checkin-id-verification':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/checkin/id-verify`,
        scope: `${scopePrefix}entries.checkin.write`,
        body: { checkinIdVerified: operation.checkinIdVerified },
      };
    case 'notes':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/notes`,
        scope: `${scopePrefix}entries.notes.write`,
        body: {
          ...(operation.internalNote === undefined
            ? {}
            : { internalNote: operation.internalNote }),
          ...(operation.driverNote === undefined
            ? {}
            : { driverNote: operation.driverNote }),
          ...(operation.inspectionNote === undefined
            ? {}
            : { inspectionNote: operation.inspectionNote }),
        },
      };
    case 'class':
      return {
        method: 'PATCH',
        path: `/admin/entries/${id}/class`,
        scope: `${scopePrefix}entries.status.write`,
        body: {
          classId: operation.classId,
          applyToBackupVehicle: operation.applyToBackupVehicle,
          allowVehicleTypeChange: operation.allowVehicleTypeChange,
        },
      };
    case 'soft-delete':
      return {
        method: 'DELETE',
        path: `/admin/entries/${id}`,
        scope: `${scopePrefix}entries.delete`,
        body: {},
      };
    case 'restore':
      return {
        method: 'POST',
        path: `/admin/entries/${id}/restore`,
        scope: `${scopePrefix}entries.delete`,
        body: {},
      };
  }
};

export class EventEntryHttpMutationTransport implements
  EventEntryMutationTransport {
  readonly #baseUrl: URL;
  readonly #token: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #scopePrefix: EventMutationScopePrefix;

  constructor(options: {
    baseUrl: URL;
    tokenProvider: TokenProvider;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    scopePrefix?: EventMutationScopePrefix;
  }) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.tokenProvider;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#scopePrefix = options.scopePrefix ?? 'msc-automation/';
  }

  async apply(
    entryId: string,
    operation: EventEntryOperation,
    context: ExecutionContext,
  ): Promise<{ externalId?: string; result: JsonValue }> {
    const request = requestForOperation(
      entryId,
      operation,
      this.#scopePrefix,
    );
    const token = await this.#token(request.scope);
    const url = new URL(this.#baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${request.path}`;
    url.search = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: request.method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': context.actionId,
          'x-msc-approval-action-id': context.actionId,
          'x-msc-approval-payload-sha256': context.payloadHash,
          'x-msc-approval-approved-at': context.approvedAt,
        },
        body: JSON.stringify(request.body ?? {}),
      });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
        throw new Error('MSC Event mutation response exceeds 2 MiB');
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error('MSC Event mutation returned invalid JSON');
      }
      if (!response.ok) {
        throw new Error(`MSC Event mutation failed with HTTP ${response.status}`);
      }
      return {
        externalId: context.actionId,
        result: responseSchema.parse(value) as JsonValue,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
