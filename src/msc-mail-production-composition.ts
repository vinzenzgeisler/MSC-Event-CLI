import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { ApprovedActionOutboxCoordinator } from './approval-execution.js';
import { SqliteDurableOutbox } from './durable-outbox.js';
import {
  createMailReplyOutboxAdapter,
  MscMailFlow,
} from './mail-flow.js';
import { InactiveMscMailFlowRuntime } from './mail-flow-runtime.js';
import type { MscMailAccountPolicy } from './mail-approved-action.js';
import { MscMailReadonlyProvider } from './mail-readonly-provider.js';
import { MailOutboxDispatchWorker } from './mail-outbox-transport.js';
import { MscApprovalReviewComposition } from './msc-approval-review-composition.js';
import { MscApprovalHttpRouter } from './msc-approval-http-router.js';
import { MscOperationsHostRuntime } from './msc-operations-host-runtime.js';
import {
  createInitialPasskeyBootstrapAuthorizer,
  PasskeyBootstrapService,
} from './passkey-bootstrap.js';
import { PasskeyRegistrationHttpContract } from './passkey-registration-http.js';
import { PrivateApprovalHttpAdapter } from './private-approval-http-adapter.js';
import {
  SmtpMailTransport,
  type SmtpClientFactory,
  type SmtpMailAccountConfig,
} from './smtp-mail-transport.js';
import {
  TrustedProxyApprovalSessionResolver,
} from './trusted-proxy-approval-session.js';
import type { WebAuthnFreshAuthOptions } from './webauthn.js';
import {
  WebAuthnRegistrationService,
  type WebAuthnRegistrationOptions,
} from './webauthn-registration.js';

export interface MscMailProductionCompositionOptions {
  stateDatabasePath: string;
  encryptionKey: Uint8Array;
  signingKey: Buffer;
  sessionCsrfKey: Uint8Array;
  publicOrigin: string;
  basePath: string;
  rpId: string;
  reviewerActor: string;
  trustedProxyAddresses: string[];
  trustConfiguredActorWithoutHeader?: boolean;
  bindAddress: string;
  port: number;
  workerIntervalMs: number;
  workerId: string;
  messageIdDomain: string;
  mailPolicy: MscMailAccountPolicy;
  smtpAccounts: SmtpMailAccountConfig[];
  verifyAuthentication?: WebAuthnFreshAuthOptions['verifyAuthentication'];
  verifyRegistration?: WebAuthnRegistrationOptions['verifyRegistration'];
  smtpClientFactory?: SmtpClientFactory;
  providerRunner?: ConstructorParameters<typeof MscMailReadonlyProvider>[0];
  lifecycle?: {
    listen(
      server: Server,
      binding: Readonly<{ address: string; port: number }>,
    ): Promise<void>;
    close(server: Server): Promise<void>;
  };
}

/**
 * Complete mail-only production composition.
 *
 * Construction opens local encrypted state and creates clients, but performs
 * no network operation. start() is the sole activation point for the private
 * listener and worker cadence. Event mutations are intentionally absent.
 */
export class MscMailProductionComposition {
  readonly review: MscApprovalReviewComposition;
  readonly outbox: SqliteDurableOutbox;
  readonly flow: MscMailFlow;
  readonly mailRuntime: InactiveMscMailFlowRuntime;
  readonly bootstrap: PasskeyBootstrapService;
  readonly registration: WebAuthnRegistrationService;
  readonly registrationHttp: PasskeyRegistrationHttpContract;
  readonly router: MscApprovalHttpRouter;
  readonly sessionResolver: TrustedProxyApprovalSessionResolver;
  readonly adapter: PrivateApprovalHttpAdapter;
  readonly host: MscOperationsHostRuntime;
  private closed = false;

  constructor(options: MscMailProductionCompositionOptions) {
    this.review = new MscApprovalReviewComposition({
      stateDatabasePath: options.stateDatabasePath,
      encryptionKey: options.encryptionKey,
      signingKey: options.signingKey,
      publicOrigin: options.publicOrigin,
      basePath: options.basePath,
      rpId: options.rpId,
      expectedOrigins: [options.publicOrigin],
      async authorizeReviewer(actor) {
        return actor === options.reviewerActor;
      },
      ...(options.verifyAuthentication === undefined
        ? {}
        : { verifyAuthentication: options.verifyAuthentication }),
    });
    try {
      this.outbox = new SqliteDurableOutbox(options.stateDatabasePath, {
        encryptionKey: options.encryptionKey,
      });
    } catch (error) {
      this.review.close();
      throw error;
    }
    try {
      this.bootstrap = new PasskeyBootstrapService({
        grants: this.review.webauthn,
      });
      this.registration = new WebAuthnRegistrationService({
        rpName: 'MSC-Freigabe',
        rpId: options.rpId,
        expectedOrigins: [options.publicOrigin],
        credentials: this.review.webauthn,
        challenges: this.review.webauthn,
        userIdForActor: (actor) => Promise.resolve(
          createHmac('sha256', options.signingKey)
            .update('approved-actions/webauthn-user/v1\0')
            .update(actor)
            .digest(),
        ),
        authorizeRegistration: createInitialPasskeyBootstrapAuthorizer(
          this.bootstrap,
        ),
        ...(options.verifyRegistration === undefined
          ? {}
          : { verifyRegistration: options.verifyRegistration }),
      });
      this.registrationHttp = new PasskeyRegistrationHttpContract(
        options.publicOrigin,
        options.basePath,
        this.registration,
      );
      this.router = new MscApprovalHttpRouter(
        options.basePath,
        this.review.http,
        this.registrationHttp,
      );
      const provider = new MscMailReadonlyProvider(options.providerRunner);
      const transport = new SmtpMailTransport(
        options.smtpAccounts,
        options.smtpClientFactory,
      );
      const worker = new MailOutboxDispatchWorker(
        this.outbox,
        transport,
        {
          workerId: options.workerId,
          messageIdDomain: options.messageIdDomain,
        },
      );
      this.flow = new MscMailFlow({
        provider,
        policy: options.mailPolicy,
        queue: this.review.queue,
        outboxCoordinator: new ApprovedActionOutboxCoordinator(
          this.review.queue,
          [createMailReplyOutboxAdapter(options.mailPolicy)],
        ),
        dispatchWorker: worker,
        approvalUrl: (actionId) => this.review.http.approvalUrl(actionId),
      });
      this.mailRuntime = new InactiveMscMailFlowRuntime(
        this.flow,
        this.review.http,
        this.review.queue,
      );
      this.sessionResolver = new TrustedProxyApprovalSessionResolver({
        publicOrigin: options.publicOrigin,
        actor: options.reviewerActor,
        csrfKey: options.sessionCsrfKey,
        trustedProxyAddresses: options.trustedProxyAddresses,
        ...(options.trustConfiguredActorWithoutHeader === undefined
          ? {}
          : {
              trustConfiguredActorWithoutHeader:
                options.trustConfiguredActorWithoutHeader,
            }),
      });
      this.adapter = new PrivateApprovalHttpAdapter({
        bindAddress: options.bindAddress,
        port: options.port,
        publicOrigin: options.publicOrigin,
        contract: this.router,
        resolveSession: (request) => Promise.resolve(
          this.sessionResolver.resolve(request),
        ),
      });
      this.host = new MscOperationsHostRuntime({
        approvalAdapter: this.adapter,
        mailRuntime: this.mailRuntime,
        workerIntervalMs: options.workerIntervalMs,
        runImmediately: true,
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
      });
    } catch (error) {
      this.outbox.close();
      this.review.close();
      throw error;
    }
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('production composition is closed'));
    return this.host.start();
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    await this.host.stop();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.outbox.close();
    this.review.close();
  }
}
