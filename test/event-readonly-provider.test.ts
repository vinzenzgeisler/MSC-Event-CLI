import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactEventEntriesList,
  MscEventReadonlyProvider,
} from '../src/event-readonly-provider.js';

test('uses only the fixed event read-only command contract', async () => {
  const calls: string[][] = [];
  const provider = new MscEventReadonlyProvider(async (args) => {
    calls.push([...args]);
    return { stdout: JSON.stringify({ status: 'matched' }) };
  });
  await provider.health();
  await provider.lookup('email', 'driver@example.org');
  await provider.lookup('codriver-name', 'Max Mustermann');
  await provider.lookup('orga-code', 'ABC-123');
  await provider.detail('10000000-0000-4000-8000-000000000001');
  await provider.listEntries({
    eventId: '20000000-0000-4000-8000-000000000002',
    acceptanceStatus: 'shortlist',
    classId: '30000000-0000-4000-8000-000000000003',
    limit: 20,
    cursor: 'next-page',
  });
  await provider.listClasses({
    eventId: '20000000-0000-4000-8000-000000000002',
  });
  assert.deepEqual(calls, [
    ['health'],
    ['lookup', '--email', 'driver@example.org'],
    ['lookup', '--codriver-name', 'Max Mustermann'],
    ['lookup', '--orga-code', 'ABC-123'],
    ['detail', '--id', '10000000-0000-4000-8000-000000000001'],
    [
      'admin-query',
      '--operation',
      'entries.list',
      '--params-json',
      JSON.stringify({
        eventId: '20000000-0000-4000-8000-000000000002',
        acceptanceStatus: 'shortlist',
        classId: '30000000-0000-4000-8000-000000000003',
        limit: 20,
        cursor: 'next-page',
      }),
    ],
    [
      'admin-query',
      '--operation',
      'events.classes',
      '--params-json',
      JSON.stringify({ id: '20000000-0000-4000-8000-000000000002' }),
    ],
  ]);
});

test('compact entry-list projection keeps shortlist fields and excludes PII', () => {
  assert.deepEqual(compactEventEntriesList({
    ok: true,
    entries: [{
      id: '10000000-0000-4000-8000-000000000001',
      eventId: '20000000-0000-4000-8000-000000000002',
      classId: '30000000-0000-4000-8000-000000000003',
      className: 'Tourenwagen',
      acceptanceStatus: 'shortlist',
      startNumberNorm: 'A17',
      driverFirstName: 'Max',
      driverLastName: 'Muster',
      vehicleLabel: 'Example 2000',
      driverEmail: 'must-not-appear@example.org',
      vehicleThumbUrl: 'https://must-not-appear.example/secret',
      internalNote: 'must not appear',
    }],
    meta: {
      hasMore: true,
      nextCursor: 'next-page',
      limit: 25,
      internalCount: 1234,
    },
    backendDebug: 'must not appear',
  }), {
    ok: true,
    entries: [{
      id: '10000000-0000-4000-8000-000000000001',
      eventId: '20000000-0000-4000-8000-000000000002',
      classId: '30000000-0000-4000-8000-000000000003',
      className: 'Tourenwagen',
      acceptanceStatus: 'shortlist',
      startNumberNorm: 'A17',
      driverFirstName: 'Max',
      driverLastName: 'Muster',
      vehicleLabel: 'Example 2000',
    }],
    meta: { hasMore: true, nextCursor: 'next-page', limit: 25 },
  });
});

test('rejects invalid detail ids and lookup control characters', () => {
  const provider = new MscEventReadonlyProvider(async () => ({
    stdout: '{}',
  }));
  assert.throws(() => provider.detail('../secret'), /uuid/i);
  assert.throws(
    () => provider.lookup('name', 'Max\n--full'),
    /invalid lookup value/,
  );
  assert.throws(() => provider.listEntries({
    eventId: '20000000-0000-4000-8000-000000000002',
    acceptanceStatus: 'shortlist',
    limit: 25,
    url: 'https://evil.example',
  } as never), /unrecognized key/i);
  assert.throws(() => provider.listClasses({
    eventId: '20000000-0000-4000-8000-000000000002',
    method: 'DELETE',
  } as never), /unrecognized key/i);
});
