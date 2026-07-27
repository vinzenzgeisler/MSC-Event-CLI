#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly SOURCE_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly INSTALL_ROOT="/root/openclaw-config/msc-approved-mail"
readonly SECRET_ROOT="/root/openclaw-secrets"
readonly APP_ROOT="${INSTALL_ROOT}/app"
readonly STATE_ROOT="${INSTALL_ROOT}/state"
readonly PRODUCTION_CONFIG="${INSTALL_ROOT}/production.json"
readonly PROPOSAL_CONFIG="${INSTALL_ROOT}/proposal.json"
readonly BOOTSTRAP_CONFIG="${INSTALL_ROOT}/bootstrap.json"
readonly OVERRIDE_FILE="${INSTALL_ROOT}/compose.approved-mail.override.yml"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly BACKUP_ROOT="${SECRET_ROOT}/.msc-approved-mail-deployments"
readonly BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
readonly CONTAINER_APP="/opt/msc-approved-mail"
readonly CONTAINER_CONFIG="/etc/msc-approved-mail"
readonly CONTAINER_STATE="/var/lib/msc-approved-mail"
readonly PUBLIC_BASE_PATH="/msc-approval"
readonly LISTENER_PORT=18443
readonly CADDY_CONFIG="/etc/caddy/Caddyfile"

declare -a COMPOSE=()
declare -a COMPOSE_FILES=()
GATEWAY_CONTAINER=""
GATEWAY_SERVICE=""
GATEWAY_IMAGE=""
PROJECT_NAME=""
PROJECT_DIR=""
TRUSTED_PROXY_IP=""
PUBLIC_ORIGIN=""
OPENCLAW_CONFIG=""
RUNTIME_USER=""
ROLLBACK_ARMED=0

log() { printf '[msc-approved-mail] %s\n' "$1"; }
die() { printf '[msc-approved-mail] FEHLER: %s\n' "$1" >&2; exit 1; }

compose() {
  local -a command=("${COMPOSE[@]}" --project-directory "$PROJECT_DIR" -p "$PROJECT_NAME")
  local file
  for file in "${COMPOSE_FILES[@]}"; do command+=(-f "$file"); done
  command+=(-f "$OVERRIDE_FILE")
  "${command[@]}" "$@"
}

rollback() {
  local status=$?
  trap - EXIT INT TERM
  if ((status != 0 && ROLLBACK_ARMED == 1)); then
    printf '[msc-approved-mail] WARNUNG: Rollback wird ausgeführt.\n' >&2
    if [[ -f "${BACKUP_DIR}/openclaw.json" ]]; then
      cp -a -- "${BACKUP_DIR}/openclaw.json" "$OPENCLAW_CONFIG"
    fi
    if [[ -f "${BACKUP_DIR}/Caddyfile" ]]; then
      cp -a -- "${BACKUP_DIR}/Caddyfile" "$CADDY_CONFIG"
    fi
    if [[ -d "${BACKUP_DIR}/install-root" ]]; then
      rm -rf -- "$INSTALL_ROOT"
      cp -a -- "${BACKUP_DIR}/install-root" "$INSTALL_ROOT"
    else
      rm -rf -- "$INSTALL_ROOT"
    fi
    local -a original=("${COMPOSE[@]}" --project-directory "$PROJECT_DIR" -p "$PROJECT_NAME")
    local file
    for file in "${COMPOSE_FILES[@]}"; do original+=(-f "$file"); done
    "${original[@]}" up -d --no-deps --force-recreate "$GATEWAY_SERVICE" \
      >/dev/null 2>&1 || true
    if [[ -f "${BACKUP_DIR}/Caddyfile" ]]; then
      caddy reload --config "$CADDY_CONFIG" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
require_preflight() {
  [[ "$(id -u)" == 0 ]] || die "Bitte als root ausführen."
  for command in docker python3 openssl install cp mv stat readlink curl rmdir \
    getent caddy systemctl; do
    command -v "$command" >/dev/null 2>&1 || die "Befehl fehlt: $command"
  done
  [[ -f "${SOURCE_ROOT}/package.json" && -f "${SOURCE_ROOT}/plugin/production.mjs" ]] \
    || die "Produktionsquellen fehlen."
  [[ -x "/usr/local/bin/msc-mail-readonly" || -x "${SOURCE_ROOT}/../../deployment/msc-mail/msc-mail-readonly" ]] \
    || log "Read-only-Wrapper wird im laufenden Gateway geprüft."
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose)
  else die "Docker Compose fehlt."; fi
  docker info >/dev/null 2>&1 || die "Docker ist nicht erreichbar."
  systemctl is-active --quiet caddy || die "Caddy-Systemdienst ist nicht aktiv."
  [[ -f "$CADDY_CONFIG" && ! -L "$CADDY_CONFIG" ]] \
    || die "Caddy-Konfiguration fehlt oder ist ein Symlink."
  caddy validate --config "$CADDY_CONFIG" >/dev/null \
    || die "Bestehende Caddy-Konfiguration ist ungültig."
  RUNTIME_USER="$(getent passwd 1000 | cut -d: -f1)"
  [[ -n "$RUNTIME_USER" ]] || die "Runtime-Benutzer mit UID 1000 fehlt."
}

detect_runtime() {
  local row candidates=""
  while IFS= read -r id; do
    row="$(docker inspect --format \
      '{{.Id}}{{"\t"}}{{index .Config.Labels "com.docker.compose.service"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project.config_files"}}{{"\t"}}{{.Image}}' "$id")"
    if [[ "${row,,}" == *gateway* && "${row,,}" == *openclaw* ]]; then
      candidates+="${row}"$'\n'
    fi
  done < <(docker ps -q)
  mapfile -t rows < <(printf '%s' "$candidates" | sed '/^$/d')
  ((${#rows[@]} == 1)) || die "OpenClaw-Gateway ist nicht eindeutig."
  local files
  IFS=$'\t' read -r GATEWAY_CONTAINER GATEWAY_SERVICE PROJECT_NAME \
    PROJECT_DIR files GATEWAY_IMAGE <<< "${rows[0]}"
  local file
  IFS=',' read -r -a raw_files <<< "$files"
  for file in "${raw_files[@]}"; do
    [[ "$file" == /* ]] || file="${PROJECT_DIR}/${file}"
    file="$(readlink -f -- "$file")"
    [[ -f "$file" ]] || die "Compose-Datei fehlt: $file"
    COMPOSE_FILES+=("$file")
  done

  OPENCLAW_CONFIG="$(docker inspect "$GATEWAY_CONTAINER" | python3 -c '
import json, sys
data=json.load(sys.stdin)[0]
for mount in data.get("Mounts", []):
    if mount.get("Destination") == "/home/node/.openclaw":
        print(mount["Source"].rstrip("/") + "/openclaw.json")
        break
')"
  [[ -f "$OPENCLAW_CONFIG" ]] || die "OpenClaw-Konfiguration wurde nicht gefunden."
  docker run --rm --entrypoint sh "$GATEWAY_IMAGE" -c \
    'command -v node >/dev/null && command -v npm >/dev/null' \
    || die "Node.js und npm fehlen im OpenClaw-Gateway-Image."

  TRUSTED_PROXY_IP="$(docker inspect "$GATEWAY_CONTAINER" | python3 -c '
import ipaddress, json, sys
gateway=json.load(sys.stdin)[0]
values=[
    network.get("Gateway")
    for network in gateway["NetworkSettings"]["Networks"].values()
]
values=[
    value for value in values
    if value and ipaddress.ip_address(value).is_private
]
if len(set(values)) != 1:
    raise SystemExit(1)
print(values[0])
')" || die "Docker-Hostadresse für den Caddy-Proxy ist nicht eindeutig."
  PUBLIC_ORIGIN="$(python3 - "$CADDY_CONFIG" <<'PY'
import re, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    lines=handle.readlines()
sites=[]
depth=0
for line in lines:
    if depth == 0:
        match=re.fullmatch(r"\s*([A-Za-z0-9.-]+)\s*\{\s*(?:#.*)?\n?", line)
        if match:
            sites.append(match.group(1))
    depth += line.count("{") - line.count("}")
    if depth < 0:
        raise SystemExit(1)
if depth != 0:
    raise SystemExit(1)
if len(sites) != 1 or "." not in sites[0]:
    raise SystemExit(1)
print("https://" + sites[0])
PY
)" || die "Öffentliche HTTPS-Origin konnte nicht sicher erkannt werden."
  [[ "$PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] \
    || die "Öffentliche HTTPS-Origin konnte nicht sicher erkannt werden."
  docker exec "$GATEWAY_CONTAINER" /usr/local/bin/msc-mail-readonly accounts \
    >/dev/null || die "Vorhandener Read-only-Mailzugriff ist nicht funktionsfähig."
}

backup_current() {
  install -d -o root -g root -m 0700 -- "$BACKUP_DIR"
  cp -a -- "$OPENCLAW_CONFIG" "${BACKUP_DIR}/openclaw.json"
  cp -a -- "$CADDY_CONFIG" "${BACKUP_DIR}/Caddyfile"
  if [[ -d "$INSTALL_ROOT" ]]; then
    cp -a -- "$INSTALL_ROOT" "${BACKUP_DIR}/install-root"
  fi
  ROLLBACK_ARMED=1
}

build_application() {
  local staging
  staging="$(mktemp -d -p /root msc-approved-mail-build-XXXXXX)"
  install -d -o 1000 -g 1000 -m 0750 -- "${staging}/app"
  cp -a -- "${SOURCE_ROOT}/package.json" "${SOURCE_ROOT}/package-lock.json" \
    "${SOURCE_ROOT}/tsconfig.json" "${SOURCE_ROOT}/src" "${SOURCE_ROOT}/plugin" \
    "${staging}/app/"
  chown -R 1000:1000 -- "${staging}/app"
  docker run --rm --user 1000:1000 --entrypoint sh \
    --volume "${staging}/app:/work" --workdir /work "$GATEWAY_IMAGE" -c '
      npm ci --legacy-peer-deps --include=dev --ignore-scripts &&
      npm run build &&
      npm prune --omit=dev --legacy-peer-deps --ignore-scripts
    '
  install -d -o 1000 -g 1000 -m 0755 -- "${staging}/app/bin"
  install -o 1000 -g 1000 -m 0755 -- "${SCRIPT_DIR}/msc" \
    "${staging}/app/bin/msc"
  rm -rf -- "$APP_ROOT"
  install -d -o root -g root -m 0755 -- "$INSTALL_ROOT"
  mv -- "${staging}/app" "$APP_ROOT"
  chown -R root:root -- "$APP_ROOT"
  chmod -R a-w -- "$APP_ROOT"
  rm -rf -- "$staging"
}

prepare_configuration_paths() {
  local path
  for path in "$@"; do
    [[ ! -L "$path" ]] || die "Konfigurationspfad ist ein Symlink: $path"
    if [[ -d "$path" ]]; then
      rmdir -- "$path" 2>/dev/null \
        || die "Konfigurationspfad ist ein nichtleeres Verzeichnis: $path"
    elif [[ -e "$path" && ! -f "$path" ]]; then
      die "Konfigurationspfad ist keine reguläre Datei: $path"
    fi
  done
}

write_configuration() {
  install -d -o 1000 -g 1000 -m 0700 -- "$STATE_ROOT"
  prepare_configuration_paths \
    "$PRODUCTION_CONFIG" "$PROPOSAL_CONFIG" "$BOOTSTRAP_CONFIG"
  local key
  for key in encryption signing session; do
    if [[ ! -f "${SECRET_ROOT}/msc-approved-mail-${key}-key" ]]; then
      openssl rand -base64 32 |
        install -o 1000 -g 1000 -m 0400 /dev/stdin \
          "${SECRET_ROOT}/msc-approved-mail-${key}-key"
    fi
  done
  python3 - "$PUBLIC_ORIGIN" "$TRUSTED_PROXY_IP" "$PRODUCTION_CONFIG" \
    "$PROPOSAL_CONFIG" "$BOOTSTRAP_CONFIG" <<'PY'
import json, sys, tomllib
origin, proxy, production_path, proposal_path, bootstrap_path = sys.argv[1:]
with open("/root/openclaw-config/msc-mail/accounts.toml", "rb") as handle:
    source = tomllib.load(handle)
entries = source.get("accounts", [])
confirmed = {
    "msc-nennung": ("nennung@msc-oberlausitzer-dreilaendereck.eu", "MSC Nennung"),
    "msc-info": ("info@msc-oberlausitzer-dreilaendereck.eu", "MSC Info"),
    "msc-vorstand": ("admin@msc-oberlausitzer-dreilaendereck.eu", "MSC Vorstand"),
}
accounts = {
    name: {
        "active": False,
        "senderIdentity": identity,
        "displayName": display,
        "allowedFolders": ["INBOX"],
    }
    for name, (identity, display) in confirmed.items()
}
smtp = []
for item in entries:
    name = item["name"]
    sender = item["sender_identity"]
    accounts[name] = {
        "active": True,
        "senderIdentity": sender,
        "displayName": item["display_name"],
        "allowedFolders": ["INBOX"],
    }
    smtp.append({
        "account": name,
        "host": "smtp.strato.de",
        "port": 465,
        "secure": True,
        "username": sender,
        "passwordFile": f"/run/secrets/{name.replace('-', '_')}_password",
        "senderIdentity": sender,
    })
policy = {"version": 1, "accounts": accounts}
shared = {
    "version": 1,
    "stateDatabasePath": "/var/lib/msc-approved-mail/state.sqlite",
    "encryptionKeyFile": "/run/secrets/msc_approval_encryption_key",
    "signingKeyFile": "/run/secrets/msc_approval_signing_key",
    "publicOrigin": origin,
    "basePath": "/msc-approval",
    "mailPolicy": policy,
}
production = {
    **shared,
    "sessionCsrfKeyFile": "/run/secrets/msc_approval_session_key",
    "rpId": origin.removeprefix("https://"),
    "reviewerActor": "vinzenz",
    "trustedProxyAddresses": [proxy],
    "bindInterface": "eth0",
    "port": 18443,
    "workerIntervalMs": 5000,
    "workerId": "msc-approved-mail-production",
    "messageIdDomain": origin.removeprefix("https://"),
    "smtpAccounts": smtp,
}
bootstrap = {
    "version": 1,
    "stateDatabasePath": shared["stateDatabasePath"],
    "allowedOperatorUids": [1000],
    "allowedActors": ["vinzenz"],
    "bootstrapTtlSeconds": 600,
}
for path, value in (
    (production_path, production),
    (proposal_path, shared),
    (bootstrap_path, bootstrap),
):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
PY
  chown root:1000 "$PRODUCTION_CONFIG" "$PROPOSAL_CONFIG" "$BOOTSTRAP_CONFIG"
  chmod 0440 "$PRODUCTION_CONFIG" "$PROPOSAL_CONFIG" "$BOOTSTRAP_CONFIG"
}

enable_plugin() {
  local config_path="${1:-$OPENCLAW_CONFIG}"
  python3 - "$config_path" <<'PY'
import json, os, stat, sys
path=sys.argv[1]
metadata=os.stat(path, follow_symlinks=False)
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("OpenClaw configuration is not a regular file")
with open(path, encoding="utf-8") as handle:
    config=json.load(handle)
plugins=config.setdefault("plugins", {})
paths=plugins.setdefault("load", {}).setdefault("paths", [])
entry="/opt/msc-approved-mail/plugin/production.mjs"
if entry not in paths:
    paths.append(entry)
plugins.setdefault("entries", {}).setdefault("msc-approved-mail", {})["enabled"]=True
allow=plugins.get("allow")
if isinstance(allow, list) and "msc-approved-mail" not in allow:
    allow.append("msc-approved-mail")
temporary=f"{path}.msc-approved-mail.tmp.{os.getpid()}"
flags=os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
try:
    descriptor=os.open(temporary, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chown(
        temporary,
        metadata.st_uid,
        metadata.st_gid,
        follow_symlinks=False,
    )
    os.chmod(
        temporary,
        stat.S_IMODE(metadata.st_mode),
        follow_symlinks=False,
    )
    os.replace(temporary, path)
    directory=os.open(
        os.path.dirname(path) or ".",
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

write_override() {
  cat > "$OVERRIDE_FILE" <<EOF
services:
  ${GATEWAY_SERVICE}:
    environment:
      MSC_APPROVED_ACTIONS_CONFIG: ${CONTAINER_CONFIG}/production.json
    ports:
      - "127.0.0.1:${LISTENER_PORT}:${LISTENER_PORT}"
    volumes:
      - ${APP_ROOT}:${CONTAINER_APP}:ro
      - ${APP_ROOT}/bin/msc:/usr/local/bin/msc:ro
      - ${PRODUCTION_CONFIG}:${CONTAINER_CONFIG}/production.json:ro
      - ${PROPOSAL_CONFIG}:${CONTAINER_CONFIG}/proposal.json:ro
      - ${BOOTSTRAP_CONFIG}:${CONTAINER_CONFIG}/bootstrap.json:ro
      - ${STATE_ROOT}:${CONTAINER_STATE}:rw
      - ${SECRET_ROOT}/msc-approved-mail-encryption-key:/run/secrets/msc_approval_encryption_key:ro
      - ${SECRET_ROOT}/msc-approved-mail-signing-key:/run/secrets/msc_approval_signing_key:ro
      - ${SECRET_ROOT}/msc-approved-mail-session-key:/run/secrets/msc_approval_session_key:ro
EOF
  chown root:root "$OVERRIDE_FILE"
  chmod 0600 "$OVERRIDE_FILE"
}

write_caddy_configuration() {
  python3 "${SCRIPT_DIR}/render-caddy.py" \
    "$CADDY_CONFIG" "$PUBLIC_BASE_PATH" "$LISTENER_PORT"
  caddy validate --config "$CADDY_CONFIG" >/dev/null \
    || die "Erweiterte Caddy-Konfiguration ist ungültig."
}

wait_for_gateway_health() {
  local timeout_seconds="${1:-180}"
  local deadline=$((SECONDS + timeout_seconds)) container health=""
  while ((SECONDS < deadline)); do
    container="$(compose ps -q "$GATEWAY_SERVICE" 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      health="$(docker inspect -f \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container" 2>/dev/null || true)"
      if [[ "$health" == healthy ]]; then
        GATEWAY_CONTAINER="$container"
        return 0
      fi
      if [[ "$health" == none ]] && docker exec "$container" openclaw health \
        >/dev/null 2>&1; then
        GATEWAY_CONTAINER="$container"
        return 0
      fi
    fi
    sleep 2
  done
  if [[ -n "$container" ]]; then
    printf '[msc-approved-mail] Gateway-Diagnose nach Zeitüberschreitung:\n' >&2
    docker inspect "$container" --format \
      '{{range .State.Health.Log}}{{println .Start "exit=" .ExitCode .Output}}{{end}}' \
      >&2 2>/dev/null || true
    docker logs --tail 120 "$container" >&2 2>/dev/null || true
  else
    printf '[msc-approved-mail] Gateway wurde nicht gestartet.\n' >&2
  fi
  return 1
}

activate_and_verify() {
  compose config --quiet
  log "Gateway wird genau einmal mit dem freigegebenen Dienst neu erstellt."
  compose up -d --no-deps --force-recreate "$GATEWAY_SERVICE"
  wait_for_gateway_health 180 \
    || die "Gateway wurde innerhalb von 180 Sekunden nicht healthy."
  local container="$GATEWAY_CONTAINER"
  caddy reload --config "$CADDY_CONFIG" >/dev/null \
    || die "Caddy-Konfiguration konnte nicht neu geladen werden."
  docker exec "$container" openclaw plugins inspect msc-approved-mail --runtime --json \
    >/dev/null || die "Produktionsplugin ist nicht aktiv."
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' \
    "${PUBLIC_ORIGIN}${PUBLIC_BASE_PATH}/register")" == 200 ]] \
    || die "Passkey-Einrichtungsseite ist über HTTPS nicht erreichbar."
  docker exec "$container" /usr/local/bin/msc-mail-readonly accounts \
    >/dev/null || die "Read-only-Mailzugriff ist nach Aktivierung gestört."
  ROLLBACK_ARMED=0
}

main() {
  (($# == 0)) || die "Das Skript akzeptiert keine Argumente."
  require_preflight
  detect_runtime
  backup_current
  build_application
  write_configuration
  enable_plugin
  write_override
  write_caddy_configuration
  activate_and_verify
  printf '\nMSC-Mail-Freigabedienst ist aktiv.\n'
  printf 'Passkey-Seite: %s%s/register\n' "$PUBLIC_ORIGIN" "$PUBLIC_BASE_PATH"
  printf 'Bootstrap-Code erzeugen:\n'
  printf 'docker exec -u 1000 %s node %s/dist/src/passkey-bootstrap-operator-cli.js --config %s/bootstrap.json --actor vinzenz\n' \
    "$GATEWAY_CONTAINER" "$CONTAINER_APP" "$CONTAINER_CONFIG"
  printf 'Antworten vorbereiten mit: msc mail reply --config %s/proposal.json ...\n' \
    "$CONTAINER_CONFIG"
  printf 'Backup: %s\n' "$BACKUP_DIR"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap rollback EXIT INT TERM
  main "$@"
fi
