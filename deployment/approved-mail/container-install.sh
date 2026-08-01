#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly SOURCE_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly OPENCLAW_STATE_DIR="${MSC_OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
readonly INSTALL_ROOT="${OPENCLAW_STATE_DIR}/msc-approved-mail"
readonly APP_ROOT="${INSTALL_ROOT}/app"
readonly CONFIG_ROOT="${INSTALL_ROOT}/config"
readonly STATE_ROOT="${INSTALL_ROOT}/state"
readonly BACKUP_ROOT="${INSTALL_ROOT}/backups"
readonly OPENCLAW_CONFIG="${OPENCLAW_STATE_DIR}/openclaw.json"
readonly PRODUCTION_CONFIG="${CONFIG_ROOT}/production.json"
readonly BOOTSTRAP_CONFIG="${CONFIG_ROOT}/bootstrap.json"
readonly PUBLIC_ORIGIN="${MSC_APPROVED_MAIL_PUBLIC_ORIGIN:-https://openclaw.vinzenz-geisler.com}"
readonly OPERATOR_SESSION_KEY="${MSC_APPROVED_MAIL_OPERATOR_SESSION_KEY:-agent:main:telegram:direct:8261978945}"
readonly PUBLIC_BASE_PATH="/msc-approval"
readonly RUNTIME_UID="$(id -u)"
readonly RUNTIME_GID="$(id -g)"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

STAGING_ROOT=""
CONFIG_BACKUP=""
APP_BACKUP=""
ROLLBACK_ARMED=0

log() { printf '[msc-approved-mail] %s\n' "$1"; }
die() { printf '[msc-approved-mail] FEHLER: %s\n' "$1" >&2; exit 1; }

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((status != 0 && ROLLBACK_ARMED == 1)); then
    printf '[msc-approved-mail] WARNUNG: Container-Installation wird zurückgerollt.\n' >&2
    if [[ -n "$CONFIG_BACKUP" && -f "$CONFIG_BACKUP" ]]; then
      cp -a -- "$CONFIG_BACKUP" "$OPENCLAW_CONFIG"
    fi
    if [[ -d "$APP_ROOT" ]]; then
      mv -- "$APP_ROOT" "${BACKUP_ROOT}/failed-app-${TIMESTAMP}"
    fi
    if [[ -n "$APP_BACKUP" && -d "$APP_BACKUP" ]]; then
      mv -- "$APP_BACKUP" "$APP_ROOT"
    fi
  fi
  if [[ -n "$STAGING_ROOT" && -d "$STAGING_ROOT" ]]; then
    rm -rf -- "$STAGING_ROOT"
  fi
  exit "$status"
}

require_private_regular_file() {
  local path="$1" max_mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "Private Datei fehlt oder ist ein Symlink: $path"
  [[ "$(stat -c %u "$path")" == "$RUNTIME_UID" ]] \
    || die "Private Datei gehört nicht dem Runtime-Benutzer: $path"
  local mode
  mode="$(stat -c %a "$path")"
  (((8#$mode & 0400) != 0 &&
    (8#$mode & (0777 ^ 8#$max_mode)) == 0)) \
    || die "Private Datei ist zu weit freigegeben: $path"
}

require_preflight() {
  for command in node npm openssl install cp mv stat readlink mktemp openclaw; do
    command -v "$command" >/dev/null 2>&1 || die "Befehl fehlt: $command"
  done
  [[ "$OPENCLAW_STATE_DIR" == /* && "$INSTALL_ROOT" == "$OPENCLAW_STATE_DIR/"* ]] \
    || die "OpenClaw-Zielpfad ist ungültig."
  [[ -d "$OPENCLAW_STATE_DIR" && ! -L "$OPENCLAW_STATE_DIR" ]] \
    || die "Persistentes OpenClaw-Verzeichnis fehlt oder ist ein Symlink."
  [[ "$(stat -c %u "$OPENCLAW_STATE_DIR")" == "$RUNTIME_UID" ]] \
    || die "Persistentes OpenClaw-Verzeichnis gehört nicht dem Runtime-Benutzer."
  require_private_regular_file "$OPENCLAW_CONFIG" 600
  for secret in \
    /run/secrets/msc_nennung_password \
    /run/secrets/msc_info_password \
    /run/secrets/msc_vorstand_password; do
    require_private_regular_file "$secret" 400
  done
  [[ -f "${SOURCE_ROOT}/package.json" &&
     -f "${SOURCE_ROOT}/plugin/production-package/openclaw.plugin.json" ]] \
    || die "Produktionsquellen oder Plugin-Manifest fehlen."
  /usr/local/bin/msc-mail-readonly accounts >/dev/null \
    || die "Vorhandener Read-only-Mailzugriff ist nicht funktionsfähig."
  node -e '
    const origin = new URL(process.argv[1]);
    if (origin.protocol !== "https:" || origin.origin !== process.argv[1]) {
      process.exit(1);
    }
  ' "$PUBLIC_ORIGIN" || die "Öffentliche Origin muss eine exakte HTTPS-Origin sein."
}

default_gateway_ip() {
  node <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
const defaults = rows
  .map((row) => row.trim().split(/\s+/))
  .filter((columns) => columns[1] === '00000000' && (Number.parseInt(columns[3], 16) & 2) !== 0)
  .map((columns) => columns[2])
  .filter((value) => /^[0-9A-Fa-f]{8}$/.test(value))
  .map((value) => [6, 4, 2, 0].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join('.'));
if (new Set(defaults).size !== 1) process.exit(1);
process.stdout.write(defaults[0]);
NODE
}

build_application() {
  install -d -m 0700 -- "$INSTALL_ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$BACKUP_ROOT"
  STAGING_ROOT="$(mktemp -d "${INSTALL_ROOT}/.build.XXXXXX")"
  install -d -m 0700 -- "${STAGING_ROOT}/app"
  cp -a -- \
    "${SOURCE_ROOT}/package.json" \
    "${SOURCE_ROOT}/package-lock.json" \
    "${SOURCE_ROOT}/tsconfig.json" \
    "${SOURCE_ROOT}/src" \
    "${SOURCE_ROOT}/plugin" \
    "${STAGING_ROOT}/app/"
  (
    cd "${STAGING_ROOT}/app"
    npm ci --legacy-peer-deps --include=dev --ignore-scripts
    npm run build
    npm prune --omit=dev --legacy-peer-deps --ignore-scripts
  )
  chmod -R go-w -- "${STAGING_ROOT}/app"
}

ensure_key() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    openssl rand -base64 32 |
      install -m 0400 /dev/stdin "$path"
  fi
  require_private_regular_file "$path" 400
}

write_configuration() {
  local trusted_proxy_ip
  trusted_proxy_ip="$(default_gateway_ip)" \
    || die "Private Standard-Gateway-Adresse ist nicht eindeutig."
  ensure_key "${CONFIG_ROOT}/encryption.key"
  ensure_key "${CONFIG_ROOT}/signing.key"
  ensure_key "${CONFIG_ROOT}/session.key"
  node - \
    "$PRODUCTION_CONFIG" \
    "$BOOTSTRAP_CONFIG" \
    "$PUBLIC_ORIGIN" \
    "$OPERATOR_SESSION_KEY" \
    "$trusted_proxy_ip" \
    "$STATE_ROOT" \
    "$CONFIG_ROOT" \
    "$RUNTIME_UID" <<'NODE'
const fs = require('node:fs');
const [
  productionPath,
  bootstrapPath,
  publicOrigin,
  operatorSessionKey,
  trustedProxy,
  stateRoot,
  configRoot,
  runtimeUid,
] = process.argv.slice(2);
const identities = {
  'msc-nennung': ['nennung@msc-oberlausitzer-dreilaendereck.eu', 'MSC Nennung'],
  'msc-info': ['info@msc-oberlausitzer-dreilaendereck.eu', 'MSC Info'],
  'msc-vorstand': ['admin@msc-oberlausitzer-dreilaendereck.eu', 'MSC Vorstand'],
};
const replySignature = [
  'Mit freundlichen Grüßen',
  'Vinzenz Geisler',
  'i. A. MSC Oberlausitzer Dreiländereck e. V.',
  '📞 +49 152 52971212',
  '🌐 www.msc-oberlausitz.de',
].join('\n');
const accounts = {};
const smtpAccounts = [];
for (const [account, [senderIdentity, displayName]] of Object.entries(identities)) {
  accounts[account] = {
    active: true,
    senderIdentity,
    displayName,
    allowedFolders: ['INBOX'],
    replySignature,
    replyBccToSelf: account === 'msc-nennung',
  };
  smtpAccounts.push({
    account,
    host: 'smtp.strato.de',
    port: 465,
    secure: true,
    username: senderIdentity,
    passwordFile: `/run/secrets/${account.replaceAll('-', '_')}_password`,
    senderIdentity,
  });
}
const production = {
  version: 1,
  stateDatabasePath: `${stateRoot}/state.sqlite`,
  encryptionKeyFile: `${configRoot}/encryption.key`,
  signingKeyFile: `${configRoot}/signing.key`,
  sessionCsrfKeyFile: `${configRoot}/session.key`,
  publicOrigin,
  basePath: '/msc-approval',
  rpId: new URL(publicOrigin).hostname,
  reviewerActor: 'vinzenz',
  operatorSessionKey,
  trustedProxyAddresses: [trustedProxy],
  trustConfiguredActorWithoutHeader: true,
  bindInterface: 'eth0',
  port: 18443,
  workerIntervalMs: 5000,
  workerId: 'msc-approved-mail-production',
  messageIdDomain: new URL(publicOrigin).hostname,
  mailPolicy: { version: 1, accounts },
  smtpAccounts,
};
const bootstrap = {
  version: 1,
  stateDatabasePath: `${stateRoot}/state.sqlite`,
  allowedOperatorUids: [Number(runtimeUid)],
  allowedActors: ['vinzenz'],
  bootstrapTtlSeconds: 600,
};
for (const [path, value] of [[productionPath, production], [bootstrapPath, bootstrap]]) {
  const temporary = `${path}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, path);
}
NODE
  require_private_regular_file "$PRODUCTION_CONFIG" 600
  require_private_regular_file "$BOOTSTRAP_CONFIG" 600
}

activate_files_and_config() {
  CONFIG_BACKUP="${BACKUP_ROOT}/openclaw-${TIMESTAMP}.json"
  cp -a -- "$OPENCLAW_CONFIG" "$CONFIG_BACKUP"
  if [[ -d "$APP_ROOT" ]]; then
    APP_BACKUP="${BACKUP_ROOT}/app-${TIMESTAMP}"
    mv -- "$APP_ROOT" "$APP_BACKUP"
  fi
  mv -- "${STAGING_ROOT}/app" "$APP_ROOT"
  rmdir -- "$STAGING_ROOT"
  STAGING_ROOT=""
  ROLLBACK_ARMED=1

  node - "$OPENCLAW_CONFIG" "${APP_ROOT}/plugin/production-package" <<'NODE'
const fs = require('node:fs');
const [path, pluginPath] = process.argv.slice(2);
const metadata = fs.lstatSync(path);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error('OpenClaw config must be a regular non-symlink file');
}
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const plugins = config.plugins ??= {};
const load = plugins.load ??= {};
const paths = Array.isArray(load.paths) ? load.paths : [];
load.paths = [...new Set([...paths, pluginPath])];
const entries = plugins.entries ??= {};
entries['msc-approved-mail'] = {
  ...(entries['msc-approved-mail'] ?? {}),
  enabled: true,
};
if (Array.isArray(plugins.allow) && !plugins.allow.includes('msc-approved-mail')) {
  plugins.allow.push('msc-approved-mail');
}
const tools = config.tools ??= {};
if (Array.isArray(tools.allow)) {
  for (const tool of [
    'msc_mail_reply_propose',
    'msc_mail_reply_send',
    'msc_event_entry_change_propose',
    'msc_event_entry_change_execute',
  ]) {
    if (!tools.allow.includes(tool)) tools.allow.push(tool);
  }
} else {
  const alsoAllow = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  tools.alsoAllow = [...new Set([
    ...alsoAllow,
    'msc_mail_reply_propose',
    'msc_mail_reply_send',
    'msc_event_entry_change_propose',
    'msc_event_entry_change_execute',
  ])];
}
const temporary = `${path}.msc-approved-mail.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
  mode: metadata.mode & 0o777,
  flag: 'wx',
});
fs.chownSync(temporary, metadata.uid, metadata.gid);
fs.renameSync(temporary, path);
NODE
  openclaw config validate
  openclaw plugins doctor
  ROLLBACK_ARMED=0
}

main() {
  (($# == 0)) || die "Das Skript akzeptiert keine Argumente."
  require_preflight
  build_application
  write_configuration
  activate_files_and_config
  printf '\nMSC-Mail-Paket ist containerintern vorbereitet.\n'
  printf 'Mailversand: separate OpenClaw-Freigabe im Telegram-Direktchat %s\n' \
    "$OPERATOR_SESSION_KEY"
  printf 'Konfigurationsbackup: %s\n' "$CONFIG_BACKUP"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT INT TERM
  main "$@"
fi
