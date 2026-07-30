# MSC Operations CLI

The `msc` command combines fixed read-only providers for Nennungen and mail
with an approval-gated preparation path. A write request is encrypted and
persisted for the shared passkey page; the CLI itself has no Event mutation or
mail transport.

## Commands

```bash
npm ci
npm run build

MSC_EVENT_API_URL=https://api.example.tld \
MSC_EVENT_TOKEN_FILE=/run/secrets/msc_event_token \
node dist/src/cli.js lookup --orga-code 11OLD-7K4P9

node dist/src/cli.js lookup --email max@example.org --format text
node dist/src/cli.js lookup --name "Max Musterfahrer"
node dist/src/cli.js lookup --codriver-name "Max Mustermann"
node dist/src/cli.js lookup --start-number 42
node dist/src/cli.js detail --id 00000000-0000-4000-8000-000000000000
node dist/src/cli.js detail --id 00000000-0000-4000-8000-000000000000 --full
node dist/src/cli.js lookup --orga-code 11OLD-7K4P9 --full
node dist/src/cli.js health

# Gemeinsame Oberfläche
node dist/src/msc-ops-cli.js nennung lookup --orga-code 11OLD-7K4P9
node dist/src/msc-ops-cli.js nennung lookup --codriver-name "Max Mustermann"
node dist/src/msc-ops-cli.js mail read \
  --account msc-info --folder INBOX --message-id 7
```

Exactly one lookup option is required. Orga code, e-mail and start number are matched exactly after the API search. Driver and codriver names are matched case-insensitively after whitespace normalization. A codriver lookup scans the current event read-only and returns every matching registration with the driver's minimal contact data.

## Configuration

- `MSC_EVENT_API_URL`: required API base URL. HTTPS is mandatory; plain HTTP is accepted only for localhost.
- Recommended machine authentication: set `MSC_EVENT_COGNITO_URL`, `MSC_EVENT_COGNITO_CLIENT_ID` and `MSC_EVENT_COGNITO_CLIENT_SECRET_FILE`. The CLI exchanges the root-protected secret for a short-lived access token on each command. `MSC_EVENT_COGNITO_SCOPE` defaults to `msc-support/entries.read`.
- Transitional user authentication: `MSC_EVENT_TOKEN` or `MSC_EVENT_TOKEN_FILE`. Set exactly one and do not combine it with Cognito client credentials.
- `MSC_EVENT_TIMEOUT_MS`: optional timeout, default 10000 ms.

The dedicated Cognito machine client must be provisioned by the matching backend infrastructure change. Never commit the client secret or pass it as a command-line argument or environment variable.

## Output and exit codes

JSON is the default; `--format text` is intended for manual diagnostics. Full mode always renders structured JSON, even when `--format text` is supplied, so nested fields and history remain unambiguous.

| Code | Meaning |
| --- | --- |
| 0 | success / matched |
| 1 | unexpected internal failure |
| 2 | not found |
| 3 | ambiguous |
| 4 | usage or configuration error |
| 5 | authentication/authorization error |
| 6 | API/network/contract error |

## Read-only and privacy guarantees

The HTTP client has no generic request entry point. It permits only:

- `GET /health`
- `GET /admin/events/current`
- `GET /admin/entries?eventId=…&q=…`
- `GET /admin/entries?eventId=…&limit=100&sortBy=createdAt&sortDir=asc`
- `GET /admin/entries/:id`

Redirects and every non-GET method are blocked. Normal compact output intentionally excludes addresses, phone numbers, birth dates, notes, history, document downloads and image URLs. The explicit codriver lookup is the narrow exception: it returns only the matching driver's name, phone, e-mail, start number, class and vehicle required for contact. `--full` explicitly returns every field present in the existing detail response, including personal data, notes and history. Use it only for authorized support purposes and avoid copying its output into tickets, chats or logs. The CLI has no telemetry and does not persist searches or responses.

The pinned API snapshot is `contracts/backend-openapi.json`, sourced from backend commit `4e1aae2f99fe77d1f44d9129928eef5b4c99bdbd`.

The CLI validates list and detail responses at runtime and fails closed with `API_CONTRACT_MISMATCH` when required fields disappear. Unknown detail fields are preserved for `--full`, while the compact projection remains explicitly allowlisted.

## Docker / OpenClaw

```bash
docker build -t msc-event-cli .
docker run --rm \
  -e MSC_EVENT_API_URL=https://api.example.tld \
  -e MSC_EVENT_TOKEN_FILE=/run/secrets/msc_event_token \
  -v /secure/msc_event_token:/run/secrets/msc_event_token:ro \
  msc-event-cli lookup --orga-code 11OLD-7K4P9
```

OpenClaw should invoke the container as a subprocess and consume JSON stdout. Never copy the bearer token into prompts, chat messages, command arguments or logs.

For the hardened gateway mount and the fixed read-only wrapper, see
[`deployment/README.md`](deployment/README.md).

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Approval-gated changes

The two preparation commands reread the exact source immediately before
creating a pending approval:

```bash
node dist/src/msc-ops-cli.js nennung change \
  --config /etc/msc/approved-actions.json \
  --id 00000000-0000-4000-8000-000000000000 \
  --operation-file /secure/operator/change.json \
  --idempotency-key entry:00000000:status:v1

node dist/src/msc-ops-cli.js mail reply \
  --config /etc/msc/approved-actions.json \
  --account msc-info \
  --folder INBOX \
  --message-id 7 \
  --body-file /secure/operator/reply.txt \
  --source "MSC-Ablaufplan 2026" \
  --idempotency-key reply:msc-info:INBOX:7:v2
```

The reply remains an ordinary UTF-8 text file and can be edited with the
operator's normal editor before submission. Use a new idempotency key for a
materially changed draft; reusing a key with different content fails closed.

An operation file contains exactly one allowlisted change, for example:

```json
{
  "type": "acceptance-status",
  "acceptanceStatus": "accepted",
  "sendLifecycleMail": false
}
```

Other supported operation types are `payment-amounts`, `notes` and `class`.
Unknown properties and lifecycle-mail side effects are rejected.

The root-owned configuration contains paths, policy and the public approval
origin, but no key material:

```json
{
  "version": 1,
  "stateDatabasePath": "/var/lib/msc-approved-actions/actions.sqlite",
  "encryptionKeyFile": "/run/secrets/msc-approved-actions-encryption-key",
  "signingKeyFile": "/run/secrets/msc-approved-actions-signing-key",
  "publicOrigin": "https://approval.example.org",
  "mailPolicy": {
    "version": 1,
    "accounts": {
      "msc-nennung": {
        "active": true,
        "senderIdentity": "nennung@example.org",
        "displayName": "MSC Nennung",
        "allowedFolders": ["INBOX"]
      },
      "msc-info": {
        "active": true,
        "senderIdentity": "info@example.org",
        "displayName": "MSC Info",
        "allowedFolders": ["INBOX"]
      },
      "msc-vorstand": {
        "active": true,
        "senderIdentity": "admin@example.org",
        "displayName": "MSC Vorstand",
        "allowedFolders": ["INBOX"]
      }
    }
  }
}
```

The configuration must be absolute, non-symlinked, owner-bound and private.
Each key file must be mode `0600` and contain exactly 32 bytes encoded as hex
or base64url. The shared approval page, explicit workers and transports remain
dormant library boundaries: this repository does not start a listener, load
production secrets, send mail or mutate an Event entry by itself.
