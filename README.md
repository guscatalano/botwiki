# botwiki

A local markdown wiki that **AI agents query over MCP** and humans browse and edit
in a browser. Designed to run in a Proxmox LXC container so every agent on your
network — Claude Code on a laptop, Claude Desktop, anything else that speaks MCP —
shares one source of truth about your environment.

```
        markdown files  ──  the only source of truth
              │
   ┌──────────┴──────────┐
   │                     │
:8788/mcp             :8787
MCP server            web UI + JSON API
   │                     │
agents               humans
```

No database, no search index, no build step. Editing a `.md` file on disk is a
valid way to change the wiki; every request reads from the filesystem.

## Quick start (local)

```sh
npm install
npm run web     # http://localhost:8787
```

In another terminal, register the MCP server with Claude Code:

```sh
claude mcp add botwiki -- node "$PWD/server/mcp.js"
```

Inside this repo that step is unnecessary — `.mcp.json` already wires up the
stdio server for the project.

## Deploying to a Proxmox LXC

From your workstation, copy the repo to the Proxmox node and run one script:

```sh
scp -r botwiki root@pve-01:/root/
ssh root@pve-01 'cd /root/botwiki && bash deploy/create-lxc.sh'
```

That creates an unprivileged Debian container, installs Node, copies the app to
`/opt/botwiki`, seeds `/var/lib/botwiki/pages`, generates a token, and starts two
systemd services. It prints the URL and the ready-made `claude mcp add` command
when it finishes.

Override anything from the environment:

```sh
CTID=120 HOSTNAME=wiki IP=10.0.0.120/24 GW=10.0.0.1 \
  MEMORY=1024 DISK=8 STORAGE=local-lvm BRIDGE=vmbr0 \
  bash deploy/create-lxc.sh
```

Already have a container? Copy the repo into it and run the installer directly:

```sh
pct exec 110 -- bash /opt/botwiki/deploy/install.sh
```

The installer is idempotent — re-run it after pulling new code. It never
overwrites `/etc/botwiki.env` or your pages.

## Connecting agents

**Claude Code / Claude Desktop, over the network:**

```sh
claude mcp add --transport http botwiki http://10.0.0.110:8788/mcp \
  --header "Authorization: Bearer $WIKI_TOKEN"
```

**On the same machine as the files, over stdio:**

```sh
claude mcp add botwiki -- node /opt/botwiki/server/mcp.js
```

**Any client that reads JSON config** (`claude_desktop_config.json` and friends):

```json
{
  "mcpServers": {
    "botwiki": {
      "type": "http",
      "url": "http://10.0.0.110:8788/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

### Tools agents get

| Tool | Does |
| --- | --- |
| `wiki_search` | Ranked full-text search; returns slugs + snippets |
| `wiki_read` | Full markdown of one page, plus its backlinks |
| `wiki_list` | Every page with title, tags, summary (optionally filtered by tag) |
| `wiki_tags` | Every tag with page counts |
| `wiki_write` | Create or update a page |
| `wiki_delete` | Delete a page |

Set `WIKI_READONLY=1` to drop the last two and serve a read-only wiki.

## HTTP API

For agents and scripts that speak HTTP rather than MCP. Send the token as
`Authorization: Bearer …`.

```
GET    /api/pages[?tag=]         list pages
GET    /api/search?q=&limit=     ranked search
GET    /api/page/<slug>          page body + backlinks
PUT    /api/page/<slug>          {"content": "...", "title": "...", "tags": [...]}
DELETE /api/page/<slug>          delete
GET    /api/tags                 tags with counts
GET    /healthz                  liveness
```

## Configuration

All of it lives in `/etc/botwiki.env` (see `deploy/botwiki.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `WIKI_DIR` | `./pages` | Directory of markdown files — **this is the data** |
| `WIKI_HOST` / `WIKI_PORT` | `0.0.0.0` / `8787` | Web UI + JSON API |
| `MCP_HOST` / `MCP_PORT` | `0.0.0.0` / `8788` | MCP over HTTP |
| `MCP_TRANSPORT` | `stdio` | `http` to serve MCP over the network |
| `WIKI_TOKEN` | *(empty)* | Shared bearer token. Empty = no auth at all |
| `WIKI_READONLY` | `0` | `1` forbids all writes |
| `WIKI_TITLE` | `botwiki` | Name shown in the browser UI |

## Writing pages

Pages are markdown with light frontmatter:

```markdown
---
title: Restore a container
tags: [proxmox, runbook]
summary: One line answering "what is this page for?"
---

# Restore a container

Link to other pages with [[hosts/pve-01]] or [[hosts/pve-01|our node]].
```

Slugs are lowercase with dashes and may nest in folders
(`runbooks/restore-postgres`). Backlinks are computed automatically.

The starter pages in `pages/meta/` cover the conventions in more depth — and are
themselves the first thing to edit.

## Operating

```sh
systemctl status botwiki-web botwiki-mcp
journalctl -u botwiki-web -u botwiki-mcp -f
systemctl restart botwiki-web botwiki-mcp
```

`/var/lib/botwiki/pages` is a git repo and an hourly timer commits changes, so
`git log` there is the page history and `git revert` undoes a bad agent edit.
Back up that directory — it is the entire wiki.

## Security notes

- `WIKI_TOKEN` is the only thing between the network and write access. Set it.
- Search and read are as privileged as write when the content is sensitive: an
  agent with the token can read every page. Keep secrets out of the wiki; record
  *where* a credential lives, never its value.
- Raw HTML inside a page is rendered as text, not executed, since pages can be
  written by agents.
- The services bind `0.0.0.0` for LAN access. Do not port-forward them to the
  internet; put them behind a VPN or a reverse proxy with real auth if you need
  remote access.
