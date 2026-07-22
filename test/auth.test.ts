import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAccessToken } from '../src/auth.js';
import { CliError, safeError } from '../src/errors.js';

const env = {
  MSC_EVENT_COGNITO_URL: 'https://auth.example.org',
  MSC_EVENT_COGNITO_CLIENT_ID: 'support-client',
  MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/support-client-secret'
};

test('client credentials are exchanged without exposing the secret in the body', async () => {
  const token = await loadAccessToken({
    env,
    read: async (path) => {
      assert.equal(path, '/run/secrets/support-client-secret');
      return 'client-secret\n';
    },
    fetchImpl: async (url, init) => {
      assert.equal(url.toString(), 'https://auth.example.org/oauth2/token');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>).authorization, `Basic ${Buffer.from('support-client:client-secret').toString('base64')}`);
      assert.equal(String(init?.body), 'grant_type=client_credentials&scope=msc-support%2Fentries.read');
      assert.equal(String(init?.body).includes('client-secret'), false);
      return new Response(JSON.stringify({ access_token: 'machine-token', token_type: 'Bearer', expires_in: 900 }), { status: 200 });
    }
  });
  assert.equal(token, 'machine-token');
});

test('bearer and Cognito auth sources cannot be mixed', async () => {
  await assert.rejects(() => loadAccessToken({ env: { ...env, MSC_EVENT_TOKEN: 'token' } }), /either/);
});

test('Cognito errors do not expose response bodies or client secrets', async () => {
  await assert.rejects(
    () => loadAccessToken({
      env,
      read: async () => 'client-secret',
      fetchImpl: async () => new Response('client-secret should not escape', { status: 401 })
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(JSON.stringify(safeError(error)).includes('client-secret'), false);
      return true;
    }
  );
});
