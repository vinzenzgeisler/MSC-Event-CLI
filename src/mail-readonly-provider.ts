import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  mscMailAccountSchema,
  type MscMailAccount,
} from './mail-approved-action.js';

const execFileAsync = promisify(execFile);
const folderSchema = z.string().trim().min(1).max(100)
  .refine((value) => !/[\r\n\0]/.test(value), 'invalid folder');
const messageIdSchema = z.string().regex(/^[1-9][0-9]{0,17}$/);
const operationSchema = z.enum(['accounts', 'folders', 'list', 'preview']);
const providerEnvelopeSchema = z.object({
  schema: z.literal('msc.mail-provider.v1'),
  provider: z.literal('himalaya'),
  operation: operationSchema,
  source: z.unknown(),
  data: z.unknown(),
}).strict();

export type MscMailProviderEnvelope = z.infer<typeof providerEnvelopeSchema>;
export type MscMailReadonlyRunner = (
  args: readonly string[],
) => Promise<{ stdout: string }>;

const defaultRunner: MscMailReadonlyRunner = async (args) => {
  const result = await execFileAsync(
    '/usr/local/bin/msc-mail-readonly',
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

/**
 * Narrow process adapter around the installed read-only provider. It has no
 * generic command, binary-path, environment or shell seam.
 */
export class MscMailReadonlyProvider {
  constructor(private readonly run: MscMailReadonlyRunner = defaultRunner) {}

  accounts(): Promise<MscMailProviderEnvelope> {
    return this.invoke('accounts', []);
  }

  folders(accountValue: MscMailAccount): Promise<MscMailProviderEnvelope> {
    const account = mscMailAccountSchema.parse(accountValue);
    return this.invoke('folders', ['--account', account]);
  }

  list(
    accountValue: MscMailAccount,
    folderValue: string,
  ): Promise<MscMailProviderEnvelope> {
    const account = mscMailAccountSchema.parse(accountValue);
    const folder = folderSchema.parse(folderValue);
    return this.invoke('list', ['--account', account, '--folder', folder]);
  }

  preview(
    accountValue: MscMailAccount,
    folderValue: string,
    messageIdValue: string,
  ): Promise<MscMailProviderEnvelope> {
    const account = mscMailAccountSchema.parse(accountValue);
    const folder = folderSchema.parse(folderValue);
    const messageId = messageIdSchema.parse(messageIdValue);
    return this.invoke('preview', [
      '--account',
      account,
      '--folder',
      folder,
      '--message-id',
      messageId,
    ]);
  }

  private async invoke(
    operation: z.infer<typeof operationSchema>,
    args: string[],
  ): Promise<MscMailProviderEnvelope> {
    const result = await this.run([operation, ...args]);
    if (Buffer.byteLength(result.stdout, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('mail provider response exceeds 2 MiB');
    }
    const parsed = providerEnvelopeSchema.parse(JSON.parse(result.stdout));
    if (parsed.operation !== operation) {
      throw new Error('mail provider returned a mismatched operation');
    }
    return parsed;
  }
}
