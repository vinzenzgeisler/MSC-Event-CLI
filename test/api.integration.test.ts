import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { MscEventApi, isAllowedRequest } from '../src/api.js';
import { CliError, safeError } from '../src/errors.js';
import { SupportService } from '../src/service.js';
import { detailFixture } from './fixtures.js';

const eventId = '20000000-0000-4000-8000-000000000002';
const entryId = '10000000-0000-4000-8000-000000000001';
let baseUrl: URL;
const requests: Array<{ url: string; authorization: string | undefined }> = [];

const reply = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
  if (request.url === '/health') return reply(response, { ok: true, status: 'healthy' });
  if (request.url === '/admin/events/current') return reply(response, { ok: true, event: { id: eventId, name: 'Event', status: 'open' } });
  if (request.url?.startsWith('/admin/entries?')) {
    return reply(response, {
      ok: true,
      entries: [
        {
          id: entryId,
          eventId,
          classId: '30000000-0000-4000-8000-000000000003',
          driverPersonId: '40000000-0000-4000-8000-000000000004',
          className: 'Classic',
          registrationStatus: 'submitted_verified',
          acceptanceStatus: 'accepted',
          paymentStatus: 'due',
          startNumberNorm: '42',
          orgaCode: '11OLD-7K4P9',
          driverFirstName: 'Max',
          driverLastName: 'Musterfahrer',
          driverEmail: 'max@example.org'
        }
      ],
      meta: { hasMore: false, nextCursor: null }
    });
  }
  if (request.url === `/admin/entries/${entryId}`) return reply(response, detailFixture(entryId));
  response.writeHead(404).end();
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);
});

after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('health is unauthenticated while all admin calls carry the bearer token', async () => {
  requests.length = 0;
  const service = new SupportService(new MscEventApi({ baseUrl, token: 'test-token', timeoutMs: 2000 }));
  assert.equal((await service.health()).ok, true);
  const result = await service.lookup({ kind: 'orgaCode', value: '11old-7k4p9' });
  assert.equal(result.status, 'matched');
  assert.equal(requests[0]?.authorization, undefined);
  assert.equal(requests.slice(1).every((item) => item.authorization === 'Bearer test-token'), true);
});

test('service returns not_found and ambiguous without fetching details', async () => {
  const base = { id: entryId, eventId, classId: '30000000-0000-4000-8000-000000000003', className: 'Classic', registrationStatus: 'submitted_verified', acceptanceStatus: 'accepted', startNumberNorm: '42', orgaCode: 'SAME', driverFirstName: 'Max', driverLastName: 'Musterfahrer', driverEmail: 'max@example.org' };
  const fakeApi = {
    currentEvent: async () => ({ ok: true, event: { id: eventId, name: 'Event', status: 'open' } }),
    searchEntries: async () => ({ ok: true, entries: [
      { ...base, driverPersonId: '40000000-0000-4000-8000-000000000004' },
      { ...base, id: '10000000-0000-4000-8000-000000000009', driverPersonId: '90000000-0000-4000-8000-000000000009' }
    ], meta: {} }),
    entryDetail: async () => { throw new Error('must not fetch'); }
  };
  const service = new SupportService(fakeApi as never);
  assert.equal((await service.lookup({ kind: 'orgaCode', value: 'missing' })).status, 'not_found');
  assert.equal((await service.lookup({ kind: 'orgaCode', value: 'same' })).status, 'ambiguous');
});

test('one driver with two exact matches is returned as one matched double starter', async () => {
  const secondId = '10000000-0000-4000-8000-000000000002';
  const base = {
    eventId,
    classId: '30000000-0000-4000-8000-000000000003',
    driverPersonId: '40000000-0000-4000-8000-000000000004',
    className: 'Classic',
    registrationStatus: 'submitted_verified',
    acceptanceStatus: 'accepted',
    orgaCode: 'DOUBLE',
    driverFirstName: 'Max',
    driverLastName: 'Musterfahrer',
    driverEmail: 'max@example.org'
  };
  const fakeApi = {
    currentEvent: async () => ({ ok: true, event: { id: eventId, name: 'Event', status: 'open' } }),
    searchEntries: async () => ({ ok: true, entries: [
      { ...base, id: entryId, startNumberNorm: '42' },
      { ...base, id: secondId, startNumberNorm: '43' }
    ], meta: {} }),
    entryDetail: async (id: string) => detailFixture(id)
  };
  const result = await new SupportService(fakeApi as never).lookup({ kind: 'orgaCode', value: 'double' });
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') assert.equal(result.entries.length, 2);
});

test('full detail is opt-in and preserves sensitive backend fields and history', async () => {
  const fakeApi = {
    entryDetail: async (id: string) => detailFixture(id)
  };
  const service = new SupportService(fakeApi as never);
  const compact = await service.detail(entryId);
  assert.equal(compact.mode, 'compact');
  assert.equal(JSON.stringify(compact).includes('Must not leave the API client'), false);
  assert.equal(JSON.stringify(compact).includes('hidden'), false);

  const full = await service.detail(entryId, true);
  assert.equal(full.mode, 'full');
  assert.equal((full.entry.person.driver as Record<string, unknown>).phone, 'Must not leave the API client');
  assert.deepEqual(full.history, [{ payload: 'hidden' }]);
});

test('allowlist rejects methods, paths and unexpected query keys', () => {
  assert.equal(isAllowedRequest('POST', new URL('/health', baseUrl)), false);
  assert.equal(isAllowedRequest('GET', new URL('/admin/entries/deleted', baseUrl)), false);
  assert.equal(isAllowedRequest('GET', new URL(`/admin/entries?eventId=${eventId}&q=x&paymentStatus=due`, baseUrl)), false);
  assert.equal(isAllowedRequest('GET', new URL('/prod/health', baseUrl), '/prod'), true);
});

test('API errors do not expose response bodies or bearer tokens', async () => {
  const api = new MscEventApi({
    baseUrl,
    token: 'super-secret-token',
    timeoutMs: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ code: 'FAILED', message: 'super-secret-token' }), { status: 500 })
  });
  await assert.rejects(api.currentEvent(), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(JSON.stringify(safeError(error)).includes('super-secret-token'), false);
    return true;
  });
});
