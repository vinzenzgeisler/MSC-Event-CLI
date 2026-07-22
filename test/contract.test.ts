import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('pinned backend contract exposes only the required read routes and core fields', async () => {
  const contract = JSON.parse(await readFile('contracts/backend-openapi.json', 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  for (const path of ['/health', '/admin/events/current', '/admin/entries', '/admin/entries/{id}']) {
    assert.ok(contract.paths[path]?.get, `${path} GET`);
  }
  const adminEntry = contract.components.schemas.AdminEntry?.properties ?? {};
  for (const field of [
    'id',
    'eventId',
    'classId',
    'driverPersonId',
    'className',
    'registrationStatus',
    'acceptanceStatus',
    'paymentStatus',
    'startNumberNorm',
    'orgaCode',
    'driverFirstName',
    'driverLastName',
    'driverEmail',
    'vehicleLabel',
    'confirmationMailSent',
    'confirmationMailVerified'
  ]) {
    assert.ok(field in adminEntry, `AdminEntry.${field}`);
  }
  const detail = contract.components.schemas.AdminEntryDetailResponse?.properties ?? {};
  assert.ok('entry' in detail);
  assert.equal((await readFile('contracts/backend-commit.txt', 'utf8')).trim(), '4e1aae2f99fe77d1f44d9129928eef5b4c99bdbd');
});
