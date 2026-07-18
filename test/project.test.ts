import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactEntry } from '../src/project.js';
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
