import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInertApprovalHook,
  INERT_APPROVAL_TOOL_NAME,
  type ApprovalDecision,
} from '../src/approval-hook.js';
import { hashActionIntent } from '../src/approval.js';
import type { ActionIntent } from '../src/action.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'mail.send',
  summary: 'Send the reviewed test message',
  target: { type: 'mailbox', id: 'msc-test', label: 'MSC test mailbox' },
  before: null,
  after: { to: 'recipient@example.invalid', subject: 'Approval test' },
  expectedState: null,
  parameters: { dryRun: true },
};

test('ignores every tool except the dedicated inert preview seam', async () => {
  const hook = createInertApprovalHook();
  assert.equal(await hook({ toolName: 'mail_send', params: { intent } }), undefined);
});

test('binds the normalized exact intent hash and only offers one-time approval or deny', async () => {
  const hook = createInertApprovalHook();
  const result = await hook({
    toolName: INERT_APPROVAL_TOOL_NAME,
    params: { intent: { ...intent, target: { id: 'msc-test', type: 'mailbox', label: 'MSC test mailbox' } } },
  });

  const payloadHash = hashActionIntent(intent);
  assert.deepEqual(result?.params, { intent, payloadHash });
  assert.deepEqual(result?.requireApproval?.allowedDecisions, ['allow-once', 'deny']);
  assert.match(result?.requireApproval?.description ?? '', new RegExp(payloadHash));
  assert.match(result?.requireApproval?.description ?? '', /performs no mutation/);
});

test('blocks malformed or non-JSON intents before creating an approval', async () => {
  const hook = createInertApprovalHook();
  const result = await hook({
    toolName: INERT_APPROVAL_TOOL_NAME,
    params: { intent: { ...intent, after: { callback: () => undefined } } },
  });

  assert.equal(result?.block, true);
  assert.equal(result?.requireApproval, undefined);
});

test('keeps the exact hash visible even when prompt text reaches its size limit', async () => {
  const longIntent = { ...intent, summary: 'x'.repeat(500), target: { ...intent.target, label: 'y'.repeat(500) } };
  const hook = createInertApprovalHook();
  const result = await hook({ toolName: INERT_APPROVAL_TOOL_NAME, params: { intent: longIntent } });

  assert.equal(result?.requireApproval?.description.length, 512);
  assert.match(result?.requireApproval?.description ?? '', new RegExp(hashActionIntent(longIntent)));
});

test('reports the resolution with the hash-bound normalized intent', async () => {
  const resolutions: Array<{ decision: ApprovalDecision; payloadHash: string; intent: ActionIntent }> = [];
  const hook = createInertApprovalHook({
    onResolution(event) {
      resolutions.push(event);
    },
  });
  const result = await hook({ toolName: INERT_APPROVAL_TOOL_NAME, params: { intent } });
  await result?.requireApproval?.onResolution?.('allow-once');

  assert.deepEqual(resolutions, [{
    decision: 'allow-once',
    payloadHash: hashActionIntent(intent),
    intent,
  }]);
});

test('rejects approval timeouts beyond the OpenClaw contract limit', () => {
  assert.throws(() => createInertApprovalHook({ timeoutMs: 600_001 }), /timeoutMs/);
});
