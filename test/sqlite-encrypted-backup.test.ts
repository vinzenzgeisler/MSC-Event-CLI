import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createEncryptedSqliteBackup,
  restoreEncryptedSqliteBackup,
} from '../src/sqlite-encrypted-backup.js';

test('creates an exclusive encrypted SQLite backup and restores it with integrity check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'encrypted-backup-'));
  const sourcePath = join(directory, 'source.sqlite');
  const backupPath = join(directory, 'backups', 'snapshot.mscbak');
  const restoredPath = join(directory, 'restored', 'state.sqlite');
  const key = Buffer.alloc(32, 23);
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE private_data (value TEXT NOT NULL) STRICT;
    INSERT INTO private_data VALUES ('person@example.invalid private payload');
  `);
  source.close();

  await createEncryptedSqliteBackup(sourcePath, backupPath, key);
  const encrypted = await readFile(backupPath);
  assert.equal(
    encrypted.includes(Buffer.from('person@example.invalid private payload')),
    false,
  );
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  await assert.rejects(
    createEncryptedSqliteBackup(sourcePath, backupPath, key),
  );

  await restoreEncryptedSqliteBackup(backupPath, restoredPath, key);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    assert.deepEqual(
      { ...restored.prepare('SELECT value FROM private_data').get() },
      { value: 'person@example.invalid private payload' },
    );
  } finally {
    restored.close();
  }
  assert.equal((await stat(restoredPath)).mode & 0o777, 0o600);
});

test('wrong key fails closed without leaving a restored database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'encrypted-backup-key-'));
  const sourcePath = join(directory, 'source.sqlite');
  const backupPath = join(directory, 'snapshot.mscbak');
  const restoredPath = join(directory, 'restored.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec('CREATE TABLE test (value INTEGER) STRICT;');
  source.close();
  await createEncryptedSqliteBackup(sourcePath, backupPath, Buffer.alloc(32, 1));
  await assert.rejects(
    restoreEncryptedSqliteBackup(
      backupPath,
      restoredPath,
      Buffer.alloc(32, 2),
    ),
  );
  await assert.rejects(stat(restoredPath), /ENOENT/);
});
