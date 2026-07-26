import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { TrustedProxyApprovalSessionResolver } from '../src/trusted-proxy-approval-session.js';

const request = (
  remoteAddress: string,
  headers: Record<string, string | string[]> = {},
): IncomingMessage => ({
  headers,
  socket: Object.assign(new EventEmitter(), { remoteAddress }),
}) as unknown as IncomingMessage;

const fixture = () => new TrustedProxyApprovalSessionResolver({
  publicOrigin: 'https://openclaw.example',
  actor: 'vinzenz',
  csrfKey: Buffer.alloc(32, 91),
  trustedProxyAddresses: ['172.20.0.2', '::1'],
});

test('creates one stable server-side session only for the exact trusted proxy identity', () => {
  const resolver = fixture();
  const headers = {
    'x-msc-approval-actor': 'vinzenz',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'openclaw.example',
  };
  const first = resolver.resolve(request('::ffff:172.20.0.2', headers));
  const second = resolver.resolve(request('172.20.0.2', headers));
  assert.equal(first?.actor, 'vinzenz');
  assert.equal(first?.csrfToken, second?.csrfToken);
  assert.match(first!.csrfToken, /^[A-Za-z0-9_-]{43}$/);
});

test('rejects spoofed identity, origin, arrays and untrusted peers', () => {
  const resolver = fixture();
  const valid = {
    'x-msc-approval-actor': 'vinzenz',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'openclaw.example',
  };
  assert.equal(resolver.resolve(request('203.0.113.7', valid)), undefined);
  assert.equal(resolver.resolve(request('172.20.0.2', {
    ...valid,
    'x-msc-approval-actor': 'someone-else',
  })), undefined);
  assert.equal(resolver.resolve(request('172.20.0.2', {
    ...valid,
    'x-forwarded-proto': 'http',
  })), undefined);
  assert.equal(resolver.resolve(request('172.20.0.2', {
    ...valid,
    'x-forwarded-host': 'attacker.example',
  })), undefined);
  assert.equal(resolver.resolve(request('172.20.0.2', {
    ...valid,
    'x-msc-approval-actor': ['vinzenz'],
  })), undefined);
});

test('fails closed on unsafe configuration', () => {
  assert.throws(() => new TrustedProxyApprovalSessionResolver({
    publicOrigin: 'http://openclaw.example',
    actor: 'vinzenz',
    csrfKey: Buffer.alloc(32),
    trustedProxyAddresses: ['127.0.0.1'],
  }), /HTTPS/);
  assert.throws(() => new TrustedProxyApprovalSessionResolver({
    publicOrigin: 'https://openclaw.example',
    actor: 'vinzenz',
    csrfKey: Buffer.alloc(31),
    trustedProxyAddresses: ['127.0.0.1'],
  }), /32 bytes/);
  assert.throws(() => new TrustedProxyApprovalSessionResolver({
    publicOrigin: 'https://openclaw.example',
    actor: 'vinzenz',
    csrfKey: Buffer.alloc(32),
    trustedProxyAddresses: [],
  }), /trusted proxy/);
});
