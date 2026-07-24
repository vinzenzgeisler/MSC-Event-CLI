import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const MAGIC = Buffer.from('MSCABK1\0', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

const validate = (
  sourcePath: string,
  destinationPath: string,
  key: Uint8Array,
): Buffer => {
  if (!isAbsolute(sourcePath) || !isAbsolute(destinationPath)) {
    throw new Error('backup paths must be absolute');
  }
  if (sourcePath === destinationPath) {
    throw new Error('backup source and destination must differ');
  }
  if (key.byteLength !== 32) {
    throw new Error('backup encryption key must contain exactly 32 bytes');
  }
  return Buffer.from(key);
};

const cleanup = async (paths: string[], directory: string): Promise<void> => {
  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    await rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export const createEncryptedSqliteBackup = async (
  sourcePath: string,
  destinationPath: string,
  keyValue: Uint8Array,
): Promise<void> => {
  const key = validate(sourcePath, destinationPath, keyValue);
  const destinationDirectory = dirname(destinationPath);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(
    join(destinationDirectory, '.approved-actions-backup-'),
  );
  await chmod(temporaryDirectory, 0o700);
  const plaintextPath = join(temporaryDirectory, 'snapshot.sqlite');
  const encryptedPath = join(temporaryDirectory, 'snapshot.enc');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, plaintextPath);
    await chmod(plaintextPath, 0o600);
    const plaintextStat = await stat(plaintextPath);
    if (plaintextStat.size > MAX_BACKUP_BYTES) {
      throw new Error('SQLite backup exceeds 256 MiB limit');
    }
    const plaintext = await readFile(plaintextPath);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const output = Buffer.concat([
      MAGIC,
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    await writeFile(encryptedPath, output, { mode: 0o600, flag: 'wx' });
    await link(encryptedPath, destinationPath);
  } finally {
    source.close();
    await cleanup([plaintextPath, encryptedPath], temporaryDirectory);
  }
};

export const restoreEncryptedSqliteBackup = async (
  sourcePath: string,
  destinationPath: string,
  keyValue: Uint8Array,
): Promise<void> => {
  const key = validate(sourcePath, destinationPath, keyValue);
  const destinationDirectory = dirname(destinationPath);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(
    join(destinationDirectory, '.approved-actions-restore-'),
  );
  await chmod(temporaryDirectory, 0o700);
  const restoredPath = join(temporaryDirectory, 'restored.sqlite');
  try {
    const input = await readFile(sourcePath);
    const headerBytes = MAGIC.byteLength + NONCE_BYTES + TAG_BYTES;
    if (
      input.byteLength <= headerBytes ||
      !input.subarray(0, MAGIC.byteLength).equals(MAGIC) ||
      input.byteLength > MAX_BACKUP_BYTES + headerBytes
    ) {
      throw new Error('encrypted backup format is invalid');
    }
    const nonceStart = MAGIC.byteLength;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      input.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(input.subarray(tagStart, ciphertextStart));
    const plaintext = Buffer.concat([
      decipher.update(input.subarray(ciphertextStart)),
      decipher.final(),
    ]);
    await writeFile(restoredPath, plaintext, { mode: 0o600, flag: 'wx' });
    const database = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== 'ok') {
        throw new Error('restored SQLite backup failed integrity check');
      }
    } finally {
      database.close();
    }
    await link(restoredPath, destinationPath);
  } finally {
    await cleanup([restoredPath], temporaryDirectory);
  }
};
