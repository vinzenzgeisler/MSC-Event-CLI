import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { AuthenticatedApprovalSession } from './approval-http.js';

export interface TrustedProxyApprovalSessionOptions {
  publicOrigin: string;
  actor: string;
  csrfKey: Uint8Array;
  trustedProxyAddresses: string[];
}

const normalizeAddress = (value: string): string =>
  value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;

const exactHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
};

/**
 * Session boundary for an identity-aware reverse proxy.
 *
 * The application accepts the actor header only from one of the exact private
 * proxy addresses configured by the host. The proxy must overwrite, not append,
 * all three forwarded headers. The CSRF value is derived server-side and never
 * accepted from proxy or client input.
 */
export class TrustedProxyApprovalSessionResolver {
  private readonly origin: URL;
  private readonly actor: string;
  private readonly csrfKey: Buffer;
  private readonly trustedProxyAddresses: Set<string>;

  constructor(options: TrustedProxyApprovalSessionOptions) {
    this.origin = new URL(options.publicOrigin);
    if (this.origin.protocol !== 'https:' ||
        this.origin.origin !== options.publicOrigin) {
      throw new Error('publicOrigin must be an exact HTTPS origin');
    }
    this.actor = options.actor.trim();
    if (!this.actor || this.actor.length > 128 ||
        /[\r\n\0]/.test(this.actor)) {
      throw new Error('approval actor is invalid');
    }
    if (options.csrfKey.byteLength !== 32) {
      throw new Error('approval session CSRF key must contain exactly 32 bytes');
    }
    this.csrfKey = Buffer.from(options.csrfKey);
    const addresses = options.trustedProxyAddresses.map(normalizeAddress);
    if (addresses.length === 0 ||
        addresses.some((address) => isIP(address) === 0)) {
      throw new Error('at least one exact trusted proxy IP is required');
    }
    this.trustedProxyAddresses = new Set(addresses);
  }

  resolve(request: IncomingMessage): AuthenticatedApprovalSession | undefined {
    const remoteAddress = request.socket.remoteAddress;
    if (!remoteAddress ||
        !this.trustedProxyAddresses.has(normalizeAddress(remoteAddress))) {
      return undefined;
    }
    const actor = exactHeader(request, 'x-msc-approval-actor');
    const proto = exactHeader(request, 'x-forwarded-proto');
    const host = exactHeader(request, 'x-forwarded-host');
    if (!actor || !safeEqual(actor, this.actor) ||
        proto !== 'https' || host !== this.origin.host) {
      return undefined;
    }
    const csrfToken = createHmac('sha256', this.csrfKey)
      .update('msc-approval-session-csrf-v1\0')
      .update(this.actor)
      .update('\0')
      .update(this.origin.origin)
      .digest('base64url');
    return { actor: this.actor, csrfToken };
  }
}
