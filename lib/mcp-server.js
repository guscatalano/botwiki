// The MCP surface agents see. Transport-agnostic: server/mcp.js attaches this to
// either stdio (agent on the same box) or streamable HTTP (agent over the network).

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as wiki from './wiki.js';
import { buildGraph, relatedTo } from './graph.js';
import * as talk from './talk.js';
import { find } from './find.js';
import * as types from './types.js';
import * as history from './history.js';
import * as revisions from './revisions.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function formatHit(h, i) {
  const tags = h.tags.length ? `  [${h.tags.join(', ')}]` : '';
  return `${i + 1}. ${h.title} — page: ${h.slug}${tags}\n   ${h.snippet}`;
}

export function createWikiServer({
  readOnly = false,
  clientIp = null,
  via = 'mcp',
  serverHost = null,
  // Read lazily: the transport only has an id after initialize has run.
  getConnectionId = () => null,
} = {}) {
  const server = new McpServer(
    { name: 'botwiki', version: '1.0.0' },
    {
      instructions: [
        'A local markdown wiki. Use it as the source of truth for this team/homelab:',
        'conventions, runbooks, host and service inventory, decisions, and gotchas.',
        '',
        'Before answering from general knowledge, call wiki_search with the key nouns',
        'from the question. Call wiki_read to get a full page once search points at one.',
        readOnly
          ? 'This instance is read-only.'
          : 'When you learn something durable and non-obvious, record it with wiki_write.',
        'Pages are addressed by slug, e.g. "runbooks/restore-postgres". Link between',
        'pages with [[other-slug]].',
        '',
        'The wiki is a graph, not a flat list. After reading a page, wiki_related pulls',
        'in its neighbours — explicitly linked, sharing a tag, or similar in content —',
        'which often carries the context the page itself assumes. wiki_graph shows the',
        'whole shape: clusters, hubs, orphans, and links to pages that do not exist yet.',
        '',
        'Every page has a discussion thread. wiki_read flags any open comments; read',
        'them with wiki_comments before you trust or change that page. When you suspect',
        'something is wrong but cannot verify it, or the call is not yours to make,',
        'leave a wiki_comment instead of editing. A comment costs nothing and is',
        'reversible; a confident wrong edit is what makes a wiki stop being trusted.',
        '',
        'If you have a situation rather than a keyword — a symptom, a task, a vague',
        'sense of what you need — use wiki_find and describe it in a sentence.',
        'wiki_search is for when you already know the exact term.',
        '',
        'Pages may declare a type (host, service, runbook, decision...) with expected',
        'fields; wiki_query fetches every page of a type. Pages also carry a freshness',
        'record: how long since anyone CONFIRMED the page is still true, which is a',
        'different question from when it was last edited. If you check a page against',
        'reality and it holds, say so with wiki_verify — that is how the wiki knows',
        'the difference between "accurate" and merely "recently written".',
        '',
        'Send your `host` (the machine you are on) with every write and comment.',
        'Pages here contain machine-specific paths, and a path is meaningless',
        'without knowing which machine it lives on. When you write one, name the',
        'machine in the page text too.',
        '',
        'Send the same `session` id on every write in one run. It is what makes it',
        'possible to ask later what else that run touched.',
      ].join('\n'),
    }
  );

  server.registerTool(
    'wiki_search',
    {
      title: 'Search the wiki',
      description:
        'Full-text ranked search across every wiki page. Start here for any question about local hosts, services, conventions, runbooks or past decisions. Returns page slugs to feed to wiki_read.',
      inputSchema: {
        query: z.string().describe('Search terms, e.g. "proxmox backup schedule"'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
        tag: z.string().optional().describe('Restrict results to pages carrying this tag'),
      },
    },
    async ({ query, limit, tag }) => {
      const hits = await wiki.search(query, { limit: limit ?? 10, tag });
      if (!hits.length) {
        const tags = await wiki.allTags();
        return text(
          `No wiki pages matched ${JSON.stringify(query)}.` +
            (tags.length ? `\n\nExisting tags: ${tags.map((t) => t.tag).join(', ')}` : '') +
            `\nUse wiki_list to see every page.`
        );
      }
      return text(
        `${hits.length} result(s) for ${JSON.stringify(query)}:\n\n${hits.map(formatHit).join('\n\n')}`
      );
    }
  );

  server.registerTool(
    'wiki_read',
    {
      title: 'Read a wiki page',
      description:
        'Return the full markdown of one wiki page by slug, plus its backlinks. The response includes a baseHash — pass it to wiki_write to make your edit safe against another agent changing the page in the meantime.',
      inputSchema: {
        page: z.string().describe('Page slug, e.g. "runbooks/restore-postgres"'),
      },
    },
    async ({ page }) => {
      const doc = await wiki.readPage(page);
      if (!doc) {
        const near = await wiki.search(page, { limit: 5 });
        return fail(
          `No page named "${page}".` +
            (near.length
              ? `\n\nClosest matches:\n${near.map((h) => `- ${h.slug} — ${h.title}`).join('\n')}`
              : '\n\nUse wiki_list to see every page.')
        );
      }
      const back = await wiki.backlinks(doc.slug);
      const footer = back.length
        ? `\n\n---\nLinked from: ${back.map((b) => b.slug).join(', ')}`
        : '';
      // An agent must not act on a page that someone has flagged as wrong.
      const open = (await talk.listComments(doc.slug)).filter((c) => c.status !== 'resolved');
      const discussion = open.length
        ? `\n\n---\nDISCUSSION: ${open.length} open comment(s) on this page. ` +
          `Read them with wiki_comments before trusting or changing it:\n` +
          open
            .map((c) => `- [${c.kind}] ${c.body.split('\n')[0].slice(0, 110)}`)
            .join('\n')
        : '';
      const stale = types.stalenessOf(doc, await types.loadTypes());
      const freshness =
        stale.status === 'stale'
          ? `\nFRESHNESS: STALE — ${types.describeStaleness(stale)}. Verify before relying on it.`
          : stale.status === 'aging'
            ? `\nfreshness: aging — ${types.describeStaleness(stale)}`
            : stale.neverVerified
              ? `\nfreshness: never verified (last edited ${stale.editedDays ?? '?'}d ago)`
              : `\nfreshness: ${types.describeStaleness(stale)}`;
      const p = doc.provenance;
      const edit = p
        ? `\nlast edit: ${wiki.describeProvenance(p)}` +
          (p.claimed.context ? `\nreason given: ${p.claimed.context}` : '') +
          (Object.keys(p.claimed).length
            ? `\n(agent/model/reason are self-reported by whoever wrote the page, not verified)`
            : '')
        : '';
      return text(
        `# ${doc.title}\npage: ${doc.slug}\nbaseHash: ${doc.hash}${doc.type ? `\ntype: ${doc.type}` : ''}${doc.tags.length ? `\ntags: ${doc.tags.join(', ')}` : ''}\nupdated: ${doc.updated}${freshness}${edit}\n\n${doc.body}${discussion}${footer}`
      );
    }
  );

  server.registerTool(
    'wiki_list',
    {
      title: 'List wiki pages',
      description:
        'List every page with its title, tags and one-line summary. Use to get oriented, or with a tag to browse one area.',
      inputSchema: {
        tag: z.string().optional().describe('Only pages carrying this tag'),
        type: z.string().optional().describe('Only pages of this type'),
      },
    },
    async ({ tag, type }) => {
      const pages = await wiki.listPages({ tag, type });
      if (!pages.length) return text(tag ? `No pages tagged "${tag}".` : 'The wiki is empty.');
      const tags = await wiki.allTags();
      return text(
        `${pages.length} page(s)${tag ? ` tagged "${tag}"` : ''}:\n\n` +
          pages
            .map(
              (p) =>
                `- ${p.slug} — ${p.title}${p.type ? ` <${p.type}>` : ''}${p.tags.length ? ` [${p.tags.join(', ')}]` : ''}` +
                (p.summary ? `\n    ${p.summary}` : '')
            )
            .join('\n') +
          (!tag && tags.length
            ? `\n\nTags: ${tags.map((t) => `${t.tag}(${t.count})`).join(', ')}`
            : '')
      );
    }
  );

  server.registerTool(
    'wiki_tags',
    {
      title: 'List wiki tags',
      description: 'Every tag in use, with page counts. Cheap way to see what the wiki covers.',
      inputSchema: {},
    },
    async () => {
      const tags = await wiki.allTags();
      return text(
        tags.length
          ? tags.map((t) => `${t.tag} (${t.count})`).join('\n')
          : 'No tags yet.'
      );
    }
  );

  server.registerTool(
    'wiki_related',
    {
      title: 'Find pages related to a page',
      description:
        'Given a page, return the pages connected to it, how strongly (0..1) and on what evidence: counted [[links]], shared tags weighted by rarity, and prose similarity. Ranked by strength, so the top result is the most related page, not merely the first linked one. Use it to pull in context after wiki_read, or to see what a change might affect.',
      inputSchema: {
        page: z.string().describe('Page slug to find neighbours of'),
        limit: z.number().int().min(1).max(30).optional().describe('Max results (default 8)'),
      },
    },
    async ({ page, limit }) => {
      const rel = await relatedTo(page, { limit: limit ?? 8 });
      if (!rel) return fail(`No page named "${page}". Use wiki_list to see every page.`);
      if (!rel.length) {
        return text(
          `"${page}" has no connections yet — nothing links to it, it shares no tags, and no page is similar enough. It may be an orphan worth linking from somewhere.`
        );
      }
      const band = (v) => (v >= 0.6 ? 'strong' : v >= 0.25 ? 'moderate' : 'weak');
      const because = (r) => {
        const e = r.evidence || {};
        const bits = [];
        if (e.mentions) {
          bits.push(`${e.mentions} explicit link${e.mentions > 1 ? 's' : ''}${e.mutual ? ', mutual' : ''}`);
        }
        if (e.sharedTags?.length) bits.push(`shares ${e.sharedTags.join(', ')}`);
        if (e.similarity) bits.push(`${Math.round(e.similarity * 100)}% similar prose`);
        return bits.join(' · ') || r.type;
      };
      return text(
        `Pages related to ${page}, strongest first:\n\n` +
          rel
            .map((r) => {
              const arrow =
                r.direction === 'out' ? 'this page -> that one'
                : r.direction === 'in' ? 'that page -> this one'
                : r.direction === 'mutual' ? 'both ways'
                : '';
              return `- ${r.slug} — ${r.title}\n    ${band(r.strength)} (${r.strength}) · ${because(r)}` +
                (arrow ? `\n    direction: ${arrow}` : '');
            })
            .join('\n') +
          `\n\nStrength combines every kind of evidence, so a page sharing two rare tags can outrank one that mentions this page once in passing.`
      );
    }
  );

  server.registerTool(
    'wiki_comments',
    {
      title: 'Read a page discussion',
      description:
        "Read the discussion thread attached to a page: notes, questions, and flags that something is stale, contradictory, or worth changing. Read this before trusting a page you are about to act on, and before rewriting one. Comments live alongside the page but are not part of it.",
      inputSchema: {
        page: z.string().describe('Page slug whose discussion to read'),
        includeResolved: z.boolean().optional().describe('Include resolved comments (default false)'),
      },
    },
    async ({ page, includeResolved }) => {
      const all = await talk.listComments(page);
      const shown = includeResolved ? all : all.filter((c) => c.status !== 'resolved');
      if (!shown.length) {
        return text(
          all.length
            ? `No open comments on ${page} (${all.length} resolved). Pass includeResolved to see them.`
            : `No discussion on ${page} yet.`
        );
      }
      return text(
        `${shown.length} comment(s) on ${page}:\n\n` +
          shown
            .map(
              (c) =>
                `[${c.id}] ${c.kind.toUpperCase()}${c.status === 'resolved' ? ' (resolved)' : ''}\n` +
                `  by ${c.author}${c.model ? ` (${c.model})` : ''}${c.via ? ` via ${c.via}` : ''} at ${c.at}\n` +
                c.body.split('\n').map((l) => `  ${l}`).join('\n') +
                (c.resolution ? `\n  → resolved: ${c.resolution}` : '')
            )
            .join('\n\n')
      );
    }
  );

  if (!readOnly) {
    server.registerTool(
      'wiki_comment',
      {
        title: 'Comment on a page',
        description:
          "Leave a comment on a page's discussion thread instead of editing the page. Use this when you suspect something is wrong but cannot verify it, when you have a question for whoever wrote it, or when a change is someone else's call. Prefer a comment over a silent edit whenever you are not certain.",
        inputSchema: {
          page: z.string().describe('Page slug to comment on'),
          body: z.string().describe('The comment. Say what you observed and what you would do about it.'),
          kind: z
            .enum(['note', 'question', 'stale', 'contradiction', 'suggestion'])
            .optional()
            .describe(
              'note (default) · question (needs a human answer) · stale (page disagrees with reality) · contradiction (page disagrees with another page) · suggestion (a change worth making)'
            ),
          model: z.string().optional().describe('Your model identifier, e.g. "claude-opus-5"'),
          host: z.string().optional().describe('The hostname of the machine you are running on.'),
          session: z.string().optional().describe('Your conversation or session id. Send the same value for every write in one run. It is what lets someone later ask what else that run touched — the first thing worth knowing when one of your pages turns out to be wrong.'),
        },
      },
      async ({ page, body, kind, model, host, session }) => {
        const doc = await wiki.readPage(page);
        if (!doc) return fail(`No page named "${page}". Comment on a page that exists.`);
        const client = server.server.getClientVersion();
        const c = await talk.addComment(page, body, {
          kind,
          model,
          host: serverHost || host,
          session: session || getConnectionId(),
          via,
          ip: clientIp,
          author: client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : null,
        });
        return text(
          `Added ${c.kind} comment ${c.id} to the discussion on ${doc.slug}. ` +
            `The page itself is unchanged, and wiki_read will now flag this to anyone who opens it.`
        );
      }
    );

    server.registerTool(
      'wiki_resolve_comment',
      {
        title: 'Resolve a page comment',
        description:
          'Mark a comment resolved once it has been dealt with — the page was fixed, or the concern turned out not to apply. Say which in the resolution.',
        inputSchema: {
          page: z.string().describe('Page slug the comment is on'),
          id: z.string().describe('Comment id, e.g. "c-m1abc2xyz"'),
          resolution: z.string().optional().describe('One line on what was done, or why nothing was needed'),
        },
      },
      async ({ page, id, resolution }) => {
        const client = server.server.getClientVersion();
        const c = await talk.resolveComment(page, id, {
          by: client ? client.name : 'unknown',
          resolution,
        });
        return c
          ? text(`Resolved ${id} on ${page}.`)
          : fail(`No comment "${id}" on ${page}. Use wiki_comments to list them.`);
      }
    );
  }

  server.registerTool(
    'wiki_review_queue',
    {
      title: 'Every open comment across the wiki',
      description:
        'All unresolved discussion, newest first. Use it to find what needs attention across the whole wiki rather than page by page.',
      inputSchema: {
        kind: z
          .enum(['note', 'question', 'stale', 'contradiction', 'suggestion'])
          .optional()
          .describe('Only comments of this kind'),
      },
    },
    async ({ kind }) => {
      let open = await talk.allOpen();
      if (kind) open = open.filter((c) => c.kind === kind);
      if (!open.length) return text(kind ? `No open ${kind} comments.` : 'No open comments anywhere.');
      const byKind = {};
      for (const c of open) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
      return text(
        `${open.length} open comment(s) — ` +
          Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') +
          `:\n\n` +
          open
            .map(
              (c) =>
                `${c.page}  [${c.id}] ${c.kind.toUpperCase()}\n  ${c.body.split('\n')[0].slice(0, 150)}`
            )
            .join('\n\n')
      );
    }
  );

  server.registerTool(
    'wiki_history',
    {
      title: 'Who changed a page, when, and why',
      description:
        "Every recorded revision of a page, newest first, with the edit record as it was AT that revision: which agent, which model, from what address, and the reason they gave. Use it to find out who introduced a claim you doubt, or whether a page has been rewritten repeatedly without ever being verified. Note the agent/model/reason are self-reported at write time and were not verified.",
      inputSchema: {
        page: z.string().describe('Page slug'),
        limit: z.number().int().min(1).max(100).optional().describe('How many revisions (default 15)'),
      },
    },
    async ({ page, limit }) => {
      const doc = await wiki.readPage(page);
      if (!doc) return fail(`No page named "${page}".`);
      const revs = await history.historyOf(page, { limit: limit ?? 15 });
      if (!revs.length) {
        return text(`No history for ${doc.slug} — the pages directory is not under version control.`);
      }
      const who = await history.contributorsOf(page);
      return text(
        `${revs.length} revision(s) of ${doc.slug}:\n\n` +
          revs
            .map((r) => {
              const p2 = r.provenance || { observed: {}, claimed: {} };
              return (
                `${r.short}  ${String(r.at).slice(0, 16).replace('T', ' ')}  ` +
                `${p2.claimed?.agent || 'unrecorded'}` +
                `${p2.claimed?.model ? ` (${p2.claimed.model})` : ''}` +
                `${p2.observed?.via ? ` via ${p2.observed.via}` : ''}` +
                `${p2.claimed?.context ? `\n    reason: ${p2.claimed.context}` : ''}` +
                `\n    ${r.lines} lines, commit: ${r.subject}`
              );
            })
            .join('\n\n') +
          `\n\nContributors: ${who.map((c) => `${c.who} (${c.edits})`).join(', ')}`
      );
    }
  );

  server.registerTool(
    'wiki_session',
    {
      title: 'Everything one run of an agent touched',
      description:
        "Every page and comment written under one session id, oldest first. Use it to find the blast radius of a run: if one page from a session turns out to be wrong, the others written by the same run are the most likely to be wrong in the same way. Call with no id to list recent sessions.",
      inputSchema: {
        session: z.string().optional().describe('Session id. Omit to list recent sessions.'),
      },
    },
    async ({ session }) => {
      if (!session) {
        const list = await revisions.sessions({ limit: 15 });
        if (!list.length) return text('No sessions recorded yet.');
        return text(
          `${list.length} recent session(s):\n\n` +
            list
              .map(
                (s2) =>
                  `${s2.session}\n` +
                  `  ${s2.agent || 'unknown'}${s2.model ? ` (${s2.model})` : ''}` +
                  `${s2.host ? ` on ${s2.host}` : ''}\n` +
                  `  ${s2.edits} edit(s) across ${s2.pages.length} page(s), ` +
                  `${String(s2.first).slice(0, 16).replace('T', ' ')} to ${String(s2.last).slice(0, 16).replace('T', ' ')}\n` +
                  `  ${s2.pages.slice(0, 8).join(', ')}${s2.pages.length > 8 ? ', ...' : ''}`
              )
              .join('\n\n')
        );
      }
      const rows = await revisions.bySession(session);
      if (!rows.length) return text(`Nothing recorded under session "${session}".`);
      return text(
        `${rows.length} change(s) in session ${session}, oldest first:\n\n` +
          rows
            .map(
              (r) =>
                `${String(r.at).slice(0, 16).replace('T', ' ')}  ${r.op.padEnd(6)} ${r.page}` +
                (r.provenance?.claimed?.context ? `\n    ${r.provenance.claimed.context}` : '')
            )
            .join('\n')
      );
    }
  );

  server.registerTool(
    'wiki_changes',
    {
      title: 'What changed across the wiki lately',
      description:
        'Recent commits touching any page, newest first. Use it to catch up on what has moved since you last looked.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }) => {
      const changes = await history.recentChanges({ limit: limit ?? 20 });
      if (!changes.length) return text('No history — the pages directory is not under version control.');
      return text(
        changes
          .map(
            (c) =>
              `${String(c.at).slice(0, 16).replace('T', ' ')}  ${c.subject}\n    ${c.pages.join(', ')}`
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'wiki_find',
    {
      title: 'Find pages from a vague description',
      description:
        'Describe the situation in your own words — a symptom, a task, a half-remembered detail — and get back a short list of the most relevant pages. Unlike wiki_search this does not need the exact words on the page; it matches meaning by term overlap weighted toward rare words, then blends in the lexical score so an exact identifier still wins. Use this when you have context rather than a keyword.',
      inputSchema: {
        context: z
          .string()
          .describe('What you are actually after, in a sentence or two. More context helps.'),
        limit: z.number().int().min(1).max(20).optional().describe('How many pages (default 5)'),
        type: z.string().optional().describe('Only pages of this type'),
        tag: z.string().optional().describe('Only pages with this tag'),
      },
    },
    async ({ context, limit, type, tag }) => {
      const res = await find(context, { limit: limit ?? 5, type, tag });
      if (!res.results.length) {
        return text(
          `Nothing in the wiki looks relevant to that.` +
            (res.unknown?.length
              ? `\n\nThese words appear nowhere in the wiki: ${res.unknown.slice(0, 8).join(', ')}. ` +
                `That may mean the subject is genuinely undocumented.`
              : '') +
            `\n\n${res.considered} page(s) were considered.`
        );
      }
      return text(
        `${res.results.length} of ${res.considered} pages look relevant:\n\n` +
          res.results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title} — page: ${r.slug}${r.type ? ` (${r.type})` : ''}\n` +
                `   relevance ${r.score}${r.matched.length ? ` · matched on: ${r.matched.join(', ')}` : ''}` +
                (r.staleness?.status === 'stale' ? `\n   WARNING: this page is stale` : '') +
                (r.summary ? `\n   ${r.summary}` : '')
            )
            .join('\n\n') +
          (res.unknown?.length
            ? `\n\nNot found anywhere in the wiki: ${res.unknown.slice(0, 8).join(', ')}`
            : '')
      );
    }
  );

  server.registerTool(
    'wiki_query',
    {
      title: 'Query pages by type and field',
      description:
        'Fetch every page of a given type, optionally filtered on its fields — "every host on pve1", "every runbook". Types and their expected fields are defined on the meta/types page. Use wiki_types to see what exists.',
      inputSchema: {
        type: z.string().optional().describe('Page type, e.g. "host" or "runbook"'),
        where: z
          .record(z.string())
          .optional()
          .describe('Field filters, e.g. {"node": "pve1"}. Matches case-insensitive substrings.'),
        tag: z.string().optional().describe('Also require this tag'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ type, where, tag, limit }) => {
      const rows = await types.queryPages({ type, where: where || {}, tag, limit: limit ?? 100 });
      if (!rows.length) {
        const rep = await types.typeReport();
        return text(
          `No pages matched.` +
            (rep.types.length
              ? `\n\nTypes in use: ${rep.types.map((t) => `${t.type}(${t.count})`).join(', ')}`
              : `\n\nNo types are defined yet — see ${types.TYPES_PAGE}.`)
        );
      }
      return text(
        `${rows.length} page(s):\n\n` +
          rows
            .map((r) => {
              const fields = Object.entries(r.fields)
                .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`)
                .join(' · ');
              return (
                `- ${r.slug} — ${r.title}` +
                (fields ? `\n    ${fields}` : '') +
                (r.staleness.status === 'stale' ? `\n    STALE (${types.describeStaleness(r.staleness)})` : '') +
                (r.conformance.missing.length
                  ? `\n    missing required field(s): ${r.conformance.missing.join(', ')}`
                  : '')
              );
            })
            .join('\n')
      );
    }
  );

  server.registerTool(
    'wiki_types',
    {
      title: 'Page types and how well pages conform',
      description:
        'The type registry from meta/types: each type, its required and optional fields, how often pages of that type should be re-verified, and which pages currently fall short. Conformance is advisory — a page missing a field is still a page.',
      inputSchema: {},
    },
    async () => {
      const rep = await types.typeReport();
      if (!rep.types.length) {
        return text(
          `No types are defined. Create the page ${types.TYPES_PAGE} with a markdown table: ` +
            `| type | required | optional | ttl | description |`
        );
      }
      return text(
        [
          'Types:',
          ...rep.types.map(
            (t) =>
              `  ${t.type} (${t.count} page(s)) — required: ${t.required.join(', ') || 'none'}` +
              `; optional: ${t.optional.join(', ') || 'none'}` +
              `; review every ${t.ttlDays ?? 'never'}${t.ttlDays ? 'd' : ''}` +
              (t.description ? `\n      ${t.description}` : '')
          ),
          ...(rep.unknownTypes.length
            ? ['', `Pages declare these UNDEFINED types: ${rep.unknownTypes.join(', ')}`]
            : []),
          ...(rep.problems.length
            ? [
                '',
                'Pages not conforming:',
                ...rep.problems.map(
                  (p) =>
                    `  ${p.slug} — ${p.problem || `missing ${p.missing.join(', ')}`}` +
                    (p.extra?.length ? ` (unexpected: ${p.extra.join(', ')})` : '')
                ),
              ]
            : ['', 'Every typed page conforms.']),
          ...(rep.untyped.length ? ['', `Untyped pages (${rep.untyped.length}): ${rep.untyped.join(', ')}`] : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'wiki_stale',
    {
      title: 'Pages whose freshness has lapsed',
      description:
        'Pages that are overdue for re-verification, worst first. Freshness is measured from the last time someone CONFIRMED a page was still true, not from the last edit — a page rewritten yesterday may never have been checked against reality.',
      inputSchema: {
        includeUntracked: z
          .boolean()
          .optional()
          .describe('Also list pages with no review interval at all (default false)'),
      },
    },
    async ({ includeUntracked }) => {
      const rows = await types.staleReport({ includeUntracked: includeUntracked ?? false });
      if (!rows.length) return text('Nothing is overdue for verification.');
      return text(
        `${rows.length} page(s) need attention:\n\n` +
          rows
            .map(
              (r) =>
                `- ${r.slug} — ${r.status.toUpperCase()}${r.overdueBy ? `, overdue by ${r.overdueBy}d` : ''}\n` +
                `    ${types.describeStaleness(r)}`
            )
            .join('\n')
      );
    }
  );

  server.registerTool(
    'wiki_graph',
    {
      title: 'Overview of how the wiki is connected',
      description:
        'The shape of the whole wiki: clusters, the most connected hub pages, orphans with no connections, and links pointing at pages that do not exist. Use it to get oriented in an unfamiliar wiki, or to find gaps worth filling.',
      inputSchema: {
        includeSimilar: z
          .boolean()
          .optional()
          .describe('Count inferred content-similarity edges too (default true)'),
      },
    },
    async ({ includeSimilar }) => {
      const g = await buildGraph({ includeSimilar: includeSimilar ?? true });
      if (!g.nodes.length) return text('The wiki is empty.');

      const byGroup = new Map();
      for (const n of g.nodes) {
        if (!byGroup.has(n.group)) byGroup.set(n.group, []);
        byGroup.get(n.group).push(n);
      }
      const hubs = [...g.nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 5);
      const orphans = g.nodes.filter((n) => n.degree === 0);

      return text(
        [
          `${g.stats.pages} pages, ${g.stats.edges} connections ` +
            `(${g.stats.links} explicit links, ${g.stats.tagEdges} by shared tag, ${g.stats.similarEdges} by content similarity).`,
          `Connections are weighted 0..1: ${g.stats.strong} strong, ${g.stats.weak} weak, mean ${g.stats.meanStrength}.`,
          '',
          'Clusters:',
          ...[...byGroup.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([group, ns]) => `  ${group}/ — ${ns.length} page(s): ${ns.map((n) => n.id).join(', ')}`),
          '',
          'Most connected:',
          ...hubs.map((n) => `  ${n.id} — ${n.degree} connection(s), weight ${n.weightedDegree}`),
          ...(orphans.length
            ? ['', `Unconnected (${orphans.length}): ${orphans.map((n) => n.id).join(', ')}`]
            : []),
          ...(g.broken.length
            ? [
                '',
                'Links pointing at pages that do not exist:',
                ...g.broken.map((b) => `  ${b.from} -> [[${b.to}]]`),
              ]
            : []),
        ].join('\n')
      );
    }
  );

  if (!readOnly) {
    server.registerTool(
      'wiki_write',
      {
        title: 'Create or update a wiki page',
        description:
          'Write a page (creates it if new, overwrites the body if it exists). Send markdown without frontmatter; title/tags are managed via the arguments. Read the page first if you mean to amend rather than replace it.',
        inputSchema: {
          page: z.string().describe('Page slug, e.g. "runbooks/restore-postgres"'),
          content: z.string().describe('Full markdown body of the page'),
          title: z.string().optional().describe('Human-readable title'),
          tags: z.array(z.string()).optional().describe('Tags for grouping and filtering'),
          type: z
            .string()
            .optional()
            .describe('Page type, e.g. "host" or "runbook". See wiki_types for what exists and what fields it expects.'),
          fields: z
            .record(z.string())
            .optional()
            .describe('Typed fields stored as frontmatter, e.g. {"address": "10.0.0.10", "node": "pve1"}. Makes the page queryable by wiki_query.'),
          ttl: z
            .string()
            .optional()
            .describe('How often this page should be re-verified, e.g. "90d". Overrides the type default.'),
          baseHash: z
            .string()
            .optional()
            .describe(
              'The baseHash from the wiki_read you based this edit on. If the page has changed since, the write is rejected and you are given the current content to merge into. ALWAYS send this when amending an existing page — without it a simultaneous edit by another agent is silently lost.'
            ),
          model: z
            .string()
            .optional()
            .describe(
              'Your model identifier, e.g. "claude-opus-5". Always send this — the wiki records who wrote each page and cannot see it otherwise.'
            ),
          host: z.string().optional().describe(
            'The hostname of the machine you are running on. Send it whenever you can: pages often contain machine-specific paths, and without this nobody can tell which machine a path refers to. It is also the only usable identity when NAT hides the real address.'
          ),
          session: z.string().optional().describe('Your conversation or session id. Send the same value for every write in one run. It is what lets someone later ask what else that run touched — the first thing worth knowing when one of your pages turns out to be wrong.'),
          context: z
            .string()
            .optional()
            .describe(
              'One line on why you are writing this: the task or question that produced it, e.g. "deploying botwiki to LXC 116". Always send this — it is what makes the edit history readable later.'
            ),
        },
      },
      async ({ page, content, title, tags, type, fields, ttl, baseHash, model, context, host, session }) => {
        const client = server.server.getClientVersion();
        let res;
        try {
          res = await wiki.writePage(page, content, {
          baseHash,
          title,
          tags,
          type,
          fields,
          ttl,
          provenance: {
            via,
            ip: clientIp,
            agent: client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : null,
            model,
            context,
            // Over stdio the server shares the agent's machine, so it knows the
            // hostname for certain and does not have to take the agent's word.
            host: serverHost || host,
            session,
            connection: getConnectionId(),
          },
          });
        } catch (err) {
          if (err?.code === 'conflict') {
            return fail(
              `${err.message}\n\n--- current content ---\n${err.current ?? '(page was deleted)'}`
            );
          }
          throw err;
        }
        const conf = types.checkPage(await wiki.readPage(res.slug), await types.loadTypes());
        const missing = [
          !model && 'model',
          !context && 'context',
          !serverHost && !host && 'host',
          !session && !getConnectionId() && 'session',
        ].filter(Boolean);
        return text(
          `${res.created ? 'Created' : 'Updated'} ${res.slug} (${res.bytes} bytes) at ${res.path}` +
            (missing.length
              ? `\n\nNote: you did not send ${missing.join(' or ')}, so the edit record for this page is incomplete. Include ${missing.length > 1 ? 'them' : 'it'} next time.`
              : '') +
            (conf.type && !conf.ok
              ? `\n\nThis page declares type "${conf.type}" but ${conf.problem || `is missing required field(s): ${conf.missing.join(', ')}`}. The page was written anyway — fill them in when you know them.`
              : '')
        );
      }
    );

    server.registerTool(
      'wiki_verify',
      {
        title: 'Record that a page is still true',
        description:
          "Mark a page as verified: you checked its claims against reality and they hold. This is NOT an edit — the page content is untouched. Only do this when you actually checked something, not merely because you read the page; a false verification is worse than none, because it resets the clock on a page nobody has really looked at.",
        inputSchema: {
          page: z.string().describe('Page slug you verified'),
          note: z
            .string()
            .optional()
            .describe('What you checked and how, e.g. "queried the Proxmox API, disk sizes match"'),
          model: z.string().optional().describe('Your model identifier'),
          host: z.string().optional().describe('The machine you checked from'),
        },
      },
      async ({ page, note, model, host }) => {
        const doc = await wiki.readPage(page);
        if (!doc) return fail(`No page named "${page}".`);
        const client = server.server.getClientVersion();
        const who = client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : 'unknown';
        await wiki.writePage(page, doc.raw, {
          verified: true,
          verifiedBy: model ? `${who} (${model})` : who,
          verifiedNote: note,
          provenance: {
            via, ip: clientIp, agent: who, model,
            host: serverHost || host,
            connection: getConnectionId(),
            context: 'verification',
          },
        });
        const s = types.stalenessOf(await wiki.readPage(page), await types.loadTypes());
        return text(`Marked ${doc.slug} verified. ${types.describeStaleness(s)}`);
      }
    );

    server.registerTool(
      'wiki_delete',
      {
        title: 'Delete a wiki page',
        description: 'Permanently delete a wiki page. Destructive — only on an explicit request.',
        inputSchema: { page: z.string().describe('Page slug to delete') },
      },
      async ({ page }) => {
        const res = await wiki.deletePage(page);
        return res.deleted ? text(`Deleted ${res.slug}.`) : fail(`No page named "${page}".`);
      }
    );
  }

  return server;
}
