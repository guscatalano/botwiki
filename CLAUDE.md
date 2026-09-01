# botwiki

A local markdown wiki that AI agents query over MCP and humans browse in a browser.
Markdown files under `pages/` (or `$WIKI_DIR` in production) are the only source of
truth — there is no database and no search index to rebuild.

## Layout

| Path | What it is |
| --- | --- |
| `lib/wiki.js` | The store: list/read/write/delete, frontmatter, ranked search, wikilinks, backlinks |
| `lib/mcp-server.js` | Tool definitions agents see (`wiki_search`, `wiki_read`, `wiki_write`, …) |
| `server/mcp.js` | MCP transport: stdio by default, `--http` for streamable HTTP |
| `server/web.js` | Browser UI + JSON API |
| `lib/types.js` | Page types, field conformance, staleness |
| `lib/talk.js` | Per-page discussion, stored in `pages/.talk/` |
| `lib/history.js` | Reads git for who-changed-what; stores nothing |
| `lib/find.js` / `lib/vectors.js` | Vague-context search and the shared TF-IDF space |
| `librarian/` | Weekly reviewer: reads, probes live systems, comments |
| `pages/` | Starter content; seeded into `$WIKI_DIR` on first install |
| `deploy/` | Proxmox LXC creation, installer, systemd units |

Everything reads through `lib/wiki.js`. New surfaces (a CLI, another transport)
should go through it too rather than touching the filesystem directly.

## Traps in this repo

These have each caused a shipped bug. Three were invisible to a passing test run.

- **Never put a backtick in a comment inside `server/graph-page.js`.** The whole
  file is one template literal; a backtick in a code comment terminates it
  mid-file. Write `t()`, not the backticked form.
- **Scripted edits on Windows write CRLF.** Harmless in JS, fatal in
  `deploy/*.sh` — bash chokes on `set -euo pipefail`. Run `bash -n` after any
  scripted edit to a shell script or unit file.
- **Use Write/Edit for source files**, not large shell heredocs; past ~100 lines
  they fail with "unexpected EOF".
- **If a tool starts calling a text file binary**, look for stray control
  characters from a scripted rewrite before anything else.

## Conventions

- ESM only (`"type": "module"`), Node >= 20, no build step, no framework.
- Dependencies stay minimal: the MCP SDK, `zod`, and `marked`. Think hard before adding more.
- `pathForSlug()` is the only way to turn user input into a filesystem path — it
  rejects traversal. Do not build page paths by hand.
- **Advisory, never blocking**: a page failing type conformance still writes.
- **The librarian only comments.** The single exception is recording a
  verification, and only for a fact a probe actually compared.
- **`type` and `strength` are orthogonal** on graph edges: type names the most
  trustworthy evidence, strength says how much there is.
- **Edited is not verified.** Freshness measures from the last confirmation.
- Page bodies may be written by agents, so `server/web.js` renders raw HTML in a
  page as escaped text. Keep it that way.
- The web server hand-rolls its routing on `node:http`. Add routes in `route()`.

## Running it locally

```sh
npm run web        # browser UI on http://localhost:8787
npm run mcp        # MCP over stdio (what .mcp.json wires up)
npm run mcp:http   # MCP over HTTP on :8788/mcp
```

`.mcp.json` registers the stdio server for this project, so `wiki_*` tools are
available while working in this repo.

## Using the wiki as an agent

When a question is about *this environment* — a host, a service, a procedure, "how
do we do X here" — call `wiki_search` before answering from general knowledge, and
`wiki_read` for the full page. Record durable, non-obvious findings with
`wiki_write`. Never write secrets into a page; reference where the credential lives.
