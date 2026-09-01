#!/usr/bin/env bash
# Create a Proxmox LXC container and install botwiki into it.
#
# Run this ON THE PROXMOX HOST, from a copy of this repo:
#
#   scp -r botwiki root@pve-01:/root/
#   ssh root@pve-01 'cd /root/botwiki && bash deploy/create-lxc.sh'
#
# Everything is overridable from the environment:
#
#   CTID=120 HOSTNAME=wiki IP=10.0.0.120/24 GW=10.0.0.1 bash deploy/create-lxc.sh
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 110)}"
HOSTNAME="${HOSTNAME:-botwiki}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"                 # or 10.0.0.120/24
GW="${GW:-}"                     # required when IP is static
MEMORY="${MEMORY:-1024}"
SWAP="${SWAP:-512}"
CORES="${CORES:-2}"
DISK="${DISK:-8}"                # GB
UNPRIVILEGED="${UNPRIVILEGED:-1}"
ONBOOT="${ONBOOT:-1}"
START_AFTER_CREATE="${START_AFTER_CREATE:-1}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "pct not found — run this on the Proxmox host, not inside a container."
[ "$(id -u)" -eq 0 ] || die "run as root"
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists. Pass a free one: CTID=xxx bash $0"

# --- template --------------------------------------------------------------

log "Locating a Debian container template"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '/debian-1[0-9]-standard/{print $1}' | sort -V | tail -1 || true)"

if [ -z "$TEMPLATE" ]; then
  AVAIL="$(pveam available --section system | awk '/debian-1[0-9]-standard/{print $2}' | sort -V | tail -1)"
  [ -n "$AVAIL" ] || die "no debian-*-standard template available; check 'pveam available'"
  log "Downloading $AVAIL to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$AVAIL"
  TEMPLATE="$TEMPLATE_STORAGE:vztmpl/$AVAIL"
fi
log "Template: $TEMPLATE"

# --- create ----------------------------------------------------------------

if [ "$IP" = "dhcp" ]; then
  NET="name=eth0,bridge=$BRIDGE,ip=dhcp"
else
  [ -n "$GW" ] || die "a static IP needs a gateway: GW=10.0.0.1"
  NET="name=eth0,bridge=$BRIDGE,ip=$IP,gw=$GW"
fi

log "Creating CT $CTID ($HOSTNAME) — ${CORES} cores, ${MEMORY}MB, ${DISK}GB on $STORAGE"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --onboot "$ONBOOT" \
  --ostype debian \
  --description "botwiki — markdown wiki served to agents over MCP"

[ "$START_AFTER_CREATE" = "1" ] || { log "Created CT $CTID (not started)."; exit 0; }

log "Starting CT $CTID"
pct start "$CTID"

log "Waiting for the container's network"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 ||
  die "CT $CTID has no working DNS/network yet — fix networking, then run: pct exec $CTID -- bash /opt/botwiki/deploy/install.sh"

# --- copy the app in -------------------------------------------------------

log "Copying botwiki into the container"
TARBALL="$(mktemp /tmp/botwiki-XXXXXX.tar.gz)"
tar -czf "$TARBALL" -C "$REPO_DIR" \
  --exclude=node_modules --exclude=.git --exclude='*.log' .
pct exec "$CTID" -- mkdir -p /opt/botwiki
pct push "$CTID" "$TARBALL" /tmp/botwiki.tar.gz
pct exec "$CTID" -- tar -xzf /tmp/botwiki.tar.gz -C /opt/botwiki
pct exec "$CTID" -- rm -f /tmp/botwiki.tar.gz
rm -f "$TARBALL"

log "Running the installer inside CT $CTID"
pct exec "$CTID" -- bash /opt/botwiki/deploy/install.sh

CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
log "Done. CT $CTID at ${CT_IP:-<no ip>}"
