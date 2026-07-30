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
