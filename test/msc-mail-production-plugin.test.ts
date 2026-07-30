import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  createMailApprovalDescription,
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
    (tool) => tool.name === 'msc_mail_reply_propose',
  );
  const watch = tools.find(
    (tool) => tool.name === 'msc_mail_watch_list',
  );
  const send = tools.find(
    (tool) => tool.name === 'msc_mail_reply_send',
  );
  const eventProposal = tools.find(
    (tool) => tool.name === 'msc_event_entry_change_propose',
  );
  const eventExecute = tools.find(
    (tool) => tool.name === 'msc_event_entry_change_execute',
  );
  return {
    route,
    watch,
    proposal,
    send,
    eventProposal,
    eventExecute,
    hook,
    service,
  };
};

test('registers one native gateway route, service and five MSC tools', () => {
  const {
    route,
    watch,
    proposal,
    send,
    eventProposal,
    eventExecute,
    hook,
    service,
  } = fixture();
  assert.equal(route?.path, '/msc-approval');
  assert.equal(route?.auth, 'plugin');
  assert.equal(route?.match, 'prefix');
  assert.equal(service?.id, 'msc-approved-mail');
  assert.equal(watch?.name, 'msc_mail_watch_list');
  assert.match(watch?.description ?? '', /read-only/i);
  assert.equal(proposal?.name, 'msc_mail_reply_propose');
  assert.match(
    proposal?.description ?? '',
    /never sends mail/i,
  );
  assert.equal(send?.name, 'msc_mail_reply_send');
  assert.equal(eventProposal?.name, 'msc_event_entry_change_propose');
  assert.match(eventProposal?.description ?? '', /never mutates/i);
  assert.equal(eventExecute?.name, 'msc_event_entry_change_execute');
  assert.equal(typeof hook, 'function');
});

test('registers all tools during tool discovery without runtime surfaces', () => {
  const {
    route,
    watch,
    proposal,
    send,
    eventProposal,
    eventExecute,
    service,
  } = fixture('tool-discovery');
  assert.equal(route, undefined);
  assert.equal(service, undefined);
  assert.equal(watch?.name, 'msc_mail_watch_list');
  assert.equal(proposal?.name, 'msc_mail_reply_propose');
  assert.equal(send?.name, 'msc_mail_reply_send');
  assert.equal(eventProposal?.name, 'msc_event_entry_change_propose');
  assert.equal(eventExecute?.name, 'msc_event_entry_change_execute');
});

test('renders a clear approval with BCC, exact body and signature', () => {
  const description = createMailApprovalDescription({
    title: 'Auf MSC-E-Mail antworten',
    summary: 'Reply',
    target: 'MSC Nennung → driver@example.org',
    risk: 'high',
    changes: [
      { field: 'Quellkonto', before: 'msc-nennung', after: 'msc-nennung' },
      { field: 'Quellnachricht', before: '1173', after: '1173' },
      { field: 'Von', before: null, after: 'nennung@msc.example' },
      { field: 'An', before: 'driver@example.org', after: 'driver@example.org' },
      { field: 'BCC', before: null, after: 'nennung@msc.example' },
      { field: 'Betreff', before: 'Frage', after: 'Re: Frage' },
      {
        field: 'Antwort',
        before: null,
        after: [
          'Guten Tag,',
          '',
          'vielen Dank für Ihre Nachricht.',
          '',
          'Mit freundlichen Grüßen',
          'Vinzenz Geisler',
        ].join('\n'),
      },
    ],
  }, 'abcdef012345');

  assert.match(description, /^Diese Antwort genau einmal senden/);
  assert.match(description, /BCC: nennung@msc\.example/);
  assert.match(description, /Antworttext inkl\. Signatur/);
  assert.match(description, /Mit freundlichen Grüßen\nVinzenz Geisler/);
  assert.match(description, /SMTP-Preflight: erfolgreich/);
  assert.match(description, /niemals automatisch wiederholt/);
});

test('fails closed before service startup for HTTP and proposal execution', async () => {
  const { route, proposal, send, eventProposal, eventExecute, hook } = fixture();
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
  assert.ok(proposal);
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
  await assert.rejects(
    eventProposal!.execute('call-3', {
      entryId: '10000000-0000-4000-8000-000000000001',
      operation: {
        type: 'checkin-id-verification',
        checkinIdVerified: true,
      },
      idempotencyKey: 'entry-test-1',
    }),
    /service is not running/,
  );
  await assert.rejects(
    eventExecute!.execute('call-4', {
      actionId: '10000000-0000-4000-8000-000000000001',
      payloadReference: 'abcdef012345',
    }),
    /service is not running/,
  );
  await assert.rejects(
    send!.execute('call-2', {
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
