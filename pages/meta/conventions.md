---
title: Page conventions
tags: [meta]
summary: How to write a wiki page that both humans and agents can use.
---

# Page conventions

## Frontmatter

Every page carries a small YAML block. `title`, `tags` and `updated` are managed
for you when a page is saved from the browser or written by an agent.

```
---
title: Restore a container
tags: [proxmox, runbook, backup]
summary: One line answering "what is this page for?"
---
```

`summary` is what shows up in listings and in an agent's `wiki_list` output, so
write it as the answer to *"what is this page for?"* — not as a topic label.

## Body

- Open with **one paragraph** stating what the page covers. Agents read that first
  and often stop there, so make it load-bearing.
- Use `##` headings for anything someone would search for on its own.
- Put concrete values — hostnames, ports, paths, IDs — in `code spans`. They are
  what search matches on.
- Link related pages with `[[slug]]` or `[[slug|custom label]]`. Backlinks are
  computed automatically and shown at the bottom of a page.
- Date anything that will age: "as of 2026-08" beats "recently".

## What belongs here

Write it down if it is **durable and non-obvious**: a decision and its reasoning,
a hostname and what runs on it, the flag that makes the backup job actually work.

Do not write down what a machine can already tell you — package versions, the
contents of a config file that lives in git, or command output that changes daily.
Link to the source of truth instead of copying it.

## Slugs

Lowercase, dashes, folders allowed: `runbooks/restore-postgres`. The slug is the
address an agent uses, so keep it descriptive and stable. Renaming breaks
`[[links]]` — search for the old slug before you rename.
