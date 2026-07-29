import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  registerMscMailProductionPlugin,
  type MscMailProductionPluginApi,
} from '../src/msc-mail-production-plugin.js';

const fixture = (registrationMode = 'full') => {
  let route:
    Parameters<MscMailProductionPluginApi['registerHttpRoute']>[0] | undefined;
  let tool:
    Parameters<MscMailProductionPluginApi['registerTool']>[0] | undefined;
  let service:
    Parameters<MscMailProductionPluginApi['registerService']>[0] | undefined;
  registerMscMailProductionPlugin({
    registrationMode,
    registerHttpRoute(value) {
      route = value;
    },
    registerTool(value, options) {
      assert.deepEqual(options, { optional: true });
      tool = value;
    },
    registerService(value) {
      service = value;
    },
  });
  return { route, tool, service };
};

test('registers one native gateway route, background service and proposal-only tool', () => {
  const { route, tool, service } = fixture();
  assert.equal(route?.path, '/msc-approval');
  assert.equal(route?.auth, 'plugin');
  assert.equal(route?.match, 'prefix');
  assert.equal(service?.id, 'msc-approved-mail');
  assert.equal(tool?.name, 'msc_mail_reply_propose');
  assert.match(tool!.description, /never sends mail/i);
});

test('registers only the proposal tool during tool discovery', () => {
  const { route, tool, service } = fixture('tool-discovery');
  assert.equal(route, undefined);
  assert.equal(service, undefined);
  assert.equal(tool?.name, 'msc_mail_reply_propose');
});

test('fails closed before service startup for HTTP and proposal execution', async () => {
  const { route, tool } = fixture();
  const request = {
    headers: {},
    method: 'GET',
    url: '/msc-approval',
    socket: Object.assign(new EventEmitter(), {
      remoteAddress: '172.20.0.1',
    }),
  } as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const response = {
    writeHead(value: number) {
      status = value;
    },
    end(value: string) {
      body = value;
    },
  } as unknown as ServerResponse;
  assert.equal(await route!.handler(request, response), true);
  assert.equal(status, 503);
  assert.equal(body, '{"error":"service_unavailable"}');
  await assert.rejects(
    tool!.execute('call-1', {
      account: 'msc-info',
      messageId: '1',
      bodyText: 'Entwurf',
      sources: ['msc/faq.md'],
      idempotencyKey: 'reply-test-1',
    }),
    /service is not running/,
  );
});
