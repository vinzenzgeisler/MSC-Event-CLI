import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  adminQueryOperationSchema,
  type AdminQueryOperation,
  type AdminQueryParameters,
} from './admin-query.js';

const execFileAsync = promisify(execFile);
const uuidSchema = z.string().uuid();
const lookupValueSchema = z.string().trim().min(1).max(320)
  .refine((value) => !/[\r\n\0]/.test(value), 'invalid lookup value');
const lookupKindSchema = z.enum([
  'email',
  'name',
  'codriver-name',
  'orga-code',
  'start-number',
]);

export const eventEntriesListInputSchema = z.object({
  eventId: uuidSchema,
  acceptanceStatus: z.enum([
    'pending',
    'shortlist',
    'accepted',
    'rejected',
  ]).optional(),
  classId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(2048)
    .refine((value) => !/[\r\n\0]/.test(value), 'invalid cursor')
    .optional(),
}).strict();

export const eventClassesListInputSchema = z.object({
  eventId: uuidSchema,
}).strict();

export type EventEntriesListInput = z.infer<typeof eventEntriesListInputSchema>;
export type EventClassesListInput = z.infer<typeof eventClassesListInputSchema>;

const compactEntryListResponseSchema = z.object({
  ok: z.boolean().optional(),
  entries: z.array(z.record(z.unknown())),
  meta: z.object({
    hasMore: z.boolean().optional(),
    nextCursor: z.string().nullable().optional(),
    limit: z.number().int().optional(),
  }).strip().optional(),
}).passthrough();

const compactEntryFields = [
  'id',
  'eventId',
  'classId',
  'className',
  'acceptanceStatus',
  'startNumberNorm',
  'driverFirstName',
  'driverLastName',
  'vehicleLabel',
] as const;

export const compactEventEntriesList = (value: unknown): Record<string, unknown> => {
  const parsed = compactEntryListResponseSchema.parse(value);
  return {
    ...(parsed.ok === undefined ? {} : { ok: parsed.ok }),
    entries: parsed.entries.map((entry) => Object.fromEntries(
      compactEntryFields.flatMap((field) => {
        const fieldValue = entry[field];
        return fieldValue === undefined ? [] : [[field, fieldValue]];
      }),
    )),
    ...(parsed.meta === undefined ? {} : { meta: parsed.meta }),
  };
};

export type MscEventReadonlyRunner = (
  args: readonly string[],
) => Promise<{ stdout: string }>;

const defaultRunner: MscEventReadonlyRunner = async (args) => {
  const result = await execFileAsync(
    '/usr/local/bin/msc-event-readonly',
    [...args],
    {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return { stdout: result.stdout };
};

export class MscEventReadonlyProvider {
  constructor(private readonly run: MscEventReadonlyRunner = defaultRunner) {}

  health(): Promise<unknown> {
    return this.invoke(['health']);
  }

  lookup(
    kindValue: z.infer<typeof lookupKindSchema>,
    valueInput: string,
  ): Promise<unknown> {
    const kind = lookupKindSchema.parse(kindValue);
    const value = lookupValueSchema.parse(valueInput);
    return this.invoke(['lookup', `--${kind}`, value]);
  }

  detail(idValue: string): Promise<unknown> {
    const id = uuidSchema.parse(idValue);
    return this.invoke(['detail', '--id', id]);
  }

  listEntries(inputValue: EventEntriesListInput): Promise<unknown> {
    const input = eventEntriesListInputSchema.parse(inputValue);
    return this.query('entries.list', input);
  }

  listClasses(inputValue: EventClassesListInput): Promise<unknown> {
    const input = eventClassesListInputSchema.parse(inputValue);
    return this.query('events.classes', { id: input.eventId });
  }

  query(
    operationValue: AdminQueryOperation,
    parameters: AdminQueryParameters = {},
  ): Promise<unknown> {
    const operation = adminQueryOperationSchema.parse(operationValue);
    const parametersJson = JSON.stringify(z.record(z.unknown()).parse(parameters));
    if (Buffer.byteLength(parametersJson, 'utf8') > 16 * 1024) {
      throw new Error('admin query parameters exceed 16 KiB');
    }
    return this.invoke([
      'admin-query',
      '--operation',
      operation,
      '--params-json',
      parametersJson,
    ]);
  }

  private async invoke(args: string[]): Promise<unknown> {
    const result = await this.run(args);
    if (Buffer.byteLength(result.stdout, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('event provider response exceeds 2 MiB');
    }
    return JSON.parse(result.stdout);
  }
}
