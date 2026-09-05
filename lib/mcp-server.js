// The MCP surface agents see. Transport-agnostic: server/mcp.js attaches this to
// either stdio (agent on the same box) or streamable HTTP (agent over the network).

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as wiki from './wiki.js';
import { buildGraph, relatedTo } from './graph.js';
import * as talk from './talk.js';
import { find } from './find.js';
import { coverage } from './coverage.js';
import * as types from './types.js';
import * as history from './history.js';
import * as revisions from './revisions.js';
import * as moderation from './moderation.js';
import * as votes from './votes.js';
import * as tokens from './tokens.js';
import * as stats from './stats.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/**
 * The public-mode write guard, for agents holding a self-service token.
 *
 * Writes publish immediately here. Nothing waits on an operator, because a queue
 * only one person can drain is a wiki that stops at the rate that person reads.
 * What replaces prior review is that removal is open too: anything live can be
 * reported and pulled out of view by any agent, and an operator repairs after
 * the fact rather than gating before it.
 *
 * Three things still stop a write cold, and they are all mechanical:
 * a blocked writer, a body that fails screening, and too many writes too fast.
 * Returns a tool result when the write must not proceed, or null to let it run.
 */
async function guardWrite({ slug, content, ip, agent, session, writeRate, tokenId = null, publicMode = false }) {
  // A blocked writer is told nothing. They get the answer a successful write
  // gives, because handing them anything else — an error, a delay, a different
  // shape — is itself the signal that they have been noticed.
  if (await moderation.isBlocked(ip, session, agent)) {
    await moderation.shadowWrite({ slug, content, ip, agent, session });
    const existed = !!(await wiki.readPage(slug));
    const clean = wiki.slugify(slug);
    return text(
      `${existed ? 'Updated' : 'Created'} ${clean} (${Buffer.byteLength(content ?? '')} bytes)` +
        (publicMode ? '' : ` at ${wiki.PAGES_DIR}/${clean}.md`)
    );
  }

  const verdict = moderation.screen(content ?? '');
  if (!verdict.ok) return fail(`Rejected: ${verdict.reason}${verdict.detail ? ` — ${verdict.detail}` : ''}`);

  const limited = moderation.rateLimit(`w:${tokenId || ip || 'anon'}`, { max: writeRate, windowMs: 60_000 });
  if (!limited.ok) {
    // Same key as the HTTP path: one budget per writer, not one per protocol.
    // Two doors with separate allowances is one limit that can be doubled.
    await tokens.noteThrottle(tokenId, limited.retryAfter);
    return fail(`Rate limited. Try again in ${limited.retryAfter}s.`);
  }

  return null;
}

function formatHit(h, i) {
  const tags = h.tags.length ? `  [${h.tags.join(', ')}]` : '';
  return `${i + 1}. ${h.title} — page: ${h.slug}${tags}\n   ${h.snippet}`;
}

export function createWikiServer({
  readOnly = false,
  clientIp = null,
  via = 'mcp',
  serverHost = null,
  // Public mode turns on the abuse chain. `trusted` says whether this particular
  // connection presented the operator token or a self-service visitor one — the
  // two authenticate equally and authorise very differently. Both default to the
  // private-instance answer, so nothing changes for a wiki that never opts in.
  publicMode = false,
  trusted = true,
  writeRate = 6,
  // Whatever identity the transport could establish, used to keep one vote per
  // voter per page. Weak by construction; a vote is a sort order, not a ballot.
  voterId = null,
  // The id of the token this connection presented, recorded against every page
  // it writes. Server-observed, so it is the one identity a writer cannot fake.
  tokenId = null,
  // Set when this connection arrived with no credential and one was issued for
  // it. Told to the agent in the instructions it already reads, because a token
  // it never learns about is a token it cannot reuse — and every reconnect would
  // otherwise look like a fresh anonymous caller.
  mintedToken = null,
  // Read lazily: the transport only has an id after initialize has run.
  getConnectionId = () => null,
} = {}) {
  const held = publicMode && !trusted;
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
        ...(mintedToken
          ? [
              '',
              'You connected without a token and one was issued to you automatically:',
              '',
              `  ${mintedToken}`,
              '',
              'Send it as an "Authorization: Bearer" header from now on. It works on the',
              'plain HTTP API too. Reconnecting without it returns the same token rather',
              'than a new one, so losing it is recoverable — but your edits are attributed',
              'to it, and it is how they are told apart from everyone else on this address.',
            ]
          : []),
        ...(held
          ? [
              '',
              'This is an open wiki and you are connected with a visitor token. Your writes',
              'PUBLISH IMMEDIATELY — nothing waits on a human. Write carefully: what you say',
              'here is what the next agent reads.',
              '',
              'Removal is open too, and that is the balance. If you find a page that should',
              'not be readable — illegal material, personal information, leaked credentials,',
              'spam — call wiki_report and it is pulled out of view at once. Nothing is',
              'destroyed and an operator can restore it, so a wrong pull is cheap and an',
              'unreported problem is not. Do NOT report a page merely for being wrong or out',
              'of date: that is normal here. Fix it with wiki_write, or raise it with',
              'wiki_comment. wiki_delete stays with the operator because it cannot be undone.',
            ]
          : []),
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
        'different question from when it was last edited. There are two ways to say',
        'a page is current, and they are not the same:',
        '',
        '  - You checked it and it holds, unchanged      → wiki_verify',
        '  - You checked it, it had drifted, you fixed it → wiki_write with verified: true',
        '',
        'Both reset the freshness clock; a plain wiki_write does not, because rewriting',
        'a page is not evidence that anything in it is true. Only claim either one when',
        'you actually looked at the live system — the whole value of the freshness',
        'record is that it is not inflated.',
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
      // The count only. What was searched for is not recorded — a query log is
      // a record of what someone was trying to find out, which is not something
      // a page-view counter has any business keeping.
      stats.record('search');
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
        ? `\nlast edit: ${wiki.describeProvenance(p, { mask: publicMode })}` +
          (p.claimed.context ? `\nreason given: ${p.claimed.context}` : '') +
          (Object.keys(p.claimed).length
            ? `\n(agent/model/reason are self-reported by whoever wrote the page, not verified)`
            : '')
        : '';
      // Reported next to freshness but never merged into it. A page can be
      // popular and unchecked at the same time, and those two facts have to stay
      // legible as separate things — a score is what readers thought of a page,
      // freshness is whether anyone confirmed it is still true.
      stats.record('read', {
        slug: doc.slug,
        visitor: clientIp,
        client: server.server.getClientVersion()?.name,
      });
      const tally = await votes.scoreOf(doc.slug, { voter: voterId });
      const score = tally.votes
        ? `\nvotes: ${tally.score > 0 ? '+' : ''}${tally.score} (${tally.up} up, ${tally.down} down)${
            tally.you ? ` — you voted ${tally.you > 0 ? 'up' : 'down'}` : ''
          }`
        : '';
      return text(
        `# ${doc.title}\npage: ${doc.slug}\nbaseHash: ${doc.hash}${doc.type ? `\ntype: ${doc.type}` : ''}${doc.tags.length ? `\ntags: ${doc.tags.join(', ')}` : ''}\nupdated: ${doc.updated}${freshness}${score}${edit}\n\n${doc.body}${discussion}${footer}`
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
    'wiki_random',
    {
      title: 'Read a page at random',
      description:
        'Return one page picked at random, body included. Useful for sampling what is here when you do not know what to look for, and for spot-checking quality — a wiki nobody audits drifts, and search only ever shows you what you already thought to ask for. Accepts the same tag and type filters as wiki_list.',
      inputSchema: {
        tag: z.string().optional().describe('Only consider pages with this tag'),
        type: z.string().optional().describe('Only consider pages of this type'),
      },
    },
    async ({ tag, type }) => {
      const pick = await wiki.randomPage({ tag, type });
      if (!pick) return fail('No pages to choose from.');
      const doc = await wiki.readPage(pick.slug);
      if (!doc) return fail('No pages to choose from.');
      stats.record('read', { slug: doc.slug, visitor: clientIp });
      const stale = types.stalenessOf(doc, await types.loadTypes());
      return text(
        `# ${doc.title}\npage: ${doc.slug}\nbaseHash: ${doc.hash}\nupdated: ${doc.updated}\n` +
          `freshness: ${types.describeStaleness(stale)}\n\n${doc.body}`
      );
    }
  );

  server.registerTool(
    'wiki_stats',
    {
      title: 'How the wiki is used',
      description:
        'Usage figures: how much is read by agents versus in a browser, which pages carry the traffic, which have never been opened, how much of the wiki has been verified lately, and the best and worst rated pages. Counts only — no addresses and no per-request log. Use it to find what is worth maintaining, and what was written and then read by nobody.',
      inputSchema: {
        days: z.number().optional().describe('Window for the trend, in days. Default 30.'),
      },
    },
    async ({ days }) => {
      const window = Math.min(120, Math.max(1, days || 30));
      const [snap, busiest, cold, best, worst, uniq] = await Promise.all([
        stats.snapshot(),
        stats.busiest({ by: 'read', limit: 10 }),
        stats.unread({ limit: 10 }),
        votes.top({ limit: 5, min: 1 }),
        votes.bottom({ limit: 5 }),
        stats.uniqueVisitors({ days: window }),
      ]);
      const t = snap.totals || {};
      const lines = [
        `pages: ${await wiki.countPages()}`,
        `agent reads: ${t.read || 0} · browser views: ${t.view || 0} · searches: ${t.search || 0}`,
        `edits: ${t.write || 0} · votes: ${t.vote || 0} · reports: ${t.report || 0}`,
        `distinct visitors: ~${uniq.window} in ${window}d, ~${uniq.allTime} all time (estimates)`,
        '',
        busiest.length ? `Most read:\n${busiest.map((r) => `  ${r.slug} — ${r.read}`).join('\n')}` : '',
        cold.length ? `\nNever opened:\n${cold.map((r) => `  ${r.slug}`).join('\n')}` : '',
        best.length ? `\nBest rated:\n${best.map((r) => `  ${r.slug} +${r.score}`).join('\n')}` : '',
        worst.length ? `\nWorst rated — likely needs rewriting:\n${worst.map((r) => `  ${r.slug} ${r.score}`).join('\n')}` : '',
      ].filter(Boolean);
      return text(lines.join('\n'));
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
    'wiki_coverage',
    {
      title: 'Check whether a topic is already covered',
      description:
        'Call this BEFORE writing a page. Describe what you are about to write and get back whether the wiki already covers it, which existing pages are nearest, and which namespace work like this lives in. wiki_search and wiki_find rank pages by relevance and leave you to interpret the score; this answers the writer\'s question instead — write a new page, edit an existing one, or drop it. It also names the words in your topic that appear nowhere in the wiki, which is the most reliable signal that a subject is genuinely new.',
      inputSchema: {
        topic: z
          .string()
          .describe('What you are thinking of writing, in a sentence or two. More detail is better.'),
        limit: z.number().int().min(1).max(20).optional().describe('How many neighbours (default 6)'),
        type: z.string().optional().describe('Only consider pages of this type'),
        tag: z.string().optional().describe('Only consider pages with this tag'),
      },
    },
    async ({ topic, limit, type, tag }) => {
      const c = await coverage(topic, { limit: limit ?? 6, type, tag });
      if (c.verdict === 'unknown') return text('Give me a topic to check.');

      const head =
        c.verdict === 'covered'
          ? 'COVERED — this looks like it already exists.'
          : c.verdict === 'adjacent'
            ? 'ADJACENT — related pages exist, but nothing on this exactly.'
            : 'OPEN — nothing here covers this.';

      const lines = [head, '', c.reason, ''];

      // The confidence is not decoration. Absence is measured reliably;
      // covered-versus-adjacent is a judgement call, and saying so is the
      // difference between a useful tool and a confident wrong answer.
      if (c.confidence !== 'high') {
        lines.push(
          'This call is approximate — read the neighbours below before trusting it.',
          ''
        );
      }

      if (c.nearest.length) {
        lines.push('Nearest pages:');
        for (const n of c.nearest) {
          lines.push(
            `  ${n.slug}${n.staleness === 'stale' ? '  [STALE]' : ''}  (relevance ${n.relevance})`,
            `    ${n.title}${n.summary ? ` — ${n.summary}` : ''}`
          );
        }
        lines.push('');
      }

      if (c.namespaces.length) {
        lines.push('Where work like this lives:');
        for (const ns of c.namespaces) {
          lines.push(`  ${ns.prefix}/  — ${ns.pages} page(s), e.g. ${ns.examples.join(', ')}`);
        }
        if (c.suggestedPrefix) {
          lines.push('', `If you write it, "${c.suggestedPrefix}/<name>" matches where the neighbours are.`);
        }
        lines.push('');
      }

      if (c.unknownTerms.length) {
        lines.push(`Words appearing nowhere in the wiki: ${c.unknownTerms.join(', ')}`);
      }

      lines.push(`${c.considered} page(s) considered.`);
      return text(lines.join('\n'));
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
          'Write a page (creates it if new, overwrites the body if it exists). Send markdown without frontmatter; title/tags are managed via the arguments. Read the page first if you mean to amend rather than replace it. If you are correcting the page because you just looked at the live system, send verified: true so the write counts as a confirmation and not only a change.',
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
          verified: z
            .boolean()
            .optional()
            .describe(
              'Set true ONLY if you checked this page against the live system as part of making this edit — you ran the command, queried the API, read the config, looked at the machine. That records the write as a confirmation as well as a change, which is the difference between "someone rewrote this" and "someone checked this". Leave it unset for edits made from memory, from another page, or from reasoning: a false verification is worse than none, because it resets the clock on a page nobody actually looked at.'
            ),
          verifiedNote: z
            .string()
            .optional()
            .describe('What you actually checked and how, e.g. "ssh\'d to pve-01, address and disk match". Only meaningful alongside verified: true.'),
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
      async ({ page, content, title, tags, type, fields, ttl, verified, verifiedNote, baseHash, model, context, host, session }) => {
        const client = server.server.getClientVersion();
        const who = client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : 'unknown';
        if (held) {
          const guarded = await guardWrite({
            slug: page, content, ip: clientIp, agent: who,
            session: session || getConnectionId(),
            writeRate,
            tokenId,
            publicMode,
          });
          if (guarded) return guarded;
        }
        let res;
        try {
          res = await wiki.writePage(page, content, {
          baseHash,
          title,
          tags,
          type,
          fields,
          ttl,
          // An edit made while looking at the live system is both a change and a
          // confirmation. Without this the two collapse into one, and a page that
          // was just corrected against reality still reports as overdue.
          verified: verified || undefined,
          verifiedBy: verified ? (model ? `${who} (${model})` : who) : undefined,
          verifiedNote: verified ? verifiedNote : undefined,
          provenance: {
            via,
            ip: clientIp,
            token: tokenId,
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
          if (err?.code === 'too_large') return fail(err.message);
          if (err?.code === 'conflict') {
            return fail(
              `${err.message}\n\n--- current content ---\n${err.current ?? '(page was deleted)'}`
            );
          }
          throw err;
        }
        stats.record('write', { slug: res.slug });
        const conf = types.checkPage(await wiki.readPage(res.slug), await types.loadTypes());
        const missing = [
          !model && 'model',
          !context && 'context',
          !serverHost && !host && 'host',
          !session && !getConnectionId() && 'session',
        ].filter(Boolean);
        return text(
          `${res.created ? 'Created' : 'Updated'} ${res.slug} (${res.bytes} bytes)` +
            (publicMode ? '' : ` at ${res.path}`) +
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
        // Deleting is the one thing that does not come back, so it stays with
        // the operator. Everyone else gets wiki_report, which pulls a page out
        // of view immediately and is reversible — the right shape for a takedown
        // anyone can trigger, because a mistaken pull costs a release and a
        // mistaken delete costs the page.
        if (held) {
          return fail(
            'Deleting is not open to visitor tokens: it cannot be undone. Use wiki_report ' +
              'to pull the page out of public view instead — that takes effect immediately ' +
              'and an operator can restore it if you were wrong.'
          );
        }
        const res = await wiki.deletePage(page);
        return res.deleted ? text(`Deleted ${res.slug}.`) : fail(`No page named "${page}".`);
      }
    );

    server.registerTool(
      'wiki_vote',
      {
        title: 'Vote a page up or down',
        description:
          'Rate how useful a page was. Up if it answered your question or saved you work; down if it was misleading, confusing, or wasted your time. One vote per caller per page — voting again changes it, and voting the same way twice clears it. This is a quality signal only: it does NOT verify a page (use wiki_verify for that, and only if you actually checked it against reality) and it does NOT hide a page (use wiki_report for content that must not be readable). Downvoting is the right response to a page that is merely bad; it never removes anything.',
        inputSchema: {
          page: z.string().describe('Page slug'),
          direction: z
            .enum(['up', 'down', 'clear'])
            .describe('up, down, or clear to withdraw your vote'),
          note: z
            .string()
            .optional()
            .describe(
              'Optional: why. A downvote with a reason is worth far more than one without, because the next agent can act on it — it is recorded as a page comment.'
            ),
        },
      },
      async ({ page, direction, note }) => {
        const doc = await wiki.readPage(page);
        if (!doc) return fail(`No page named "${page}".`);
        const client = server.server.getClientVersion();
        const who = client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : 'unknown';

        stats.record('vote', { slug: doc.slug });
        const res = await votes.voteWithNote(doc.slug, direction, {
          voter: voterId || clientIp || who,
          note,
          via: via === 'stdio' ? 'stdio' : 'mcp',
          author: who,
        });
        const standing =
          res.you === 0 ? 'Your vote is cleared.' : `You voted ${res.you > 0 ? 'up' : 'down'}.`;
        return text(
          `${standing} ${doc.slug} is now ${res.score > 0 ? '+' : ''}${res.score} ` +
            `(${res.up} up, ${res.down} down).` +
            (note ? ' Your note was added to the page discussion.' : '')
        );
      }
    );

    // Open moderation. Writing here needs no approval, so removal cannot need
    // one either: the two have to be equally fast or the wiki is only open in
    // the direction that adds. Any token can pull any page, immediately.
    //
    // A pull HIDES. Nothing is destroyed, the page keeps its history, and an
    // operator can put it back — which is what makes it safe to hand to
    // strangers. A wrong pull costs a release; a wrong delete costs the page.
    server.registerTool(
      'wiki_report',
      {
        title: 'Report a page and pull it from public view',
        description:
          'Report a page as a problem. This takes effect IMMEDIATELY: the page is hidden from the wiki for everyone until an operator reviews it. Nothing is deleted — the page and its history are preserved, and a page pulled by mistake can be restored. Use this for content that should not be readable while someone looks at it: illegal material, private personal information, leaked credentials, spam. Do NOT use it for a page that is merely wrong or out of date — that is a normal condition here, and the fix is to edit the page or leave a comment with wiki_comment.',
        inputSchema: {
          page: z.string().describe('Page slug to report'),
          reason: z
            .enum(['illegal', 'csam', 'privacy', 'security', 'spam', 'inaccurate', 'other'])
            .describe(
              'Why. "inaccurate" is recorded but does NOT pull the page: being wrong is not an abuse of the wiki, and hiding every disputed page would let a disagreement erase content.'
            ),
          detail: z.string().optional().describe('What is wrong, in a sentence. This is what the operator reads first.'),
          model: z.string().optional().describe('Your model identifier'),
          context: z.string().optional().describe('One line on how you came across it'),
        },
      },
      async ({ page, reason, detail, model, context }) => {
        const doc = await wiki.readPage(page);
        if (!doc) return fail(`No page named "${page}".`);
        const client = server.server.getClientVersion();
        const who = client ? `${client.name}${client.version ? ` ${client.version}` : ''}` : 'unknown';

        // Pulling is powerful and anonymous, which is exactly the combination
        // that invites someone to hide the whole wiki. Capped per caller.
        const limited = moderation.rateLimit(`report:${clientIp || 'anon'}`, {
          max: 10,
          windowMs: 60 * 60_000,
        });
        if (!limited.ok) {
          return fail(
            `Rate limited: too many reports from here. Try again in ${limited.retryAfter}s. ` +
              `If a large number of pages genuinely need pulling, say so on a page comment instead.`
          );
        }

        stats.record('report', { slug: doc.slug });
        const rec = await moderation.report({
          slug: doc.slug,
          reason,
          detail: [detail, context && `context: ${context}`].filter(Boolean).join(' — '),
          ip: clientIp,
          agent: model ? `${who} (${model})` : who,
        });

        // Being wrong is the wiki's normal state and has its own machinery —
        // staleness, comments, edits. Treating it as abuse would hand anyone who
        // disagrees with a page a button that hides it.
        if (reason === 'inaccurate') {
          return text(
            `Recorded a report on ${doc.slug} (${rec.id}). The page is still live: "inaccurate" ` +
              `does not pull a page. If you know what it should say, edit it with wiki_write; ` +
              `if you are unsure, wiki_comment leaves the question on the page.`
          );
        }

        await moderation.quarantine(doc.slug, {
          by: `report:${rec.id}`,
          note: `${reason}${detail ? ` — ${detail}` : ''} (reported by ${who})`,
        });
        return text(
          `Pulled ${doc.slug} from public view and recorded report ${rec.id}. ` +
            `It is hidden from readers now; nothing was deleted, and an operator will review it.`
        );
      }
    );
  }

  return server;
}
