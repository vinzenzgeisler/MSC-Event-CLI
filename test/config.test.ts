import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBearerToken, loadRuntimeConfig, parseBaseUrl } from '../src/config.js';

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
