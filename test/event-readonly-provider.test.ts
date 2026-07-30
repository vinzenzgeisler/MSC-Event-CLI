import assert from 'node:assert/strict';
import test from 'node:test';
import { MscEventReadonlyProvider } from '../src/event-readonly-provider.js';

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
  assert.deepEqual(calls, [
    ['health'],
    ['lookup', '--email', 'driver@example.org'],
    ['lookup', '--codriver-name', 'Max Mustermann'],
    ['lookup', '--orga-code', 'ABC-123'],
    ['detail', '--id', '10000000-0000-4000-8000-000000000001'],
  ]);
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
});
