import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActionPreview, JsonValue } from './action.js';
import { loadAccessToken } from './auth.js';
import { parseBaseUrl } from './config.js';
import {
  eventEntryOperationSchema,
  type EventEntryOperation,
} from './event-approved-action.js';
import { EventEntryHttpMutationTransport } from './event-http-mutation-transport.js';
import type { EventMutationScopePrefix } from './event-http-mutation-transport.js';
import {
  compactEventEntriesList,
  eventClassesListInputSchema,
  eventEntriesListInputSchema,
} from './event-readonly-provider.js';
import { MscMailProductionComposition } from './msc-mail-production-composition.js';
import { loadMscMailProductionOptions } from './msc-mail-production-config.js';

export const eventAutomationTokenEnv = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined => {
  const tokenUrl = env.MSC_EVENT_AUTOMATION_COGNITO_URL?.trim();
  const clientId = env.MSC_EVENT_AUTOMATION_COGNITO_CLIENT_ID?.trim();
  const clientSecretFile =
    env.MSC_EVENT_AUTOMATION_COGNITO_CLIENT_SECRET_FILE?.trim();
  const configured = [tokenUrl, clientId, clientSecretFile]
    .filter((value) => Boolean(value)).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error(
      'Set MSC_EVENT_AUTOMATION_COGNITO_URL, '
      + 'MSC_EVENT_AUTOMATION_COGNITO_CLIENT_ID and '
      + 'MSC_EVENT_AUTOMATION_COGNITO_CLIENT_SECRET_FILE together.',
    );
  }
  return {
    MSC_EVENT_COGNITO_URL: tokenUrl,
    MSC_EVENT_COGNITO_CLIENT_ID: clientId,
    MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: clientSecretFile,
  };
};

export type EventMutationAuthConfiguration = {
  tokenEnv: NodeJS.ProcessEnv;
  scopePrefix: EventMutationScopePrefix;
};

export const eventMutationAuthConfiguration = (
  env: NodeJS.ProcessEnv = process.env,
): EventMutationAuthConfiguration | undefined => {
  const mode = env.MSC_EVENT_MUTATION_AUTH_MODE?.trim() ?? '';
  if (mode !== '' && mode !== 'support') {
    throw new Error(
      'MSC_EVENT_MUTATION_AUTH_MODE must be unset or set to support.',
    );
  }
  if (mode === '') {
    const tokenEnv = eventAutomationTokenEnv(env);
    return tokenEnv
      ? { tokenEnv, scopePrefix: 'msc-automation/' }
      : undefined;
  }

  const tokenUrl = env.MSC_EVENT_COGNITO_URL?.trim();
  const clientId = env.MSC_EVENT_COGNITO_CLIENT_ID?.trim();
  const clientSecretFile = env.MSC_EVENT_COGNITO_CLIENT_SECRET_FILE?.trim();
  const configured = [tokenUrl, clientId, clientSecretFile]
    .filter((value) => Boolean(value)).length;
  if (configured !== 3) {
    throw new Error(
      'MSC_EVENT_MUTATION_AUTH_MODE=support requires '
      + 'MSC_EVENT_COGNITO_URL, MSC_EVENT_COGNITO_CLIENT_ID and '
      + 'MSC_EVENT_COGNITO_CLIENT_SECRET_FILE together.',
    );
  }
  return {
    tokenEnv: {
      MSC_EVENT_COGNITO_URL: tokenUrl,
      MSC_EVENT_COGNITO_CLIENT_ID: clientId,
      MSC_EVENT_COGNITO_CLIENT_SECRET_FILE: clientSecretFile,
    },
    scopePrefix: 'msc-support/',
  };
};

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

type EventProposalTool = {
  name: 'msc_event_entry_change_propose';
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
};

type EventExecuteTool = {
  name: 'msc_event_entry_change_execute';
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
};

type EventEntriesListTool = {
  name: 'msc_event_entries_list';
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
};

type EventClassesListTool = {
  name: 'msc_event_classes_list';
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
};

const APPROVAL_BASE_PATH = '/msc-approval';
const SEND_TOOL_NAME = 'msc_mail_reply_send';
const EVENT_EXECUTE_TOOL_NAME = 'msc_event_entry_change_execute';
const AUTHORIZATION_NONCE_PARAM = 'operatorApprovalNonce';

type ApprovedToolCallBinding = {
  actionId: string;
  payloadReference: string;
  sessionKey: string;
  toolCallId: string;
};

export class OneTimeToolApprovalStore {
  readonly #approved = new Map<string, ApprovedToolCallBinding & {
    expiresAtMs: number;
  }>();

  constructor(private readonly now: () => number = Date.now) {}

  authorize(
    nonce: string,
    binding: ApprovedToolCallBinding,
    ttlMs = 60_000,
  ): void {
    if (ttlMs <= 0) throw new Error('approval TTL must be positive');
    this.#approved.set(nonce, {
      ...binding,
      expiresAtMs: this.now() + ttlMs,
    });
  }

  consume(
    nonce: string,
    expected: Pick<
      ApprovedToolCallBinding,
      'actionId' | 'payloadReference' | 'toolCallId'
    >,
  ): ApprovedToolCallBinding | undefined {
    const authorization = this.#approved.get(nonce);
    this.#approved.delete(nonce);
    if (!authorization || authorization.expiresAtMs <= this.now() ||
        authorization.actionId !== expected.actionId ||
        authorization.payloadReference !== expected.payloadReference ||
        authorization.toolCallId !== expected.toolCallId) {
      return undefined;
    }
    return {
      actionId: authorization.actionId,
      payloadReference: authorization.payloadReference,
      sessionKey: authorization.sessionKey,
      toolCallId: authorization.toolCallId,
    };
  }
}

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
    tool:
      | ReplyProposalTool
      | ReplySendTool
      | MailWatchTool
      | EventEntriesListTool
      | EventClassesListTool
      | EventProposalTool
      | EventExecuteTool,
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
const eventProposalInputSchema = z.object({
  entryId: z.string().uuid(),
  operation: eventEntryOperationSchema,
  label: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  ttlSeconds: z.number().int().min(60).max(3_600).default(900),
}).strict();
const eventExecuteInputSchema = z.object({
  actionId: z.string().uuid(),
  payloadReference: z.string().regex(/^[a-f0-9]{12}$/),
  operatorApprovalNonce: z.string().uuid().optional(),
}).strict();
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


const compactApprovalValue = (
  value: JsonValue | undefined,
  fallback = '—',
  maximum = 72,
): string => {
  const displayed = displayValue(value)?.trim() || fallback;
  if (displayed.length <= maximum) return displayed;
  return `${displayed.slice(0, maximum - 1).trimEnd()}…`;
};

export const createMailApprovalDescription = (
  preview: ActionPreview,
  _payloadReference: string,
): string => {
  const isReply = preview.changes.some(
    (change) => change.field === 'Antwort',
  );
  const body = displayValue(previewValue(
    preview,
    isReply ? 'Antwort' : 'Nachricht',
  ))?.trim() || '—';
  const subject = compactApprovalValue(
    previewValue(preview, 'Betreff'),
    '—',
    80,
  );
  const reason = isReply
    ? 'Passende Antwort auf die eingegangene Anfrage.'
    : 'Neue ausgehende Nachricht.';
  const header = [
    isReply ? 'Antwort freigeben' : 'E-Mail freigeben',
    `Absender: ${compactApprovalValue(previewValue(preview, 'Von'))}`,
    `Empfänger: ${compactApprovalValue(previewValue(preview, 'An'), preview.target)}`,
    `BCC: ${compactApprovalValue(previewValue(preview, 'BCC'))}`,
    `Betreff: ${subject}`,
    '',
    '--- DAS KOMMT IN DIE MAIL ---',
  ];
  const footer = ['--- ENDE MAIL ---', '', `Begründung: ${reason}`];
  const frame = [...header, '', ...footer].join('\n');
  const bodyLimit = Math.max(1, 511 - frame.length);
  const shownBody = body.length <= bodyLimit
    ? body
    : `${body.slice(0, Math.max(0, bodyLimit - 1)).trimEnd()}…`;
  return [...header, shownBody, ...footer].join('\n');
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
  const approvedCalls = new OneTimeToolApprovalStore();
  const approvedEventCalls = new OneTimeToolApprovalStore();

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
    name: 'msc_event_entries_list',
    description:
      'List MSC event registrations through the fixed read-only entries query. Filters are limited to event, acceptance status, class and bounded pagination.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId'],
      properties: {
        eventId: { type: 'string', format: 'uuid' },
        acceptanceStatus: {
          type: 'string',
          enum: ['pending', 'shortlist', 'accepted', 'rejected'],
        },
        classId: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        cursor: { type: 'string', minLength: 1, maxLength: 2_048 },
      },
    },
    async execute(_id, params) {
      const input = eventEntriesListInputSchema.parse(params);
      if (!composition?.eventProvider) {
        throw new Error('MSC event read-only service is not running');
      }
      const details = {
        readOnly: true,
        operation: 'entries.list',
        result: compactEventEntriesList(
          await composition.eventProvider.listEntries(input),
        ),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  api.registerTool({
    name: 'msc_event_classes_list',
    description:
      'List classes for one MSC event through the fixed read-only event-classes query.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId'],
      properties: {
        eventId: { type: 'string', format: 'uuid' },
      },
    },
    async execute(_id, params) {
      const input = eventClassesListInputSchema.parse(params);
      if (!composition?.eventProvider) {
        throw new Error('MSC event read-only service is not running');
      }
      const details = {
        readOnly: true,
        operation: 'events.classes',
        result: await composition.eventProvider.listClasses(input),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  }, { optional: true });

  api.registerTool({
    name: 'msc_event_entry_change_propose',
    description:
      'Read one MSC registration, bind its current state and create an encrypted proposal for one typed change. This tool never mutates the backend.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['entryId', 'operation', 'idempotencyKey'],
      properties: {
        entryId: { type: 'string', format: 'uuid' },
        operation: { type: 'object' },
        label: { type: 'string' },
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
      if (!composition?.eventProposals) {
        throw new Error('MSC event mutation service is not running');
      }
      const input = eventProposalInputSchema.parse(params);
      const result = await composition.eventProposals.proposeEventEntryChange({
        entryId: input.entryId,
        operation: input.operation as EventEntryOperation,
        idempotencyKey: input.idempotencyKey,
        ttlSeconds: input.ttlSeconds,
        ...(input.label === undefined ? {} : { label: input.label }),
      });
      const details = {
        mutatesBackend: false,
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
    name: EVENT_EXECUTE_TOOL_NAME,
    description:
      'Execute one existing exact MSC registration change proposal. OpenClaw blocks this tool until Vinzenz approves this exact call once.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['actionId', 'payloadReference'],
      properties: {
        actionId: { type: 'string', format: 'uuid' },
        payloadReference: { type: 'string', pattern: '^[a-f0-9]{12}$' },
        operatorApprovalNonce: {
          type: 'string',
          format: 'uuid',
          description: 'Injected by the OpenClaw approval hook.',
        },
      },
    },
    async execute(id, params) {
      if (!composition) {
        throw new Error('MSC event mutation service is not running');
      }
      const input = eventExecuteInputSchema.parse(params);
      if (!input.operatorApprovalNonce) {
        throw new Error('operator approval is missing');
      }
      const authorization = approvedEventCalls.consume(
        input.operatorApprovalNonce,
        {
          actionId: input.actionId,
          payloadReference: input.payloadReference,
          toolCallId: id,
        },
      );
      if (!authorization) {
        throw new Error(
          'operator approval is missing or does not match this tool call',
        );
      }
      const result = await composition.approveAndExecuteEventFromGateway({
        actionId: input.actionId,
        payloadReference: input.payloadReference,
        sessionKey: authorization.sessionKey,
        toolCallId: id,
      });
      const details = {
        mutatesBackend: true,
        approvalMethod: 'openclaw-plugin-approval',
        actionId: result.actionId,
        kind: result.kind,
        result: result.result,
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
      'Send one existing encrypted MSC mail proposal. OpenClaw blocks this tool until Vinzenz explicitly approves this exact call in an authorized direct session.',
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
      const authorization = approvedCalls.consume(
        input.operatorApprovalNonce,
        {
          actionId: input.actionId,
          payloadReference: input.payloadReference,
          toolCallId: id,
        },
      );
      if (!authorization) {
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
    if (event.toolName === EVENT_EXECUTE_TOOL_NAME) {
      if (!composition) {
        return {
          block: true,
          blockReason: 'MSC event mutation service is not running',
        };
      }
      const parsed = eventExecuteInputSchema.omit({
        operatorApprovalNonce: true,
      }).safeParse(event.params);
      const sessionKey = context.sessionKey ?? '';
      const toolCallId = event.toolCallId ?? context.toolCallId ?? '';
      if (!parsed.success || !toolCallId) {
        return {
          block: true,
          blockReason: 'event mutation request is incomplete or invalid',
        };
      }
      let preview;
      try {
        preview = await composition.gatewayEventApprovalPreview(
          parsed.data.actionId,
          parsed.data.payloadReference,
          sessionKey,
        );
      } catch (error) {
        return {
          block: true,
          blockReason: error instanceof Error
            ? error.message
            : 'event mutation cannot be approved',
        };
      }
      const nonce = randomUUID();
      const description = [
        'Diese Änderung genau einmal ausführen',
        `Ziel: ${preview.target}`,
        `Aktion: ${preview.summary}`,
        '',
        ...preview.changes.map((change) =>
          `${change.field}: ${displayValue(change.before) ?? '—'} → ${
            displayValue(change.after) ?? '—'
          }`),
        '',
        `Prüfreferenz: ${parsed.data.payloadReference}`,
        'Der aktuelle Stand wird vor dem Schreiben erneut geprüft und danach zur Kontrolle erneut gelesen.',
      ].join('\n');
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
            approvedEventCalls.authorize(nonce, {
              actionId: parsed.data.actionId,
              payloadReference: parsed.data.payloadReference,
              sessionKey,
              toolCallId,
            });
          },
        },
      };
    }
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
          approvedCalls.authorize(nonce, {
            actionId: parsed.data.actionId,
            payloadReference: parsed.data.payloadReference,
            sessionKey,
            toolCallId,
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
      const eventBaseUrlRaw = process.env.MSC_EVENT_API_URL?.trim();
      const mutationAuth = eventMutationAuthConfiguration();
      if (mutationAuth && !eventBaseUrlRaw) {
        throw new Error(
          'MSC_EVENT_API_URL is required when event automation credentials are configured.',
        );
      }
      const eventMutationTransport = eventBaseUrlRaw && mutationAuth
        ? new EventEntryHttpMutationTransport({
          baseUrl: parseBaseUrl(eventBaseUrlRaw),
          tokenProvider: (scope) => loadAccessToken({
            env: {
              ...mutationAuth.tokenEnv,
              MSC_EVENT_COGNITO_SCOPE: scope,
            },
          }),
          scopePrefix: mutationAuth.scopePrefix,
        })
        : undefined;
      const candidate = new MscMailProductionComposition({
        ...options,
        ...(eventMutationTransport === undefined
          ? {}
          : { eventMutationTransport }),
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
