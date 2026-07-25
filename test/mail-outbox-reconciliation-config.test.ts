import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkMailOutboxReconciliationReadiness,
  loadTrustedMailOutboxReconciliationConfig,
  openInactiveMailOutboxReconciliation,
  reconciliationCompositionOptions,
  validateInactiveMailOutboxReconciliationState,
  type MailOutboxReconciliationRuntimeConfig,
} from '../src/mail-outbox-reconciliation-config.js';

const config: MailOutboxReconciliationRuntimeConfig = {
  version: 1,
  outboxPath: '/var/lib/openclaw/approved-mail-outbox.sqlite',
  webauthnPath: '/var/lib/openclaw/approved-actions-webauthn.sqlite',
  publicOrigin: 'https://approval.example.invalid',
  rpId: 'approval.example.invalid',
  expectedOrigins: ['https://approval.example.invalid'],
  reviewerPolicy: {
    vinzenz: {
      accounts: ['msc-info', 'msc-nennung'],
      actionKinds: ['mail.send', 'mail.reply'],
    },
  },
  challengeTtlSeconds: 120,
  maxFreshAuthAgeSeconds: 300,
};

test('returns readiness without paths, actor identifiers or key bytes', () => {
  const key = Buffer.alloc(32, 71);
  const readiness = checkMailOutboxReconciliationReadiness(config, key);
  assert.deepEqual(readiness, {
    ready: true,
    inactive: true,
    version: 1,
    publicOrigin: config.publicOrigin,
    rpId: config.rpId,
    expectedOriginCount: 1,
    reviewerCount: 1,
    accountCoverage: ['msc-info', 'msc-nennung'],
    actionKindCoverage: ['mail.reply', 'mail.send'],
    statePathsConfigured: 2,
    encryptionKey: 'injected-32-byte-key',
  });
  const serialized = JSON.stringify(readiness);
  assert.doesNotMatch(serialized, /vinzenz|\/var\/lib|71/);

  const options = reconciliationCompositionOptions(config, key);
  assert.equal(options.outboxEncryptionKey, key);
  assert.deepEqual(options.reviewerPolicy, config.reviewerPolicy);
});

test('fails closed on unsafe origins, RP mismatch, relative state or invalid keys', () => {
  const key = Buffer.alloc(32);
  assert.throws(
    () => checkMailOutboxReconciliationReadiness({
      ...config,
      publicOrigin: 'http://approval.example.invalid',
      expectedOrigins: ['http://approval.example.invalid'],
    }, key),
    /HTTPS origin/,
  );
  assert.throws(
    () => checkMailOutboxReconciliationReadiness({
      ...config,
      rpId: 'other.example.invalid',
    }, key),
    /registrable suffix/,
  );
  assert.throws(
    () => checkMailOutboxReconciliationReadiness({
      ...config,
      outboxPath: 'relative.sqlite',
    }, key),
    /absolute/,
  );
  assert.throws(
    () => checkMailOutboxReconciliationReadiness(config, Buffer.alloc(31)),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => checkMailOutboxReconciliationReadiness({
      ...config,
      webauthnPath: config.outboxPath,
    }, key),
    /must differ/,
  );
});

test('loads only an absolute owner-matched private regular config file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-config-'));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');
  assert.deepEqual(
    await loadTrustedMailOutboxReconciliationConfig(path, {
      expectedOwnerUid: uid,
    }),
    config,
  );

  await chmod(path, 0o640);
  assert.deepEqual(
    await loadTrustedMailOutboxReconciliationConfig(path, {
      expectedOwnerUid: uid,
    }),
    config,
  );
  await chmod(path, 0o660);
  await assert.rejects(
    loadTrustedMailOutboxReconciliationConfig(path, {
      expectedOwnerUid: uid,
    }),
    /group-writable or world-accessible/,
  );
  await chmod(path, 0o600);
  const link = join(directory, 'config-link.json');
  await symlink(path, link);
  await assert.rejects(
    loadTrustedMailOutboxReconciliationConfig(link, {
      expectedOwnerUid: uid,
    }),
  );
  await assert.rejects(
    loadTrustedMailOutboxReconciliationConfig('relative.json'),
    /absolute/,
  );
});

test('opens the complete inactive composition only after trusted validation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-open-'));
  const configPath = join(directory, 'config.json');
  const outboxPath = join(directory, 'state', 'outbox.sqlite');
  const webauthnPath = join(directory, 'state', 'webauthn.sqlite');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');
  await writeFile(configPath, JSON.stringify({
    ...config,
    outboxPath,
    webauthnPath,
  }), { mode: 0o600 });
  const opened = await openInactiveMailOutboxReconciliation({
    configPath,
    outboxEncryptionKey: Buffer.alloc(32, 88),
    expectedConfigOwnerUid: uid,
  });
  t.after(() => opened.composition.close());
  assert.equal(opened.readiness.ready, true);
  assert.equal(opened.readiness.inactive, true);
  assert.equal((await stat(outboxPath)).mode & 0o777, 0o600);
  assert.ok(await stat(webauthnPath));
  opened.composition.close();
  opened.composition.close();
});

test('does not open state databases when policy or key validation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-refuse-'));
  const configPath = join(directory, 'config.json');
  const outboxPath = join(directory, 'outbox.sqlite');
  const webauthnPath = join(directory, 'webauthn.sqlite');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');
  await writeFile(configPath, JSON.stringify({
    ...config,
    outboxPath,
    webauthnPath,
  }), { mode: 0o666 });
  await assert.rejects(
    openInactiveMailOutboxReconciliation({
      configPath,
      outboxEncryptionKey: Buffer.alloc(32),
      expectedConfigOwnerUid: uid,
    }),
    /world-accessible/,
  );
  await assert.rejects(stat(outboxPath), /ENOENT/);
  await assert.rejects(stat(webauthnPath), /ENOENT/);

  await chmod(configPath, 0o600);
  await assert.rejects(
    openInactiveMailOutboxReconciliation({
      configPath,
      outboxEncryptionKey: Buffer.alloc(31),
      expectedConfigOwnerUid: uid,
    }),
    /exactly 32 bytes/,
  );
  await assert.rejects(stat(outboxPath), /ENOENT/);
  await assert.rejects(stat(webauthnPath), /ENOENT/);
});

test('requires restored reconciliation state to be a complete private pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-restore-'));
  const outboxPath = join(directory, 'outbox.sqlite');
  const webauthnPath = join(directory, 'webauthn.sqlite');
  const stateConfig = { ...config, outboxPath, webauthnPath };
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');

  assert.equal(
    await validateInactiveMailOutboxReconciliationState(stateConfig, {
      expectedOwnerUid: uid,
    }),
    'fresh',
  );
  await writeFile(outboxPath, Buffer.alloc(0), { mode: 0o600 });
  await assert.rejects(
    validateInactiveMailOutboxReconciliationState(stateConfig, {
      expectedOwnerUid: uid,
    }),
    /incomplete/,
  );

  await writeFile(webauthnPath, Buffer.alloc(0), { mode: 0o600 });
  await assert.rejects(
    validateInactiveMailOutboxReconciliationState(stateConfig, {
      expectedOwnerUid: uid,
    }),
  );
});

test('checks restored state permissions and integrity before inactive startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-integrity-'));
  const configPath = join(directory, 'config.json');
  const outboxPath = join(directory, 'outbox.sqlite');
  const webauthnPath = join(directory, 'webauthn.sqlite');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');
  await writeFile(configPath, JSON.stringify({
    ...config,
    outboxPath,
    webauthnPath,
  }), { mode: 0o600 });

  const initialized = await openInactiveMailOutboxReconciliation({
    configPath,
    outboxEncryptionKey: Buffer.alloc(32, 99),
    expectedConfigOwnerUid: uid,
    expectedStateOwnerUid: uid,
  });
  initialized.composition.close();
  assert.equal(
    await validateInactiveMailOutboxReconciliationState(
      { ...config, outboxPath, webauthnPath },
      { expectedOwnerUid: uid },
    ),
    'existing',
  );

  await chmod(webauthnPath, 0o640);
  await assert.rejects(
    openInactiveMailOutboxReconciliation({
      configPath,
      outboxEncryptionKey: Buffer.alloc(32, 99),
      expectedConfigOwnerUid: uid,
      expectedStateOwnerUid: uid,
    }),
    /group- or world-accessible/,
  );
  await chmod(webauthnPath, 0o600);
  await truncate(webauthnPath, 64);
  await assert.rejects(
    openInactiveMailOutboxReconciliation({
      configPath,
      outboxEncryptionKey: Buffer.alloc(32, 99),
      expectedConfigOwnerUid: uid,
      expectedStateOwnerUid: uid,
    }),
  );
  t.after(async () => {
    await chmod(webauthnPath, 0o600);
  });
});
