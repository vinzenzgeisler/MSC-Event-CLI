import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBearerToken, loadCognitoClientConfig, loadRuntimeConfig, parseBaseUrl, parseCognitoBaseUrl } from '../src/config.js';

test('base URL requires HTTPS except localhost', () => {
  assert.equal(parseBaseUrl('https://api.example.org/').toString(), 'https://api.example.org/');
  assert.equal(parseBaseUrl('http://127.0.0.1:3000').port, '3000');
  assert.throws(() => parseBaseUrl('http://api.example.org'), /HTTPS/);
  assert.throws(() => parseBaseUrl('https://user:secret@api.example.org'), /credentials/);
});

test('runtime config validates timeout', () => {
  assert.equal(loadRuntimeConfig({ env: { MSC_EVENT_API_URL: 'https://api.example.org', MSC_EVENT_TIMEOUT_MS: '500' } }).timeoutMs, 500);
  assert.throws(() => loadRuntimeConfig({ env: { MSC_EVENT_API_URL: 'https://api.example.org', MSC_EVENT_TIMEOUT_MS: '1' } }), /between/);
});

test('Cognito client config is complete and HTTPS-only', () => {
  const config = loadCognitoClientConfig({
    MSC_EVENT_COGNITO_URL: 'https://auth.example.org',
    MSC_EVENT_COGNITO_CLIENT_ID: 'client-id',
    MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/client-secret'
  });
  assert.equal(config?.tokenUrl.toString(), 'https://auth.example.org/oauth2/token');
  assert.equal(config?.scope, 'msc-support/entries.read');
  assert.equal(parseCognitoBaseUrl('https://auth.example.org/').pathname, '/oauth2/token');
  assert.throws(() => parseCognitoBaseUrl('http://auth.example.org'), /HTTPS/);
  assert.throws(() => loadCognitoClientConfig({ MSC_EVENT_COGNITO_URL: 'https://auth.example.org' }), /together/);
});

test('token loads from environment without reading a file', async () => {
  let called = false;
  const token = await loadBearerToken({ MSC_EVENT_TOKEN: ' secret ' }, async () => {
    called = true;
    return 'unused';
  });
  assert.equal(token, 'secret');
  assert.equal(called, false);
});

test('token loads from a file and rejects multiple sources', async () => {
  const token = await loadBearerToken({ MSC_EVENT_TOKEN_FILE: '/run/secret' }, async (path) => {
    assert.equal(path, '/run/secret');
    return ' file-token\n';
  });
  assert.equal(token, 'file-token');
  await assert.rejects(() => loadBearerToken({ MSC_EVENT_TOKEN: 'a', MSC_EVENT_TOKEN_FILE: '/b' }), /only one/);
});
