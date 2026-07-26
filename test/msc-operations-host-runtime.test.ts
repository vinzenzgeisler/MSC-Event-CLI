import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import type { InactiveMscEventChangeRuntime } from '../src/event-change-runtime.js';
import type { InactiveMscMailFlowRuntime } from '../src/mail-flow-runtime.js';
import { MscOperationsHostRuntime } from '../src/msc-operations-host-runtime.js';
import type { PrivateApprovalHttpAdapter } from '../src/private-approval-http-adapter.js';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const fixture = (overrides: {
  mail?: () => Promise<[]>;
  event?: () => Promise<[]>;
  listen?: () => Promise<void>;
  close?: () => Promise<void>;
  interval?: number;
  runImmediately?: boolean;
  onWorkerError?: (worker: 'mail' | 'event', error: unknown) => void;
} = {}) => {
  const server = createServer();
  const calls = { listen: 0, close: 0 };
  const adapter = {
    server,
    binding: { address: '127.0.0.1', port: 8443 },
  } as PrivateApprovalHttpAdapter;
  const mail = overrides.mail ?? (async () => []);
  const event = overrides.event;
  const runtime = new MscOperationsHostRuntime({
    approvalAdapter: adapter,
    mailRuntime: { runWorkerOnce: mail } as unknown as InactiveMscMailFlowRuntime,
    ...(event
      ? {
          eventRuntime: {
            runWorkerOnce: event,
          } as unknown as InactiveMscEventChangeRuntime,
        }
      : {}),
    workerIntervalMs: overrides.interval ?? 60_000,
    runImmediately: overrides.runImmediately ?? false,
    ...(overrides.onWorkerError ? { onWorkerError: overrides.onWorkerError } : {}),
    lifecycle: {
      async listen(_server: Server) {
        calls.listen += 1;
        await overrides.listen?.();
      },
      async close(_server: Server) {
        calls.close += 1;
        await overrides.close?.();
      },
    },
  });
  return { runtime, server, calls };
};

test('construction is inert and start/stop own the exact listener lifecycle', async () => {
  const { runtime, calls } = fixture();
  assert.equal(runtime.status, 'inactive');
  assert.deepEqual(calls, { listen: 0, close: 0 });
  await runtime.start();
  assert.equal(runtime.status, 'running');
  assert.deepEqual(calls, { listen: 1, close: 0 });
  await runtime.stop();
  assert.equal(runtime.status, 'inactive');
  assert.deepEqual(calls, { listen: 1, close: 1 });
});

test('coalesces overlapping ticks and waits for active work before closing', async () => {
  const gate = deferred();
  let cycles = 0;
  const { runtime, calls } = fixture({
    mail: async () => {
      cycles += 1;
      await gate.promise;
      return [];
    },
  });
  await runtime.start();
  const first = runtime.runWorkersOnce();
  const second = runtime.runWorkersOnce();
  assert.equal(first, second);
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(runtime.status, 'stopping');
  assert.equal(calls.close, 0);
  gate.resolve();
  await stopping;
  assert.equal(cycles, 1);
  assert.equal(calls.close, 1);
});

test('isolates worker failures and can run the initial cycle explicitly', async () => {
  const errors: Array<{ worker: string; error: unknown }> = [];
  let eventRuns = 0;
  const failure = new Error('smtp unavailable');
  const { runtime } = fixture({
    runImmediately: true,
    mail: async () => { throw failure; },
    event: async () => {
      eventRuns += 1;
      return [];
    },
    onWorkerError(worker, error) {
      errors.push({ worker, error });
    },
  });
  await runtime.start();
  assert.equal(eventRuns, 1);
  assert.deepEqual(errors, [{ worker: 'mail', error: failure }]);
  assert.equal(runtime.status, 'running');
  await runtime.stop();
});

test('rolls back listener startup failures and remains restartable', async () => {
  let fail = true;
  const { runtime, calls } = fixture({
    listen: async () => {
      if (fail) throw new Error('address unavailable');
    },
  });
  await assert.rejects(runtime.start(), /address unavailable/);
  assert.equal(runtime.status, 'inactive');
  assert.deepEqual(calls, { listen: 1, close: 1 });
  fail = false;
  await runtime.start();
  assert.equal(runtime.status, 'running');
  await runtime.stop();
});

test('rejects invalid worker configuration', () => {
  const server = createServer();
  assert.throws(() => new MscOperationsHostRuntime({
    approvalAdapter: {
      server,
      binding: { address: '127.0.0.1', port: 8443 },
    } as PrivateApprovalHttpAdapter,
    workerIntervalMs: 10,
    runImmediately: false,
  }), /worker runtime|required/);
  assert.throws(() => new MscOperationsHostRuntime({
    approvalAdapter: {
      server,
      binding: { address: '127.0.0.1', port: 8443 },
    } as PrivateApprovalHttpAdapter,
    mailRuntime: {
      async runWorkerOnce() {
        return [];
      },
    } as unknown as InactiveMscMailFlowRuntime,
    workerIntervalMs: 1,
    runImmediately: false,
  }), /workerIntervalMs/);
  server.close();
});
