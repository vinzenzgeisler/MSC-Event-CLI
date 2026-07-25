import assert from 'node:assert/strict';
import test from 'node:test';
import { MscMailReadonlyProvider } from '../src/mail-readonly-provider.js';

const response = (operation: string): string => JSON.stringify({
  schema: 'msc.mail-provider.v1',
  provider: 'himalaya',
  operation,
  source: operation === 'accounts'
    ? null
    : { mailbox: 'MSC Info', account: 'msc-info' },
  data: operation === 'preview' ? { id: '7', subject: 'Frage' } : [],
});

test('uses only the fixed read-only provider argument contract', async () => {
  const calls: string[][] = [];
  const provider = new MscMailReadonlyProvider(async (args) => {
    calls.push([...args]);
    return { stdout: response(args[0]!) };
  });

  await provider.accounts();
  await provider.folders('msc-info');
  await provider.list('msc-info', 'INBOX');
  const preview = await provider.preview('msc-info', 'INBOX', '7');

  assert.deepEqual(calls, [
    ['accounts'],
    ['folders', '--account', 'msc-info'],
    ['list', '--account', 'msc-info', '--folder', 'INBOX'],
    [
      'preview',
      '--account',
      'msc-info',
      '--folder',
      'INBOX',
      '--message-id',
      '7',
    ],
  ]);
  assert.deepEqual(preview.data, { id: '7', subject: 'Frage' });
});

test('rejects command injection and mismatched provider responses', async () => {
  const provider = new MscMailReadonlyProvider(async () => ({
    stdout: response('list'),
  }));
  assert.throws(
    () => provider.preview('msc-info', 'INBOX', '7;send'),
    /invalid_string|regex/i,
  );
  assert.throws(
    () => provider.preview('msc-info', 'INBOX\nSent', '7'),
    /invalid folder/,
  );
  await assert.rejects(
    provider.preview('msc-info', 'INBOX', '7'),
    /mismatched operation/,
  );
});
