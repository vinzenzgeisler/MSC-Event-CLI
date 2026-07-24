import assert from 'node:assert/strict';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadTrustedOperatorConfig,
  runPasskeyBootstrapOperator,
  type PasskeyBootstrapOperatorConfig,
} from '../src/passkey-bootstrap-operator.js';
import { InMemoryPasskeyBootstrapGrantStore } from '../src/passkey-bootstrap.js';

const config: PasskeyBootstrapOperatorConfig = {
  version: 1,
  stateDatabasePath: '/var/lib/openclaw/approved-actions.sqlite',
  allowedOperatorUids: [1000],
  allowedActors: ['vinzenz'],
  bootstrapTtlSeconds: 60,
};

test('issues once for an OS-authorized operator and writes no secret to audit', async () => {
  const grants = new InMemoryPasskeyBootstrapGrantStore();
  let output = '';
  let closed = false;
  await runPasskeyBootstrapOperator(
    ['--config', '/etc/openclaw/bootstrap.json', '--actor', 'vinzenz'],
    {
      currentUid: () => 1000,
      loadConfig: async () => config,
      createGrantStore: () => Object.assign(grants, {
        async listByActor() { return []; },
        close() { closed = true; },
      }),
      writeOutput(value) { output += value; },
    },
  );
  const result = JSON.parse(output) as {
    actor: string;
    code: string;
    expiresAt: string;
  };
  assert.equal(result.actor, 'vinzenz');
  assert.match(result.code, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(closed, true);
  const audit = grants.bootstrapAuditEvents();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.operatorId, 'uid:1000');
  assert.equal(JSON.stringify(audit).includes(result.code), false);
});

test('rejects a non-authorized OS user or reviewer before opening the store', async () => {
  let opened = false;
  const dependencies = {
    currentUid: () => 1001,
    loadConfig: async () => config,
    createGrantStore: () => {
      opened = true;
      return Object.assign(new InMemoryPasskeyBootstrapGrantStore(), {
        async listByActor() { return []; },
        close() {},
      });
    },
    writeOutput() {},
  };
  await assert.rejects(
    runPasskeyBootstrapOperator(
      ['--config', '/etc/openclaw/bootstrap.json', '--actor', 'vinzenz'],
      dependencies,
    ),
    /not authorized/,
  );
  assert.equal(opened, false);

  await assert.rejects(
    runPasskeyBootstrapOperator(
      ['--config', '/etc/openclaw/bootstrap.json', '--actor', 'mallory'],
      { ...dependencies, currentUid: () => 1000 },
    ),
    /not allowlisted/,
  );
  assert.equal(opened, false);
});

test('loads only an absolute, owner-matched, private regular config file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-operator-'));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('test requires a POSIX uid');
  assert.deepEqual(
    await loadTrustedOperatorConfig(path, { expectedOwnerUid: uid }),
    config,
  );

  await chmod(path, 0o640);
  assert.deepEqual(
    await loadTrustedOperatorConfig(path, { expectedOwnerUid: uid }),
    config,
  );
  await chmod(path, 0o660);
  await assert.rejects(
    loadTrustedOperatorConfig(path, { expectedOwnerUid: uid }),
    /group-writable or world-accessible/,
  );
  await chmod(path, 0o600);

  const link = join(directory, 'config-link.json');
  await symlink(path, link);
  await assert.rejects(
    loadTrustedOperatorConfig(link, { expectedOwnerUid: uid }),
  );
  await assert.rejects(
    loadTrustedOperatorConfig('relative.json', { expectedOwnerUid: uid }),
    /absolute/,
  );
});
