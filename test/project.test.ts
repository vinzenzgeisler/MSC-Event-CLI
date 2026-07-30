import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactCodriverMatch, compactEntry } from '../src/project.js';
import { detailFixture } from './fixtures.js';

test('compact projection excludes sensitive and operationally irrelevant fields', () => {
  const projected = compactEntry(detailFixture());
  const serialized = JSON.stringify(projected);
  assert.equal(projected.payment.amountOpenCents, 8000);
  assert.equal(projected.start.vehicle, 'KTM EXC');
  for (const forbidden of ['street', 'phone', 'internalNote', 'history', 'ownerName', 'techCheckedBy', 'createdAt']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('codriver match projection includes only required contact and start fields', () => {
  const projected = compactCodriverMatch(detailFixture());
  assert.deepEqual(projected, {
    entryId: '10000000-0000-4000-8000-000000000001',
    driver: {
      firstName: 'Max',
      lastName: 'Musterfahrer',
      email: 'max@example.org',
      phone: 'Must not leave the API client',
    },
    codriver: {
      firstName: 'Erika',
      lastName: 'Beifahrerin',
    },
    start: {
      startNumber: '42',
      className: 'Classic',
      vehicle: 'KTM EXC',
    },
  });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    'street',
    'internalNote',
    'history',
    'ownerName',
    'erika@example.org',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
