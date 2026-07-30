import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exactMatch,
  exactPersonName,
  groupByDriver,
  parseSearchSpec,
} from '../src/lookup.js';
import type { EntryListItem } from '../src/schemas.js';

const entry = (overrides: Partial<EntryListItem> = {}): EntryListItem => ({
  id: '10000000-0000-4000-8000-000000000001',
  eventId: '20000000-0000-4000-8000-000000000002',
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
  driverEmail: 'Max@Example.org',
  ...overrides
});

test('lookup requires exactly one non-empty option', () => {
  assert.deepEqual(parseSearchSpec({ orgaCode: ' ABC ' }), { kind: 'orgaCode', value: 'ABC' });
  assert.deepEqual(parseSearchSpec({ codriverName: ' Max Mustermann ' }), {
    kind: 'codriverName',
    value: 'Max Mustermann',
  });
  assert.throws(() => parseSearchSpec({}), /exactly one/);
  assert.throws(() => parseSearchSpec({ email: 'a@b.de', name: 'A B' }), /exactly one/);
});

test('post-filtering is exact and normalized', () => {
  assert.equal(exactMatch(entry(), { kind: 'orgaCode', value: '11old-7k4p9' }), true);
  assert.equal(exactMatch(entry(), { kind: 'email', value: 'max@example.org' }), true);
  assert.equal(exactMatch(entry(), { kind: 'startNumber', value: '42' }), true);
  assert.equal(exactMatch(entry(), { kind: 'startNumber', value: '4' }), false);
  assert.equal(exactMatch(entry(), { kind: 'name', value: '  max   musterfahrer ' }), true);
  assert.equal(exactMatch(entry(), { kind: 'codriverName', value: 'Max Musterfahrer' }), false);
  assert.equal(exactPersonName(' Max ', ' Mustermann', 'max mustermann'), true);
});

test('grouping keeps double starters together and separates drivers', () => {
  const secondStart = entry({ id: '10000000-0000-4000-8000-000000000002', startNumberNorm: '43' });
  const otherDriver = entry({ id: '10000000-0000-4000-8000-000000000003', driverPersonId: '50000000-0000-4000-8000-000000000005' });
  const groups = groupByDriver([entry(), secondStart, otherDriver]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((item) => item.driverPersonId.startsWith('4'))?.entries.length, 2);
});
