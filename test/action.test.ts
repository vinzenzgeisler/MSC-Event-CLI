import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  actionIntentSchema,
  parseActionIntent,
  renderActionPreview,
  type ActionIntent,
  type ExecutorAdapter,
  type PreviewRenderer,
} from '../src/action.js';

const intent: ActionIntent = {
  version: 1,
  kind: 'mail.send',
  summary: 'Testnachricht an den Vorstand senden',
  target: { type: 'mailbox', id: 'msc-vorstand', label: 'Vorstand' },
  before: null,
  after: { to: ['test@example.invalid'], subject: 'Test' },
  expectedState: { draftVersion: 3 },
  parameters: { account: 'msc-info' },
};

test('validates a workflow-independent, JSON-only action intent', () => {
  assert.deepEqual(parseActionIntent(intent), intent);
  assert.throws(
    () => parseActionIntent({ ...intent, kind: 'send', unexpected: true }),
    /Invalid/,
  );
  assert.throws(
    () => parseActionIntent({ ...intent, after: { callback: () => undefined } }),
    /Invalid/,
  );
});

test('validates renderer output before it reaches an approval UI', () => {
  const renderer: PreviewRenderer = {
    kind: 'mail.send',
    render: () => ({
      title: 'Mail senden',
      summary: intent.summary,
      target: 'msc-vorstand → test@example.invalid',
      risk: 'medium',
      changes: [{ field: 'subject', before: null, after: 'Test' }],
    }),
  };
  assert.equal(renderActionPreview(renderer, intent).risk, 'medium');
  assert.throws(
    () => renderActionPreview({ ...renderer, render: () => ({ ...renderer.render(intent), risk: 'critical' as never }) }, intent),
    /Invalid/,
  );
});

test('defines a kind-specific executor contract without invoking a transport', () => {
  const mailIntentSchema = actionIntentSchema.refine(
    (candidate): candidate is ActionIntent & { kind: 'mail.send' } => candidate.kind === 'mail.send',
  );
  const adapter: ExecutorAdapter<ActionIntent & { kind: 'mail.send' }> = {
    kind: 'mail.send',
    intentSchema: mailIntentSchema,
    async readCurrentState() { return { draftVersion: 3 }; },
    async execute() { return { result: { dryRun: true } }; },
  };
  assert.equal(adapter.kind, 'mail.send');
  assert.equal(adapter.intentSchema.parse(intent).kind, 'mail.send');
});
