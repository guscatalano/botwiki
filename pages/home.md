---
title: Home
tags: [meta]
summary: Start here. What this wiki is for and how it is organised.
---

# Home

This is a local wiki. It is the source of truth for things that are **true about
this environment** and that no amount of general knowledge could tell you: host
names, IP addresses, why a service is configured the way it is, and the exact
steps that fix a thing when it breaks.

Humans read and edit it in the browser. Agents query it over MCP with
`wiki_search`, `wiki_read` and `wiki_write`.

## How it is organised

| Folder | Holds |
| --- | --- |
| `hosts/` | One page per physical machine or VM/CT |
| `services/` | One page per running service — what it is, where it lives, how it is configured |
| `runbooks/` | Step-by-step procedures: restore, rotate, upgrade, recover |
| `decisions/` | Why we chose X over Y, dated, with the tradeoff |
| `meta/` | Conventions for the wiki itself |

## Start here

- [[meta/conventions]] — how to write a page that agents can actually use
- [[meta/agent-guide]] — how agents should query and update this wiki
- [[hosts/pve-01]] — example host page
- [[runbooks/restore-a-container]] — example runbook
