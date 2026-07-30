import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActionPreview, JsonValue } from './action.js';
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

type PluginToolContext = {
  sessionKey?: string;
  toolCallId?: string;
};

type ReplySendTool = {
  name: 'msc_mail_reply_send';
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
};

type MailWatchTool = {
  name: 'msc_mail_watch_list';
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult>;
};

const APPROVAL_BASE_PATH = '/msc-approval';
const SEND_TOOL_NAME = 'msc_mail_reply_send';
const AUTHORIZATION_NONCE_PARAM = 'operatorApprovalNonce';

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
  registerTool(
    tool: ReplyProposalTool | ReplySendTool | MailWatchTool,
    options: { optional: true },
  ): void;
  on(
    hook: 'before_tool_call',
    handler: (
      event: {
        toolName: string;
        params: Record<string, unknown>;
        toolCallId?: string;
      },
      context: PluginToolContext,
    ) => Promise<{
      block?: boolean;
      blockReason?: string;
      params?: Record<string, unknown>;
      requireApproval?: {
        title: string;
        description: string;
        severity: 'critical';
        allowedDecisions: ['allow-once', 'deny'];
        timeoutMs: number;
        onResolution(decision: string): void;
      };
    } | undefined>,
  ): void;
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

const sendInputSchema = z.object({
  actionId: z.string().uuid(),
  payloadReference: z.string().regex(/^[a-f0-9]{12}$/),
  operatorApprovalNonce: z.string().uuid().optional(),
}).strict();

const watchInputSchema = z.object({}).strict();
const watchEnvelopeSchema = z.object({
  source: z.object({
    account: z.enum(['msc-nennung', 'msc-info', 'msc-vorstand']),
    sender_identity: z.string().email(),
  }).passthrough(),
  data: z.array(z.object({
    id: z.string().regex(/^[1-9][0-9]{0,17}$/),
    from: z.object({
      addr: z.string().email().nullable(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();
const WATCH_ACCOUNTS = [
  'msc-nennung',
  'msc-info',
  'msc-vorstand',
] as const;

const previewValue = (
  preview: ActionPreview,
  field: string,
): JsonValue | undefined => preview.changes.find(
  (change) => change.field === field,
)?.after;

const displayValue = (value: JsonValue | undefined): string | undefined => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
};

const boundedApprovalBody = (body: string, maximum = 2_800): string => {
  if (body.length <= maximum) return body;
  const separator = '\n\n… [Mittelteil gekürzt] …\n\n';
  const available = maximum - separator.length;
  const startLength = Math.floor(available * 0.72);
  return `${body.slice(0, startLength).trimEnd()}${separator}${
    body.slice(-(available - startLength)).trimStart()
  }`;
};

export const createMailApprovalDescription = (
  preview: ActionPreview,
  payloadReference: string,
): string => {
  const isReply = preview.changes.some(
    (change) => change.field === 'Antwort',
  );
  const sourceMessage = displayValue(previewValue(preview, 'Quellnachricht'));
  const body = displayValue(previewValue(
    preview,
    isReply ? 'Antwort' : 'Nachricht',
  ));
  const lines = [
    isReply
      ? 'Diese Antwort genau einmal senden'
      : 'Diese E-Mail genau einmal senden',
    `Konto: ${
      displayValue(previewValue(
        preview,
        isReply ? 'Quellkonto' : 'Absenderkonto',
      )) ?? preview.target
    }`,
    ...(sourceMessage ? [`Antwort auf Nachricht: ${sourceMessage}`] : []),
    `Von: ${displayValue(previewValue(preview, 'Von')) ?? '—'}`,
    `An: ${displayValue(previewValue(preview, 'An')) ?? preview.target}`,
    ...(displayValue(previewValue(preview, 'BCC'))
      ? [`BCC: ${displayValue(previewValue(preview, 'BCC'))}`]
      : []),
    `Betreff: ${displayValue(previewValue(preview, 'Betreff')) ?? '—'}`,
    '',
    isReply
      ? 'Antworttext inkl. Signatur (lange Texte mittig gekürzt):'
      : 'Nachrichtentext (lange Texte mittig gekürzt):',
    boundedApprovalBody(body ?? '—'),
    '',
    `Prüfreferenz: ${payloadReference}`,
    'SMTP-Preflight: erfolgreich',
    'allow-once erlaubt genau diesen einen Versandversuch. Ein unklares Ergebnis wird quarantänisiert und niemals automatisch wiederholt.',
  ];
  return lines.join('\n');
};

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
  const approvedCalls = new Map<string, {
    actionId: string;
    payloadReference: string;
    sessionKey: string;
    toolCallId: string;
    expiresAtMs: number;
  }>();

  api.registerTool({
    name: 'msc_mail_watch_list',
    description:
      'List only opaque message references and own-sender flags for the three MSC INBOX folders. This tool is read-only and never returns subjects or message bodies.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_id, params) {
      if (!composition) {
        throw new Error('MSC approved mail service is not running');
      }
      watchInputSchema.parse(params);
      const accounts = await Promise.all(WATCH_ACCOUNTS.map(async (account) => {
        const envelope = watchEnvelopeSchema.parse(
          await composition!.provider.list(account, 'INBOX'),
        );
        const own = envelope.source.sender_identity.toLowerCase();
        return {
          account,
          entries: envelope.data.slice(0, 200).map((message) => ({
            messageId: message.id,
            incoming: message.from.addr?.toLowerCase() !== own,
          })),
        };
      }));
      const details = {
        readOnly: true,
        folder: 'INBOX',
        accounts,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  api.registerTool({
    name: 'msc_mail_reply_propose',
    description:
      'Create an encrypted MSC mail reply proposal from one exact read-only source message. This tool never sends mail; each proposal requires a separate operator approval.',
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
        requiresSeparateOperatorApproval: true,
        ...result,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  api.registerTool({
    name: SEND_TOOL_NAME,
    description:
      'Send one existing encrypted MSC mail proposal. OpenClaw blocks this tool until Vinzenz explicitly approves this exact call in the authorized Telegram direct chat.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['actionId', 'payloadReference'],
      properties: {
        actionId: { type: 'string', format: 'uuid' },
        payloadReference: {
          type: 'string',
          pattern: '^[a-f0-9]{12}$',
        },
        operatorApprovalNonce: {
          type: 'string',
          format: 'uuid',
          description: 'Injected by the OpenClaw approval hook.',
        },
      },
    },
    async execute(id, params) {
      if (!composition) {
        throw new Error('MSC approved mail service is not running');
      }
      const input = sendInputSchema.parse(params);
      if (!input.operatorApprovalNonce) {
        throw new Error('operator approval is missing');
      }
      const authorization = approvedCalls.get(input.operatorApprovalNonce);
      approvedCalls.delete(input.operatorApprovalNonce);
      if (!authorization ||
          authorization.expiresAtMs <= Date.now() ||
          authorization.actionId !== input.actionId ||
          authorization.payloadReference !== input.payloadReference ||
          authorization.toolCallId !== id) {
        throw new Error('operator approval is missing or does not match this tool call');
      }
      const result = await composition.approveAndDispatchFromGateway({
        actionId: input.actionId,
        payloadReference: input.payloadReference,
        sessionKey: authorization.sessionKey,
        toolCallId: id,
      });
      const details = {
        sendsMail: true,
        approvalMethod: 'openclaw-plugin-approval',
        actionId: result.actionId,
        status: result.status,
        messageId: result.messageId,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  api.on('before_tool_call', async (event, context) => {
    if (event.toolName !== SEND_TOOL_NAME) return undefined;
    if (!composition) {
      return {
        block: true,
        blockReason: 'MSC approved mail service is not running',
      };
    }
    const parsed = sendInputSchema.omit({
      operatorApprovalNonce: true,
    }).safeParse(event.params);
    const sessionKey = context.sessionKey ?? '';
    const toolCallId = event.toolCallId ?? context.toolCallId ?? '';
    if (!parsed.success || !toolCallId) {
      return {
        block: true,
        blockReason: 'mail send request is incomplete or invalid',
      };
    }
    let preview;
    try {
      preview = await composition.gatewayApprovalPreview(
        parsed.data.actionId,
        parsed.data.payloadReference,
        sessionKey,
      );
      await composition.assertGatewaySmtpReady(
        parsed.data.actionId,
        parsed.data.payloadReference,
        sessionKey,
      );
    } catch (error) {
      return {
        block: true,
        blockReason: error instanceof Error
          ? error.message
          : 'mail proposal cannot be approved',
      };
    }
    const nonce = randomUUID();
    const description = createMailApprovalDescription(
      preview,
      parsed.data.payloadReference,
    );
    return {
      params: {
        ...event.params,
        [AUTHORIZATION_NONCE_PARAM]: nonce,
      },
      requireApproval: {
        title: preview.title.slice(0, 80),
        description,
        severity: 'critical',
        allowedDecisions: ['allow-once', 'deny'],
        timeoutMs: 600_000,
        onResolution(decision) {
          if (decision !== 'allow-once') return;
          approvedCalls.set(nonce, {
            actionId: parsed.data.actionId,
            payloadReference: parsed.data.payloadReference,
            sessionKey,
            toolCallId,
            expiresAtMs: Date.now() + 60_000,
          });
        },
      },
    };
  });

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
