import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adminQueryOperationSchema,
  buildAdminQueryPath,
  isAdminQueryPath,
} from '../src/admin-query.js';
import { CliError } from '../src/errors.js';

const eventId = '20000000-0000-4000-8000-000000000002';
const entryId = '10000000-0000-4000-8000-000000000001';

test('builds typed paths with bounded query parameters', () => {
  assert.equal(
    buildAdminQueryPath('entries.list', {
      eventId,
      q: 'Mustermann',
      limit: 25,
      sortDir: 'asc',
    }),
    `/admin/entries?eventId=${eventId}&q=Mustermann&limit=25&sortDir=asc`,
  );
  assert.equal(
    buildAdminQueryPath('entries.get', { id: entryId }),
    `/admin/entries/${entryId}`,
  );
});

test('rejects arbitrary operations, parameters and invalid values', () => {
  const rejected: Array<() => unknown> = [
    () => buildAdminQueryPath('arbitrary.http', {}),
    () => buildAdminQueryPath('entries.list', {}),
    () => buildAdminQueryPath('entries.list', { eventId, url: 'https://evil.example' }),
    () => buildAdminQueryPath('entries.list', { eventId, limit: 101 }),
    () => buildAdminQueryPath('entries.get', { id: '../../db/schema' }),
  ];
  for (const call of rejected) {
    assert.throws(call, CliError);
  }
  assert.equal(adminQueryOperationSchema.safeParse('entries.delete').success, false);
});

test('read allowlist contains no write or debug routes', () => {
  for (const path of [
    '/admin/db/schema',
    '/admin/entries/10000000-0000-4000-8000-000000000001/status',
    '/admin/mail/send',
    '/admin/iam/users/x/status',
  ]) {
    assert.equal(isAdminQueryPath(path), false, path);
  }
  assert.equal(isAdminQueryPath(`/admin/entries/${entryId}`), true);
});
