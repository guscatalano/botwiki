// Core wiki store: markdown files on disk are the single source of truth.
// Shared by the MCP server (agents) and the web server (humans).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STOP } from './vectors.js';
import * as revisions from './revisions.js';
import * as indexdb from './index-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PAGES_DIR = path.resolve(
  process.env.WIKI_DIR || path.join(HERE, '..', 'pages')
);

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * The largest a page may be, enforced in the store.
 *
 * There was already a 256 KB cap, but it lived in the moderation screen, which
 * only runs on a public instance — so a private wiki, the librarian, or any
 * future surface calling writePage() directly had no ceiling at all beyond the
 * transport's body limit. A limit that one code path enforces is not a limit.
 *
 * One mebibyte is deliberately far above anything real: a page of dense prose is
 * a few kilobytes, and the longest thing here is under thirty. What this stops
 * is the pathological case — a runaway generator, a pasted binary, a loop that
 * appends — where the failure is silent until a listing has to read it back.
 * Public instances stay much stricter at 256 KB; this is the backstop.
 */
export const MAX_PAGE_BYTES = Math.max(
  4096,
  Number(process.env.WIKI_MAX_PAGE_BYTES) || 1024 * 1024
);

export class WikiError extends Error {
  constructor(message, code = 'wiki_error') {
    super(message);
    this.code = code;
  }
}

/**
 * A write whose base is no longer current. Carries the live content so the
 * caller can merge rather than guess — losing an edit silently is the failure
 * mode this whole mechanism exists to prevent.
 */
export class ConflictError extends WikiError {
  constructor(slug, expected, actual, current) {
    super(
      `Conflict on "${slug}": the page changed since you read it ` +
        `(you based this on ${expected}, current is ${actual}). ` +
        `Re-read it, merge your change into the current content, and write again.`,
      'conflict'
    );
    this.slug = slug;
    this.expected = expected;
    this.actual = actual;
    this.current = current;
  }
}

let maskSalt = null;
function pseudonym(kind, value) {
  if (!maskSalt) {
    maskSalt = process.env.WIKI_TOKEN_SECRET || process.env.WIKI_TOKEN || PAGES_DIR;
  }
  return createHash('sha256').update(`${kind}:${maskSalt}:${value}`).digest('hex').slice(0, 4);
}


/**
 * An address, replaced by a stable pseudonym.
 *
 *   192.168.4.27      ->  visitor-3c9f
 *   2001:db8:1:2::7   ->  visitor-a17b
 *
 * Masking octets was the first attempt and it gave away more than it looked
 * like: keeping any part of an address still names a network, and a network is
 * often an organisation or a town. Since the only thing worth showing is that
 * two edits came from the *same* writer, the address can be discarded entirely
 * and replaced with something that says exactly that and nothing else.
 *
 * Same scheme as maskHost, and the same reasoning behind the salt: without one,
 * pseudonyms could be precomputed for every address in IPv4 and matched back.
 *
 * The operator's moderation view deliberately does NOT use this — blocking works
 * on an exact address, so the one screen that acts on addresses has to see them.
 */
export function maskIp(ip) {
  const raw = String(ip ?? '').trim().replace(/^::ffff:/i, '');
  if (!raw) return '';
  // Already a pseudonym — from a scrubbed record. Masking it again would give a
  // different answer for the same writer, which is the one thing the pseudonym
  // is for.
  if (/^visitor-[0-9a-f]{4}$/.test(raw) || raw === 'localhost') return raw;
  // Worth naming rather than hiding: it means the wiki wrote its own page.
  if (raw === '127.0.0.1' || raw === '::1') return 'localhost';
  return `visitor-${pseudonym('ip', raw.split('%')[0].toLowerCase())}`;
}

/**
 * A machine name, replaced by a stable pseudonym.
 *
 *   pve-01        ->  machine-4f1a
 *   gus-desktop   ->  machine-b207
 *
 * Not truncated the way an address is, because hostnames are short, meaningful
 * and guessable — half of `gus-desktop` still says whose desktop it is. What is
 * worth keeping is only that two edits came from the *same* machine, so the
 * pseudonym is derived from the name and stays put: the same host reads the same
 * everywhere, and nothing about it reads back.
 *
 * Salted with a per-installation value so pseudonyms cannot be precomputed
 * against a list of likely hostnames and matched up.
 */
export function maskHost(host) {
  const raw = String(host ?? '').trim();
  if (!raw) return '';
  if (/^machine-[0-9a-f]{4}$/.test(raw)) return raw;
  return `machine-${pseudonym('host', raw.toLowerCase())}`;
}

// The coarse family a client belongs to. Deliberately a fixed list: an
// unrecognised string becomes "Other" rather than becoming its own label, so a
// hand-crafted User-Agent cannot smuggle itself through as a category.
const CLIENT_PATTERNS = [
  [/\bEdg\//i, 'Edge'],
  [/\bOPR\/|\bOpera\b/i, 'Opera'],
  [/\bFirefox\//i, 'Firefox'],
  [/\bChrome\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
  [/\bcurl\//i, 'curl'],
  [/\bwget\b/i, 'wget'],
  [/\bpython-requests|httpx|aiohttp\b/i, 'Python'],
  [/\bnode-fetch|undici|axios\b/i, 'Node'],
  [/\bgo-http-client\b/i, 'Go'],
  [/\bbot\b|\bcrawler\b|\bspider\b|\bbingbot|googlebot\b/i, 'Crawler'],
];

export function clientFamily(ua) {
  const s = String(ua || '').trim();
  if (!s) return null;
  for (const [re, label] of CLIENT_PATTERNS) if (re.test(s)) return label;
  return 'Other';
}

// A User-Agent is a browser announcing itself, not a writer describing itself:
// version, engine, platform and build, which together are close enough to a
// fingerprint that ad networks are built on them. `Mozilla/5.0 (Macintosh;
// Intel Mac OS X 10_15_7) AppleWebKit/537.36 …` says a great deal about one
// machine and nothing useful about the edit.
const LOOKS_LIKE_UA = /Mozilla\/|AppleWebKit|Gecko\/|\bcurl\/|\bwget\b|python-requests|node-fetch|undici|go-http-client/i;

/**
 * A client string, reduced to its family plus a stable pseudonym.
 *
 *   Mozilla/5.0 (Macintosh; …) Chrome/141 …  ->  Chrome (client-4b71)
 *   curl/8.11.0                              ->  curl (client-2f0e)
 *   claude-code 1.2.3                        ->  claude-code 1.2.3
 *
 * A self-reported agent name is left alone. That is the writer telling you what
 * it is, which is the useful half of this record and carries no fingerprint —
 * only strings that look like a browser or tool announcing itself get reduced.
 */
export function maskAgent(agent) {
  const raw = String(agent ?? '').trim();
  if (!raw) return '';
  if (/\(client-[0-9a-f]{4}\)$/.test(raw)) return raw;
  if (!LOOKS_LIKE_UA.test(raw)) return raw;
  return `${clientFamily(raw)} (client-${pseudonym('agent', raw)})`;
}

/**
 * Roughly how many tokens a page's text costs to read.
 *
 * One character in four. That is the canonical rule of thumb for English, and
 * when measured against hand-counted prose, markdown, code and table samples it
 * beat both a word-count model and a subword-chunk model — 11% mean error
 * against 21% and 17%. No tokenizer dependency is going into this repo for a
 * footer number, and a real one would be wrong anyway: every model tokenises
 * differently, so the honest answer is an estimate clearly labelled as one.
 *
 * Measured on the BODY, never the stored file. Frontmatter is roughly a hundred
 * tokens of server bookkeeping per page that no reader ever receives; counting
 * it would overstate every page on the wiki.
 */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

/** Content hash a caller passes back as `baseHash` to prove what it edited. */
export const contentHash = (s) =>
  createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);

// --- write locking ----------------------------------------------------------
//
// The web server and the MCP server are separate processes writing the same
// directory, and agents write concurrently, so serialising within one process
// is not enough. An exclusive-create lockfile is the simplest thing that is
// actually correct across processes on one filesystem.

const LOCK_DIR = path.join(PAGES_DIR, '.locks');
const LOCK_STALE_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- visibility -------------------------------------------------------------
// A public instance can pull a page out of view (see lib/moderation.js). That
// has to be enforced in the store rather than in each caller: there are twenty
// MCP tools, a JSON API and a web UI reading through here, and a hide that any
// one of them can forget is not a hide. Every listing path in the wiki is
// listSlugs() then readPage(), so filtering readPage covers all of them at once.
//
// The store must not import the moderation module — moderation imports this one
// — so the server injects the lookup instead.
let hiddenLoader = null;

/** Install the visibility source. Called by the server when WIKI_PUBLIC is set. */
export function setHiddenLoader(fn) {
  hiddenLoader = fn;
}

/** Kept for callers that used to need it; the set is no longer cached here. */
export function invalidateHidden() {}

// Things that hang off a page and live outside it — votes, for one — have to be
// told when the page goes, or a new page written at the same slug would inherit
// a stranger's opinion of a page that no longer exists. Those modules import
// this one, so they register themselves rather than being imported back.
const deleteHooks = [];
export function onPageDeleted(fn) {
  if (typeof fn === 'function') deleteHooks.push(fn);
}

// Same reasoning as the delete hook, for counting rather than cleanup.
//
// Statistics used to be recorded at the call sites, and the call sites were
// whichever surface the feature was built on: `search`, `write`, `vote` and
// `report` were counted in the MCP server and nowhere else, so the browser and
// the JSON API — which is where nearly all the traffic is — contributed nothing
// and four tiles read 0 forever. An event counted by its callers is only as
// good as your enumeration of callers, and mine was wrong every single time.
//
// So the store announces what happened and whoever cares subscribes. A surface
// added tomorrow is counted without knowing statistics exist.
const writeHooks = [];
export function onPageWritten(fn) {
  if (typeof fn === 'function') writeHooks.push(fn);
}
const searchHooks = [];
export function onSearch(fn) {
  if (typeof fn === 'function') searchHooks.push(fn);
}
/** For searches that do not go through search() — find() runs its own scoring. */
export function noteSearch(info = {}) {
  announce(searchHooks, info);
}
// Never let a counter break the thing it is counting.
function announce(hooks, arg) {
  for (const hook of hooks) {
    try {
      hook(arg);
    } catch {
      /* a statistic is not worth an exception */
    }
  }
}

// Asked every time, deliberately not cached here.
//
// There was a TTL cache at this layer and it was wrong. The web server and the
// MCP server are separate processes over one directory, so a pull made through
// one is invisible to the other until its copy expires — which means a page
// somebody has just reported stays readable through the other door for as long
// as the window lasts. For a takedown that is the one thing the mechanism must
// not do, and no window is short enough to be obviously fine.
//
// It also bought very little. The loader below it (moderation.quarantinedSlugs)
// already caches, validated against the file's mtime, so a repeat call costs one
// `stat` and no read. Paying a stat per page read to have takedowns take effect
// the instant they happen is the right side of that trade.
async function hiddenSet() {
  if (!hiddenLoader) return null;
  try {
    return await hiddenLoader();
  } catch {
    // A failure to determine what is hidden must not take the wiki down; the
    // moderation store answers "nothing hidden" on its own errors already.
    return null;
  }
}

/** Drop hidden rows from anything the index answered without opening a file. */
async function withoutHidden(rows) {
  const hidden = await hiddenSet();
  if (!hidden || hidden.size === 0 || !Array.isArray(rows)) return rows;
  return rows.filter((r) => !hidden.has(typeof r === 'string' ? r : r.slug));
}

/**
 * One page at random.
 *
 * Goes through listPages rather than picking a file off disk, so it inherits the
 * visibility check — a pulled page must not be reachable by rolling the dice
 * enough times, which is exactly the kind of back door a separate code path
 * grows. Filters are honoured too, so "a random runbook" works.
 */
export async function randomPage({ tag, type } = {}) {
  const rows = await listPages({ tag, type });
  if (!rows.length) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

/** How many pages are hidden right now, so counts can be corrected. */
export async function hiddenCount() {
  const hidden = await hiddenSet();
  return hidden ? hidden.size : 0;
}

async function withPageLock(slug, fn) {
  const lockFile = path.join(LOCK_DIR, `${slug.replace(/\//g, '__')}.lock`);
  await fs.mkdir(LOCK_DIR, { recursive: true });

  let handle = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await fs.open(lockFile, 'wx');
      break;
    } catch (err) {
      // EPERM as well as EEXIST: on Windows, opening a lockfile that another
      // writer is in the middle of unlinking fails with EPERM rather than
      // "already exists". Both mean the same thing here — someone else has it,
      // wait and retry — and treating EPERM as fatal turns a normal contention
      // into a failed write.
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
      // Break a lock left behind by a process that died holding it.
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      await sleep(20 + Math.random() * 30);
    }
  }
  if (!handle) {
    throw new WikiError(`Timed out waiting to write "${slug}" — another writer is holding it.`, 'locked');
  }

  try {
    await handle.write(String(process.pid));
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
  }
}

export function slugify(input) {
  return String(input)
    .trim()
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/\\+/g, '/')
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg
        .replace(/[^a-z0-9._\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.-]+/, '')
    )
    .filter(Boolean)
    .join('/');
}

// Resolve a slug to an absolute path, refusing anything that escapes PAGES_DIR.
// slugify() alone would quietly rewrite "../../etc/passwd" into "etc/passwd";
// rejecting outright gives the caller a real error instead of a phantom miss.
export function pathForSlug(slug) {
  const raw = String(slug ?? '').trim();
  if (
    /^[/\\]/.test(raw) ||
    /^[a-zA-Z]:[/\\]/.test(raw) ||
    raw.split(/[/\\]/).some((seg) => seg === '..' || seg === '.') ||
    raw.includes('\0')
  ) {
    throw new WikiError(
      `Refusing page name ${JSON.stringify(slug)}: it must be a relative wiki slug, not a filesystem path.`,
      'invalid_slug'
    );
  }
  const clean = slugify(raw);
  if (!clean || !SLUG_RE.test(clean)) {
    throw new WikiError(
      `Invalid page name: ${JSON.stringify(slug)}. Use lowercase letters, digits and dashes, optionally in folders (e.g. "runbooks/restore-db").`,
      'invalid_slug'
    );
  }
  const abs = path.resolve(PAGES_DIR, `${clean}.md`);
  const root = PAGES_DIR.endsWith(path.sep) ? PAGES_DIR : PAGES_DIR + path.sep;
  if (!abs.startsWith(root)) {
    throw new WikiError(`Page name escapes the wiki directory: ${slug}`, 'invalid_slug');
  }
  return { slug: clean, abs };
}

// --- frontmatter -----------------------------------------------------------

function parseList(value) {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'tags' || key === 'aliases' || key === 'see_also') {
        meta[key] = parseList(value);
      } else {
        meta[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
  return { meta, body: body.replace(/^\s*\n/, '') };
}

export function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function titleFrom(meta, body, slug) {
  if (meta.title) return meta.title;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return h1[1].trim();
  return slug
    .split('/')
    .pop()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- reading ---------------------------------------------------------------

async function walk(dir, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await walk(path.join(dir, e.name), rel)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(rel.slice(0, -3));
    }
  }
  return out;
}

export async function listSlugs() {
  return (await walk(PAGES_DIR)).sort();
}

// Parsed pages, keyed on slug and validated by mtime+size.
//
// Every listing path in the wiki is `listSlugs()` then `readPage()` per slug —
// the index page, search, find, the graph, the stale report. Walking the tree is
// cheap (7ms at 4k pages); re-reading and re-parsing every file on every request
// is what actually costs, and it is linear in corpus size. Caching the parse here
// fixes all of those callers at once, which is why it lives in the store rather
// than in each of them.
//
// A stat still happens per read, so an edit made outside the process is picked up
// immediately. Bounded because the point is to survive a large corpus, not to hold
// one in memory.
const PAGE_CACHE_MAX = 5000;
const pageCache = new Map();

// Bumped on every write and delete, so derived caches can tell the corpus has
// moved without stat-ing it themselves.
let writeEpoch = 0;

export function invalidatePage(slug) {
  try {
    pageCache.delete(pathForSlug(slug).slug);
  } catch {
    // An unparseable slug was never cached under one.
  }
}

export function clearPageCache() {
  pageCache.clear();
}

export const pageCacheSize = () => pageCache.size;

/**
 * Read a page, honouring visibility.
 *
 * A hidden page reads as absent, which is what makes every listing path skip it
 * without knowing visibility exists — they all already drop a null. Operator
 * surfaces that must see a pulled page (to review or release it) pass
 * includeHidden, and so does the write path: hiding a page must not make a write
 * to it look like a create, or the operator's own fix would lose its history.
 */
export async function readPage(slug, { includeHidden = false } = {}) {
  const doc = await readRaw(slug);
  // includeHidden marks a privileged read — the write path and the operator's
  // review view. Those get the record untouched. Everything else is a read on
  // its way outward, and gets the redacted one.
  if (!doc || includeHidden) return doc;
  const hidden = await hiddenSet();
  if (hidden && hidden.has(doc.slug)) return null;
  return redactMeta(doc);
}

// The bookkeeping the server writes into frontmatter, stripped on the way out.
//
// `provenance` already carries all of this in masked form, so these keys are
// redundant on output and were the last place a raw address survived: an
// endpoint returning a whole document handed back `meta.updated_ip` even though
// its `provenance.observed.ip` beside it was correctly blunted.
const META_PRIVATE = ['updated_ip', 'updated_token', 'updated_agent', 'updated_host'];

function redactMeta(doc) {
  if (!maskingOn || !doc?.meta) return doc;
  let touched = false;
  const meta = { ...doc.meta };
  for (const k of META_PRIVATE) {
    if (k in meta) {
      delete meta[k];
      touched = true;
    }
  }
  return touched ? { ...doc, meta } : doc;
}

async function readRaw(slug) {
  const { slug: clean, abs } = pathForSlug(slug);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      pageCache.delete(clean);
      return null;
    }
    throw err;
  }

  let entry = pageCache.get(clean);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    let raw;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        pageCache.delete(clean);
        return null;
      }
      throw err;
    }
    const parsed = parseFrontmatter(raw);
    entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      mtimeIso: stat.mtime.toISOString(),
      raw,
      meta: parsed.meta,
      body: parsed.body,
      hash: contentHash(raw),
    };
    // Map preserves insertion order, so the first key is the oldest.
    if (pageCache.size >= PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
    pageCache.set(clean, entry);
  }

  // Callers mutate the meta they are handed (recording a verification, say), so
  // hand out a copy — the cached parse must stay pristine.
  const meta = { ...entry.meta };
  if (Array.isArray(entry.meta.tags)) meta.tags = [...entry.meta.tags];

  return {
    slug: clean,
    path: abs,
    title: titleFrom(meta, entry.body, clean),
    tags: meta.tags || [],
    meta,
    body: entry.body,
    raw: entry.raw,
    updated: meta.updated_at || entry.mtimeIso,
    bytes: entry.size,
    mtimeMs: entry.mtimeMs,
    type: meta.type || null,
    hash: entry.hash,
    provenance: provenanceOf(meta),
  };
}

/**
 * Slug, size and mtime for every page — a walk plus one stat each, no contents.
 * This is what lets the index reconcile cheaply: it can tell which pages changed
 * without opening any of them.
 */
export async function statRows() {
  const rows = [];
  for (const slug of await listSlugs()) {
    try {
      const st = await fs.stat(pathForSlug(slug).abs);
      rows.push({ slug, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Vanished between the walk and the stat; the reconcile will drop it.
    }
  }
  return rows;
}

// The index is reconciled once per process before it is first trusted, then kept
// current by the write hooks below. Both the web and MCP processes write to the
// same database, so a page written by one is immediately visible to the other.
let indexReady = null;

export async function ensureIndex({ force = false } = {}) {
  if (force) indexReady = null;
  if (!indexReady) {
    indexReady = indexdb.reconcile(await statRows(), (slug) => readPage(slug, { includeHidden: true }));
  }
  return indexReady;
}

/** Rebuild the index from disk. For after a git pull or a hand edit. */
export async function reindex() {
  return ensureIndex({ force: true });
}

/**
 * Release the index file. Only needed by short-lived processes that then delete
 * the pages directory — on Windows an open SQLite handle blocks the unlink.
 */
export function closeIndex() {
  indexReady = null;
  indexdb.close();
}

// Reconciles first: opening the database creates empty tables, so reporting on
// it before it has been filled says "0 pages" about a healthy wiki.
export const indexStats = async () => {
  await ensureIndex().catch(() => {});
  return indexdb.stats();
};
export const indexFreshnessRows = () => indexdb.freshnessRows();
// Answers from index columns, so it needs the same visibility pass listPages
// does — a field query would otherwise confirm a hidden page's existence and
// its field values to anyone who guessed at them.
/** Wiki-wide page/token/byte totals, from the index. Null if it is unavailable. */
export const indexTotals = () => indexdb.totals();

export const indexQueryByFields = async (opts) => withoutHidden(await indexdb.queryByFields(opts));
export const indexDocCount = () => indexdb.docCount();
export const indexDfFor = (t) => indexdb.dfFor(t);
export const indexPostings = (t, o) => indexdb.postings(t, o);
export const indexVectorsFor = (s) => indexdb.vectorsFor(s);
export const indexInverted = () => indexdb.invertedIndex();
export const indexSearchCandidates = (t, o) => indexdb.searchCandidates(t, o);
export const indexRowsFor = (s, o) => indexdb.rowsFor(s, o);
export const indexScoringRows = (t, o) => indexdb.scoringRowsFor(t, o);

/**
 * Split the edit record into what the server saw and what the caller claimed.
 * Anything under `claimed` is unverified by construction — an agent could put
 * whatever it liked there — so callers should present it as an assertion.
 */
// --- masking, applied to data rather than to a template ----------------------
//
// Masking used to live in the HTML renderers. That was wrong in the way these
// mistakes are usually wrong: it covered the surface I was looking at and left
// every other one raw. /api/graph and /api/history served unmasked addresses to
// anyone with no token at all, because JSON never passes through a template.
//
// So it happens here, where provenance is built, and every reader inherits it —
// the JSON API, the graph, the MCP tools, the HTML. Nothing downstream has to
// remember. The raw values stay on disk, because an operator investigating abuse
// needs them and the file is not the thing being published.
let maskingOn = false;

/** Turn on masking for outbound provenance. The server calls this when public. */
export function setPublicMasking(on) {
  maskingOn = !!on;
}

export const isMasking = () => maskingOn;

/**
 * Blunt the fields that identify a machine rather than describe an edit.
 *
 * Marked with `masked: true` when anything was changed, and that flag is the
 * point. The whole contract of this record is that `observed` is what the server
 * saw and `claimed` is what the writer said about itself — so quietly swapping a
 * writer's `host` for a pseudonym leaves a value in `claimed` that the writer
 * never claimed. An agent noticed exactly that: it sent one hostname and read a
 * different one back, from the field that is supposed to mean "their words".
 *
 * Rather than mix the two, the record now says it has been through this. The
 * values stay pseudonymous; the reader is told not to quote them as claims.
 */
export function maskProvenance(p) {
  if (!maskingOn || !p) return p;
  const observed = { ...(p.observed || {}) };
  const claimed = { ...(p.claimed || {}) };
  let touched = false;
  if (observed.ip) ((observed.ip = maskIp(observed.ip)), (touched = true));
  if (observed.host) ((observed.host = maskHost(observed.host)), (touched = true));
  if (claimed.host) ((claimed.host = maskHost(claimed.host)), (touched = true));
  if (claimed.agent && claimed.agent !== maskAgent(claimed.agent)) {
    claimed.agent = maskAgent(claimed.agent);
    touched = true;
  }
  return touched ? { ...p, observed, claimed, masked: true } : { ...p, observed, claimed };
}

export function provenanceOf(meta = {}) {
  const observed = {};
  if (meta.updated_via) observed.via = meta.updated_via;
  if (meta.updated_ip) observed.ip = meta.updated_ip;
  // Server-observed, never claimed: the token is what the request actually
  // presented, so it is the one identity in this record the writer cannot lie
  // about. It is what makes "what did this token write" answerable at all.
  if (meta.updated_token) observed.token = meta.updated_token;
  if (meta.updated_connection) observed.connection = meta.updated_connection;

  const claimed = {};
  if (meta.updated_agent) claimed.agent = meta.updated_agent;
  // Over stdio the server and the agent are the same machine, so the server
  // filled this in and it is observed fact. Over any network transport it is
  // whatever the client said about itself.
  if (meta.updated_host) {
    if (meta.updated_via === 'stdio') observed.host = meta.updated_host;
    else claimed.host = meta.updated_host;
  }
  if (meta.updated_model) claimed.model = meta.updated_model;
  if (meta.updated_session) claimed.session = meta.updated_session;
  if (meta.updated_context) claimed.context = meta.updated_context;

  const at = meta.updated_at || null;
  if (!at && !Object.keys(observed).length && !Object.keys(claimed).length) return null;
  return maskProvenance({ at, observed, claimed });
}

/** One-line human summary of who last touched a page. */
/**
 * One line describing who made an edit.
 *
 * `mask` blunts the two fields that identify a machine rather than describe an
 * edit — the address and the hostname. A public instance passes true: it
 * publishes this line to everyone, and "pve-01 at 192.168.4.27" is somebody's
 * inventory. A private instance passes false, because there the machine name is
 * the most useful thing in the record and the only reader is the operator.
 */
export function describeProvenance(p, { mask = false } = {}) {
  if (!p) return 'no edit record';
  const who = p.claimed.agent || (p.observed.via === 'web' ? 'a browser' : 'an unnamed client');
  const model = p.claimed.model ? ` (${p.claimed.model})` : '';
  const rawHost = p.observed.host || p.claimed.host;
  const host = rawHost && mask ? maskHost(rawHost) : rawHost;
  const on = host ? ` on ${host}` : '';
  const from = p.observed.ip ? ` from ${mask ? maskIp(p.observed.ip) : p.observed.ip}` : '';
  const via = p.observed.via ? ` via ${p.observed.via}` : '';
  return `${who}${model}${on}${from}${via}`;
}

// A single frontmatter line must not be able to forge extra lines.
const oneLine = (v, max = 240) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);

export function normaliseIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  return s === '::1' ? '127.0.0.1' : s;
}

export async function writePage(slug, content, opts = {}) {
  const { slug: clean } = pathForSlug(slug);
  // Checked before the lock is taken: there is no reason to make other writers
  // queue behind a page that is going to be refused anyway.
  const bytes = Buffer.byteLength(String(content ?? ''), 'utf8');
  if (bytes > MAX_PAGE_BYTES) {
    throw new WikiError(
      `Page too large: ${bytes} bytes, limit is ${MAX_PAGE_BYTES}. ` +
        `A wiki page is prose — if this is generated output or a file, link to where it lives instead.`,
      'too_large'
    );
  }
  return withPageLock(clean, () => writeLocked(clean, content, opts));
}

async function writeLocked(slug, content, opts = {}) {
  const { slug: clean, abs } = pathForSlug(slug);
  const existing = await readPage(clean, { includeHidden: true });

  // Optimistic concurrency. A caller that passes the hash it read is guaranteed
  // either to apply its change to that exact content or to be told it is stale.
  // A caller that passes nothing keeps the old last-write-wins behaviour.
  if (opts.baseHash !== undefined && opts.baseHash !== null) {
    const actual = existing ? contentHash(existing.raw) : null;
    if (actual !== opts.baseHash) {
      // The body, not the raw file. Two reasons, and the second is the one that
      // bit: the caller merges into `content`, so handing back frontmatter would
      // have it nest the server's bookkeeping inside the page — and that
      // bookkeeping includes `updated_ip`, which made a conflict response an
      // unauthenticated way to read the last writer's address.
      throw new ConflictError(clean, opts.baseHash, actual, existing?.body ?? null);
    }
  }

  const incoming = parseFrontmatter(String(content ?? ''));

  // Frontmatter precedence: explicit args > frontmatter in the new content > what
  // the page already had, so a caller can send a bare body and keep its metadata.
  const meta = { ...(existing?.meta || {}), ...incoming.meta };
  if (opts.title) meta.title = opts.title;
  if (opts.tags) meta.tags = Array.isArray(opts.tags) ? opts.tags : parseList(String(opts.tags));
  if (!meta.title) meta.title = titleFrom(meta, incoming.body, clean);
  meta.updated = new Date().toISOString().slice(0, 10);

  // Who changed this, and why. `via` and `ip` are observed by the server and are
  // trustworthy; `agent`, `model` and `context` are self-reported by the caller
  // and are only as honest as the caller. readPage() keeps that split visible.
  // Typed fields live in frontmatter alongside title/tags. Nothing validates
  // them here on purpose — see lib/types.js for why conformance is advisory.
  if (opts.type !== undefined) meta.type = oneLine(opts.type, 40).toLowerCase();
  if (opts.ttl !== undefined) meta.ttl = oneLine(opts.ttl, 20);
  // `title`, `tags`, `type` and `ttl` could all be sent as arguments; `summary`
  // could not, and was silently dropped — a 200 with the field discarded. Two
  // agents independently lost writes to it, which is what a silent no-op costs:
  // the caller has no way to tell the difference between "ignored" and "stored".
  // It is also the field the index shows, so losing it makes a page harder to
  // find than one that never had it.
  if (opts.summary !== undefined) meta.summary = oneLine(opts.summary, 300);
  if (opts.fields && typeof opts.fields === 'object') {
    for (const [k, v] of Object.entries(opts.fields)) {
      const key = oneLine(k, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!key) continue;
      if (v === null || v === '') delete meta[key];
      else meta[key] = Array.isArray(v) ? v.map((x) => oneLine(x, 80)) : oneLine(v, 300);
    }
  }

  // A verification is a distinct act from an edit: "I checked, this is still
  // true" rather than "I changed it".
  if (opts.verified) {
    meta.verified_at = new Date().toISOString();
    if (opts.verifiedBy) meta.verified_by = oneLine(opts.verifiedBy, 80);
    if (opts.verifiedNote) meta.verified_note = oneLine(opts.verifiedNote, 240);
  }

  const p = opts.provenance || {};
  meta.updated_at = new Date().toISOString();
  if (p.via) meta.updated_via = oneLine(p.via, 32);
  // Masked on the way IN, not on the way out. Read-time masking was the original
  // design and it has two holes: it is a rule at a surface, so it leaks through
  // every reader written afterwards; and it does nothing at all about the data
  // at rest, which quietly accumulates on disk and in backups. A one-time scrub
  // against a live source is bailing, not a fix — every write afterwards puts
  // the identifier straight back. On a public wiki nothing needs the original,
  // so the original never lands. See hindsight/pseudonyms.
  // Only on a public wiki. A private one wants the real machine name: knowing
  // which host wrote a page is most of the value of recording it at all.
  const keep = (raw, mask) => oneLine((maskingOn ? mask(raw) : raw) || raw, 80);
  if (p.ip) meta.updated_ip = keep(normaliseIp(p.ip), maskIp);
  if (p.token) meta.updated_token = oneLine(p.token, 24);
  if (p.agent) meta.updated_agent = keep(p.agent, maskAgent);
  // The machine the writer was on. Pages routinely contain machine-specific
  // paths, and without this nobody can tell which machine one refers to. Also
  // the only usable identity when NAT collapses every off-subnet client to the
  // gateway address.
  if (p.host) meta.updated_host = keep(p.host, maskHost);
  // Which run of an agent produced this. Timestamps almost group related edits
  // and stop working the moment two agents write in the same minute — which is
  // the normal case here. This is the key that answers "what else did that run
  // touch", which is the first question when a page turns out to be wrong.
  if (p.session) meta.updated_session = oneLine(p.session, 80);
  // Assigned by the MCP transport, so unlike the session it is observed.
  if (p.connection) meta.updated_connection = oneLine(p.connection, 80);
  if (p.model) meta.updated_model = oneLine(p.model, 80);
  if (p.context) meta.updated_context = oneLine(p.context, 240);

  const out = `${buildFrontmatter(meta)}\n\n${incoming.body.trimEnd()}\n`;

  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Write-then-rename: a reader never sees a half-written page, even if the
  // process dies mid-write.
  const tmp = `${abs}.${process.pid}.tmp`;
  await fs.writeFile(tmp, out, 'utf8');
  await fs.rename(tmp, abs);
  // The mtime+size check would catch this on the next read, but two writes inside
  // the same millisecond that happen to land on the same length would not change
  // either. Drop the entry outright rather than rely on that.
  pageCache.delete(clean);
  writeEpoch++;
  // Keep the derived index in step. It is advisory — if this fails the listing
  // is briefly out of date and a reindex fixes it, but the page itself is safe
  // on disk either way, so a failure here must never fail the write.
  try {
    await indexdb.upsert(await readPage(clean, { includeHidden: true }));
  } catch {
    // Index unavailable or unwritable. Files are the truth; carry on.
  }

  // Same argument as the index directly above, and it took a real 500 to notice
  // the case was not covered here too: by this point the page is durably on
  // disk, so throwing tells the caller their write failed when it did not. They
  // retry, and the second write is a no-op that looks like the first one working
  // — or, worse, they report the write as impossible and stop. The history is
  // valuable but it is derived from a page that already exists.
  //
  // Not silent: it returns `historyRecorded: false` so a caller that cares can
  // see it, and it logs, because a failure nobody can observe is not handled.
  let historyRecorded = true;
  try {
    await revisions.record(clean, {
      raw: out,
      op: existing ? (opts.verified ? 'verify' : 'update') : 'create',
      meta,
      provenance: provenanceOf(meta),
    });
  } catch (err) {
    historyRecorded = false;
    console.error(`[wiki] page ${clean} written but its history was not recorded:`, err?.message || err);
  }

  announce(writeHooks, { slug: clean, created: !existing, verified: !!opts.verified });

  return {
    historyRecorded,
    slug: clean,
    path: abs,
    created: !existing,
    bytes: Buffer.byteLength(out),
    hash: contentHash(out),
  };
}

export async function deletePage(slug) {
  const { slug: clean, abs } = pathForSlug(slug);
  return withPageLock(clean, async () => {
    const existing = await readPage(clean, { includeHidden: true });
    try {
      await fs.unlink(abs);
    } catch (err) {
      if (err.code === 'ENOENT') return { slug: clean, deleted: false };
      throw err;
    }
    pageCache.delete(clean);
    writeEpoch++;
    try {
      await indexdb.remove(clean);
    } catch {
      // See writeLocked: the index is never allowed to fail an operation.
    }
    // A deletion is an event in the page's history, and the last content is
    // kept so the page can be brought back.
    await revisions.record(clean, {
      raw: existing?.raw || '',
      op: 'delete',
      meta: existing?.meta || {},
      provenance: existing ? provenanceOf(existing.meta) : null,
    });
    // Never allowed to fail the delete: the page is already gone, and a hook
    // that throws must not turn a completed deletion into an error.
    for (const hook of deleteHooks) {
      try {
        await hook(clean);
      } catch {
        // Best effort by design.
      }
    }
    return { slug: clean, deleted: true };
  });
}

function firstProse(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('|')) continue;
    return t.replace(/[*_`]/g, '').slice(0, 200);
  }
  return '';
}

/**
 * Page summaries, newest-first order preserved from listSlugs.
 *
 * `offset`/`limit` exist so the index page can cost one screen of reads instead
 * of the whole corpus. When nothing is being filtered the slice is taken on slugs
 * — before any file is opened — which is the whole point; a tag or type filter
 * has to read every page to know what matches, so it cannot be short-circuited.
 */
export async function listPages({ tag, type, offset = 0, limit = null } = {}) {
  // The index answers this without opening a file, which is the whole point of
  // it — a listing needs title, type, tags and summary, and those are columns.
  try {
    await ensureIndex();
    const rows = await indexdb.listSlice({ tag, type, offset, limit });
    // The index answers from its own columns and never opens a file, so it is
    // the one listing path that does not inherit readPage's visibility check.
    // A page pulled from view would otherwise still be listed, with its title
    // and summary — which is most of what a takedown was trying to remove.
    if (rows) return await withoutHidden(rows);
  } catch {
    // Fall through to the filesystem. It is slower, never wrong.
  }

  const slugs = await listSlugs();
  const sliceEarly = !tag && !type && limit != null;
  const chosen = sliceEarly ? slugs.slice(offset, offset + limit) : slugs;
  const pages = [];
  for (const slug of chosen) {
    const page = await readPage(slug);
    if (!page) continue;
    if (tag && !page.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;
    if (type && String(page.type || '').toLowerCase() !== String(type).toLowerCase()) continue;
    pages.push({
      slug: page.slug,
      title: page.title,
      type: page.type,
      tags: page.tags,
      updated: page.updated,
      bytes: page.bytes,
      tokens: estimateTokens(page.body),
      summary: page.meta.summary || firstProse(page.body),
      // Kept in step with the index path, so a listing shows the same freshness
      // whichever route produced it.
      ttl: page.meta.ttl || null,
      verified_at: page.meta.verified_at || null,
    });
  }
  if (sliceEarly || limit == null) return pages;
  return pages.slice(offset, offset + limit);
}

/**
 * How many pages match. Unfiltered this is the slug count — a directory walk,
 * no reads at all (7ms at 4,000 pages) — so a paginated view can show a total
 * without loading the corpus to count it.
 */
export async function countPages({ tag, type } = {}) {
  try {
    await ensureIndex();
    const n = await indexdb.count({ tag, type });
    // Corrected downward so the listing's "N pages" agrees with the rows it can
    // actually show. Approximate when a tag or type is filtered — the hidden set
    // is not indexed by tag — but never larger than the truth, which is the
    // direction that matters: a count must not advertise a page nobody can open.
    if (n != null) return Math.max(0, n - (await hiddenCount()));
  } catch {
    // Fall through.
  }
  if (!tag && !type) return (await listSlugs()).length;
  return (await listPages({ tag, type })).length;
}

// Counting tags needs every page's frontmatter, so it cannot be sliced the way a
// listing can. It is memoised instead, on the page count plus a counter this
// module bumps on every write — the tag cloud is navigation, and rebuilding it on
// every index load is the one remaining full-corpus pass on that page.
//
// An edit made outside this process that only changes tags is missed until a page
// is added, removed, or written through the store. Acceptable for a chip cloud;
// it would not be for anything load-bearing.
let tagsMemo = { key: null, tags: null };

export async function allTags() {
  // One GROUP BY, where this used to be a full-corpus read.
  try {
    await ensureIndex();
    const rows = await indexdb.tagCounts();
    if (rows) return rows;
  } catch {
    // Fall through to counting them the slow way.
  }

  const slugs = await listSlugs();
  const key = `${slugs.length}:${writeEpoch}`;
  if (tagsMemo.key === key) return tagsMemo.tags;

  const counts = new Map();
  for (const p of await listPages()) {
    for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  tagsMemo = { key, tags };
  return tags;
}

// --- search ----------------------------------------------------------------

function tokenize(s) {
  const raw = String(s).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [];
  // Body matching is substring-based, so a two-letter word like "in" would match
  // almost every page and drown the real terms. Drop stopwords and very short
  // words — unless the whole query is one of them, in which case honour it.
  const kept = raw.filter((t) => t.length >= 3 && !STOP.has(t));
  return kept.length ? kept : raw;
}

function snippetFor(body, terms) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      const ctx = [lines[i - 1], lines[i], lines[i + 1]]
        .filter((l) => l != null && l.trim())
        .join(' ')
        .trim();
      return ctx.length > 280 ? `${ctx.slice(0, 280)}…` : ctx;
    }
  }
  return firstProse(body);
}

/**
 * Ranked full-text search. Weighting: title > slug/tags > headings > body.
 * Scans files on every call, so it can never serve a stale index; fine well into
 * the low thousands of pages.
 */
export async function search(query, { limit = 10, tag, scanAll = false, count = true } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  // `count: false` for searches nobody asked for: the lexical half of find(),
  // and the "did you mean" suggestions on a 404. Counting those would make the
  // number measure the wiki talking to itself.
  if (count) announce(searchHooks, { query: q, tag });
  const terms = [...new Set(tokenize(q))];
  const phrase = q.toLowerCase();
  const results = [];

  // Narrow to pages that could match before opening any of them. The scoring
  // below is untouched — the index only decides which files are worth reading,
  // and it returns a superset, so results are the same ones a full scan found.
  // `scanAll` forces the pre-index behaviour, so the two can be compared on the
  // same corpus — a narrowing that quietly drops results would otherwise be
  // invisible.
  let scan = null;
  if (!scanAll) {
    try {
      await ensureIndex();
      scan = await indexdb.searchCandidates(terms, { tag });
    } catch {
      scan = null;
    }
  }
  if (!scan) scan = await listSlugs();

  for (const slug of scan) {
    const page = await readPage(slug);
    if (!page) continue;
    if (tag && !page.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;

    const title = page.title.toLowerCase();
    const slugL = page.slug.toLowerCase();
    const tagsL = page.tags.join(' ').toLowerCase();
    const bodyL = page.body.toLowerCase();
    const headings = (page.body.match(/^#{1,6}\s+.*$/gm) || []).join('\n').toLowerCase();

    let score = 0;
    let hits = 0;
    for (const t of terms) {
      let termScore = 0;
      if (title.includes(t)) termScore += 12;
      if (slugL.includes(t)) termScore += 8;
      if (tagsL.includes(t)) termScore += 8;
      if (headings.includes(t)) termScore += 4;
      const bodyHits = bodyL.split(t).length - 1;
      if (bodyHits) termScore += Math.min(6, 1 + Math.log2(bodyHits));
      if (termScore) hits++;
      score += termScore;
    }
    if (!hits) continue;

    if (terms.length > 1) score *= hits / terms.length; // reward covering the whole query
    if (title.includes(phrase)) score += 25;
    else if (bodyL.includes(phrase)) score += 10;

    results.push({
      slug: page.slug,
      title: page.title,
      tags: page.tags,
      updated: page.updated,
      score: Math.round(score * 10) / 10,
      body: page.body,
    });
  }

  // Snippets only for the rows actually returned. Building one for every match
  // and then discarding all but `limit` of them was pure waste, and on a broad
  // query — where nearly every page matches — it was most of the cost of the
  // search, and therefore most of the cost of find(), which calls this purely
  // for the scores.
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(({ body, ...r }) => ({ ...r, snippet: snippetFor(body, terms) }));
}

// --- links -----------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// A page documenting the [[…]] syntax shows it inside code. Those are examples,
// not links — counting them produces phantom broken links in the graph.
const stripCode = (md) =>
  md.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');

/**
 * Wikilinks in a body, each marked with whether its target exists.
 *
 * `known` lets a caller that already holds the full slug set pass it in. Without
 * it this walks the tree on every call, which is fine for rendering one page and
 * ruinous for the graph — that walked it once per page, 4,000 times, for 13
 * seconds of the 16 the whole graph took.
 */
export async function linksIn(body, { known = null } = {}) {
  const slugs = known || new Set(await listSlugs());
  const out = [];
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const target = slugify(m[1]);
    out.push({ slug: target, label: (m[2] || m[1]).trim(), exists: slugs.has(target) });
  }
  return out;
}

export async function backlinks(slug) {
  const clean = slugify(slug);

  // Indexed. This used to open every page in the wiki and parse it, on every
  // page view — O(n) work per read, so the cost grew with the corpus and
  // nothing announced it. At 217 pages a read was taking over two seconds.
  //
  // Null means the index could not answer, which is different from answering
  // "none" and is why the fast path checks for null rather than for length.
  const indexed = await indexdb.backlinksTo(clean).catch(() => null);
  if (indexed) {
    const hidden = await hiddenSet();
    return hidden ? indexed.filter((r) => !hidden.has(r.slug)) : indexed;
  }

  // Files are the truth and the index is a cache, so the scan stays as the
  // fallback rather than being deleted.
  const out = [];
  for (const s of await listSlugs()) {
    if (s === clean) continue;
    const page = await readPage(s);
    if (!page) continue;
    if ((await linksIn(page.body)).some((l) => l.slug === clean)) {
      out.push({ slug: page.slug, title: page.title });
    }
  }
  return out;
}
