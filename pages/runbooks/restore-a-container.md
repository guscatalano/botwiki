---
title: Restore a container from backup
tags: [proxmox, runbook, backup, example]
summary: EXAMPLE PAGE — restore an LXC container from a vzdump backup on the Proxmox node.
---

# Restore a container from backup

> **This is a placeholder runbook.** Verify each step against your own node
> before trusting it at 3am.

Run everything below on the Proxmox node ([[hosts/pve-01]]), as root.

## 1. Find the backup

```sh
ls -lh /var/lib/vz/dump/ | grep vzdump-lxc
# or, across every storage:
pvesm list local --content backup
```

Backups are named `vzdump-lxc-<ctid>-<YYYY_MM_DD>-<HH_MM_SS>.tar.zst`.

## 2. Stop the broken container

```sh
pct stop 110
```

## 3. Restore

Restoring over an existing CTID **destroys** the current rootfs, so take the
`--force` flag seriously.

```sh
pct restore 110 /var/lib/vz/dump/vzdump-lxc-110-2026_08_30-03_00_01.tar.zst \
  --storage local-lvm \
  --force 1
```

To restore alongside the original instead, give it a free CTID and a new
hostname:

```sh
pct restore 999 /var/lib/vz/dump/vzdump-lxc-110-....tar.zst \
  --storage local-lvm --hostname botwiki-restored
```

## 4. Start and verify

```sh
pct start 110
pct exec 110 -- systemctl status botwiki-web botwiki-mcp --no-pager
curl -fsS http://10.0.0.110:8787/healthz
```

## If it fails

- *"volume already exists"* — the old rootfs was not removed; `pct destroy 110`
  first, then restore without `--force`.
- *Container starts but the service does not* — the unit is enabled but its
  environment file may not have been in the backup. Check `/etc/botwiki.env`.
