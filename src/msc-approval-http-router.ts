import type {
  ApprovalHttpContract,
  AuthenticatedApprovalSession,
} from './approval-http.js';
import type { PasskeyRegistrationHttpContract } from './passkey-registration-http.js';

export class MscApprovalHttpRouter {
  constructor(
    private readonly basePath: string,
    private readonly approvals: ApprovalHttpContract,
    private readonly registration: PasskeyRegistrationHttpContract,
  ) {}

  handle(
    request: Request,
    session?: AuthenticatedApprovalSession,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === `${this.basePath}/register` ||
        path === `${this.basePath}/assets/register.js` ||
        path.startsWith(`${this.basePath}/api/registration/`)) {
      return this.registration.handle(request, session);
    }
    return this.approvals.handle(request, session);
  }
}
