# MSC Admin-Automation

## Goal

OpenClaw may query and change the operational MSC event system without gaining
an unrestricted HTTP, SQL, shell, or secret-reading capability.

The integration covers the complete documented admin API through versioned,
typed operations. Backend routes remain the source of business rules. No
operation may accept an arbitrary URL, method, database statement, header set,
or unvalidated JSON body.

## Trust boundaries

1. **Query identity**
   - OAuth client credentials with read scopes only.
   - Typed filters, pagination, sorting, and bounded field projections.
   - Full records are available only through an explicit sensitive-data query.
   - Credentials, tokens, download URLs, and raw document contents never enter
     the model context, approval text, or audit log.
2. **Execution identity**
   - Separate OAuth client and secret, mounted only into the approval worker.
   - Granular scopes matching backend permissions.
   - The model and ordinary read-only tools cannot invoke this identity.
3. **Approval envelope**
   - Versioned operation kind, stable target, exact validated payload, current
     state hash, resulting state preview, action ID, reviewer, issue/expiry
     times, and idempotency key.
   - One-time approval and one-time backend consumption.
   - Backend rejects stale state, target substitution, replay, expired
     envelopes, unregistered operation kinds, and missing scopes.
4. **Verification**
   - Mutation response alone is insufficient.
   - The worker rereads the affected resource and compares it with the approved
     result before marking the action complete.
   - Unknown outcomes remain quarantined and are never retried automatically.

## Operation domains

### Registrations and people

- search/list active and deleted registrations
- full registration detail, driver, codriver, vehicles, documents, history
- acceptance and registration status
- payment status and payment amounts
- internal and driver notes
- class assignment
- check-in identity verification
- technical status and inspection decisions
- restore and soft delete

### Events and classes

- list, read, create, and update events
- activate, close, and archive event
- list, create, update, close, and delete classes
- pricing rules and invoice recalculation
- entry-confirmation defaults

### Finance and documents

- invoices and recorded payments
- waiver, technical-check, confirmation, and inspection QR generation
- export creation, status, and download metadata

### Communication

- outbox and delivery status
- templates, versions, placeholders, and preview
- recipient resolution
- lifecycle, reminder, and broadcast proposals
- sending and retrying remain separate externally consequential actions

### IAM

- roles and users
- role assignment and account status
- every IAM mutation is a separate critical-risk action and cannot be batched
  with event or registration changes

## Risk policy

- **Read:** no approval, but explicit projection and bounded result size.
- **Routine write:** one exact approval, stale-state check, idempotency, reread.
- **External side effect:** separate approval for mail, export publication, or
  document generation.
- **Destructive/security:** separate critical approval for delete, archive,
  IAM, authentication, or permission changes. No wildcard/batch approval.

## Delivery order

1. Comprehensive query provider and projection policy.
2. Entry mutations already represented by `event.entry.update`.
3. Event, class, finance, document, export, and communication contracts.
4. Backend OAuth scopes and one-time approval-envelope verification.
5. IAM and destructive operations after independent review.
6. Production installation, one marked acceptance test per risk class, and
   rollback verification.
