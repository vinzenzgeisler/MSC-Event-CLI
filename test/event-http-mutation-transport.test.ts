import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEntryHttpMutationTransport } from '../src/event-http-mutation-transport.js';

const entryId = '10000000-0000-4000-8000-000000000001';
const context = {
  actionId: '20000000-0000-4000-8000-000000000002',
  payloadHash: 'a'.repeat(64),
  approvedBy: 'vinzenz',
  approvedAt: new Date().toISOString(),
};

test('maps each typed entry operation to one fixed scoped backend request', async () => {
  const requests: Array<{ url: string; init: RequestInit; scope: string }> = [];
  const transport = new EventEntryHttpMutationTransport({
    baseUrl: new URL('https://event.example/prod'),
    tokenProvider: async (scope) => {
      requests.push({ url: '', init: {}, scope });
      return 'short-lived-token';
    },
    fetchImpl: async (url, init) => {
      const current = requests.at(-1)!;
      current.url = String(url);
      current.init = init ?? {};
      return new Response(JSON.stringify({ ok: true, entryId }), {
        status: 200,
      });
    },
  });

  await transport.apply(entryId, {
    type: 'checkin-id-verification',
    checkinIdVerified: true,
  }, context);
  await transport.apply(entryId, { type: 'soft-delete' }, context);

  assert.equal(
    requests[0]?.url,
    `https://event.example/prod/admin/entries/${entryId}/checkin/id-verify`,
  );
  assert.equal(requests[0]?.scope, 'msc-automation/entries.checkin.write');
  assert.equal(requests[0]?.init.method, 'PATCH');
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>)['idempotency-key'],
    context.actionId,
  );
  assert.equal(requests[1]?.init.method, 'DELETE');
  assert.equal(requests[1]?.scope, 'msc-automation/entries.delete');
});

test('never exposes backend error bodies or retries a failed mutation', async () => {
  let calls = 0;
  const transport = new EventEntryHttpMutationTransport({
    baseUrl: new URL('https://event.example'),
    tokenProvider: async () => 'secret-token',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        message: 'secret-token and private backend details',
      }), { status: 409 });
    },
  });
  await assert.rejects(
    transport.apply(entryId, { type: 'restore' }, context),
    (error: unknown) => {
      assert.equal(String(error).includes('secret-token'), false);
      assert.match(String(error), /HTTP 409/);
      return true;
    },
  );
  assert.equal(calls, 1);
});
