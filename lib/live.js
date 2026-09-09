// A live activity feed: what is happening to the wiki, as it happens.
//
// The hard part is not the feed, it is that the wiki is two processes. The web
// server and the MCP server run separately, and most writing arrives over MCP
// while nearly all watching happens in a browser — so an in-memory emitter
// would show a viewer only the half of the traffic that came through the
// process they happen to be connected to, and would look like a working feed
// while doing it. That is the failure this file exists to avoid.
//
// So events go to a small SQLite file both processes open, and readers poll it.
// A separate file from the page index on purpose: that one is derived from the
// markdown and gets dropped and rebuilt whenever its schema changes or someone
// reindexes, and an activity log that vanishes on reindex is worse than none.
//
// It lives in `.stats/` beside stats.json, which the page walker skips, so it
// never leaks into search, the graph or a listing.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as wiki from './wiki.js';

// node:sqlite is loaded synchronously, unlike lib/index-db.js which awaits it.
// emit() is called from inside request handling and must not introduce an await
// there: an activity feed that reorders the events it is describing, or that
// leaves a floating promise in a request that has already returned, is worse
// than one that costs a synchronous require once per process.
const require = createRequire(import.meta.url);

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const PUBLIC = truthy(process.env.WIKI_PUBLIC);

// Resolved lazily: wiki.js is mid-initialisation when this module is imported.
const dbDir = () => path.join(wiki.PAGES_DIR, '.stats');
const dbFile = () => path.join(dbDir(), 'events.db');

// Enough to fill a screen and scroll back a little, not an audit log. Anything
// that matters for the record is already in stats.json, the git history, or the
// page itself; this is a window, and a window does not need to remember.
const KEEP_EVENTS = Number(process.env.WIKI_LIVE_KEEP) || 2000;
const PRUNE_EVERY = 200;

let db = null;
let state = 'cold'; // cold | ready | unavailable
let sinceLastPrune = 0;

function open() {
  if (state !== 'cold') return db;
  state = 'unavailable';
  try {
    // Required here rather than at module load so a Node without node:sqlite
    // degrades to "no live feed" instead of failing to start the wiki.
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dbDir(), { recursive: true });
    const d = new DatabaseSync(dbFile());
    // WAL so a reader polling once a second never blocks a writer mid-request,
    // which is the whole shape of this workload.
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA synchronous = NORMAL;');
    d.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      slug TEXT,
      detail TEXT,
      via TEXT
    );`);
    db = d;
    state = 'ready';
  } catch {
    db = null;
  }
  return db;
}

/**
 * Record something that happened.
 *
 * Never throws and never blocks the thing it is describing. A wiki that fails a
 * write because it could not log the write is a worse wiki than one with a gap
 * in its activity feed, and this is the only place that trade needs deciding.
 */
export function emit(kind, { slug = null, detail = null, via = null } = {}) {
  const d = open();
  if (!d) return;
  try {
    d.prepare('INSERT INTO events (ts, kind, slug, detail, via) VALUES (?, ?, ?, ?, ?)').run(
      Date.now(),
      String(kind),
      slug ? String(slug) : null,
      detail == null ? null : JSON.stringify(detail),
      via ? String(via) : null
    );
    if (++sinceLastPrune >= PRUNE_EVERY) {
      sinceLastPrune = 0;
      // Keep the newest KEEP_EVENTS by id. Cheaper than a time window and it
      // bounds the file rather than the age, which is what the disk cares about.
      d.prepare(
        'DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?'
      ).run(KEEP_EVENTS);
    }
  } catch {
    // A full disk, a locked database, a schema someone changed by hand. None of
    // those are reasons to break the request that triggered this.
  }
}

/** Events after a cursor, oldest first. `after` of 0 means "the recent past". */
export function since(after = 0, limit = 100, { raw = false } = {}) {
  const d = open();
  if (!d) return [];
  try {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = after
      ? d.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(Number(after), n)
      : // A viewer arriving at an empty page should see the wiki is alive, so
        // opening the feed replays the tail. Selected newest-first to get the
        // LAST n rather than the first, then flipped back into order.
        d.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n).reverse();
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      slug: r.slug || null,
      via: r.via || null,
      detail: raw ? (r.detail ? safeParse(r.detail) : null) : redact(r.kind, r.detail ? safeParse(r.detail) : null),
    }));
  } catch {
    return [];
  }
}

/**
 * Strip what a public instance must not publish, on the way out.
 *
 * The emitter already declines to store a search term on a public instance, and
 * that is not sufficient. Redaction at write time is a property of whoever
 * wrote the row; this log is a file, and any process pointed at the same pages
 * directory reads it — so a public instance sharing a directory with a private
 * one would faithfully republish the private one's queries. Deciding on the way
 * out makes it a property of who is *reading*, which is the one that matters.
 *
 * This is the conservative form, used by since(). feed() replaces it with the
 * corpus-vocabulary form, which shows more and is still safe — see anonymise().
 */
function redact(kind, detail) {
  if (!PUBLIC || kind !== 'search' || !detail) return detail;
  const { client } = detail;
  return client ? { redacted: true, client } : { redacted: true };
}

/**
 * Anonymise a search query by publishing only words the wiki already published.
 *
 * Withholding the query entirely is safe and nearly useless: a feed of
 * "somebody searched for something" tells a reader nothing about what this
 * wiki is being asked for, which is the most interesting thing it knows.
 *
 * The line drawn here is corpus vocabulary. A term that appears in the pages
 * this wiki already serves to anyone is not a secret — publishing it back
 * reveals nothing that /w/ does not. A term that appears nowhere in the corpus
 * is, by construction, something the searcher brought with them: a name, an
 * address, a credential pasted into the wrong box, the thing they were actually
 * looking for and did not find. Those are dropped.
 *
 * It fails safe in the direction that matters. A brand-new page's vocabulary is
 * unknown until it is indexed, so a term can only ever be withheld when it
 * should have been shown — never shown when it should have been withheld.
 *
 * The count of dropped terms is published, because "3 words, 2 withheld" is
 * honest about what is missing where a silent trim would not be.
 */
/**
 * Shapes that suppress a whole query regardless of vocabulary.
 *
 * Corpus membership is judged per token, and tokenising splits things that only
 * mean something whole. An email typed into the search box becomes a local part
 * and a domain, and the domain is very often in the corpus — so
 * "me@example.com" published back as "example.com" is a fragment of somebody's
 * address, cleared by a rule that was reasoning about a word.
 *
 * These patterns look at the raw string before it is broken up. They can only
 * ever withhold more than the vocabulary rule would, never less, so a false
 * positive costs a line in the feed and nothing else.
 */
const SENSITIVE_SHAPES = [
  /@/, //                           an address, or a handle
  /:\/\//, //                       a URL, which may carry a path or credentials
  /\d[\d\s().-]{6,}/, //            a phone number, card, or account
  /\b[A-Za-z0-9+/]{20,}={0,2}\b/, // a key, token or hash pasted in
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // an IP address
];

async function anonymise(detail) {
  const raw = String(detail?.query || '').trim();
  const base = detail?.client ? { client: detail.client } : {};
  if (!raw) return { ...base, redacted: true };
  if (SENSITIVE_SHAPES.some((re) => re.test(raw))) return { ...base, redacted: true };
  try {
    const { terms } = await import('./vectors.js');
    const index = await import('./index-db.js');
    const tokens = terms(raw);
    if (!tokens.length) return { ...base, redacted: true };
    const df = await index.dfFor([...new Set(tokens)]);
    const kept = tokens.filter((t) => (df?.get?.(t) || 0) > 0);
    return {
      ...base,
      terms: kept,
      withheld: tokens.length - kept.length,
      tag: detail?.tag || null,
    };
  } catch {
    // The index is the thing that decides what is safe to show. If it cannot
    // be consulted, show nothing rather than guess.
    return { ...base, redacted: true };
  }
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * The feed as a public-facing surface should see it.
 *
 * `since` is the raw log. This is the only thing a reader should call, because
 * it applies what a public instance owes its readers on top: search terms
 * withheld, and nothing naming a page moderation has pulled.
 *
 * That second one is why this exists at all. A page can be written, appear in
 * the feed, and be quarantined a minute later — and the row naming it stays in
 * the log. Filtering at the surface would put the check in whichever surface
 * remembered to do it; here, a reader added later inherits it.
 *
 * moderation is imported lazily because it counts reports through stats, which
 * emits here — importing it at load time would close a cycle. By the time this
 * is called, at request time, everything is initialised.
 */
export async function feed(after = 0, limit = 100) {
  const rows = since(after, limit, { raw: true });
  // A row carrying a raw query on a public instance was written by something
  // else pointed at this pages directory — a private instance, or this one
  // before WIKI_PUBLIC was set. Anonymise it here rather than trust that every
  // writer applied the policy this reader is bound by.
  if (PUBLIC) {
    for (const r of rows) {
      if (r.kind === 'search' && r.detail?.query) r.detail = await anonymise(r.detail);
    }
  }
  // The cursor is the highest id READ, not the highest id returned. Advancing
  // it by the filtered rows would stall the moment the newest event happened to
  // be a hidden one — and stall permanently if every event in the window was.
  const cursor = rows.length ? rows[rows.length - 1].id : after;
  if (!PUBLIC || !rows.length) return { rows, cursor };
  try {
    const moderation = await import('./moderation.js');
    const hidden = await moderation.quarantinedSlugs();
    if (!hidden.size) return { rows, cursor };
    return { rows: rows.filter((r) => !r.slug || !hidden.has(r.slug)), cursor };
  } catch {
    // If the quarantine list cannot be read, publish nothing that names a page
    // rather than publish something that might name a pulled one.
    return { rows: rows.filter((r) => !r.slug), cursor };
  }
}

/** The newest id, so a caller can subscribe without replaying anything. */
export function head() {
  const d = open();
  if (!d) return 0;
  try {
    return d.prepare('SELECT MAX(id) AS m FROM events').get()?.m || 0;
  } catch {
    return 0;
  }
}

export const available = () => Boolean(open());

/**
 * Release the database handle.
 *
 * Needed because Windows will not unlink an open file, so a test that opened
 * this cannot clean up its own temp directory — the same reason wiki.closeIndex
 * exists. Reopening on the next emit is free, so calling this is never wrong.
 */
export function close() {
  try {
    db?.close();
  } catch {
    // Already closed, or never opened. Either way there is nothing to release.
  }
  db = null;
  state = 'cold';
}

// --- what gets recorded -----------------------------------------------------
//
// Subscribed here rather than emitted from each surface, for the reason this
// codebase has now learned four times: an event emitted at call sites is an
// event emitted at *some* call sites. A surface added next year is covered
// without knowing this file exists.
//
// Reads, views, votes and reports are emitted from stats.record(), which is
// their single funnel. Writes, searches and deletes are emitted here instead,
// because the store hooks carry more than a counter does — whether a page was
// created or updated, what was searched for.

wiki.onPageWritten(({ slug, created, verified }) =>
  emit('write', { slug, detail: { created: !!created, verified: !!verified } })
);

wiki.onPageDeleted((slug) => emit('delete', { slug: typeof slug === 'string' ? slug : slug?.slug }));

wiki.onSearch((info = {}) => {
  // A public instance anonymises before the row is written, not after, so a raw
  // query is never on its disk at all. Read-time filtering alone would leave
  // the last few thousand queries sitting in a file on an internet-facing box,
  // which is a worse thing to hold than the feed is a good thing to show.
  //
  // Deliberately not awaited: a search must not wait on the activity log, and
  // the hook contract is fire-and-forget. Ordering still holds because ids are
  // assigned at insert.
  if (!PUBLIC) {
    emit('search', { detail: { query: info.query || '', tag: info.tag || null, client: info.client || null } });
    return;
  }
  anonymise({ query: info.query, tag: info.tag, client: info.client })
    .then((detail) => emit('search', { detail }))
    .catch(() => emit('search', { detail: { redacted: true } }));
});
