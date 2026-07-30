import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { ActionPreview, JsonValue } from './action.js';
import type { MailDispatchResult } from './mail-outbox-transport.js';
import {
  ApprovedActionExecutionCoordinator,
  ApprovedActionOutboxCoordinator,
  type ApprovedActionExecution,
} from './approval-execution.js';
import { SqliteDurableOutbox } from './durable-outbox.js';
import {
  createMailReplyOutboxAdapter,
  createMailSendOutboxAdapter,
  MscMailFlow,
} from './mail-flow.js';
import { InactiveMscMailFlowRuntime } from './mail-flow-runtime.js';
import {
  MailReplyPreviewRenderer,
  MailSendPreviewRenderer,
  parseMailReplyIntent,
  parseMailSendIntent,
  type MscMailAccountPolicy,
} from './mail-approved-action.js';
import { MscMailReadonlyProvider } from './mail-readonly-provider.js';
import {
  EventEntryChangeAdapter,
  EventEntryChangePreviewRenderer,
  parseEventEntryChangeIntent,
  type EventEntryMutationTransport,
} from './event-approved-action.js';
import { MscEventReadonlyProvider } from './event-readonly-provider.js';
import { MscApprovalProposalWriter } from './msc-approval-proposal.js';
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
  operatorSessionKey?: string;
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
  eventProviderRunner?: ConstructorParameters<typeof MscEventReadonlyProvider>[0];
  eventMutationTransport?: EventEntryMutationTransport;
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
  readonly provider: MscMailReadonlyProvider;
  readonly smtpTransport: SmtpMailTransport;
  readonly eventProvider: MscEventReadonlyProvider | undefined;
  readonly eventProposals: MscApprovalProposalWriter | undefined;
  readonly eventCoordinator: ApprovedActionExecutionCoordinator | undefined;
  private closed = false;
  private readonly reviewerActor: string;
  private readonly operatorSessionKey: string | undefined;

  constructor(options: MscMailProductionCompositionOptions) {
    this.reviewerActor = options.reviewerActor;
    this.operatorSessionKey = options.operatorSessionKey;
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
      this.provider = new MscMailReadonlyProvider(options.providerRunner);
      this.smtpTransport = new SmtpMailTransport(
        options.smtpAccounts,
        options.smtpClientFactory,
      );
      const worker = new MailOutboxDispatchWorker(
        this.outbox,
        this.smtpTransport,
        {
          workerId: options.workerId,
          messageIdDomain: options.messageIdDomain,
        },
      );
      this.flow = new MscMailFlow({
        provider: this.provider,
        policy: options.mailPolicy,
        queue: this.review.queue,
        outboxCoordinator: new ApprovedActionOutboxCoordinator(
          this.review.queue,
          [
            createMailReplyOutboxAdapter(options.mailPolicy),
            createMailSendOutboxAdapter(options.mailPolicy),
          ],
        ),
        dispatchWorker: worker,
        approvalUrl: (actionId) => this.review.http.approvalUrl(actionId),
      });
      this.mailRuntime = new InactiveMscMailFlowRuntime(
        this.flow,
        this.review.http,
        this.review.queue,
      );
      this.eventProvider = options.eventMutationTransport
        ? new MscEventReadonlyProvider(options.eventProviderRunner)
        : undefined;
      this.eventProposals = this.eventProvider
        ? new MscApprovalProposalWriter(
          this.eventProvider,
          this.provider,
          this.review.queue,
          options.publicOrigin + options.basePath,
          options.mailPolicy,
        )
        : undefined;
      this.eventCoordinator = this.eventProvider && options.eventMutationTransport
        ? new ApprovedActionExecutionCoordinator(this.review.queue, [
          new EventEntryChangeAdapter(
            (entryId) => this.eventProvider!.detail(entryId) as Promise<JsonValue>,
            options.eventMutationTransport,
          ),
        ])
        : undefined;
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

  async gatewayApprovalPreview(
    actionId: string,
    payloadReference: string,
    sessionKey: string,
  ): Promise<ActionPreview> {
    this.assertGatewayOperatorSession(sessionKey);
    const record = await this.review.queue.review(actionId);
    if (record.intent.kind !== 'mail.reply' && record.intent.kind !== 'mail.send') {
      throw new Error('gateway approval supports only mail actions');
    }
    if (record.payloadHash.slice(0, 12) !== payloadReference) {
      throw new Error('payload reference does not match the pending action');
    }
    return record.intent.kind === 'mail.reply'
      ? new MailReplyPreviewRenderer().render(parseMailReplyIntent(record.intent))
      : new MailSendPreviewRenderer().render(parseMailSendIntent(record.intent));
  }

  async gatewayEventApprovalPreview(
    actionId: string,
    payloadReference: string,
    sessionKey: string,
  ): Promise<ActionPreview> {
    this.assertGatewayOperatorSession(sessionKey);
    if (!this.eventCoordinator) {
      throw new Error('MSC event mutation service is not configured');
    }
    const record = await this.review.queue.review(actionId);
    if (record.intent.kind !== 'event.entry.update') {
      throw new Error('gateway event approval supports only entry updates');
    }
    if (record.payloadHash.slice(0, 12) !== payloadReference) {
      throw new Error('payload reference does not match the pending action');
    }
    return new EventEntryChangePreviewRenderer().render(
      parseEventEntryChangeIntent(record.intent),
    );
  }

  async approveAndExecuteEventFromGateway(options: {
    actionId: string;
    payloadReference: string;
    sessionKey: string;
    toolCallId: string;
  }): Promise<ApprovedActionExecution> {
    this.assertGatewayOperatorSession(options.sessionKey);
    if (!this.eventCoordinator) {
      throw new Error('MSC event mutation service is not configured');
    }
    await this.gatewayEventApprovalPreview(
      options.actionId,
      options.payloadReference,
      options.sessionKey,
    );
    const decidedAt = new Date().toISOString();
    await this.review.approvals.decide({
      actionId: options.actionId,
      decision: 'approve',
      decidedAt,
      decidedBy: this.reviewerActor,
      expiresAfter: decidedAt,
      authenticationMethod: 'gateway-operator',
      assertionId: `openclaw-plugin:${options.toolCallId}`,
    });
    return this.eventCoordinator.execute(options.actionId);
  }

  async assertGatewaySmtpReady(
    actionId: string,
    payloadReference: string,
    sessionKey: string,
  ): Promise<void> {
    this.assertGatewayOperatorSession(sessionKey);
    const record = await this.review.queue.review(actionId);
    if (record.intent.kind !== 'mail.reply' && record.intent.kind !== 'mail.send') {
      throw new Error('gateway approval supports only mail actions');
    }
    if (record.payloadHash.slice(0, 12) !== payloadReference) {
      throw new Error('payload reference does not match the pending action');
    }
    const account = record.intent.kind === 'mail.reply'
      ? parseMailReplyIntent(record.intent).after.account
      : parseMailSendIntent(record.intent).after.account;
    const readiness = await this.smtpTransport.checkReady(account);
    if (!readiness.ready) {
      throw new Error(
        'STRATO-SMTP ist nicht erreichbar; die Mailfreigabe wurde nicht angefordert oder verbraucht',
      );
    }
  }

  async approveAndDispatchFromGateway(options: {
    actionId: string;
    payloadReference: string;
    sessionKey: string;
    toolCallId: string;
  }): Promise<MailDispatchResult> {
    this.assertGatewayOperatorSession(options.sessionKey);
    const record = await this.review.queue.review(options.actionId);
    if (record.intent.kind !== 'mail.reply' && record.intent.kind !== 'mail.send') {
      throw new Error('gateway approval supports only mail actions');
    }
    if (record.payloadHash.slice(0, 12) !== options.payloadReference) {
      throw new Error('payload reference does not match the pending action');
    }
    const decidedAt = new Date().toISOString();
    await this.review.approvals.decide({
      actionId: options.actionId,
      decision: 'approve',
      decidedAt,
      decidedBy: this.reviewerActor,
      expiresAfter: decidedAt,
      authenticationMethod: 'gateway-operator',
      assertionId: `openclaw-plugin:${options.toolCallId}`,
    });
    try {
      return await this.flow.dispatchApproved(options.actionId);
    } catch (error) {
      try {
        const outbox = this.outbox.get(options.actionId);
        if (outbox.status === 'accepted' || outbox.status === 'uncertain') {
          return {
            actionId: options.actionId,
            attemptId: outbox.attemptId ?? 'unknown',
            messageId: 'redacted',
            status: outbox.status,
          };
        }
      } catch {
        // Preserve the original dispatch error when no durable hand-off exists.
      }
      throw error;
    }
  }

  private assertGatewayOperatorSession(sessionKey: string): void {
    if (!this.operatorSessionKey || sessionKey !== this.operatorSessionKey) {
      throw new Error('gateway operator approval is not enabled for this session');
    }
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
