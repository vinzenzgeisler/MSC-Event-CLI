# OpenClaw deployment

This package exposes the CLI to OpenClaw through `/usr/local/bin/msc-event-readonly`.
The wrapper permits only compact lookup/detail operations plus the exact typed
`entries.list` and `events.classes` admin queries needed by the OpenClaw tools.
It rejects `--full`, custom base URLs, legacy bearer tokens and every command
outside its fixed allowlist.

## Production values

- API: `https://j3w759az4f.execute-api.eu-central-1.amazonaws.com`
- Cognito hosted domain: `https://dreiecksrennen-prod-auth-330221.auth.eu-central-1.amazoncognito.com`
- OAuth scopes: `msc-support/entries.read msc-support/settings.read`

The existing browser client `686klq4439v73rdutvufgj8kua` is intentionally not
used. Deploy the backend machine-client change first and use its
`SupportUserPoolClientId` output plus the corresponding client secret.

## Installation outline

1. Deploy the backend change after reviewing `cdk diff`.
2. Read the generated support client ID and secret through an authorized AWS
   administrator. Never copy the secret into chat, shell history, arguments or
   environment variables.
3. Build the CLI with `npm ci && npm run build && npm prune --omit=dev` and copy
   `dist`, `node_modules` and `package.json` to
   `/root/openclaw-config/msc-event-cli/app` as `root:root`, read-only for the
   gateway.
4. Install `msc-event-readonly` as `root:root 0755` under
   `/root/openclaw-config/msc-event-cli/`.
5. Write the client secret without a trailing newline to
   `/root/openclaw-secrets/msc_event_cognito_client_secret`, owned by the gateway
   UID/GID with mode `0400`.
6. Merge `compose.override.yml.template` with the detected gateway service and
   generated support client ID. Keep all mounts read-only and recreate only the
   gateway service.
7. Run `/usr/local/bin/msc-event-readonly health`, then a known authorized
   lookup. Confirm `--full`, arbitrary URLs and write-like commands are rejected.

The production deployment and gateway recreate are deliberately not automated
here until the backend change is approved and deployed; otherwise an installer
could provision a secret against an audience the live API does not yet accept.
