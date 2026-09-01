---
title: pve-01
tags: [proxmox, host, example]
summary: EXAMPLE PAGE — replace with your real Proxmox node. Shows the shape a host page should take.
---

# pve-01

> **This is a placeholder.** Replace the values below with your actual node, or
> delete the page. It exists to show the shape a host page should take.

Proxmox VE node. Everything in this homelab runs on it as an LXC container or VM.

## Facts

| | |
| --- | --- |
| Address | `10.0.0.10` / `pve-01.lan` |
| Web UI | `https://10.0.0.10:8006` |
| PVE version | 9.x |
| Storage | `local-lvm` (guests), `local` (templates, ISOs, dumps) |
| Backups | vzdump nightly 03:00 → `local`, keep-last 7 |

## Guests

| CTID | Name | What it is |
| --- | --- | --- |
| 110 | `botwiki` | This wiki — see [[services/botwiki]] |

## Gotchas

- Unprivileged containers cannot bind ports below 1024 without extra config;
  services here listen high (botwiki on `8787`/`8788`) and get fronted by a
  reverse proxy if a friendly port is needed.
- `pct enter <ctid>` from the node is the fastest way into a container when SSH
  is unhappy.

See also: [[runbooks/restore-a-container]]
