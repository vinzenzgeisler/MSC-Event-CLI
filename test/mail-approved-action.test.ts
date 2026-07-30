import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailSendIntent,
  createMailReplyIntent,
  MailReplyDryRunAdapter,
  MailReplyPreviewRenderer,
  MailSendDryRunAdapter,
  MailSendPreviewRenderer,
  parseMailReplyIntent,
  parseMailSendIntent,
  type MscMailAccountPolicy,
} from '../src/mail-approved-action.js';

const policy: MscMailAccountPolicy = {
  version: 1,
  accounts: {
    'msc-nennung': {
      active: true,
      senderIdentity: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Nennung',
      allowedFolders: ['INBOX'],
    },
    'msc-info': {
      active: true,
      senderIdentity: 'info@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Info',
      allowedFolders: ['INBOX'],
    },
    'msc-vorstand': {
      active: true,
      senderIdentity: 'admin@msc-oberlausitzer-dreilaendereck.eu',
      displayName: 'MSC Vorstand',
      allowedFolders: ['INBOX'],
    },
  },
};

const draft = {
  account: 'msc-info' as const,
  to: 'recipient@example.invalid',
  subject: 'MSC-Test',
  bodyText: 'Guten Tag,\n\ndies ist eine geprüfte Testnachricht.\n',
  triageStatus: 'READY_TO_DRAFT' as const,
  sources: ['msc/faq.md'],
  uncertainties: [],
};

test('binds one confirmed account identity to recipient, content, sources and dry-run state', () => {
  const intent = createMailSendIntent(policy, draft);
  assert.equal(intent.after.account, 'msc-info');
  assert.equal(intent.after.from, 'info@msc-oberlausitzer-dreilaendereck.eu');
  assert.equal(intent.target.id, intent.after.account);
  assert.equal(intent.expectedState.senderIdentity, intent.after.from);
  assert.equal(intent.parameters.dryRun, true);

  const preview = new MailSendPreviewRenderer().render(intent);
  assert.equal(preview.risk, 'high');
  assert.ok(preview.changes.some((change) => change.field === 'Nachricht'));
});

test('rejects inactive or unconfirmed accounts and header injection', () => {
  assert.throws(
    () => createMailSendIntent({
      ...policy,
      accounts: {
        ...policy.accounts,
        'msc-info': { ...policy.accounts['msc-info'], active: false },
      },
    }, draft),
    /inactive/,
  );
  assert.throws(
    () => createMailSendIntent({
      ...policy,
      accounts: {
        ...policy.accounts,
        'msc-info': { ...policy.accounts['msc-info'], senderIdentity: 'TBD' },
      },
    }, draft),
    /no confirmed sender/,
  );
  assert.throws(
    () => createMailSendIntent(policy, {
      ...draft,
      subject: 'Hello\r\nBcc: attacker@example.invalid',
    }),
    /line breaks/,
  );
});

test('rejects hidden write capabilities and mismatched account identities', () => {
  const intent = createMailSendIntent(policy, draft);
  assert.throws(
    () => parseMailSendIntent({
      ...intent,
      after: { ...intent.after, bcc: 'attacker@example.invalid' },
    }),
    /unrecognized key/i,
  );
  assert.throws(
    () => parseMailSendIntent({
      ...intent,
      expectedState: {
        ...intent.expectedState,
        account: 'msc-nennung',
      },
    }),
    /must match/,
  );
});

test('dry-run adapter returns the exact would-send payload without accepting a transport', async () => {
  const intent = createMailSendIntent(policy, draft);
  const adapter = new MailSendDryRunAdapter(async (account) => ({
    policyVersion: 1,
    account,
    senderIdentity: policy.accounts[account].senderIdentity,
    allowedFolders: policy.accounts[account].allowedFolders,
  }));
  assert.deepEqual(await adapter.readCurrentState(intent), intent.expectedState);
  assert.deepEqual(
    await adapter.execute(intent, {
      actionId: 'action-1',
      payloadHash: 'hash',
      approvedBy: 'vinzenz',
      approvedAt: '2026-07-23T14:00:00.000Z',
    }),
    {
      result: {
        dryRun: true,
        wouldSend: intent.after,
      },
    },
  );
});

const replyDraft = {
  source: {
    account: 'msc-info' as const,
    folder: 'INBOX',
    messageId: '<source-123@example.invalid>',
    from: 'sender@example.invalid',
    subject: 'Frage zur Veranstaltung',
  },
  bodyText: 'Guten Tag,\n\nvielen Dank für Ihre Nachricht.\n',
  triageStatus: 'READY_TO_DRAFT' as const,
  sources: ['msc/faq.md'],
  uncertainties: ['Termin noch manuell prüfen'],
};

const signature = [
  'Mit freundlichen Grüßen',
  'Vinzenz Geisler',
  'i. A. MSC Oberlausitzer Dreiländereck e. V.',
  '📞 +49 152 52971212',
  '🌐 www.msc-oberlausitzer-dreilaendereck.eu',
].join('\n');

test('binds reply account, source message, sender, recipient and absent thread context', () => {
  const intent = createMailReplyIntent(policy, replyDraft);
  assert.equal(intent.after.account, intent.before.account);
  assert.equal(intent.after.from, 'info@msc-oberlausitzer-dreilaendereck.eu');
  assert.equal(intent.after.to, replyDraft.source.from);
  assert.equal(intent.after.sourceFolder, replyDraft.source.folder);
  assert.equal(intent.after.inReplyToMessageId, replyDraft.source.messageId);
  assert.equal(intent.after.subject, 'Re: Frage zur Veranstaltung');
  assert.equal(intent.parameters.conversationContext, 'not-available');

  const preview = new MailReplyPreviewRenderer().render(intent);
  assert.equal(preview.risk, 'high');
  assert.ok(preview.changes.some((change) => change.field === 'Quellnachricht'));
  assert.ok(preview.changes.some((change) => change.field === 'Antwort'));
});

test('preserves an existing reply prefix and rejects an unapproved source folder', () => {
  assert.equal(
    createMailReplyIntent(policy, {
      ...replyDraft,
      source: { ...replyDraft.source, subject: 'RE: Bestehende Antwort' },
    }).after.subject,
    'RE: Bestehende Antwort',
  );
  assert.throws(
    () => createMailReplyIntent(policy, {
      ...replyDraft,
      source: { ...replyDraft.source, folder: 'Sent' },
    }),
    /not allowed/,
  );
});

test('adds the verified signature and self-BCC only for MSC Nennung replies', () => {
  const configuredPolicy: MscMailAccountPolicy = {
    ...policy,
    accounts: {
      ...policy.accounts,
      'msc-nennung': {
        ...policy.accounts['msc-nennung'],
        replySignature: signature,
        replyBccToSelf: true,
      },
      'msc-info': {
        ...policy.accounts['msc-info'],
        replySignature: signature,
        replyBccToSelf: false,
      },
    },
  };
  const nennung = createMailReplyIntent(configuredPolicy, {
    ...replyDraft,
    source: {
      ...replyDraft.source,
      account: 'msc-nennung',
    },
  });
  assert.deepEqual(nennung.after.bcc, [
    'nennung@msc-oberlausitzer-dreilaendereck.eu',
  ]);
  assert.equal(
    nennung.after.bodyText,
    `${replyDraft.bodyText.trim()}\n\n${signature}`,
  );
  const preview = new MailReplyPreviewRenderer().render(nennung);
  assert.ok(preview.changes.some(
    (change) => change.field === 'BCC' &&
      change.after === 'nennung@msc-oberlausitzer-dreilaendereck.eu',
  ));

  const alreadySigned = createMailReplyIntent(configuredPolicy, {
    ...replyDraft,
    source: {
      ...replyDraft.source,
      account: 'msc-nennung',
    },
    bodyText: `${replyDraft.bodyText.trim()}\n\n${signature}`,
  });
  assert.equal(alreadySigned.after.bodyText, nennung.after.bodyText);

  const info = createMailReplyIntent(configuredPolicy, replyDraft);
  assert.equal(info.after.bcc, undefined);
  assert.equal(info.after.bodyText, `${replyDraft.bodyText.trim()}\n\n${signature}`);
});

test('rejects tampering with signature or configured BCC', () => {
  const configuredPolicy: MscMailAccountPolicy = {
    ...policy,
    accounts: {
      ...policy.accounts,
      'msc-nennung': {
        ...policy.accounts['msc-nennung'],
        replySignature: signature,
        replyBccToSelf: true,
      },
    },
  };
  const intent = createMailReplyIntent(configuredPolicy, {
    ...replyDraft,
    source: { ...replyDraft.source, account: 'msc-nennung' },
  });
  assert.throws(
    () => parseMailReplyIntent({
      ...intent,
      after: { ...intent.after, bcc: ['attacker@example.invalid'] },
    }),
    /BCC must match/,
  );
  assert.throws(
    () => parseMailReplyIntent({
      ...intent,
      after: { ...intent.after, bodyText: 'Geänderter Text ohne Signatur' },
    }),
    /signature/,
  );
});

test('rejects cross-account replies, header injection and hidden mail capabilities', () => {
  const intent = createMailReplyIntent(policy, replyDraft);
  assert.throws(
    () => parseMailReplyIntent({
      ...intent,
      after: { ...intent.after, account: 'msc-vorstand' },
    }),
    /must match/,
  );
  assert.throws(
    () => createMailReplyIntent(policy, {
      ...replyDraft,
      source: {
        ...replyDraft.source,
        from: 'sender@example.invalid\r\nBcc: attacker@example.invalid',
      },
    }),
    /plain email/,
  );
  assert.throws(
    () => parseMailReplyIntent({
      ...intent,
      after: { ...intent.after, attachments: ['secret.pdf'] },
    }),
    /unrecognized key/i,
  );
});

test('reply dry-run returns the exact bound payload without accepting a transport', async () => {
  const intent = createMailReplyIntent(policy, replyDraft);
  const adapter = new MailReplyDryRunAdapter(async (source) => ({
    policyVersion: 1,
    account: source.account,
    senderIdentity: policy.accounts[source.account].senderIdentity,
    allowedFolders: policy.accounts[source.account].allowedFolders,
    source,
  }));
  assert.deepEqual(await adapter.readCurrentState(intent), intent.expectedState);
  assert.deepEqual(
    await adapter.execute(intent, {
      actionId: 'action-reply-1',
      payloadHash: 'hash',
      approvedBy: 'vinzenz',
      approvedAt: '2026-07-23T15:00:00.000Z',
    }),
    {
      result: {
        dryRun: true,
        wouldReply: intent.after,
      },
    },
  );
});
