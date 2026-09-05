// A derived index over the pages, so listing and querying stop walking the tree.
//
// The markdown files remain the only source of truth. Nothing here is ever the
// authority on a page's content — this table holds the handful of fields that
// listings, filters and reports need (title, type, tags, freshness), so those can
// be answered by a query instead of by opening every file. Delete the database and
// the wiki still works; it will rebuild it and be slower until it has.
//
// Why SQLite, and why now: Stage 1's parse cache made the second request fast, but
// the first one after a restart still read the whole corpus, and it held the whole
// corpus in memory to do it. An index on disk survives restarts, is shared between
// the web and MCP processes, and does not grow the heap.
//
// Why node:sqlite: it ships with Node 22+, so this adds no dependency. Both the
// workstation (v24) and the container (v22) have it.
//
// It lives in `.index/` beside `.talk/` and `.history/` for the same reason those
// do: the page walker skips dot-directories, so it never leaks into search, the
// graph, or a listing.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as wiki from './wiki.js';
import { terms as tokenise } from './vectors.js';

// Resolved lazily — wiki.js imports this module, so reading PAGES_DIR at load
// time would run before wiki.js has finished initialising it.
const dbDir = () => path.join(wiki.PAGES_DIR, '.index');
const dbFile = () => path.join(dbDir(), 'pages.db');

let db = null;
let state = 'cold'; // cold | ready | unavailable
let lastError = null;

// Bump when the shape below changes. There is no migration path and there does
// not need to be one: this table is derived from the markdown, so on a mismatch
// it is dropped and rebuilt from disk. That is strictly cheaper than getting
// migrations right for something disposable.
const SCHEMA_VERSION = 7;

// A safety cap on terms per page, not a selection strategy.
//
// The first attempt kept the top 40 by term frequency, which was exactly wrong:
// the highest-tf terms are the corpus-wide ones, so all 40 slots filled with
// words every page had, and query-time df pruning then discarded the lot. The
// result was an index that proposed no candidates at all.
//
// Distinctiveness is a property of the corpus, so it cannot be judged when a
// single page is written. Store the page's vocabulary and prune at query time,
// where df is known. Real pages hold a few hundred terms after stopwords, so
// this cap only ever bites on something pathological.
const TERMS_PER_PAGE = 400;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  type          TEXT,
  summary       TEXT,
  bytes         INTEGER NOT NULL,
  tokens        INTEGER NOT NULL DEFAULT 0,
  mtime_ms      REAL NOT NULL,
  updated       TEXT,
  verified_at   TEXT,
  verified_by   TEXT,
  verified_note TEXT,
  ttl           TEXT,
  norm          REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS page_tags (
  slug TEXT NOT NULL,
  tag  TEXT NOT NULL,
  PRIMARY KEY (slug, tag)
);
CREATE TABLE IF NOT EXISTS page_fields (
  slug  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (slug, key)
);
-- Who links to whom. The whole reason this table exists: backlinks() answered
-- "who links here" by opening every page in the wiki and parsing it, which is
-- O(n) work on every single page view. At 217 pages a page read took over two
-- seconds, and it got worse with every page anybody wrote.
CREATE TABLE IF NOT EXISTS page_links (
  slug   TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (slug, target)
);
CREATE INDEX IF NOT EXISTS page_links_target ON page_links(target);
CREATE TABLE IF NOT EXISTS page_terms (
  slug TEXT NOT NULL,
  term TEXT NOT NULL,
  tf   INTEGER NOT NULL,
  PRIMARY KEY (slug, term)
);
CREATE INDEX IF NOT EXISTS page_terms_term ON page_terms(term);
-- Full text, for narrowing a search to candidates instead of opening every file.
-- The trigram tokeniser is the reason this works: wiki search has always matched
-- substrings (\`body.includes(term)\`), and a word-level index cannot reproduce
-- that — under trigram, "oxmo" still finds "proxmox", so the candidate set stays
-- a true superset of what the existing scoring would have matched.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  slug UNINDEXED, title, tags, body, tokenize='trigram'
);
CREATE INDEX IF NOT EXISTS pages_type      ON pages(type);
CREATE INDEX IF NOT EXISTS pages_updated   ON pages(updated DESC);
CREATE INDEX IF NOT EXISTS page_tags_tag   ON page_tags(tag);
CREATE INDEX IF NOT EXISTS page_fields_kv  ON page_fields(key, value);
`;

/**
 * Open the index, creating it if needed. Failure is not an error the caller has
 * to handle — it returns null and every read falls back to the filesystem, which
 * is the behaviour the wiki had before this file existed.
 */
async function open() {
  if (state === 'ready') return db;
  if (state === 'unavailable') return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    await fs.mkdir(dbDir(), { recursive: true });
    db = new DatabaseSync(dbFile());
    // WAL so the web and MCP processes can read while the other writes.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');

    // A schema from an older build is thrown away rather than migrated.
    const found = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
    if (found !== SCHEMA_VERSION) {
      for (const t of ['pages', 'page_tags', 'page_fields', 'page_terms', 'page_links', 'pages_fts']) db.exec(`DROP TABLE IF EXISTS ${t};`);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec(SCHEMA);
    state = 'ready';
    return db;
  } catch (err) {
    lastError = err;
    state = 'unavailable';
    db = null;
    return null;
  }
}

export const available = () => state === 'ready';
export const status = () => ({ state, file: state === 'ready' ? dbFile() : null, error: lastError?.message || null });

export function close() {
  try { db?.close(); } catch { /* already gone */ }
  db = null;
  state = 'cold';
}

const rowFrom = (page) => ({
  slug: page.slug,
  title: page.title,
  type: page.type || null,
  summary: page.meta?.summary || null,
  bytes: page.bytes,
  // The body only — see estimateTokens. Indexed so a whole-wiki total costs
  // one SUM() rather than reading every page.
  tokens: wiki.estimateTokens(page.body),
  mtime_ms: page.mtimeMs ?? 0,
  updated: page.updated || null,
  verified_at: page.meta?.verified_at || null,
  verified_by: page.meta?.verified_by || null,
  verified_note: page.meta?.verified_note || null,
  ttl: page.meta?.ttl || null,
});

function writeRow(d, page) {
  invEpoch++;
  const r = rowFrom(page);
  d.prepare(
    `INSERT INTO pages (slug,title,type,summary,bytes,tokens,mtime_ms,updated,verified_at,verified_by,verified_note,ttl)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET
       title=excluded.title, type=excluded.type, summary=excluded.summary,
       bytes=excluded.bytes, tokens=excluded.tokens, mtime_ms=excluded.mtime_ms, updated=excluded.updated,
       verified_at=excluded.verified_at, verified_by=excluded.verified_by,
       verified_note=excluded.verified_note, ttl=excluded.ttl`
  ).run(
    r.slug, r.title, r.type, r.summary, r.bytes, r.tokens, r.mtime_ms,
    r.updated, r.verified_at, r.verified_by, r.verified_note, r.ttl
  );

  d.prepare('DELETE FROM page_tags WHERE slug = ?').run(page.slug);
  const tagIns = d.prepare('INSERT OR IGNORE INTO page_tags (slug, tag) VALUES (?, ?)');
  for (const t of page.tags || []) tagIns.run(page.slug, String(t).toLowerCase());

  // Wikilink targets, slugified the same way the store does so a link written
  // as [[Hosts/PVE-01]] matches the page it means. The label after a pipe is
  // display text and is not a target.
  d.prepare('DELETE FROM page_links WHERE slug = ?').run(page.slug);
  const linkIns = d.prepare('INSERT OR IGNORE INTO page_links (slug, target) VALUES (?, ?)');
  for (const m of String(page.body || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = wiki.slugify(m[1].trim());
    if (target && target !== page.slug) linkIns.run(page.slug, target);
  }

  d.prepare('DELETE FROM page_fields WHERE slug = ?').run(page.slug);
  const fieldIns = d.prepare('INSERT OR IGNORE INTO page_fields (slug, key, value) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(page.meta || {})) {
    if (v == null || typeof v === 'object') continue;
    fieldIns.run(page.slug, String(k).toLowerCase(), String(v));
  }

  // Title and tags weighted the way find and the graph already weight them, and
  // wikilinks stripped for the same reason the graph strips them: a link is
  // already counted as link evidence, so letting its text drive similarity too
  // counts one signal twice.
  d.prepare('DELETE FROM page_terms WHERE slug = ?').run(page.slug);
  const tf = new Map();
  const text =
    `${page.title} ${page.title} ${(page.tags || []).join(' ')} ${(page.tags || []).join(' ')} ` +
    String(page.body || '').replace(/\[\[[^\]]*\]\]/g, ' ');
  for (const t of tokenise(text)) tf.set(t, (tf.get(t) || 0) + 1);
  const top = [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, TERMS_PER_PAGE);
  const termIns = d.prepare('INSERT OR IGNORE INTO page_terms (slug, term, tf) VALUES (?, ?, ?)');
  for (const [term, n] of top) termIns.run(page.slug, term, n);

  // Raw text for the trigram index. Not tokenised and not truncated — search
  // matches substrings anywhere in the page, so anything dropped here would be a
  // result that silently stops being findable.
  d.prepare('DELETE FROM pages_fts WHERE slug = ?').run(page.slug);
  d.prepare('INSERT INTO pages_fts (slug, title, tags, body) VALUES (?, ?, ?, ?)').run(
    page.slug,
    `${page.title} ${page.slug}`,
    (page.tags || []).join(' '),
    String(page.body || '')
  );
}

/**
 * Store each page's tf-idf vector length.
 *
 * This is what lets scoring stop loading whole vectors: a cosine needs the terms
 * the query and the page share, plus the page's magnitude. Terms they don't share
 * contribute nothing to the dot product but everything to the magnitude — so with
 * the magnitude precomputed, find only ever has to fetch the shared terms.
 *
 * idf drifts as the corpus grows, so a stored norm is slightly stale between
 * reindexes. Adding one page to a corpus of thousands moves idf by a fraction of
 * a percent, which is far below the resolution anyone reads these scores at.
 */
function refreshNorms(d, slugs = null) {
  const n = d.prepare('SELECT COUNT(*) AS n FROM pages').get().n || 1;
  const termsOf = d.prepare('SELECT term, tf FROM page_terms WHERE slug = ?');
  const upd = d.prepare('UPDATE pages SET norm = ? WHERE slug = ?');

  // One GROUP BY for a whole rebuild; targeted lookups for a single page, where
  // scanning the entire postings table would dwarf the write itself.
  let dfOf;
  if (slugs) {
    const one = d.prepare('SELECT COUNT(*) AS df FROM page_terms WHERE term = ?');
    const memo = new Map();
    dfOf = (t) => {
      let v = memo.get(t);
      if (v === undefined) memo.set(t, (v = one.get(t).df));
      return v;
    };
  } else {
    const all = new Map();
    for (const r of d.prepare('SELECT term, COUNT(*) AS df FROM page_terms GROUP BY term').all()) {
      all.set(r.term, r.df);
    }
    dfOf = (t) => all.get(t) || 0;
  }

  const targets = slugs || d.prepare('SELECT slug FROM pages').all().map((r) => r.slug);
  for (const slug of targets) {
    let sum = 0;
    for (const { term, tf } of termsOf.all(slug)) {
      const w = (1 + Math.log(tf)) * Math.log(1 + n / (dfOf(term) + 1));
      sum += w * w;
    }
    upd.run(Math.sqrt(sum) || 1, slug);
  }
}

// FTS5 treats a bare string as a query language, so anything the user typed has
// to be quoted to be taken literally. Doubling the quote is the escape.
const ftsQuote = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Everything find needs, fetched by targeted query rather than by pulling the
 * whole postings table into memory.
 *
 * Returns the candidate pages that share at least one query term, each with the
 * shared terms' frequencies, its stored norm, and its listing metadata.
 */
export async function scoringRowsFor(queryTerms, { type = null, tag = null } = {}) {
  const d = await open();
  if (!d || !queryTerms.length) return null;
  const holes = queryTerms.map(() => '?').join(',');
  const n = d.prepare('SELECT COUNT(*) AS n FROM pages').get().n || 1;

  const df = new Map();
  for (const r of d
    .prepare(`SELECT term, COUNT(*) AS df FROM page_terms WHERE term IN (${holes}) GROUP BY term`)
    .all(...queryTerms)) {
    df.set(r.term, r.df);
  }

  // Postings joined to metadata in a single statement. Fetching each candidate's
  // row and tags individually meant two round trips per page, so a query matching
  // most of the corpus issued thousands of them and came out slower than reading
  // the files. Filters go into SQL for the same reason.
  const args = [...queryTerms];
  let filter = '';
  if (type) {
    filter += ' AND LOWER(COALESCE(p.type, \'\')) = ?';
    args.push(String(type).toLowerCase());
  }
  if (tag) {
    filter += ' AND EXISTS (SELECT 1 FROM page_tags gt WHERE gt.slug = p.slug AND gt.tag = ?)';
    args.push(String(tag).toLowerCase());
  }

  const byslug = new Map();
  for (const r of d
    .prepare(
      `SELECT pt.slug, pt.term, pt.tf,
              p.title, p.type, p.summary, p.updated,
              p.verified_at, p.verified_by, p.verified_note, p.ttl, p.norm
       FROM page_terms pt
       JOIN pages p ON p.slug = pt.slug
       WHERE pt.term IN (${holes})${filter}`
    )
    .all(...args)) {
    let row = byslug.get(r.slug);
    if (!row) {
      byslug.set(
        r.slug,
        (row = {
          slug: r.slug, title: r.title, type: r.type, summary: r.summary,
          updated: r.updated, verified_at: r.verified_at, verified_by: r.verified_by,
          verified_note: r.verified_note, ttl: r.ttl, norm: r.norm,
          tags: [], shared: new Map(),
        })
      );
    }
    row.shared.set(r.term, r.tf);
  }

  // Tags for exactly those pages, also in one statement.
  if (byslug.size) {
    for (const r of d
      .prepare(
        `SELECT t.slug, t.tag FROM page_tags t
         WHERE t.slug IN (SELECT DISTINCT slug FROM page_terms WHERE term IN (${holes}))
         ORDER BY t.tag`
      )
      .all(...queryTerms)) {
      byslug.get(r.slug)?.tags.push(r.tag);
    }
  }

  return { docs: n, df, rows: [...byslug.values()] };
}

/**
 * Slugs that could match any of these terms — a superset of what the caller's own
 * scoring will accept, so the caller keeps its exact behaviour and only stops
 * opening files that could never have matched.
 *
 * Returns null when the index cannot answer, which means "scan everything".
 */
export async function searchCandidates(terms, { tag = null } = {}) {
  const d = await open();
  if (!d) return null;
  // The trigram tokeniser cannot match anything shorter than three characters,
  // so a query made only of short terms has to fall back to the full scan.
  const usable = terms.filter((t) => String(t).length >= 3);
  if (!usable.length) return null;

  // Deliberately unlimited. Capping this was a real bug: for a term held by most
  // of the corpus the truncated set stopped being a superset, and pages that
  // would have scored in the top ten simply fell outside it — a search quietly
  // returning different results, which is worse than a slow one. A query that
  // genuinely matches everything must still look at everything; the win is on
  // selective queries, which is nearly all of them.
  const match = usable.map(ftsQuote).join(' OR ');
  const args = [match];
  let sql = 'SELECT f.slug FROM pages_fts f WHERE pages_fts MATCH ?';
  if (tag) {
    sql += ' AND EXISTS (SELECT 1 FROM page_tags t WHERE t.slug = f.slug AND t.tag = ?)';
    args.push(String(tag).toLowerCase());
  }
  try {
    return d.prepare(sql).all(...args).map((r) => r.slug);
  } catch (err) {
    // A query FTS5 will not parse is not worth failing a search over.
    lastError = err;
    return null;
  }
}

/** Record one page. Called on every write, so the index tracks the files. */
export async function upsert(page) {
  const d = await open();
  if (!d || !page) return false;
  try {
    writeRow(d, page);
    refreshNorms(d, [page.slug]);
    return true;
  } catch (err) {
    lastError = err;
    return false;
  }
}

export async function remove(slug) {
  const d = await open();
  if (!d) return false;
  try {
    for (const t of ['pages', 'page_tags', 'page_fields', 'page_terms', 'page_links', 'pages_fts']) {
      d.prepare(`DELETE FROM ${t} WHERE slug = ?`).run(slug);
    }
    invEpoch++;
    return true;
  } catch (err) {
    lastError = err;
    return false;
  }
}

/**
 * Bring the index in line with what is actually on disk.
 *
 * `diskRows` is the cheap part — a walk plus a stat, no file contents. Only pages
 * whose size or mtime disagrees with the index get opened, so a reconcile after a
 * restart costs one stat per page and reads nothing if nothing changed.
 */
export async function reconcile(diskRows, load) {
  const d = await open();
  if (!d) return { indexed: 0, updated: 0, removed: 0, skipped: true };

  const known = new Map();
  for (const r of d.prepare('SELECT slug, bytes, mtime_ms FROM pages').all()) {
    known.set(r.slug, r);
  }

  let updated = 0;
  const seen = new Set();
  d.exec('BEGIN');
  try {
    for (const disk of diskRows) {
      seen.add(disk.slug);
      const have = known.get(disk.slug);
      if (have && have.bytes === disk.size && have.mtime_ms === disk.mtimeMs) continue;
      const page = await load(disk.slug);
      if (!page) continue;
      writeRow(d, { ...page, mtimeMs: disk.mtimeMs });
      updated++;
    }
    let removed = 0;
    for (const slug of known.keys()) {
      if (seen.has(slug)) continue;
      for (const t of ['pages', 'page_tags', 'page_fields', 'page_terms', 'page_links', 'pages_fts']) {
        d.prepare(`DELETE FROM ${t} WHERE slug = ?`).run(slug);
      }
      removed++;
    }
    if (updated || removed) refreshNorms(d);
    d.exec('COMMIT');
    return { indexed: seen.size, updated, removed, skipped: false };
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    lastError = err;
    return { indexed: 0, updated: 0, removed: 0, skipped: true, error: err.message };
  }
}

// --- reads ------------------------------------------------------------------

const filterSql = ({ tag, type }) => {
  const where = [];
  const args = [];
  if (type) {
    where.push('LOWER(COALESCE(p.type, \'\')) = ?');
    args.push(String(type).toLowerCase());
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM page_tags t WHERE t.slug = p.slug AND t.tag = ?)');
    args.push(String(tag).toLowerCase());
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
};

export async function count({ tag, type } = {}) {
  const d = await open();
  if (!d) return null;
  const { clause, args } = filterSql({ tag, type });
  return d.prepare(`SELECT COUNT(*) AS n FROM pages p ${clause}`).get(...args).n;
}

/**
 * A page of listings, ordered by slug so it matches what the filesystem walk
 * produced. No file is opened: everything a listing shows lives in the row.
 */
export async function listSlice({ tag, type, offset = 0, limit = null } = {}) {
  const d = await open();
  if (!d) return null;
  const { clause, args } = filterSql({ tag, type });
  const lim = limit == null ? -1 : limit;
  const rows = d
    .prepare(
      `SELECT p.slug, p.title, p.type, p.summary, p.bytes, p.updated, p.ttl, p.verified_at
       FROM pages p ${clause}
       ORDER BY p.slug
       LIMIT ? OFFSET ?`
    )
    .all(...args, lim, offset);

  const tagsFor = d.prepare('SELECT tag FROM page_tags WHERE slug = ? ORDER BY tag');
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    type: r.type,
    tags: tagsFor.all(r.slug).map((t) => t.tag),
    updated: r.updated,
    bytes: r.bytes,
    summary: r.summary || '',
    // Carried so a listing can show freshness without reopening each page.
    ttl: r.ttl,
    verified_at: r.verified_at,
  }));
}

export async function tagCounts() {
  const d = await open();
  if (!d) return null;
  return d
    .prepare('SELECT tag, COUNT(*) AS count FROM page_tags GROUP BY tag ORDER BY count DESC, tag ASC')
    .all()
    .map((r) => ({ tag: r.tag, count: r.count }));
}

/** Slugs of a type, optionally matching frontmatter fields. Backs wiki_query. */
export async function queryByFields({ type, where = {} } = {}) {
  const d = await open();
  if (!d) return null;
  const args = [];
  const clauses = [];
  if (type) {
    clauses.push('LOWER(COALESCE(p.type, \'\')) = ?');
    args.push(String(type).toLowerCase());
  }
  for (const [k, v] of Object.entries(where)) {
    clauses.push(
      'EXISTS (SELECT 1 FROM page_fields f WHERE f.slug = p.slug AND f.key = ? AND LOWER(f.value) = ?)'
    );
    args.push(String(k).toLowerCase(), String(v).toLowerCase());
  }
  const clause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return d.prepare(`SELECT p.slug FROM pages p ${clause} ORDER BY p.slug`).all(...args).map((r) => r.slug);
}

/**
 * Everything the staleness calculation needs, without opening a file. Pages with
 * neither a ttl of their own nor a type cannot be stale, so they are excluded
 * here rather than read and discarded.
 */
export async function freshnessRows() {
  const d = await open();
  if (!d) return null;
  return d
    .prepare(
      `SELECT slug, title, type, ttl, verified_at, verified_by, verified_note, updated, tokens
       FROM pages
       WHERE ttl IS NOT NULL OR type IS NOT NULL
       ORDER BY slug`
    )
    .all();
}

// --- inverted index -------------------------------------------------------
//
// All-pairs cosine is O(n²) and was the wall: 72 seconds to build the graph over
// 4,000 pages, and it is the one thing neither the parse cache nor the metadata
// index touched, because it is arithmetic rather than I/O.
//
// The way out is not a faster loop, it is comparing fewer pairs. Two pages with
// no vocabulary in common score zero, and almost every pair is such a pair — so
// look up the pages that share a distinctive term and score only those.

export async function docCount() {
  const d = await open();
  if (!d) return null;
  return d.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
}

/** How many indexed pages use each of these terms. Drives both idf and pruning. */
export async function dfFor(termList) {
  const d = await open();
  if (!d || !termList.length) return null;
  const holes = termList.map(() => '?').join(',');
  const out = new Map();
  for (const r of d
    .prepare(`SELECT term, COUNT(*) AS df FROM page_terms WHERE term IN (${holes}) GROUP BY term`)
    .all(...termList)) {
    out.set(r.term, r.df);
  }
  return out;
}

/**
 * Pages sharing any of these terms, most overlap first.
 *
 * Terms held by a large fraction of the corpus are dropped before the lookup —
 * they match nearly everything, so their postings cost a lot and separate
 * nothing. That pruning is what bounds the work.
 */
export async function postings(termList, { exclude = null, limit = 200, maxDfRatio = 0.15 } = {}) {
  const d = await open();
  if (!d || !termList.length) return null;
  const n = d.prepare('SELECT COUNT(*) AS n FROM pages').get().n || 1;
  const df = await dfFor(termList);
  const useful = termList.filter((t) => {
    const seen = df.get(t) || 0;
    return seen > 0 && seen <= Math.max(2, Math.floor(n * maxDfRatio));
  });
  if (!useful.length) return [];

  const holes = useful.map(() => '?').join(',');
  const args = [...useful];
  let clause = `WHERE term IN (${holes})`;
  if (exclude) {
    clause += ' AND slug != ?';
    args.push(exclude);
  }
  return d
    .prepare(
      `SELECT slug, COUNT(*) AS shared FROM page_terms ${clause}
       GROUP BY slug ORDER BY shared DESC, slug LIMIT ?`
    )
    .all(...args, limit)
    .map((r) => r.slug);
}

/** The stored term frequencies for these pages, as slug → Map(term → tf). */
export async function vectorsFor(slugs) {
  const d = await open();
  if (!d || !slugs.length) return null;
  const out = new Map();
  const stmt = d.prepare('SELECT term, tf FROM page_terms WHERE slug = ?');
  for (const slug of slugs) {
    const m = new Map();
    for (const r of stmt.all(slug)) m.set(r.term, r.tf);
    out.set(slug, m);
  }
  return out;
}

/**
 * The whole inverted index in one query.
 *
 * The first attempt at candidate generation ran two statements per page — a df
 * lookup and a postings lookup — and at 4,000 pages that was 8,000 round trips
 * for 41 seconds of work, barely better than the n² it replaced. The postings
 * table is small (terms-per-page × pages), so pulling it once and pivoting in
 * memory is both simpler and roughly two orders of magnitude quicker.
 *
 * The trade is memory: this holds the whole postings list. At a corpus large
 * enough for that to hurt, candidate generation has to move into SQL as a
 * self-join and be paged — but that is a different problem from this one.
 */
// Pulling the whole postings table is cheap once and ruinous per request: find()
// called it on every query and came out slower than the full scan it replaced.
//
// Keying the cache on a module-level counter alone was wrong, and provably so:
// the web and MCP servers are separate processes sharing one database, so a page
// written over MCP stayed invisible to the web process's find() until it was
// restarted. `PRAGMA data_version` is the missing half — SQLite bumps it when
// ANOTHER connection commits, and deliberately does not for your own writes, so
// the two together cover both cases.
let invEpoch = 0;
let invMemo = { key: null, value: null };
export const bumpIndexEpoch = () => { invEpoch++; };

const cacheKey = (d) => `${invEpoch}:${d.prepare('PRAGMA data_version').get().data_version}`;

export async function invertedIndex() {
  const d = await open();
  if (!d) return null;
  const key = cacheKey(d);
  if (invMemo.key === key && invMemo.value) return invMemo.value;
  const vectors = new Map(); // slug -> Map(term -> tf)
  const byTerm = new Map(); // term -> slug[]
  for (const r of d.prepare('SELECT slug, term, tf FROM page_terms').all()) {
    let v = vectors.get(r.slug);
    if (!v) vectors.set(r.slug, (v = new Map()));
    v.set(r.term, r.tf);
    let list = byTerm.get(r.term);
    if (!list) byTerm.set(r.term, (list = []));
    list.push(r.slug);
  }
  const value = { vectors, byTerm, docs: d.prepare('SELECT COUNT(*) AS n FROM pages').get().n };
  invMemo = { key: cacheKey(d), value };
  return value;
}

/**
 * Everything a result listing needs about specific pages — metadata and
 * freshness together — so a caller that already knows which slugs it wants never
 * has to open one.
 */
/**
 * Wiki-wide size, from the index. One SUM rather than reading every page — the
 * reason the column exists at all.
 */
export async function totals() {
  const db = await open();
  if (!db) return null;
  const r = db.prepare('SELECT COUNT(*) AS pages, SUM(tokens) AS tokens, SUM(bytes) AS bytes FROM pages').get();
  return { pages: r?.pages || 0, tokens: r?.tokens || 0, bytes: r?.bytes || 0 };
}

/**
 * Pages linking to `target`. One indexed query instead of reading the corpus.
 *
 * Returns null — not an empty array — when the index is unavailable, so the
 * caller can tell "nothing links here" from "I could not look". Collapsing
 * those two is how a degraded cache starts confidently reporting absence.
 */
export async function backlinksTo(target) {
  const d = await open();
  if (!d) return null;
  return d
    .prepare(
      `SELECT p.slug, p.title FROM page_links l
       JOIN pages p ON p.slug = l.slug
       WHERE l.target = ? ORDER BY p.slug`
    )
    .all(String(target));
}

export async function rowsFor(slugs, { type = null, tag = null } = {}) {
  const d = await open();
  if (!d || !slugs.length) return null;
  const meta = d.prepare(
    `SELECT slug, title, type, summary, updated, verified_at, verified_by, verified_note, ttl
     FROM pages WHERE slug = ?`
  );
  const tagsFor = d.prepare('SELECT tag FROM page_tags WHERE slug = ? ORDER BY tag');
  const wantType = type ? String(type).toLowerCase() : null;
  const wantTag = tag ? String(tag).toLowerCase() : null;

  const out = [];
  for (const slug of slugs) {
    const r = meta.get(slug);
    if (!r) continue;
    if (wantType && String(r.type || '').toLowerCase() !== wantType) continue;
    const tags = tagsFor.all(slug).map((t) => t.tag);
    if (wantTag && !tags.includes(wantTag)) continue;
    out.push({ ...r, tags });
  }
  return out;
}

export async function allIndexedSlugs() {
  const d = await open();
  if (!d) return null;
  return d.prepare('SELECT slug FROM pages ORDER BY slug').all().map((r) => r.slug);
}

export async function stats() {
  const d = await open();
  if (!d) return { available: false, ...status() };
  return {
    available: true,
    ...status(),
    pages: d.prepare('SELECT COUNT(*) AS n FROM pages').get().n,
    tags: d.prepare('SELECT COUNT(DISTINCT tag) AS n FROM page_tags').get().n,
    fields: d.prepare('SELECT COUNT(*) AS n FROM page_fields').get().n,
    terms: d.prepare('SELECT COUNT(DISTINCT term) AS n FROM page_terms').get().n,
    postings: d.prepare('SELECT COUNT(*) AS n FROM page_terms').get().n,
  };
}
