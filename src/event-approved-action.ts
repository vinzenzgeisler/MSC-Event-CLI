import { z } from 'zod';
import {
  actionPreviewSchema,
  jsonValueSchema,
  parseActionIntent,
  type ActionIntent,
  type ActionPreview,
  type ExecutionContext,
  type ExecutionResult,
  type ExecutorAdapter,
  type JsonValue,
  type PreviewRenderer,
} from './action.js';

const entryIdSchema = z.string().uuid();
export const eventEntryOperationSchema = z.union([
  z.object({
    type: z.literal('acceptance-status'),
    acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']),
    sendLifecycleMail: z.literal(false),
  }).strict(),
  z.object({
    type: z.literal('payment-amounts'),
    totalCents: z.number().int().min(0).optional(),
    paidAmountCents: z.number().int().min(0).optional(),
    note: z.string().trim().max(2_000).optional(),
  }).strict().refine(
    (value) => value.totalCents !== undefined ||
      value.paidAmountCents !== undefined,
    'totalCents or paidAmountCents is required',
  ),
  z.object({
    type: z.literal('payment-status'),
    paymentStatus: z.literal('paid'),
    paidAt: z.string().datetime().optional(),
    note: z.string().trim().max(1_000).optional(),
  }).strict(),
  z.object({
    type: z.literal('technical-status'),
    techStatus: z.enum(['pending', 'passed', 'failed']),
  }).strict(),
  z.object({
    type: z.literal('checkin-id-verification'),
    checkinIdVerified: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('notes'),
    internalNote: z.string().max(2_000).nullable().optional(),
    driverNote: z.string().max(2_000).nullable().optional(),
    inspectionNote: z.string().max(2_000).nullable().optional(),
  }).strict().refine(
    (value) => value.internalNote !== undefined ||
      value.driverNote !== undefined ||
      value.inspectionNote !== undefined,
    'at least one note is required',
  ),
  z.object({
    type: z.literal('class'),
    classId: z.string().uuid(),
    applyToBackupVehicle: z.boolean(),
    allowVehicleTypeChange: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('soft-delete'),
  }).strict(),
  z.object({
    type: z.literal('restore'),
  }).strict(),
]);

export type EventEntryOperation =
  z.infer<typeof eventEntryOperationSchema> & JsonValue;

const stateSchema = z.object({
  entryId: entryIdSchema,
  snapshot: jsonValueSchema,
}).strict();
const afterSchema = z.object({
  entryId: entryIdSchema,
  operation: eventEntryOperationSchema,
}).strict();
const parametersSchema = z.object({
  executionMode: z.literal('approved-change'),
}).strict();

export type EventEntryChangeIntent = Omit<
  ActionIntent,
  'kind' | 'target' | 'before' | 'after' | 'expectedState' | 'parameters'
> & {
  kind: 'event.entry.update';
  target: { type: 'event-entry'; id: string; label?: string };
  before: z.infer<typeof stateSchema>;
  after: { entryId: string; operation: EventEntryOperation };
  expectedState: z.infer<typeof stateSchema>;
  parameters: z.infer<typeof parametersSchema>;
};

export interface EventEntryChangeDraft {
  entryId: string;
  label?: string;
  currentSnapshot: JsonValue;
  operation: EventEntryOperation;
}

export const parseEventEntryChangeIntent = (
  value: unknown,
): EventEntryChangeIntent => {
  const intent = parseActionIntent(value);
  if (intent.kind !== 'event.entry.update') {
    throw new Error('expected event.entry.update intent');
  }
  const target = z.object({
    type: z.literal('event-entry'),
    id: entryIdSchema,
    label: z.string().trim().min(1).max(500).optional(),
  }).strict().parse(intent.target);
  const before = stateSchema.parse(intent.before);
  const after = afterSchema.parse(intent.after) as {
    entryId: string;
    operation: EventEntryOperation;
  };
  const expectedState = stateSchema.parse(intent.expectedState);
  const parameters = parametersSchema.parse(intent.parameters);
  if (
    target.id !== before.entryId ||
    target.id !== after.entryId ||
    target.id !== expectedState.entryId ||
    JSON.stringify(before) !== JSON.stringify(expectedState)
  ) {
    throw new Error('event entry target and expected state must match');
  }
  const normalizedTarget: EventEntryChangeIntent['target'] = {
    type: 'event-entry',
    id: target.id,
    ...(target.label ? { label: target.label } : {}),
  };
  return {
    ...intent,
    kind: 'event.entry.update',
    target: normalizedTarget,
    before,
    after,
    expectedState,
    parameters,
  };
};

export const createEventEntryChangeIntent = (
  draft: EventEntryChangeDraft,
): EventEntryChangeIntent => {
  const entryId = entryIdSchema.parse(draft.entryId);
  const snapshot = jsonValueSchema.parse(draft.currentSnapshot);
  const operation = eventEntryOperationSchema.parse(
    draft.operation,
  ) as EventEntryOperation;
  return parseEventEntryChangeIntent({
    version: 1,
    kind: 'event.entry.update',
    summary: `Nennung ${entryId} ändern: ${operation.type}`,
    target: {
      type: 'event-entry',
      id: entryId,
      ...(draft.label ? { label: draft.label } : {}),
    },
    before: { entryId, snapshot },
    after: { entryId, operation },
    expectedState: { entryId, snapshot },
    parameters: { executionMode: 'approved-change' },
  });
};

export class EventEntryChangePreviewRenderer implements
  PreviewRenderer<EventEntryChangeIntent> {
  readonly kind = 'event.entry.update' as const;

  render(value: EventEntryChangeIntent): ActionPreview {
    const intent = parseEventEntryChangeIntent(value);
    return actionPreviewSchema.parse({
      title: 'Nennung ändern',
      summary: intent.summary,
      target: intent.target.label ?? intent.target.id,
      risk: 'high',
      changes: Object.entries(intent.after.operation)
        .filter(([field]) => field !== 'type')
        .map(([field, after]) => ({
          field,
          before: null,
          after: jsonValueSchema.parse(after),
        })),
    });
  }
}

export interface EventEntryMutationTransport {
  apply(
    entryId: string,
    operation: EventEntryOperation,
    context: ExecutionContext,
  ): Promise<{ externalId?: string; result: JsonValue }>;
}

export class EventEntryChangeAdapter implements
  ExecutorAdapter<EventEntryChangeIntent> {
  readonly kind = 'event.entry.update' as const;
  readonly intentSchema = { parse: parseEventEntryChangeIntent };

  constructor(
    private readonly readCurrentSnapshot: (entryId: string) => Promise<JsonValue>,
    private readonly transport: EventEntryMutationTransport,
  ) {}

  async readCurrentState(value: EventEntryChangeIntent): Promise<JsonValue> {
    const intent = parseEventEntryChangeIntent(value);
    return {
      entryId: intent.target.id,
      snapshot: await this.readCurrentSnapshot(intent.target.id),
    };
  }

  async execute(
    value: EventEntryChangeIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const intent = parseEventEntryChangeIntent(value);
    const applied = await this.transport.apply(
      intent.target.id,
      intent.after.operation,
      context,
    );
    const verifiedSnapshot = await this.readCurrentSnapshot(intent.target.id);
    return {
      ...(applied.externalId === undefined
        ? {}
        : { externalId: applied.externalId }),
      result: {
        mutation: applied.result,
        verifiedSnapshot,
      },
    };
  }
}
