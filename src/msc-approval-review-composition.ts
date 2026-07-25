import { ApprovalHttpContract } from './approval-http.js';
import { SqliteApprovalStore } from './approval-sqlite.js';
import { ApprovalQueue, type ApprovalRecord } from './approval.js';
import { EventEntryChangePreviewRenderer } from './event-approved-action.js';
import {
  MailReplyPreviewRenderer,
  MailSendPreviewRenderer,
} from './mail-approved-action.js';
import {
  WebAuthnFreshAuthVerifier,
  type WebAuthnFreshAuthOptions,
} from './webauthn.js';
import { SqliteWebAuthnStore } from './webauthn-sqlite.js';

export interface MscApprovalReviewCompositionOptions {
  stateDatabasePath: string;
  encryptionKey: Uint8Array;
  signingKey: Buffer;
  publicOrigin: string;
  rpId: string;
  expectedOrigins: string[];
  authorizeReviewer(
    actor: string,
    record: ApprovalRecord,
  ): Promise<boolean>;
  challengeTtlSeconds?: number;
  maxFreshAuthAgeSeconds?: number;
  now?: () => Date;
  verifyAuthentication?: WebAuthnFreshAuthOptions['verifyAuthentication'];
}

/**
 * Shared, inactive passkey review composition for Nennung and mail actions.
 * Both domains use one encrypted approval queue, one credential/challenge
 * store, one URL surface and one fresh-auth verifier. It owns no HTTP listener,
 * session middleware, worker, mutation transport or mail transport.
 */
export class MscApprovalReviewComposition {
  readonly approvals: SqliteApprovalStore;
  readonly webauthn: SqliteWebAuthnStore;
  readonly freshAuth: WebAuthnFreshAuthVerifier;
  readonly queue: ApprovalQueue;
  readonly http: ApprovalHttpContract;
  private closed = false;

  constructor(options: MscApprovalReviewCompositionOptions) {
    this.approvals = new SqliteApprovalStore(options.stateDatabasePath, {
      encryptionKey: options.encryptionKey,
    });
    try {
      this.webauthn = new SqliteWebAuthnStore(options.stateDatabasePath);
    } catch (error) {
      this.approvals.close();
      throw error;
    }
    try {
      this.freshAuth = new WebAuthnFreshAuthVerifier({
        rpId: options.rpId,
        expectedOrigins: options.expectedOrigins,
        credentials: this.webauthn,
        challenges: this.webauthn,
        ...(options.challengeTtlSeconds === undefined
          ? {}
          : { challengeTtlSeconds: options.challengeTtlSeconds }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.verifyAuthentication === undefined
          ? {}
          : { verifyAuthentication: options.verifyAuthentication }),
      });
      this.queue = new ApprovalQueue({
        store: this.approvals,
        signingKey: options.signingKey,
        freshAuthVerifier: this.freshAuth,
        ...(options.maxFreshAuthAgeSeconds === undefined
          ? {}
          : { maxFreshAuthAgeSeconds: options.maxFreshAuthAgeSeconds }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      this.http = new ApprovalHttpContract({
        publicOrigin: options.publicOrigin,
        queue: this.queue,
        renderers: [
          new EventEntryChangePreviewRenderer(),
          new MailReplyPreviewRenderer(),
          new MailSendPreviewRenderer(),
        ],
        authorizeReviewer: options.authorizeReviewer,
        beginFreshAuth: (actor, context) => this.freshAuth.begin(actor, context),
      });
    } catch (error) {
      this.webauthn.close();
      this.approvals.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.webauthn.close();
    this.approvals.close();
  }
}
