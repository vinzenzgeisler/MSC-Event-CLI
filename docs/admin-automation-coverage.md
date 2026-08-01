# MSC admin automation coverage

This inventory defines what “comprehensive write access” means for OpenClaw.
It is deliberately an API capability matrix, not a database-table editor. Every
mutation must use a typed operation, the backend's business rules, one exact
native approval, an expected-state check, an idempotency key, an audit identity,
and a post-write reread.

## Current implementation

| Domain | Read | Typed writes | Status |
| --- | --- | --- | --- |
| Registrations | Search, list, detail, deleted entries | Acceptance status, payment amounts/status, technical status, ID verification, notes, class, soft-delete, restore | Implemented; activation pending |
| Events and classes | Admin API query coverage | None | Contract required |
| Pricing and invoices | Admin API query coverage | Entry payment fields only | Contract required |
| Documents and exports | Admin API query coverage | None | Contract required |
| Communication | Mailbox plus event outbox/template queries | MSC mailbox reply only | Event-mail contracts required |
| Technical inspection | Admin API query coverage | Entry technical status only | Decision/assignment contracts required |
| IAM | Admin API query coverage | None | Separate critical-risk contract required |
| Marshals | Admin API query coverage | None | Contract required |
| Signing | Admin API query coverage | None | External-side-effect contract required |

The backend currently exposes 54 protected administrative mutation routes. The
first production slice covers the nine registration operation variants above.
The remaining routes must not be exposed through a generic URL, method, JSON,
SQL, or table-name parameter.

## Business-managed data

Typed operations may be added for these tables where the backend has, or gains,
a business API:

- `event`, `event_class`, `app_config`
- `person`, `vehicle`, `entry`, `registration_group`
- `invoice`, `event_pricing_rule`, `class_pricing_rule`, `invoice_payment`
- `technical_inspector_assignment`, `technical_inspection_decision`
- `email_template`, `email_template_version`
- `marshal_person`, event participation/day/section/post/assignment,
  qualification, training, and training participant

Documents, signing sessions, mail queue rows, exports, and generation jobs are
changed only through their dedicated lifecycle actions. They are not ordinary
record edits because creating or retrying them can send mail, publish files, or
produce signatures.

## System-managed data excluded from generic mutation

The following records are intentionally not editable as arbitrary rows:

- audit logs and consent evidence
- verification tokens, public submissions, rate limits, and upload staging
- email outbox/delivery internals and attachment links
- signing device/session internals
- import/export/document-generation job internals
- geolocation cache and other derived/cache data

Maintenance or privacy workflows may operate on these records through a
separately reviewed, narrowly scoped command. An approval can authorize a
specific maintenance action, but never grant a general database console.

## Activation boundary

Read access uses the existing `msc-support` client. Mutation execution requires
a separate `msc-automation` Cognito client and secret. The plugin refuses to
construct a mutation transport from support credentials or a bearer token.
Partial automation credential configuration fails closed.

