#!/usr/bin/env bash
# Install botwiki as two systemd services. Run as root INSIDE the container:
#
#   bash /opt/botwiki/deploy/install.sh
#
# Idempotent: safe to re-run after pulling new code (it reinstalls deps, refreshes
# the units and restarts, but never overwrites /etc/botwiki.env or your pages).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/var/lib/botwiki}"
PAGES_DIR="$DATA_DIR/pages"
ENV_FILE="/etc/botwiki.env"
SVC_USER="botwiki"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git gnupg >/dev/null

have_node() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] 2>/dev/null
}

if have_node; then
  log "Node $(node -v) already present"
else
  log "Installing Node.js $NODE_MAJOR"
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh; then
    bash /tmp/nodesource.sh >/dev/null 2>&1 || true
    rm -f /tmp/nodesource.sh
  fi
  apt-get install -y -qq nodejs >/dev/null
  have_node || { echo "Node >= 20 required; got $(node -v 2>&1)" >&2; exit 1; }
  log "Installed Node $(node -v)"
fi

log "Creating service user '$SVC_USER'"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"

log "Installing dependencies in $APP_DIR"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

log "Preparing $PAGES_DIR"
mkdir -p "$PAGES_DIR"
# Seed the starter pages only into an empty wiki; never clobber real content.
if [ -z "$(ls -A "$PAGES_DIR" 2>/dev/null)" ] && [ -d "$APP_DIR/pages" ]; then
  cp -r "$APP_DIR/pages/." "$PAGES_DIR/"
  log "Seeded starter pages"
fi

if [ ! -d "$PAGES_DIR/.git" ]; then
  log "Initialising git history for the pages"
  git init -q -b main "$PAGES_DIR"
  git -C "$PAGES_DIR" config user.email "botwiki@localhost"
  git -C "$PAGES_DIR" config user.name "botwiki"
  git -C "$PAGES_DIR" add -A
  git -C "$PAGES_DIR" commit -q -m "initial pages" || true
fi
git config --global --add safe.directory "$PAGES_DIR" 2>/dev/null || true
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE with a fresh token"
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  sed "s|^WIKI_TOKEN=.*|WIKI_TOKEN=$TOKEN|" "$APP_DIR/deploy/botwiki.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown root:"$SVC_USER" "$ENV_FILE"
else
  log "Keeping existing $ENV_FILE"
fi

log "Installing librarian config"
mkdir -p /etc/botwiki
if [ ! -f /etc/botwiki/librarian.json ]; then
  sed "s|\"baseUrl\": \"http://127.0.0.1:8787\"|\"baseUrl\": \"http://127.0.0.1:${WEB_PORT_GUESS:-8787}\"|"     "$APP_DIR/librarian/config.example.json" > /etc/botwiki/librarian.json
  chmod 640 /etc/botwiki/librarian.json
  chown root:"$SVC_USER" /etc/botwiki/librarian.json
  log "Wrote /etc/botwiki/librarian.json — edit it to point probes at your gear"
else
  log "Keeping existing /etc/botwiki/librarian.json"
fi
chown root:"$SVC_USER" /etc/botwiki 2>/dev/null || true
chmod 750 /etc/botwiki

log "Installing systemd units"
install -m644 "$APP_DIR/deploy/botwiki-web.service"      /etc/systemd/system/
install -m644 "$APP_DIR/deploy/botwiki-mcp.service"      /etc/systemd/system/
install -m644 "$APP_DIR/deploy/botwiki-snapshot.service" /etc/systemd/system/
install -m644 "$APP_DIR/deploy/botwiki-snapshot.timer"   /etc/systemd/system/
install -m644 "$APP_DIR/deploy/botwiki-librarian.service" /etc/systemd/system/
install -m644 "$APP_DIR/deploy/botwiki-librarian.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now botwiki-web.service botwiki-mcp.service botwiki-snapshot.timer botwiki-librarian.timer >/dev/null
systemctl restart botwiki-web.service botwiki-mcp.service

sleep 1
WEB_PORT="$(. "$ENV_FILE"; echo "${WIKI_PORT:-8787}")"
MCP_PORT_V="$(. "$ENV_FILE"; echo "${MCP_PORT:-8788}")"
TOKEN_V="$(. "$ENV_FILE"; echo "${WIKI_TOKEN:-}")"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

if curl -fsS "http://127.0.0.1:${WEB_PORT}/healthz" >/dev/null; then
  log "web  OK  http://${IP}:${WEB_PORT}"
else
  echo "web service unhealthy — journalctl -u botwiki-web -n 50" >&2
fi
if curl -fsS "http://127.0.0.1:${MCP_PORT_V}/healthz" >/dev/null; then
  log "mcp  OK  http://${IP}:${MCP_PORT_V}/mcp"
else
  echo "mcp service unhealthy — journalctl -u botwiki-mcp -n 50" >&2
fi

cat <<EOF

  botwiki is up.

  Browser   http://${IP}:${WEB_PORT}/?token=${TOKEN_V}
  Agents    claude mcp add --transport http botwiki http://${IP}:${MCP_PORT_V}/mcp \\
              --header "Authorization: Bearer ${TOKEN_V}"

  Pages     ${PAGES_DIR}
  Config    ${ENV_FILE}
  Logs      journalctl -u botwiki-web -u botwiki-mcp -f
  Librarian systemctl start botwiki-librarian   (weekly; config /etc/botwiki/librarian.json)

EOF
