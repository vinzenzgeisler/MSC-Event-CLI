import type { Server } from 'node:http';
import type { EventChangeWorkerResult, InactiveMscEventChangeRuntime } from './event-change-runtime.js';
import type { MailFlowWorkerResult, InactiveMscMailFlowRuntime } from './mail-flow-runtime.js';
import type { PrivateApprovalHttpAdapter } from './private-approval-http-adapter.js';

export type MscOperationsWorker = 'mail' | 'event';

export interface MscOperationsWorkerCycleResult {
  worker: MscOperationsWorker;
  ok: boolean;
  results?: MailFlowWorkerResult[] | EventChangeWorkerResult[];
  error?: unknown;
}

export interface MscOperationsHostRuntimeOptions {
  approvalAdapter: PrivateApprovalHttpAdapter;
  mailRuntime?: InactiveMscMailFlowRuntime;
  eventRuntime?: InactiveMscEventChangeRuntime;
  workerIntervalMs: number;
  runImmediately: boolean;
  onWorkerError?(worker: MscOperationsWorker, error: unknown): void;
  onListenerError?(error: Error): void;
  lifecycle?: {
    listen(
      server: Server,
      binding: Readonly<{ address: string; port: number }>,
    ): Promise<void>;
    close(server: Server): Promise<void>;
  };
}

const listen = (
  server: Server,
  binding: Readonly<{ address: string; port: number }>,
): Promise<void> => new Promise((resolve, reject) => {
  const onListening = (): void => {
    server.off('error', onError);
    resolve();
  };
  const onError = (error: Error): void => {
    server.off('listening', onListening);
    reject(error);
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen({
    host: binding.address,
    port: binding.port,
    exclusive: true,
  });
});

const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

const DEFAULT_LIFECYCLE = { listen, close };

/**
 * Explicit host lifecycle for the approval listener and both execution workers.
 *
 * Construction is inert. Only start() binds the already validated private
 * listener and starts the worker timer. Worker cycles are coalesced, so a slow
 * cycle can never overlap the next timer tick. stop() prevents new work, waits
 * for the active cycle and then closes the listener.
 */
export class MscOperationsHostRuntime {
  private state: 'inactive' | 'starting' | 'running' | 'stopping' = 'inactive';
  private timer: NodeJS.Timeout | undefined;
  private activeCycle: Promise<MscOperationsWorkerCycleResult[]> | undefined;
  private readonly lifecycle: NonNullable<MscOperationsHostRuntimeOptions['lifecycle']>;
  private readonly listenerErrorHandler = (error: Error): void => {
    try {
      this.options.onListenerError?.(error);
    } catch {
      // An observability callback must never crash the host process.
    }
  };

  constructor(private readonly options: MscOperationsHostRuntimeOptions) {
    if (!Number.isInteger(options.workerIntervalMs) ||
        options.workerIntervalMs < 10 ||
        options.workerIntervalMs > 86_400_000) {
      throw new Error('workerIntervalMs must be between 10 and 86400000');
    }
    if (!options.mailRuntime && !options.eventRuntime) {
      throw new Error('at least one operations worker runtime is required');
    }
    this.lifecycle = options.lifecycle ?? DEFAULT_LIFECYCLE;
  }

  get status(): 'inactive' | 'starting' | 'running' | 'stopping' {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== 'inactive') {
      throw new Error(`operations host runtime is ${this.state}`);
    }
    this.state = 'starting';
    const server = this.options.approvalAdapter.server;
    server.on('error', this.listenerErrorHandler);
    try {
      await this.lifecycle.listen(server, this.options.approvalAdapter.binding);
      this.state = 'running';
      this.timer = setInterval(() => {
        void this.runWorkersOnce();
      }, this.options.workerIntervalMs);
      this.timer.unref();
      if (this.options.runImmediately) {
        await this.runWorkersOnce();
      }
    } catch (error) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      server.off('error', this.listenerErrorHandler);
      await this.lifecycle.close(server).catch(() => undefined);
      this.state = 'inactive';
      throw error;
    }
  }

  runWorkersOnce(): Promise<MscOperationsWorkerCycleResult[]> {
    if (this.state !== 'running') {
      return Promise.reject(new Error(`operations host runtime is ${this.state}`));
    }
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.executeWorkerCycle();
    this.activeCycle = cycle;
    void cycle.finally(() => {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    });
    return cycle;
  }

  async stop(): Promise<void> {
    if (this.state === 'inactive') return;
    if (this.state !== 'running') {
      throw new Error(`operations host runtime is ${this.state}`);
    }
    this.state = 'stopping';
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.activeCycle) await this.activeCycle;
    const server = this.options.approvalAdapter.server;
    try {
      await this.lifecycle.close(server);
    } finally {
      server.off('error', this.listenerErrorHandler);
      this.state = 'inactive';
    }
  }

  private async executeWorkerCycle(): Promise<MscOperationsWorkerCycleResult[]> {
    const workers: Array<{
      worker: MscOperationsWorker;
      run(): Promise<MailFlowWorkerResult[] | EventChangeWorkerResult[]>;
    }> = [];
    if (this.options.mailRuntime) {
      workers.push({
        worker: 'mail',
        run: () => this.options.mailRuntime!.runWorkerOnce(),
      });
    }
    if (this.options.eventRuntime) {
      workers.push({
        worker: 'event',
        run: () => this.options.eventRuntime!.runWorkerOnce(),
      });
    }
    return Promise.all(workers.map(async ({ worker, run }) => {
      try {
        return { worker, ok: true, results: await run() };
      } catch (error) {
        try {
          this.options.onWorkerError?.(worker, error);
        } catch {
          // An observability callback must never abort the other worker.
        }
        return { worker, ok: false, error };
      }
    }));
  }
}
