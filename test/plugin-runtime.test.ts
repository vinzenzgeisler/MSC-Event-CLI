import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionIntent } from '../src/action.js';
import {
  registerApprovedActionPreviewPlugin,
  type ApprovedActionPreviewPluginApi,
} from '../src/plugin-runtime.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'mail.send',
  summary: 'Preview a reviewed test message',
  target: { type: 'mailbox', id: 'msc-test', label: 'MSC test mailbox' },
  before: null,
  after: { to: 'recipient@example.invalid', subject: 'Approval test' },
  expectedState: null,
  parameters: { dryRun: true },
};

const fixture = () => {
  let tool: Parameters<ApprovedActionPreviewPluginApi['registerTool']>[0] | undefined;
  let optional: { optional: true } | undefined;
  let hook: Parameters<ApprovedActionPreviewPluginApi['on']>[1] | undefined;
  registerApprovedActionPreviewPlugin({
    registerTool(value, options) {
      tool = value;
      optional = options;
    },
    on(name, handler) {
      assert.equal(name, 'before_tool_call');
      hook = handler;
    },
  });
  if (!tool || !hook) throw new Error('plugin registration incomplete');
  return { tool, optional, hook };
};

test('registers only the optional inert preview tool and its approval hook', () => {
  const { tool, optional } = fixture();
  assert.equal(tool.name, 'approved_action_preview');
  assert.deepEqual(optional, { optional: true });
  assert.match(tool.description, /never sends, updates, deletes, or executes/i);
});

test('executes only the exact hash-bound normalized preview after one-time approval', async () => {
  const { tool, hook } = fixture();
  const policy = await hook({ toolName: tool.name, params: { intent } });
  assert.deepEqual(policy?.requireApproval?.allowedDecisions, ['allow-once', 'deny']);
  assert.ok(policy?.params);

  const result = await tool.execute('call-1', policy.params);
  assert.equal(result.details.inert, true);
  assert.deepEqual(result.details.intent, intent);
  assert.equal(result.details.payloadHash, policy.params.payloadHash);
});

test('fails closed when execution bypasses or tampers with the approval-bound hash', async () => {
  const { tool } = fixture();
  await assert.rejects(tool.execute('call-1', { intent }), /hash is missing/);
  await assert.rejects(tool.execute('call-2', { intent, payloadHash: 'forged' }), /does not match/);
});
