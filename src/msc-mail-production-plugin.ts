import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MscMailProductionComposition } from './msc-mail-production-composition.js';
import { loadMscMailProductionOptions } from './msc-mail-production-config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
};

type ReplyProposalTool = {
  name: 'msc_mail_reply_propose';
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
};

const APPROVAL_BASE_PATH = '/msc-approval';

export interface MscMailProductionPluginApi {
  registrationMode?: string;
  registerHttpRoute(route: {
    path: string;
    auth: 'plugin';
    match: 'prefix';
    handler(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean>;
  }): void;
  registerTool(tool: ReplyProposalTool, options: { optional: true }): void;
  registerService(service: {
    id: string;
    start(context: {
      logger: {
        info(message: string): void;
        error(message: string): void;
      };
    }): Promise<void>;
    stop(): Promise<void>;
  }): void;
}

const proposalInputSchema = z.object({
  account: z.enum(['msc-nennung', 'msc-info', 'msc-vorstand']),
  folder: z.string().trim().min(1).max(200).default('INBOX'),
  messageId: z.string().trim().min(1).max(200),
  bodyText: z.string().min(1).max(100_000),
  sources: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(50)
    .default([]),
  idempotencyKey: z.string().trim().min(8).max(200),
  ttlSeconds: z.number().int().min(60).max(3_600).default(900),
}).strict();

const defaultConfigPath = (): string => join(
  homedir(),
  '.openclaw',
  'msc-approved-mail',
  'config',
  'production.json',
);

const trustedConfigOwner = async (configPath: string): Promise<number> => {
  const metadata = await lstat(configPath);
  const runtimeUid = process.getuid?.() ?? 0;
  if (!metadata.isFile() || (metadata.uid !== 0 && metadata.uid !== runtimeUid)) {
    throw new Error('MSC approved mail config must be a regular file owned by root or the runtime user');
  }
  return metadata.uid;
};

const noListenerLifecycle = {
  async listen(_server: Server): Promise<void> {},
  async close(_server: Server): Promise<void> {},
};

export const registerMscMailProductionPlugin = (
  api: MscMailProductionPluginApi,
): void => {
  let composition: MscMailProductionComposition | undefined;

  api.registerTool({
    name: 'msc_mail_reply_propose',
    description:
      'Create an encrypted MSC mail reply proposal from one exact read-only source message. This tool never sends mail; each proposal requires a separate Passkey approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [
        'account',
        'messageId',
        'bodyText',
        'sources',
        'idempotencyKey',
      ],
      properties: {
        account: {
          type: 'string',
          enum: ['msc-nennung', 'msc-info', 'msc-vorstand'],
        },
        folder: { type: 'string', default: 'INBOX' },
        messageId: { type: 'string' },
        bodyText: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' }, minItems: 1 },
        uncertainties: {
          type: 'array',
          items: { type: 'string' },
          default: [],
        },
        idempotencyKey: { type: 'string', minLength: 8 },
        ttlSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 3_600,
          default: 900,
        },
      },
    },
    async execute(_id, params) {
      if (!composition) {
        throw new Error('MSC approved mail service is not running');
      }
      const input = proposalInputSchema.parse(params);
      const result = await composition.flow.proposeReplyFromSource(
        input,
        input.idempotencyKey,
        input.ttlSeconds,
      );
      const details = {
        sendsMail: false,
        requiresPasskeyApproval: true,
        ...result,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  if (api.registrationMode && api.registrationMode !== 'full') return;
  const configPath = process.env.MSC_APPROVED_ACTIONS_CONFIG?.trim() ||
    defaultConfigPath();

  api.registerHttpRoute({
    path: APPROVAL_BASE_PATH,
    auth: 'plugin',
    match: 'prefix',
    async handler(request, response) {
      if (!composition) {
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store, max-age=0',
        });
        response.end('{"error":"service_unavailable"}');
        return true;
      }
      await composition.adapter.handleNodeRequest(request, response);
      return true;
    },
  });

  api.registerService({
    id: 'msc-approved-mail',
    async start(context) {
      if (composition) throw new Error('MSC approved mail service is already started');
      const configOwnerUid = await trustedConfigOwner(configPath);
      const options = await loadMscMailProductionOptions(configPath, {
        configOwnerUid,
      });
      if (options.basePath !== APPROVAL_BASE_PATH) {
        throw new Error(
          `MSC approved mail basePath must be ${APPROVAL_BASE_PATH}`,
        );
      }
      const candidate = new MscMailProductionComposition({
        ...options,
        lifecycle: noListenerLifecycle,
      });
      try {
        await candidate.start();
        composition = candidate;
        context.logger.info(
          `MSC approved mail service mounted at ${options.basePath}`,
        );
      } catch (error) {
        await candidate.close().catch(() => undefined);
        context.logger.error('MSC approved mail service failed closed during startup');
        throw error;
      }
    },
    async stop() {
      const current = composition;
      composition = undefined;
      await current?.close();
    },
  });
};
