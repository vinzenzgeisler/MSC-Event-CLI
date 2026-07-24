import { parseActionIntent } from './action.js';
import {
  createInertApprovalHook,
  INERT_APPROVAL_TOOL_NAME,
  type BeforeToolCallEvent,
  type BeforeToolCallResult,
} from './approval-hook.js';
import { hashActionIntent } from './approval.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: {
    inert: true;
    payloadHash: string;
    intent: ReturnType<typeof parseActionIntent>;
  };
};

type PreviewTool = {
  name: typeof INERT_APPROVAL_TOOL_NAME;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
};

export interface ApprovedActionPreviewPluginApi {
  registerTool(tool: PreviewTool, options: { optional: true }): void;
  on(
    hook: 'before_tool_call',
    handler: (event: BeforeToolCallEvent) => Promise<BeforeToolCallResult | undefined>,
  ): void;
}

const createPreviewTool = (): PreviewTool => ({
  name: INERT_APPROVAL_TOOL_NAME,
  description:
    'Request one-time approval for an exact action preview and return its normalized intent and SHA-256. This tool never sends, updates, deletes, or executes anything.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['intent'],
    properties: {
      intent: {
        type: 'object',
        description: 'Versioned approved-action intent containing the complete before/after preview.',
      },
      payloadHash: {
        type: 'string',
        description: 'Injected by the approval hook. Callers should omit this value.',
      },
    },
  },
  async execute(_id, params) {
    const intent = parseActionIntent(params.intent);
    const payloadHash = hashActionIntent(intent);
    if (params.payloadHash !== payloadHash) {
      throw new Error('approved-action preview hash is missing or does not match the normalized intent');
    }
    const details = { inert: true as const, payloadHash, intent };
    return {
      content: [{ type: 'text', text: JSON.stringify(details) }],
      details,
    };
  },
});

export const registerApprovedActionPreviewPlugin = (api: ApprovedActionPreviewPluginApi): void => {
  api.registerTool(createPreviewTool(), { optional: true });
  api.on('before_tool_call', createInertApprovalHook());
};
