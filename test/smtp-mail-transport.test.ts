import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SmtpMailTransport,
  type SmtpClientFactory,
} from '../src/smtp-mail-transport.js';
import type { MailTransportEnvelope } from '../src/mail-outbox-transport.js';

const config = {
  account: 'msc-info' as const,
  host: 'smtp.example.org',
  port: 465 as const,
  secure: true,
  username: 'info@example.org',
  password: 'injected-test-secret',
  senderIdentity: 'info@example.org',
};
const envelope: MailTransportEnvelope = {
  actionId: 'action-1',
  payloadHash: 'a'.repeat(64),
  account: 'msc-info',
  from: 'info@example.org',
  to: 'recipient@example.net',
  subject: 'Antwort',
  bodyText: 'Guten Tag,\n\nvielen Dank.',
  messageId: '<msc-approved-test@mail.example.org>',
  inReplyToMessageId: '<source@example.net>',
};

test('pins TLS, account, envelope and safe plain-text message options', async () => {
  const factoryOptions: unknown[] = [];
  const messages: unknown[] = [];
  const factory: SmtpClientFactory = (options) => {
    factoryOptions.push(options);
    return {
      async sendMail(message) {
        messages.push(message);
        return {
          accepted: [envelope.to],
          rejected: [],
          pending: [],
          messageId: envelope.messageId,
        };
      },
    };
  };
  const transport = new SmtpMailTransport([config], factory);
  assert.deepEqual(await transport.deliver(envelope), { status: 'accepted' });
  assert.deepEqual(factoryOptions, [{
    host: config.host,
    port: 465,
    secure: true,
    requireTLS: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user: config.username, pass: config.password },
    tls: {
      rejectUnauthorized: true,
      servername: config.host,
      minVersion: 'TLSv1.2',
    },
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  }]);
  assert.deepEqual(messages, [{
    envelope: { from: envelope.from, to: [envelope.to] },
    from: envelope.from,
    to: envelope.to,
    subject: envelope.subject,
    text: envelope.bodyText,
    messageId: envelope.messageId,
    inReplyTo: envelope.inReplyToMessageId,
    disableFileAccess: true,
    disableUrlAccess: true,
  }]);
});

test('fails before submission for missing account or sender mismatch', async () => {
  let calls = 0;
  const transport = new SmtpMailTransport([config], () => ({
    async sendMail() {
      calls += 1;
      throw new Error('must not run');
    },
  }));
  assert.deepEqual(
    await transport.deliver({ ...envelope, account: 'msc-vorstand' }),
    { status: 'not-submitted', reasonCode: 'account-not-configured' },
  );
  assert.deepEqual(
    await transport.deliver({ ...envelope, from: 'other@example.org' }),
    { status: 'not-submitted', reasonCode: 'sender-policy-mismatch' },
  );
  assert.equal(calls, 0);
});

test('treats incomplete provider acceptance as ambiguous', async () => {
  const transport = new SmtpMailTransport([config], () => ({
    async sendMail() {
      return {
        accepted: [],
        rejected: [envelope.to],
        messageId: envelope.messageId,
      };
    },
  }));
  assert.deepEqual(await transport.deliver(envelope), {
    status: 'unknown',
    reasonCode: 'provider-acceptance-not-confirmed',
  });
});

test('rejects unsafe SMTP configuration before creating a client', () => {
  let factories = 0;
  assert.throws(
    () => new SmtpMailTransport(
      [{ ...config, port: 587, secure: true }],
      () => {
        factories += 1;
        throw new Error('must not run');
      },
    ),
    /port 465 requires|port 587 requires/,
  );
  assert.throws(
    () => new SmtpMailTransport([{
      ...config,
      username: 'other@example.org',
    }]),
    /must match/,
  );
  assert.equal(factories, 0);
});
