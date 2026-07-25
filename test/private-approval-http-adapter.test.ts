import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApprovalHttpContract,
  AuthenticatedApprovalSession,
} from '../src/approval-http.js';
import { PrivateApprovalHttpAdapter } from '../src/private-approval-http-adapter.js';

class FakeResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body = Buffer.alloc(0);

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(body?: string | Uint8Array): this {
    this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    return this;
  }
}

const request = (
  path: string,
  method = 'GET',
  body?: string,
): IncomingMessage => {
  const stream = Readable.from(body === undefined ? [] : [body]);
  return Object.assign(stream, {
    url: path,
    method,
    headers: body === undefined
      ? {}
      : {
        origin: 'https://approval.example',
        'content-type': 'application/json',
      },
  }) as IncomingMessage;
};

test('creates a private server adapter without binding or starting it', () => {
  const adapter = new PrivateApprovalHttpAdapter({
    bindAddress: '127.0.0.1',
    port: 8443,
    publicOrigin: 'https://approval.example',
    contract: {
      async handle() {
        return Response.json({ ok: true });
      },
    } as unknown as ApprovalHttpContract,
    async resolveSession() {
      return { actor: 'vinzenz', csrfToken: 'csrf' };
    },
  });
  assert.deepEqual(adapter.binding, { address: '127.0.0.1', port: 8443 });
  assert.equal(adapter.server.listening, false);
  adapter.server.close();
});

test('bridges only origin-form requests and injects the trusted session', async () => {
  const handled: Array<{ url: string; actor: string | undefined }> = [];
  const adapter = new PrivateApprovalHttpAdapter({
    bindAddress: '10.20.30.40',
    port: 8443,
    publicOrigin: 'https://approval.example',
    contract: {
      async handle(
        fetchRequest: Request,
        session?: AuthenticatedApprovalSession,
      ) {
        handled.push({ url: fetchRequest.url, actor: session?.actor });
        return new Response('page', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    } as unknown as ApprovalHttpContract,
    async resolveSession() {
      return { actor: 'vinzenz', csrfToken: 'server-csrf' };
    },
  });
  const response = new FakeResponse();
  await adapter.handleNodeRequest(
    request('/approve/10000000-0000-4000-8000-000000000001'),
    response as unknown as ServerResponse,
  );
  assert.deepEqual(handled, [{
    url: 'https://approval.example/approve/10000000-0000-4000-8000-000000000001',
    actor: 'vinzenz',
  }]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), 'page');
  assert.equal(adapter.server.listening, false);
  adapter.server.close();
});

test('refuses public or wildcard bind addresses and oversized bodies', async () => {
  assert.throws(
    () => new PrivateApprovalHttpAdapter({
      bindAddress: '0.0.0.0',
      port: 8443,
      publicOrigin: 'https://approval.example',
      contract: {} as ApprovalHttpContract,
      async resolveSession() {
        return undefined;
      },
    }),
    /private IP/,
  );

  let called = false;
  const adapter = new PrivateApprovalHttpAdapter({
    bindAddress: '::1',
    port: 8443,
    publicOrigin: 'https://approval.example',
    contract: {
      async handle() {
        called = true;
        return Response.json({ ok: true });
      },
    } as unknown as ApprovalHttpContract,
    async resolveSession() {
      return undefined;
    },
  });
  const response = new FakeResponse();
  await adapter.handleNodeRequest(
    request('/api/approvals/id/decision', 'POST', 'x'.repeat(65 * 1024)),
    response as unknown as ServerResponse,
  );
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  assert.equal(adapter.server.listening, false);
  adapter.server.close();
});
