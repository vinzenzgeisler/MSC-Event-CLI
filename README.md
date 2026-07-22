# MSC Event CLI

Strictly read-only support client for the MSC Event admin API. It resolves a participant in the current event and returns compact operational fields by default, with an explicit full-detail mode for authorized support work.

## Commands

```bash
npm ci
npm run build

MSC_EVENT_API_URL=https://api.example.tld \
MSC_EVENT_TOKEN_FILE=/run/secrets/msc_event_token \
node dist/src/cli.js lookup --orga-code 11OLD-7K4P9

node dist/src/cli.js lookup --email max@example.org --format text
node dist/src/cli.js lookup --name "Max Musterfahrer"
node dist/src/cli.js lookup --start-number 42
node dist/src/cli.js detail --id 00000000-0000-4000-8000-000000000000
node dist/src/cli.js detail --id 00000000-0000-4000-8000-000000000000 --full
node dist/src/cli.js lookup --orga-code 11OLD-7K4P9 --full
node dist/src/cli.js health
```

Exactly one lookup option is required. Orga code, e-mail and start number are matched exactly after the API search. Names are matched case-insensitively after whitespace normalization. Multiple registrations belonging to one driver are returned together; multiple drivers produce `ambiguous`.

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
- `GET /admin/entries/:id`

Redirects and every non-GET method are blocked. Compact output intentionally excludes addresses, phone numbers, birth dates, notes, history, document downloads and image URLs. `--full` explicitly returns every field present in the existing detail response, including personal data, notes and history. Use it only for authorized support purposes and avoid copying its output into tickets, chats or logs. The CLI has no telemetry and does not persist searches or responses.

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
