import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEventEntryChangeIntent,
  EventEntryChangeAdapter,
  EventEntryChangePreviewRenderer,
  parseEventEntryChangeIntent,
} from '../src/event-approved-action.js';

const entryId = '10000000-0000-4000-8000-000000000001';
const snapshot = {
  acceptanceStatus: 'pending',
  classId: '30000000-0000-4000-8000-000000000003',
};

test('binds one typed Nennung change to its exact current snapshot', () => {
  const intent = createEventEntryChangeIntent({
    entryId,
    label: 'Max Musterfahrer / Classic',
    currentSnapshot: snapshot,
    operation: {
      type: 'acceptance-status',
      acceptanceStatus: 'accepted',
      sendLifecycleMail: false,
    },
  });
  assert.deepEqual(intent.before, intent.expectedState);
  assert.equal(intent.target.id, entryId);
  assert.equal(intent.parameters.executionMode, 'approved-change');
  const preview = new EventEntryChangePreviewRenderer().render(intent);
  assert.equal(preview.title, 'Nennung ändern');
  assert.equal(preview.risk, 'high');
  assert.ok(preview.changes.some(
    (change) => change.field === 'acceptanceStatus' &&
      change.after === 'accepted',
  ));
});

test('rejects hidden fields, target substitution and lifecycle mail side effects', () => {
  const intent = createEventEntryChangeIntent({
    entryId,
    currentSnapshot: snapshot,
    operation: {
      type: 'notes',
      driverNote: 'Bitte Unterlagen mitbringen.',
    },
  });
  assert.throws(
    () => parseEventEntryChangeIntent({
      ...intent,
      after: { ...intent.after, entryId: crypto.randomUUID() },
    }),
    /must match/,
  );
  assert.throws(
    () => createEventEntryChangeIntent({
      entryId,
      currentSnapshot: snapshot,
      operation: {
        type: 'acceptance-status',
        acceptanceStatus: 'accepted',
        sendLifecycleMail: true as false,
      },
    }),
    /invalid_literal|literal/i,
  );
  assert.throws(
    () => parseEventEntryChangeIntent({
      ...intent,
      after: {
        ...intent.after,
        operation: {
          ...(intent.after.operation as Record<string, unknown>),
          deleteEntry: true,
        },
      },
    }),
    /unrecognized key/i,
  );
});

test('reads current state before applying the approved typed mutation', async () => {
  const intent = createEventEntryChangeIntent({
    entryId,
    currentSnapshot: snapshot,
    operation: {
      type: 'payment-amounts',
      paidAmountCents: 5_000,
      note: 'Überweisung geprüft',
    },
  });
  const applied: unknown[] = [];
  const adapter = new EventEntryChangeAdapter(
    async () => snapshot,
    {
      async apply(id, operation, context) {
        applied.push({ id, operation, context });
        return { result: { ok: true } };
      },
    },
  );
  assert.deepEqual(await adapter.readCurrentState(intent), {
    entryId,
    snapshot,
  });
  const context = {
    actionId: 'action-1',
    payloadHash: 'a'.repeat(64),
    approvedBy: 'vinzenz',
    approvedAt: '2026-07-25T22:50:00.000Z',
  };
  assert.deepEqual(await adapter.execute(intent, context), {
    result: { ok: true },
  });
  assert.deepEqual(applied, [{
    id: entryId,
    operation: intent.after.operation,
    context,
  }]);
});
