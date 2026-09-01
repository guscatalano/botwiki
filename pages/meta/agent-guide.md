---
title: Agent guide
tags: [meta, agents]
summary: How an AI agent should query and update this wiki.
---

# Agent guide

If you are an agent connected to the `botwiki` MCP server, this is your operating
manual.

## Read before you answer

When a question touches this environment — a host, a service, a procedure, "how
do we do X here" — call `wiki_search` **before** answering from general knowledge.
The wiki wins over your priors, because it describes this specific setup.

```
wiki_search("proxmox backup schedule")   -> ranked slugs + snippets
wiki_read("runbooks/restore-a-container") -> full page + backlinks
wiki_list()                               -> everything, with summaries
wiki_tags()                               -> what the wiki covers
```

If search returns nothing, say so plainly rather than inventing a local detail.
A confident wrong hostname is worse than "the wiki doesn't cover that".

## Write when you learn something durable

Call `wiki_write` when you discover something that will still be true next month
and that isn't already recorded: a fix that worked, a constraint you hit, a
decision and its reasoning.

- `wiki_read` first if the page might exist — `wiki_write` replaces the body.
- Send a bare markdown body; pass `title` and `tags` as arguments.
- Prefer amending an existing page over creating a near-duplicate.

Do not record secrets. No passwords, API keys, or private keys — reference where
a credential lives (`the token is in Vault at secret/botwiki`), never its value.

## Tone

Pages are written for a colleague at 3am with a broken service. Short sentences,
exact values, no throat-clearing.
