import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const actionIntentSchema = z.object({
  version: z.literal(1),
  kind: z.string().min(3).max(100).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  summary: z.string().trim().min(1).max(500),
  target: z.object({
    type: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  before: jsonValueSchema,
  after: jsonValueSchema,
  expectedState: jsonValueSchema,
  parameters: jsonValueSchema.optional(),
}).strict().superRefine((intent, context) => {
  if (Buffer.byteLength(JSON.stringify(intent), 'utf8') > 256 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'action intent exceeds 256 KiB' });
  }
});

export type ActionIntent = z.infer<typeof actionIntentSchema>;

export const canonicalizeJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`).join(',')}}`;
  }
  throw new Error('value is not valid JSON');
};

export const actionPreviewSchema = z.object({
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2_000),
  target: z.string().trim().min(1).max(1_000),
  risk: z.enum(['low', 'medium', 'high']),
  changes: z.array(z.object({
    field: z.string().trim().min(1).max(500),
    before: jsonValueSchema,
    after: jsonValueSchema,
  }).strict()).min(1).max(1_000),
}).strict();

export type ActionPreview = z.infer<typeof actionPreviewSchema>;

/**
 * Presentation boundary. Implementations must render only the validated,
 * persisted intent that is covered by the approval payload hash.
 */
export interface PreviewRenderer<TIntent extends ActionIntent = ActionIntent> {
  readonly kind: TIntent['kind'];
  render(intent: TIntent): ActionPreview;
}

export interface ExecutionContext {
  actionId: string;
  payloadHash: string;
  approvedBy: string;
  approvedAt: string;
}

export interface ExecutionResult {
  externalId?: string;
  result: JsonValue;
}

export interface IntentValidator<TIntent extends ActionIntent = ActionIntent> {
  parse(input: unknown): TIntent;
}

/**
 * Mutation boundary. The caller must consume a valid one-time execution proof
 * and compare `readCurrentState` before calling `execute`.
 */
export interface ExecutorAdapter<TIntent extends ActionIntent = ActionIntent> {
  readonly kind: TIntent['kind'];
  readonly intentSchema: IntentValidator<TIntent>;
  readCurrentState(intent: TIntent): Promise<JsonValue>;
  execute(intent: TIntent, context: ExecutionContext): Promise<ExecutionResult>;
}

export const parseActionIntent = (input: unknown): ActionIntent => actionIntentSchema.parse(input);

export const renderActionPreview = <TIntent extends ActionIntent>(
  renderer: PreviewRenderer<TIntent>,
  intent: TIntent,
): ActionPreview => actionPreviewSchema.parse(renderer.render(intent));
