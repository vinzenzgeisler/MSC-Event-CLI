import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { AuthenticatedApprovalSession } from './approval-http.js';

export interface ApprovalRequestHandler {
  handle(
    request: Request,
    session?: AuthenticatedApprovalSession,
  ): Promise<Response>;
}

export interface PrivateApprovalHttpAdapterOptions {
  bindAddress: string;
  port: number;
  publicOrigin: string;
  contract: ApprovalRequestHandler;
  resolveSession(
    request: IncomingMessage,
  ): Promise<AuthenticatedApprovalSession | undefined>;
}

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(
    (part) => Number.isInteger(part) && part >= 0 && part <= 255,
  ) && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127
  );
};

const isPrivateBindAddress = (address: string): boolean => {
  if (address === '::1') return true;
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
};

const safePath = (value: string | undefined): string => {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    throw new Error('origin-form request target required');
  }
  return value;
};

const bodyFromRequest = async (
  request: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Buffer | undefined> => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error('request body exceeds 64 KiB');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const copyResponse = async (
  source: Response,
  target: ServerResponse,
): Promise<void> => {
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(source.status, headers);
  target.end(Buffer.from(await source.arrayBuffer()));
};

/**
 * Node HTTP bridge for the shared approval page.
 *
 * Construction creates an unbound server only. The adapter exposes no listen
 * or start method; a separately approved host integration must bind the exact
 * private address and port. Sessions come only from trusted server middleware.
 */
export class PrivateApprovalHttpAdapter {
  readonly server: Server;
  readonly binding: Readonly<{ address: string; port: number }>;
  private readonly publicOrigin: string;

  constructor(private readonly options: PrivateApprovalHttpAdapterOptions) {
    if (!isPrivateBindAddress(options.bindAddress)) {
      throw new Error('approval listener bind address must be a private IP');
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error('approval listener port must be between 1 and 65535');
    }
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin) {
      throw new Error('publicOrigin must be an exact HTTPS origin');
    }
    this.publicOrigin = origin.origin;
    this.binding = Object.freeze({
      address: options.bindAddress,
      port: options.port,
    });
    this.server = createServer((request, response) => {
      void this.handleNodeRequest(request, response);
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  async handleNodeRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const path = safePath(request.url);
      const body = await bodyFromRequest(request);
      const fetchRequest = new Request(`${this.publicOrigin}${path}`, {
        method: request.method ?? 'GET',
        headers: request.headers as Record<string, string>,
        ...(body === undefined ? {} : { body: body.toString('utf8') }),
      });
      const session = await this.options.resolveSession(request);
      await copyResponse(
        await this.options.contract.handle(fetchRequest, session),
        response,
      );
    } catch {
      response.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      });
      response.end('{"error":"invalid_request"}');
    }
  }
}
