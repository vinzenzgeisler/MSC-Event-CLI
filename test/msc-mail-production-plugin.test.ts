import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  createMailApprovalDescription,
  eventAutomationTokenEnv,
  eventMutationAuthConfiguration,
  OneTimeToolApprovalStore,
  registerMscMailProductionPlugin,
  type MscMailProductionPluginApi,
} from '../src/msc-mail-production-plugin.js';
import { parseOperatorSessionKeys } from '../src/msc-mail-production-config.js';

test('operator session configuration accepts only Telegram and WebChat direct keys', () => {
  const telegram = 'agent:main:telegram:direct:8261978945';
  const webchat =
    'agent:main:dashboard:a08cd2c0-a3db-4175-8069-2e6c1aee7842';
  assert.deepEqual(parseOperatorSessionKeys([telegram, webchat]), [
    telegram,
    webchat,
  ]);
  for (const rejected of [
    [telegram, 'agent:main:telegram:group:8261978945'],
    [telegram, 'agent:main:dashboard:not-a-uuid'],
    [webchat, telegram],
    [telegram],
    [telegram, webchat, 'agent:main:dashboard:extra'],
  ]) {
    assert.throws(() => parseOperatorSessionKeys(rejected));
  }
});

test('one-time tool approval binds nonce, action, payload, call and expiry', () => {
  let now = 1_000;
  const store = new OneTimeToolApprovalStore(() => now);
  const binding = {
    actionId: '10000000-0000-4000-8000-000000000001',
    payloadReference: 'abcdef012345',
    sessionKey: 'agent:main:dashboard:a08cd2c0-a3db-4175-8069-2e6c1aee7842',
    toolCallId: 'call-1',
  };
  store.authorize('nonce-1', binding, 1_000);
  assert.equal(store.consume('nonce-1', {
    actionId: binding.actionId,
    payloadReference: '000000000000',
    toolCallId: binding.toolCallId,
  }), undefined);
  assert.equal(store.consume('nonce-1', {
    actionId: binding.actionId,
    payloadReference: binding.payloadReference,
    toolCallId: binding.toolCallId,
  }), undefined, 'a payload mismatch burns the nonce');

  store.authorize('nonce-2', binding, 1_000);
  assert.deepEqual(store.consume('nonce-2', {
    actionId: binding.actionId,
    payloadReference: binding.payloadReference,
    toolCallId: binding.toolCallId,
  }), binding);
  assert.equal(store.consume('nonce-2', {
    actionId: binding.actionId,
    payloadReference: binding.payloadReference,
    toolCallId: binding.toolCallId,
  }), undefined, 'an authorization cannot be replayed');

  store.authorize('nonce-3', binding, 1_000);
  now = 2_000;
  assert.equal(store.consume('nonce-3', {
    actionId: binding.actionId,
    payloadReference: binding.payloadReference,
    toolCallId: binding.toolCallId,
  }), undefined, 'expired authorization is rejected');
});

test('uses only dedicated event automation credentials for mutations', () => {
  assert.equal(eventAutomationTokenEnv({}), undefined);
  assert.throws(
    () => eventAutomationTokenEnv({
      MSC_EVENT_AUTOMATION_COGNITO_CLIENT_ID: 'partial',
    }),
    /together/,
  );
  assert.deepEqual(eventAutomationTokenEnv({
    MSC_EVENT_AUTOMATION_COGNITO_URL: 'https://auth.example.test',
    MSC_EVENT_AUTOMATION_COGNITO_CLIENT_ID: 'automation-client',
    MSC_EVENT_AUTOMATION_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/automation',
    MSC_EVENT_COGNITO_CLIENT_ID: 'support-client',
    MSC_EVENT_TOKEN: 'must-not-leak',
  }), {
    MSC_EVENT_COGNITO_URL: 'https://auth.example.test',
    MSC_EVENT_COGNITO_CLIENT_ID: 'automation-client',
    MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/automation',
  });
});

test('can explicitly reuse only the support client credentials for mutations', () => {
  assert.deepEqual(eventMutationAuthConfiguration({
    MSC_EVENT_MUTATION_AUTH_MODE: 'support',
    MSC_EVENT_COGNITO_URL: 'https://auth.example.test',
    MSC_EVENT_COGNITO_CLIENT_ID: 'support-client',
    MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/support',
    MSC_EVENT_TOKEN: 'must-not-leak',
    MSC_EVENT_AUTOMATION_COGNITO_CLIENT_ID: 'must-not-leak',
  }), {
    tokenEnv: {
      MSC_EVENT_COGNITO_URL: 'https://auth.example.test',
      MSC_EVENT_COGNITO_CLIENT_ID: 'support-client',
      MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: '/run/secrets/support',
    },
    scopePrefix: 'msc-support/',
  });
  assert.throws(
    () => eventMutationAuthConfiguration({
      MSC_EVENT_MUTATION_AUTH_MODE: 'support',
      MSC_EVENT_COGNITO_CLIENT_ID: 'partial',
    }),
    /requires.*together/,
  );
  assert.throws(
    () => eventMutationAuthConfiguration({
      MSC_EVENT_MUTATION_AUTH_MODE: 'unknown',
    }),
    /must be unset or set to support/,
  );
});

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
  const eventEntries = tools.find(
    (tool) => tool.name === 'msc_event_entries_list',
  );
  const eventClasses = tools.find(
    (tool) => tool.name === 'msc_event_classes_list',
  );
  return {
    route,
    watch,
    proposal,
    send,
    eventProposal,
    eventExecute,
    eventEntries,
    eventClasses,
    hook,
    service,
  };
};

test('registers one native gateway route, service and seven MSC tools', () => {
  const {
    route,
    watch,
    proposal,
    send,
    eventProposal,
    eventExecute,
    eventEntries,
    eventClasses,
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
  assert.equal(eventEntries?.name, 'msc_event_entries_list');
  assert.match(eventEntries?.description ?? '', /read-only/i);
  assert.equal(eventClasses?.name, 'msc_event_classes_list');
  assert.match(eventClasses?.description ?? '', /read-only/i);
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
    eventEntries,
    eventClasses,
    service,
  } = fixture('tool-discovery');
  assert.equal(route, undefined);
  assert.equal(service, undefined);
  assert.equal(watch?.name, 'msc_mail_watch_list');
  assert.equal(proposal?.name, 'msc_mail_reply_propose');
  assert.equal(send?.name, 'msc_mail_reply_send');
  assert.equal(eventProposal?.name, 'msc_event_entry_change_propose');
  assert.equal(eventExecute?.name, 'msc_event_entry_change_execute');
  assert.equal(eventEntries?.name, 'msc_event_entries_list');
  assert.equal(eventClasses?.name, 'msc_event_classes_list');
});

test('renders a compact approval with only relevant mail information', () => {
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

  assert.match(description, /^Antwort freigeben/);
  assert.match(description, /Absender: nennung@msc\.example/);
  assert.match(description, /Empfänger: driver@example\.org/);
  assert.match(description, /BCC: nennung@msc\.example/);
  assert.match(description, /Betreff: Re: Frage/);
  assert.match(description, /--- DAS KOMMT IN DIE MAIL ---\nGuten Tag,/);
  assert.match(description, /Mit freundlichen Grüßen\nVinzenz Geisler/);
  assert.match(description, /--- ENDE MAIL ---/);
  assert.match(description, /Begründung: Passende Antwort auf die eingegangene Anfrage\./);
  assert.doesNotMatch(description, /Quellkonto|Quellnachricht|Prüfreferenz/);
  assert.doesNotMatch(description, /SMTP|allow-once|abcdef012345|1173/);
  assert.ok(description.length <= 511);
});

test('keeps long approval descriptions within the Telegram limit', () => {
  const description = createMailApprovalDescription({
    title: 'Auf MSC-E-Mail antworten',
    summary: 'Reply',
    target: 'driver@example.org',
    risk: 'high',
    changes: [
      { field: 'Von', before: null, after: `${'sender'.repeat(20)}@example.org` },
      { field: 'An', before: null, after: `${'recipient'.repeat(20)}@example.org` },
      { field: 'BCC', before: null, after: `${'archive'.repeat(20)}@example.org` },
      { field: 'Betreff', before: null, after: 'Langer Betreff '.repeat(20) },
      { field: 'Antwort', before: null, after: 'Langer Inhalt '.repeat(200) },
    ],
  }, 'must-not-appear');

  assert.equal(description.length, 511);
  assert.match(description, /--- DAS KOMMT IN DIE MAIL ---\n.*…\n--- ENDE MAIL ---\n\nBegründung:/s);
  assert.doesNotMatch(description, /must-not-appear/);
});

test('fails closed before service startup for HTTP and tool execution', async () => {
  const {
    route,
    proposal,
    send,
    eventProposal,
    eventExecute,
    eventEntries,
    eventClasses,
    hook,
  } = fixture();
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
    eventEntries!.execute('call-read-1', {
      eventId: '20000000-0000-4000-8000-000000000002',
      acceptanceStatus: 'shortlist',
      limit: 25,
    }),
    /read-only service is not running/,
  );
  await assert.rejects(
    eventClasses!.execute('call-read-2', {
      eventId: '20000000-0000-4000-8000-000000000002',
    }),
    /read-only service is not running/,
  );
  await assert.rejects(
    eventEntries!.execute('call-read-3', {
      eventId: '20000000-0000-4000-8000-000000000002',
      path: '/admin/entries',
    }),
    /unrecognized key/i,
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
