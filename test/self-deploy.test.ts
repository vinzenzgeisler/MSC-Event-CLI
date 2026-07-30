import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selfDeploy } from '../src/self-deploy.js';

describe('selfDeploy', () => {
  it('dry-run returns the correct docker compose command without executing', async () => {
    const result = await selfDeploy('openclaw', { dryRun: true });
    assert.equal(result.service, 'openclaw');
    assert.equal(result.dryRun, true);
    assert.match(result.command, /docker compose/);
    assert.match(result.command, /--project-name openclaw/);
    assert.match(result.command, /up --detach --no-deps openclaw/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('dry-run with custom project name includes the project name', async () => {
    const result = await selfDeploy('openclaw', {
      projectName: 'myproject',
      dryRun: true,
    });
    assert.match(result.command, /--project-name myproject/);
  });

  it('dry-run with compose file includes --file argument', async () => {
    const result = await selfDeploy('openclaw', {
      composeFile: '/opt/docker-compose.yml',
      dryRun: true,
    });
    assert.match(result.command, /--file \/opt\/docker-compose\.yml/);
  });

  it('fails with a clear error message when docker is not available', async () => {
    // We override PATH so docker isn't found; this tests the error path
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await assert.rejects(
        () => selfDeploy('openclaw', { dryRun: false }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /docker compose up failed/);
          return true;
        },
      );
    } finally {
      process.env.PATH = origPath;
    }
  });
});
