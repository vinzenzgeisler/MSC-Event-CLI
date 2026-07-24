# Approved actions prototype

This local prototype isolates write approval from the existing read-only MSC
providers. It does not call Himalaya, the Event API, or any production service.

## Existing-solutions preflight

- OpenClaw 2026.7.2 already has durable plugin permission requests, the
  authenticated `/approve/{id}` Control-UI route, first-answer-wins resolution,
  device/reviewer binding, expiry, and `allow-once`/`deny`. MSC actions should
  reuse that surface through a plugin `before_tool_call.requireApproval` hook
  rather than adding a second approval page or unauthenticated REST endpoint.
- The installed approval surface proves an authenticated operator with the
  `operator.approvals` scope, but its documented contract has no fresh
  WebAuthn/passkey challenge. This prototype therefore keeps fresh auth as a
  separate server-side verifier boundary before an approval can mint an
  execution proof.
- The Event backend contract already exposes preview and mutation endpoints.
  The current MSC Event CLI deliberately allows GET requests only, so write
  execution must remain a separate provider.
- Generic self-hosted human-in-the-loop gateways exist, but adopting one adds
  another security boundary and deployment. The smallest safe next step is a
  domain-specific queue behind the existing OpenClaw Control UI authentication.

## Proven flow

1. `propose` validates a workflow-independent, versioned `ActionIntent` and
   stores the complete before/after diff, target, expected current
   state, expiry (maximum one hour), payload hash, and idempotency key.
2. A reviewer sees the stored diff. `WebAuthnFreshAuthVerifier.begin` creates a
   short-lived, single-use challenge for a server-authenticated reviewer and
   binds it to action id, payload hash and decision. The browser never supplies
   reviewer identity, RP ID, origin or credential ownership.
3. `decide` passes the assertion to the verifier. The maintained
   `@simplewebauthn/server` implementation checks the exact challenge, RP ID,
   HTTPS origin, credential signature and mandatory user verification. The
   credential repository confirms ownership and atomically compares and updates
   the signature counter. The queue additionally rejects authentication results
   older than five minutes.
4. Approval returns an HMAC-authenticated, short-lived proof bound to the exact
   action payload and expiry. The signing key is injected and never persisted.
5. `consume` verifies the proof and current target-state hash, atomically marks
   the action consumed, and returns the intent exactly once.
6. Lifecycle events are appended to a JSONL audit file without storing the
   potentially personal before/after payload.

## Generic adapter boundary

- Action kinds are namespaced strings such as `mail.send` or `event.update`;
  the security core has no MSC-specific action union.
- `ActionIntent` accepts JSON values only, rejects unknown fields, limits
  names and the complete encoded intent, and identifies the target explicitly.
- `PreviewRenderer` returns a validated UI model with title, exact target,
  risk level, and field-level changes.
- `ExecutorAdapter` owns a kind-specific schema, reads current state, and
  performs execution. The contract explicitly requires callers to consume the
  one-time proof and compare state before invoking the adapter.
- No executor or transport implementation is registered in this prototype.

## Inert OpenClaw preview plugin

- `createInertApprovalHook` recognizes only the dedicated
  `approved_action_preview` seam. It never intercepts or authorizes a mail,
  Event API, shell, or other mutation tool.
- The hook validates and normalizes the complete `ActionIntent`, computes the
  same canonical SHA-256 used by the queue, places that hash in both the
  post-approval tool parameters and the human-facing prompt, and offers only
  `allow-once` or `deny`.
- Malformed intents are blocked before an approval is created. Timeouts and
  cancellations remain fail-closed under OpenClaw's approval contract.
- `plugin/index.mjs` is a native, locally loadable OpenClaw entry backed by
  `openclaw.plugin.json`. It registers only the optional
  `approved_action_preview` tool plus this hook.
- After approval, the tool recomputes the normalized intent hash and rejects a
  missing or changed hash. Its only result is the inert normalized preview and
  SHA-256; it has no executor, transport, credentials, network call, filesystem
  write, mail send, or Event API mutation.
- Loading the entry does not enable it. The host would still need an explicit
  plugin-path/configuration change and tool allowlist. Those runtime changes are
  intentionally not part of this local prototype.

## Transactional WebAuthn state

- `SqliteWebAuthnStore` implements both the challenge store and credential
  repository with Node's built-in SQLite driver. WAL mode and a busy timeout
  permit separate service connections to share the same database.
- A challenge is removed and returned with one atomic
  `DELETE ... RETURNING` statement, so two workers cannot verify the same
  ceremony.
- Credential updates compare the credential id, authenticator counter and an
  internal revision in one `UPDATE`. The revision always increments, including
  when a synced passkey legitimately keeps its signature counter at zero. A
  stale concurrent snapshot therefore fails closed even for counterless
  passkeys.
- Credential insertion is exposed as a narrow storage seam for the future
  registration ceremony.

## Transactional approval queue

- `ApprovalQueue` now depends on an explicit storage contract. The existing
  permission-restricted JSON/JSONL store remains available for isolated local
  tests, while `SqliteApprovalStore` supplies the shared production-shaped
  path.
- Idempotent proposal insertion, pending-to-decided transitions,
  approved-to-consumed transitions and their audit events run in
  `BEGIN IMMEDIATE` SQLite transactions. Status, expiry, payload hash and
  expected-state hash are compared again inside the transaction.
- Unique idempotency keys and conditional updates ensure that competing
  workers cannot approve or consume one action twice. The lifecycle audit is
  written in the same transaction and stores hashes plus bounded metadata, not
  the potentially personal intent body.

## Passkey registration boundary

- `WebAuthnRegistrationService` starts a short-lived, single-use registration
  ceremony only after a mandatory separate registration authorizer accepts it
  for a reviewer identity supplied by the trusted server. A normal authenticated
  browser session supplies neither authorization nor reviewer identity. RP ID,
  exact HTTPS origins, mandatory user presence and user verification are verified
  by SimpleWebAuthn before a credential is stored.
- A stable opaque WebAuthn user ID must be resolved server-side for the actor;
  the browser cannot choose it, and repeated credentials for one reviewer use
  the same WebAuthn identity. Existing credentials are excluded from the new
  ceremony.
- Registration challenges use the same atomic SQLite consume pattern as
  authentication challenges. New credentials start at repository revision
  zero.

## Initial passkey bootstrap

- `PasskeyBootstrapService.issue` creates a 256-bit random, actor-bound code
  with a maximum 15-minute lifetime. The database stores only its
  domain-separated SHA-256 hash. The plaintext code is returned once.
- No HTTP, plugin, approval-page or tool route can issue a code. Production must
  call `issue` only through `approved-actions-bootstrap`; wiring it to the
  browser session would violate the trust model. The command reads one absolute,
  root-owned JSON policy through `O_NOFOLLOW`; mode `0600` or group-readable
  `0640` is accepted, but group write and every world permission are rejected.
  It matches the current OS uid and requested reviewer against allowlists and
  takes neither uid nor database path from ordinary environment variables.
- Grant creation and a datensparsame audit event are committed in one SQLite
  transaction. The audit records operator uid, reviewer, grant id and expiry,
  but never the plaintext code or its secret component. The code is printed
  exactly once to stdout.
- `createInitialPasskeyBootstrapAuthorizer` accepts the exact code only while
  the actor has no credential. Actor mismatch, secret mismatch, expiry and
  replay all fail closed and burn the stored grant. It intentionally cannot add
  a second passkey; that later lifecycle needs fresh authentication with an
  already enrolled credential.
- A unique actor constraint and persistent consumed marker permit only one
  initial bootstrap grant per reviewer, including after the code is consumed.
  This deliberately fails closed if enrollment aborts; recovery must become a
  separate authenticated and audited operator procedure.
- SQLite issuance and consumption share the WebAuthn state database.
  `DELETE ... RETURNING` makes the grant single-use across service workers.
- This remains an inert service boundary: it does not expose a listener, enroll
  a real device, change OpenClaw configuration or activate the plugin.

## MSC mail send dry-run

- The `msc-mail` skill and confirmed provider policy remain authoritative:
  existing mailbox access stays read-only, direct Himalaya use remains
  forbidden, mailbox identities never mix and only `READY_TO_DRAFT` content can
  enter a send preview.
- `createMailSendIntent` accepts exactly one allowlisted MSC account, its active
  confirmed sender identity, one plain recipient address, a CR/LF-safe subject,
  plain-text body, confirmed sources and explicit uncertainties. `TBD`,
  inactive accounts, header injection and extra capabilities such as BCC,
  HTML or attachments fail validation.
- The preview renderer shows account, From, To, subject and the complete body
  as a high-risk change. Account, target, sender identity and expected policy
  state are bound to the same intent hash.
- `MailSendDryRunAdapter` deliberately accepts no transport dependency. Even
  after a valid approval proof it can only return the exact `wouldSend`
  structure with `dryRun: true`; it cannot invoke Himalaya, SMTP, a process,
  network or filesystem write.

## MSC mail reply dry-run

- A reply is bound to one exact read-only source tuple: MSC account, allowed
  folder, message id, original sender and original subject. The selected
  account's confirmed sender identity is derived from policy; the recipient is
  derived from the source sender and cannot be supplied independently.
- The intent repeats and validates account, source folder and source message id
  across target, before-state, after-state and expected current state. Any
  cross-account substitution, disallowed folder, recipient change, header
  injection or extra mail capability fails closed.
- Version 1 explicitly records `conversationContext: not-available`; it never
  claims knowledge of a thread or silently combines messages.
- The high-risk preview shows the exact source identity and complete reply.
  `MailReplyDryRunAdapter` accepts only a source-state reader and can return only
  the exact `wouldReply` structure with `dryRun: true`. It has no transport.

## Inert mobile approval HTTP contract

- `ApprovalHttpContract` produces an HTTPS approval link containing only the
  opaque action UUID. Every route requires a reviewer session injected by
  trusted server middleware; reviewer identity is never read from URL, headers
  or JSON. A mandatory server-side authorization callback must also allow that
  reviewer for the exact queued action.
- The review route returns the complete validated preview with `no-store`,
  anti-framing, no-referrer and no-sniff headers. Mutating routes additionally
  require exact same-origin JSON and a constant-time checked session CSRF token,
  with a 64 KiB body limit.
- Starting WebAuthn binds the server session actor, action id, payload hash and
  approve/reject decision. Completion additionally requires the verified
  passkey actor to equal the current authenticated session actor.
- This layer deliberately discards an approval execution proof and returns
  `executionAvailable: false`. It has no bound listener, Telegram sender,
  executor, transport or runtime registration; approving through this inert
  contract cannot perform the action.
- The contract now also serves a responsive German mobile page plus same-origin
  CSS and JavaScript assets. Untrusted preview values are inserted only with DOM
  `textContent`; the client uses neither HTML interpolation nor `innerHTML`.
  CSP permits only same-origin script, style and API connections.
- Approve and reject both start `navigator.credentials.get`, convert the
  WebAuthn binary fields explicitly and complete the decision with the
  session-bound CSRF token. The success state states that execution remains
  disabled.

## Protected state, retention and backup

- Complete approval intents are encrypted before SQLite persistence with
  AES-256-GCM. The 32-byte key is injected, never stored in the database, and
  each ciphertext uses a random nonce plus action-id-bound additional
  authenticated data. Swapping ciphertext between action rows fails closed.
- Lifecycle cleanup transactionally purges encrypted pending/approved records
  after expiry and rejected/consumed records after the configured retention
  threshold while retaining a datensparsame `purged` audit event.
- Expired authentication and registration challenges are deleted. Expired,
  unused initial-bootstrap grants may be deleted and reissued by an authorized
  operator; consumed initial-bootstrap trust locks are retained.
- `createEncryptedSqliteBackup` uses SQLite's online backup API inside a
  mode-`0700` temporary directory and writes an exclusive mode-`0600`
  AES-256-GCM backup. Restore is also exclusive, verifies authentication and
  runs `PRAGMA integrity_check` before publishing the database. Wrong keys and
  existing destination files fail closed.

## Internal dry-run execution worker

- `ApprovedActionExecutionCoordinator` discovers approved records internally
  and mints execution proofs server-side; the browser never receives a proof.
- It revalidates the kind-specific intent, reads the current target state and
  atomically consumes the one-time approval before invoking the adapter. Two
  workers racing the same action can invoke the adapter only once.
- Only inert dry-run adapters are suitable today. A productive mail transport
  must first add a durable outbox/dispatch state and explicitly reconcile
  uncertain SMTP outcomes; otherwise a crash could silently lose or duplicate
  a message.

## Privacy-minimized notification seam

- `ApprovalProposalService` persists the exact action before asking an injected
  notification sink to deliver its link. The notification id is stable per
  action so a future Telegram adapter can deduplicate retries.
- The German notification contains only the generic action kind, expiry,
  approval URL and a short payload-hash reference. Recipient, sender, subject,
  message body and source-message metadata never enter Telegram text.
- No Telegram adapter is registered in the prototype. Connecting a real chat is
  an external messaging action and remains separately approval-gated.

## Deliberate limits before production

- The legacy JSON/JSONL approval store remains single-process and is not a
  production option. Production must inject `SqliteApprovalStore` (or another
  store implementing the same transactional compare-and-update contract).
- The WebAuthn verifier is concrete and uses the maintained SimpleWebAuthn
  server implementation, transactional SQLite store, registration service and
  initial one-time bootstrap grant. Production still needs the separately
  authenticated local operator command that invokes bootstrap issuance,
  encrypted/permissioned database placement, backup/restore policy and
  lifecycle cleanup for expired challenges and grants. The included in-memory
  stores remain test/development-only. OpenClaw's existing operator session
  alone is not treated as fresh authentication.
- HMAC is sufficient for one trusted service boundary. Separate approval and
  execution services should use asymmetric signed proofs and key rotation.
- A productive mail transport and Event API adapters still need strict schemas,
  recipient/identity binding, preview parity tests, and dry-run transport seams.
- No existing read-only wrapper or `msc-mail` skill policy is changed.
