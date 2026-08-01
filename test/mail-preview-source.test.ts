import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMailPreviewSource } from '../src/mail-preview-source.js';

test('parses the bounded RFC preview returned by the read-only wrapper', () => {
  const source = parseMailPreviewSource([
    'Message-ID: <source@example.org>',
    'Received: first hop',
    'Received: second hop',
    'From: Vinzenz Beispiel',
    ' <driver@example.org>',
    'To: nennung@msc-oberlausitzer-dreilaendereck.eu',
    'Subject: Rückfrage zur Nennung',
    '',
    'From: attacker@example.org',
    'Subject: forged body header',
  ].join('\r\n'), '1173');

  assert.deepEqual(source, {
    id: '1173',
    from: 'driver@example.org',
    subject: 'Rückfrage zur Nennung',
  });
});

test('prefers one validated Reply-To header', () => {
  assert.deepEqual(parseMailPreviewSource([
    'From: Website <info@msc-oberlausitzer-dreilaendereck.eu>',
    'Reply-To: Patrick Krause <patkra147@gmail.com>',
    'Subject: Kontakt',
    '',
    'Untrusted body.',
  ].join('\r\n'), '6883'), {
    id: '6883',
    from: 'patkra147@gmail.com',
    subject: 'Kontakt',
  });
});

test('uses the strict MSC contact-form email only for the trusted own sender', () => {
  const preview = [
    'From: MSC Oberlausitzer Dreiländereck <info@msc-oberlausitzer-dreilaendereck.eu>',
    'To: info@msc-oberlausitzer-dreilaendereck.eu',
    'Subject: Neue Nachricht: Nennung Oberlausitzer Dreieck',
    '',
    'Name: Patrick Krause',
    'E-Mail: patkra147@gmail.com',
    'Nachricht:',
    'Darf ich teilnehmen?',
  ].join('\r\n');

  assert.equal(parseMailPreviewSource(preview, '6883', {
    trustedSenderIdentity: 'info@msc-oberlausitzer-dreilaendereck.eu',
  }).from, 'patkra147@gmail.com');
  assert.equal(parseMailPreviewSource(preview, '6883', {
    trustedSenderIdentity: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
  }).from, 'info@msc-oberlausitzer-dreilaendereck.eu');
});

test('rejects ambiguous MSC contact-form reply addresses', () => {
  assert.throws(() => parseMailPreviewSource([
    'From: info@msc-oberlausitzer-dreilaendereck.eu',
    'Subject: Neue Nachricht: Nennung Oberlausitzer Dreieck',
    '',
    'E-Mail: first@example.org',
    'E-Mail: second@example.org',
  ].join('\n'), '6883', {
    trustedSenderIdentity: 'info@msc-oberlausitzer-dreilaendereck.eu',
  }), /exactly one reply email/);
});

test('accepts the legacy structured provider source and binds its id', () => {
  assert.deepEqual(parseMailPreviewSource({
    id: 44,
    from: { addr: 'driver@example.org' },
    subject: 'Rückfrage',
    text: 'untrusted body',
  }, '44'), {
    id: '44',
    from: 'driver@example.org',
    subject: 'Rückfrage',
  });
  assert.throws(
    () => parseMailPreviewSource({
      id: 45,
      from: 'driver@example.org',
      subject: 'Rückfrage',
    }, '44'),
    /mismatched source message/,
  );
});

test('rejects ambiguous or incomplete source headers', () => {
  assert.throws(
    () => parseMailPreviewSource([
      'From: first@example.org',
      'From: second@example.org',
      'Subject: Rückfrage',
      '',
    ].join('\n'), '1'),
    /duplicate from/i,
  );
  assert.throws(
    () => parseMailPreviewSource('From: driver@example.org\n\nText', '1'),
    /missing From or Subject/,
  );
});
