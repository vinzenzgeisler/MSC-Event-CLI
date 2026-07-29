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
  const tools: Array<
    Parameters<MscMailProductionPluginApi['registerTool']>[0]
  > = [];
  let hook:
    Parameters<MscMailProductionPluginApi['on']>[1] | undefined;
  let service:
    Parameters<MscMailProductionPluginApi['registerService']>[0] | undefined;
  registerMscMailProductionPlugin({
    registrationMode,
    registerHttpRoute(value) {
      route = value;
    },
    registerTool(value, options) {
      assert.equal(options.optional, true);
      tools.push(value);
    },
    on(name, value) {
      assert.equal(name, 'before_tool_call');
      hook = value;
    },
    registerService(value) {
      service = value;
    },
  });
  const proposal = tools.find(
    (tool) => typeof tool !== 'function',
  );
  const sendFactory = tools.find(
    (tool) => typeof tool === 'function',
  );
  return { route, proposal, sendFactory, hook, service };
};

test('registers one native gateway route, service and both approval tools', () => {
  const { route, proposal, sendFactory, hook, service } = fixture();
  assert.equal(route?.path, '/msc-approval');
  assert.equal(route?.auth, 'plugin');
  assert.equal(route?.match, 'prefix');
  assert.equal(service?.id, 'msc-approved-mail');
  assert.equal(proposal && typeof proposal !== 'function'
    ? proposal.name
    : undefined, 'msc_mail_reply_propose');
  assert.match(
    proposal && typeof proposal !== 'function' ? proposal.description : '',
    /never sends mail/i,
  );
  assert.equal(typeof sendFactory, 'function');
  assert.equal(sendFactory!({
    sessionKey: 'agent:main:telegram:direct:8261978945',
  })?.name, 'msc_mail_reply_send');
  assert.equal(typeof hook, 'function');
});

test('registers both tools during tool discovery without runtime surfaces', () => {
  const { route, proposal, sendFactory, service } = fixture('tool-discovery');
  assert.equal(route, undefined);
  assert.equal(service, undefined);
  assert.equal(proposal && typeof proposal !== 'function'
    ? proposal.name
    : undefined, 'msc_mail_reply_propose');
  assert.equal(typeof sendFactory, 'function');
});

test('fails closed before service startup for HTTP and proposal execution', async () => {
  const { route, proposal, sendFactory, hook } = fixture();
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
  assert.ok(proposal && typeof proposal !== 'function');
  await assert.rejects(
    proposal.execute('call-1', {
      account: 'msc-info',
      messageId: '1',
      bodyText: 'Entwurf',
      sources: ['msc/faq.md'],
      idempotencyKey: 'reply-test-1',
    }),
    /service is not running/,
  );
  const send = sendFactory!({
    sessionKey: 'agent:main:telegram:direct:8261978945',
  })!;
  await assert.rejects(
    send.execute('call-2', {
      actionId: '10000000-0000-4000-8000-000000000001',
      payloadReference: 'abcdef012345',
    }),
    /service is not running/,
  );
  assert.deepEqual(await hook!({
    toolName: 'msc_mail_reply_send',
    params: {
      actionId: '10000000-0000-4000-8000-000000000001',
      payloadReference: 'abcdef012345',
    },
    toolCallId: 'call-2',
  }, {
    sessionKey: 'agent:main:telegram:direct:8261978945',
  }), {
    block: true,
    blockReason: 'MSC approved mail service is not running',
  });
});
