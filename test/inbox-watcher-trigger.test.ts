import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'deployment',
  'approved-mail',
  'inbox-watcher-trigger.js',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (
    trigger: unknown,
    tools: unknown,
    json: (value: unknown) => unknown,
  ) => Promise<unknown>;

const envelope = (
  account: string,
  own: string,
  entries: Array<{ id: string; from: string }>,
) => JSON.stringify({
  schema: 'msc.mail-provider.v1',
  provider: 'himalaya',
  operation: 'list',
  source: { account, sender_identity: own },
  data: entries.map((entry) => ({
    id: entry.id,
    from: { addr: entry.from },
  })),
});

const run = async (
  state: unknown,
  additions: Record<string, Array<{ id: string; from: string }>> = {},
) => {
  const script = await readFile(scriptPath, 'utf8');
  const calls: string[] = [];
  const result = await new AsyncFunction('trigger', 'tools', 'json', script)(
    { state },
    {
      async call(name: string, params: { command: string }) {
        assert.equal(name, 'exec');
        calls.push(params.command);
        const account = /--account ([a-z-]+)/.exec(params.command)?.[1];
        assert.ok(account);
        const own = `${account!.replace('msc-', '')}@msc.example`;
        return {
          output: envelope(account!, own, [
            { id: '10', from: 'external@example.org' },
            { id: '9', from: own },
            ...(additions[account!] ?? []),
          ]),
        };
      },
    },
    (value) => value,
  );
  return { result, calls };
};

test('baselines all mailboxes without firing on first activation', async () => {
  const { result, calls } = await run({
    version: 2,
    seen: { 'msc-nennung': ['1'] },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result, {
    state: {
      version: 3,
      seen: {
        'msc-nennung': ['10', '9'],
        'msc-info': ['10', '9'],
        'msc-vorstand': ['10', '9'],
      },
    },
  });
});

test('fires only for new externally-sent message references', async () => {
  const prior = {
    version: 3,
    seen: {
      'msc-nennung': ['10', '9'],
      'msc-info': ['10', '9'],
      'msc-vorstand': ['10', '9'],
    },
  };
  const { result } = await run(prior, {
    'msc-nennung': [
      { id: '12', from: 'new@example.org' },
      { id: '11', from: 'nennung@msc.example' },
    ],
  });
  assert.deepEqual(result, {
    state: {
      version: 3,
      seen: {
        'msc-nennung': ['10', '9', '12', '11'],
        'msc-info': ['10', '9'],
        'msc-vorstand': ['10', '9'],
      },
    },
    fire: {
      events: [{ account: 'msc-nennung', messageId: '12' }],
    },
  });
});
