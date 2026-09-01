---
title: botwiki
tags: [service, wiki, mcp, proxmox]
summary: This wiki itself — where it runs, which ports it uses, and how agents connect to it.
---

# botwiki

This wiki. Markdown files on disk are the source of truth; two small Node
processes serve them.

## Where it runs

| | |
| --- | --- |
| Container | LXC on [[hosts/pve-01]] |
| App | `/opt/botwiki` |
| Pages | `/var/lib/botwiki/pages` — **this is the data**, back it up |
| Config | `/etc/botwiki.env` (contains `WIKI_TOKEN`) |
| Units | `botwiki-web.service`, `botwiki-mcp.service` |

## Ports

| Port | Serves |
| --- | --- |
| `8787` | Browser UI + JSON API (`/api/search`, `/api/page/<slug>`) |
| `8788` | MCP over streamable HTTP at `/mcp` — this is what agents connect to |

Both answer `GET /healthz`.

## Connecting an agent

```sh
claude mcp add --transport http botwiki http://<container-ip>:8788/mcp \
  --header "Authorization: Bearer $WIKI_TOKEN"
```

## Operating it

```sh
systemctl status botwiki-web botwiki-mcp
journalctl -u botwiki-mcp -f
systemctl restart botwiki-web botwiki-mcp
```

Editing a `.md` file directly on disk is a perfectly valid way to change the
wiki — nothing caches, every request reads the files.

## Gotchas

- `WIKI_TOKEN` is shared by the web UI and the MCP endpoint. Rotating it means
  re-adding the MCP server on every agent.
- The pages directory is a git repo; a timer commits changes hourly, so `git log`
  in `/var/lib/botwiki/pages` is the page history.

See also: [[runbooks/restore-a-container]], [[meta/agent-guide]]
