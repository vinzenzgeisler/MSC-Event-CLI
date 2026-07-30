import { z } from 'zod';
import { CliError, EXIT } from './errors.js';
import {
  buildAdminQueryPath,
  isAdminQueryPath,
  type AdminQueryOperation,
  type AdminQueryParameters
} from './admin-query.js';
import {
  CurrentEventResponseSchema,
  EntriesResponseSchema,
  EntryDetailResponseSchema,
  type EntryDetailResponse
} from './schemas.js';

type FetchLike = typeof fetch;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isAllowedRequest = (method: string, url: URL, basePath = ''): boolean => {
  if (method !== 'GET') return false;
  const prefix = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const routePath = url.pathname.slice(prefix.length) || '/';
  if (isAdminQueryPath(`${routePath}${url.search}`)) return true;
  if (routePath === '/health' || routePath === '/admin/events/current') return url.search === '';
  if (routePath === '/admin/entries') {
    const keys = [...url.searchParams.keys()];
    const validEvent = UUID.test(url.searchParams.get('eventId') ?? '');
    const query = url.searchParams.get('q');
    if (query) {
      return validEvent &&
        keys.every((key) => ['eventId', 'q', 'limit', 'cursor'].includes(key));
    }
    return validEvent &&
      keys.every((key) =>
        ['eventId', 'limit', 'cursor', 'sortBy', 'sortDir'].includes(key)) &&
      url.searchParams.get('limit') === '100' &&
      url.searchParams.get('sortBy') === 'createdAt' &&
      url.searchParams.get('sortDir') === 'asc';
  }
  const match = routePath.match(/^\/admin\/entries\/([^/]+)$/);
  return Boolean(match?.[1] && UUID.test(match[1]) && url.search === '');
};

const parseJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  let value: unknown;
  try {
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) {
      throw new Error('response too large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('response too large');
    }
    value = JSON.parse(body) as unknown;
  } catch {
    throw new CliError('INVALID_API_RESPONSE', 'MSC Event API returned invalid JSON.', EXIT.api);
  }
  if (!response.ok) {
    const candidateCode = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
      ? value.code
      : '';
    const code = /^[A-Z0-9_]{1,64}$/.test(candidateCode) ? candidateCode : `HTTP_${response.status}`;
    const exitCode = response.status === 401 || response.status === 403 ? EXIT.auth : EXIT.api;
    throw new CliError(code, `MSC Event API request failed with HTTP ${response.status}.`, exitCode);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError('API_CONTRACT_MISMATCH', 'MSC Event API response does not match the pinned contract.', EXIT.api);
  }
  return parsed.data;
};

export class MscEventApi {
  readonly #baseUrl: URL;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(input: { baseUrl: URL; token?: string; timeoutMs: number; fetchImpl?: FetchLike }) {
    this.#baseUrl = input.baseUrl;
    this.#token = input.token;
    this.#timeoutMs = input.timeoutMs;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async #get<T>(path: string, schema: z.ZodType<T>, authenticated: boolean): Promise<T> {
    const requested = new URL(path, 'https://allowlist.invalid');
    const url = new URL(this.#baseUrl.origin);
    url.pathname = `${this.#baseUrl.pathname.replace(/\/$/, '')}${requested.pathname}`;
    url.search = requested.search;
    if (!isAllowedRequest('GET', url, this.#baseUrl.pathname)) {
      throw new CliError('REQUEST_NOT_ALLOWED', 'Blocked a request outside the read-only allowlist.', EXIT.usage);
    }
    if (authenticated && !this.#token) {
      throw new CliError('MISSING_TOKEN', 'Admin request requires a bearer token.', EXIT.auth);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const init: RequestInit = {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal
      };
      if (authenticated) init.headers = { authorization: `Bearer ${this.#token}` };
      const response = await this.#fetch(url, init);
      return await parseJson(response, schema);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const code = error instanceof Error && error.name === 'AbortError' ? 'API_TIMEOUT' : 'API_UNREACHABLE';
      throw new CliError(code, 'MSC Event API could not be reached.', EXIT.api);
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.#get('/health', z.record(z.unknown()), false);
  }

  currentEvent() {
    return this.#get('/admin/events/current', CurrentEventResponseSchema, true);
  }

  searchEntries(eventId: string, query: string, cursor?: string) {
    const params = new URLSearchParams({ eventId, q: query, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    return this.#get(`/admin/entries?${params.toString()}`, EntriesResponseSchema, true);
  }

  listEntries(eventId: string, cursor?: string) {
    const params = new URLSearchParams({
      eventId,
      limit: '100',
      sortBy: 'createdAt',
      sortDir: 'asc',
    });
    if (cursor) params.set('cursor', cursor);
    return this.#get(`/admin/entries?${params.toString()}`, EntriesResponseSchema, true);
  }

  entryDetail(entryId: string): Promise<EntryDetailResponse> {
    if (!UUID.test(entryId)) {
      throw new CliError('INVALID_ENTRY_ID', 'Entry ID must be a UUID.', EXIT.usage);
    }
    return this.#get(`/admin/entries/${entryId}`, EntryDetailResponseSchema, true);
  }

  adminQuery(
    operation: AdminQueryOperation,
    parameters: AdminQueryParameters = {},
  ): Promise<Record<string, unknown>> {
    return this.#get(
      buildAdminQueryPath(operation, parameters),
      z.record(z.unknown()),
      true,
    );
  }
}
