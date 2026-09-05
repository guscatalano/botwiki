// Abuse handling for a publicly reachable wiki.
//
// This module only matters when WIKI_PUBLIC is set. A private instance — one on
// a LAN, behind a token, run by the person who wrote it — has no use for any of
// it, and gets none of it: no report link, no policy page, no extra checks on
// the write path. The whole file is inert unless the server asks for it.
//
// Two primitives, and the distinction between them is deliberate:
//
//   report     — a visitor says a page is a problem. Cheap, anonymous, unproven.
//   quarantine — an operator pulls a page out of public view. Immediate.
//
// Quarantine HIDES, it does not delete. That is the important part. For anything
// genuinely illegal the obligation is to remove it from view, preserve it, and
// report it to the relevant authority — destroying it destroys the evidence the
// investigation needs. `wiki_delete` is still there when deletion is the right
// answer; it is just not what a takedown should reach for first.
//
// Both stores live in dot-directories under the pages dir, so the page walker
// skips them exactly as it skips .talk and .history.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as wiki from './wiki.js';

const modDir = () => path.join(wiki.PAGES_DIR, '.moderation');
const reportsFile = () => path.join(modDir(), 'reports.jsonl');
const quarantineFile = () => path.join(modDir(), 'quarantine.json');

const REASONS = new Set([
  'illegal',      // content that is unlawful to host
  'csam',         // routed separately below; kept explicit so it can never be a free-text tag
  'privacy',      // personal information published without consent
  'security',     // credentials, keys, exploit material
  'inaccurate',   // wrong, which on this wiki is a normal condition rather than abuse
  'spam',
  'other',
]);

// --- reports ----------------------------------------------------------------

/**
 * Record a report. Never throws at the caller: a failure to write a report must
 * not turn into a 500 that tells an abuser their report did not land.
 */
export async function report({ slug, reason, detail = '', ip = null, agent = null } = {}) {
  const entry = {
    id: `rp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    slug: String(slug || '').slice(0, 300),
    reason: REASONS.has(reason) ? reason : 'other',
    // Bounded hard. This is an unauthenticated free-text field on a public box.
    detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
    ip,
    agent: String(agent || '').slice(0, 200) || null,
    status: 'open',
  };
  try {
    await fs.mkdir(modDir(), { recursive: true });
    await fs.appendFile(reportsFile(), JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  } catch {
    return null;
  }
}

export async function listReports({ limit = 200, status = null } = {}) {
  let text;
  try {
    text = await fs.readFile(reportsFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!status || e.status === status) out.push(e);
    } catch {
      // A truncated final line must not lose the rest.
    }
  }
  return out.reverse().slice(0, limit);
}

/** Reports per page, so an operator sees which pages are actually being flagged. */
export async function reportCounts() {
  const by = new Map();
  for (const r of await listReports({ limit: 5000 })) {
    if (!by.has(r.slug)) by.set(r.slug, { slug: r.slug, total: 0, reasons: {} });
    const e = by.get(r.slug);
    e.total++;
    e.reasons[r.reason] = (e.reasons[r.reason] || 0) + 1;
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}


// Written to a temporary file and renamed rather than in place. A plain
// writeFile truncates first, so a reader arriving mid-write parses half a
// document, fails, and falls back to "nothing is quarantined" — a hidden page
// briefly visible again, which is the one failure this file exists to prevent.
async function writeJsonAtomic(file, value) {
  await fs.mkdir(modDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// --- quarantine -------------------------------------------------------------

async function readQuarantine() {
  try {
    const raw = await fs.readFile(quarantineFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.slugs) ? parsed : { slugs: [], entries: {} };
  } catch {
    return { slugs: [], entries: {} };
  }
}

// Read on every check would be a file read per request; the set is tiny and only
// changes when someone pulls or releases a page, so it is cached.
//
// Validated against the file's mtime rather than only invalidated on write. The
// web server and the MCP server are different processes over one directory: a
// pull made through MCP never runs this module's invalidation inside the web
// server, so a cache that trusted its own writes alone would keep serving a
// pulled page there until it restarted. Statting is cheap; being wrong is not.
let cache = null;
let cacheStamp = '';

export async function quarantinedSlugs() {
  let stamp = 'none';
  try {
    const st = await fs.stat(quarantineFile());
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // No file yet: nothing is quarantined, and "none" is a stable stamp for that.
  }
  if (!cache || stamp !== cacheStamp) {
    cache = new Set((await readQuarantine()).slugs);
    cacheStamp = stamp;
  }
  return cache;
}

export async function isQuarantined(slug) {
  return (await quarantinedSlugs()).has(wiki.slugify(String(slug || '')));
}

export async function quarantine(slug, { by = 'operator', note = '' } = {}) {
  const clean = wiki.slugify(String(slug || ''));
  if (!clean) return null;
  const q = await readQuarantine();
  if (!q.slugs.includes(clean)) q.slugs.push(clean);
  q.entries = q.entries || {};
  q.entries[clean] = { at: new Date().toISOString(), by, note: String(note).slice(0, 500) };
  await writeJsonAtomic(quarantineFile(), q);
  cache = null;
  wiki.invalidateHidden();
  return q.entries[clean];
}

export async function release(slug) {
  const clean = wiki.slugify(String(slug || ''));
  const q = await readQuarantine();
  q.slugs = q.slugs.filter((s) => s !== clean);
  if (q.entries) delete q.entries[clean];
  await writeJsonAtomic(quarantineFile(), q);
  cache = null;
  wiki.invalidateHidden();
  return true;
}

/**
 * Forget the moderation state attached to a page that has been deleted.
 *
 * The quarantine entry is the one that matters. Left behind, it hides whatever
 * is written at that slug next: someone posts a page, it is invisible, and all
 * they get is a 404 with no explanation — punished for a takedown against a
 * page they never saw. A hide is a statement about *content*, and the content
 * is gone.
 *
 * Reports are deliberately kept. They are the evidence trail, they carry their
 * own detail and timestamps, and the fact that a page was reported and then
 * removed is exactly the history an operator may need later. Pending proposals
 * go, because they propose edits to something that no longer exists.
 */
export async function forget(slug) {
  const clean = wiki.slugify(String(slug || ''));
  if (!clean) return false;
  let touched = false;

  if (await isQuarantined(clean)) {
    await release(clean);
    touched = true;
  }

  try {
    const pending = await listPending({ status: null, limit: 1000 });
    for (const e of pending) {
      if (e.slug === clean && e.status === 'pending') {
        await reject(e.id, { by: 'page deleted' });
        touched = true;
      }
    }
  } catch {
    // A pending store that cannot be read must not fail the delete.
  }
  return touched;
}

wiki.onPageDeleted((slug) => forget(slug));

export async function quarantineList() {
  const q = await readQuarantine();
  return q.slugs.map((s) => ({ slug: s, ...(q.entries?.[s] || {}) }));
}

/** Drop quarantined pages from anything a public visitor is shown. */
export async function filterPublic(rows) {
  const q = await quarantinedSlugs();
  if (!q.size) return rows;
  return rows.filter((r) => !q.has(r.slug));
}

export const REPORT_REASONS = [...REASONS];

// --- write screening --------------------------------------------------------
//
// Moderation is reactive: something bad gets published, someone reports it, an
// operator pulls it. That loop is fine for a one-off and useless against someone
// posting the same thing a hundred times. Two things actually stop repetition:
// refusing the payload at the door, and being able to stop the writer.
//
// The strongest control is not here at all — it is `WIKI_READONLY=1`. A public
// instance with no write path has nothing to repeat.

// A data: URI is the page carrying the bytes rather than pointing at them. The
// renderer already refuses to display one; this refuses to STORE one, which is
// the difference between "not shown" and "not hosted".
const DATA_URI = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;[^\s)"']*base64/i;

export const SCREEN_LIMITS = {
  maxBytes: 256 * 1024,
  maxLinks: 200,
};

/**
 * Decide whether a public instance should accept this body at all.
 * Returns { ok } or { ok:false, reason, detail }.
 */
export function screen(body, { maxBytes = SCREEN_LIMITS.maxBytes, maxLinks = SCREEN_LIMITS.maxLinks } = {}) {
  const text = String(body ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, reason: 'too_large', detail: `${bytes} bytes exceeds ${maxBytes}` };
  }
  if (DATA_URI.test(text)) {
    return {
      ok: false,
      reason: 'embedded_binary',
      detail: 'data: URIs embed file content in the page; link to a source instead',
    };
  }
  const links = (text.match(/\]\(/g) || []).length;
  if (links > maxLinks) {
    return { ok: false, reason: 'too_many_links', detail: `${links} links exceeds ${maxLinks}` };
  }
  return { ok: true };
}

// --- blocking writers -------------------------------------------------------
//
// The wiki already records who wrote every revision — address, agent, session.
// That provenance is what makes a block possible: without identity, a repeat
// abuser is indistinguishable from a new one and there is nothing to act on.

const blocksFile = () => path.join(modDir(), 'blocked.json');
let blockCache = null;

async function readBlocks() {
  try {
    const parsed = JSON.parse(await fs.readFile(blocksFile(), 'utf8'));
    return Array.isArray(parsed?.blocked) ? parsed : { blocked: [] };
  } catch {
    return { blocked: [] };
  }
}

export async function blockedSet() {
  if (!blockCache) blockCache = new Set((await readBlocks()).blocked.map((b) => b.id));
  return blockCache;
}

/** `id` is whatever identifies the writer: an address, a session, a token name. */
export async function isBlocked(...ids) {
  const set = await blockedSet();
  return ids.some((i) => i && set.has(String(i)));
}

export async function block(id, { reason = '', by = 'operator' } = {}) {
  const clean = String(id || '').trim();
  if (!clean) return null;
  const b = await readBlocks();
  if (!b.blocked.some((x) => x.id === clean)) {
    b.blocked.push({ id: clean, at: new Date().toISOString(), by, reason: String(reason).slice(0, 300) });
  }
  await writeJsonAtomic(blocksFile(), b);
  blockCache = null;
  return clean;
}

export async function unblock(id) {
  const clean = String(id || '').trim();
  const b = await readBlocks();
  b.blocked = b.blocked.filter((x) => x.id !== clean);
  await writeJsonAtomic(blocksFile(), b);
  blockCache = null;
  return true;
}

export async function blockList() {
  return (await readBlocks()).blocked;
}

// --- pending edits ----------------------------------------------------------
//
// The control that makes open writing survivable, and the only one on this page
// that is not reactive.
//
// Screening and blocking both lose the same argument: an abuser has to succeed
// once, an operator has to succeed every time, and a ban costs nothing to route
// around. Holding untrusted writes changes which way that asymmetry points —
// nothing an unknown writer submits is ever public, so there is no payoff to
// keep trying, and the operator is reviewing a queue instead of chasing a live
// site.
//
// A trusted writer (one holding the instance's token) still writes straight
// through. This is a gate on strangers, not a workflow for the owner.

const pendingFile = () => path.join(modDir(), 'pending.jsonl');

export async function propose({ slug, content, opts = {}, ip = null, agent = null, note = '' } = {}) {
  const entry = {
    id: `pe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    slug: wiki.slugify(String(slug || '')),
    content: String(content ?? ''),
    // Only the fields a proposal is allowed to set. Anything else an untrusted
    // caller sent is dropped rather than replayed on approval.
    opts: {
      title: opts.title ? String(opts.title).slice(0, 200) : undefined,
      tags: Array.isArray(opts.tags) ? opts.tags.slice(0, 20).map((t) => String(t).slice(0, 40)) : undefined,
      type: opts.type ? String(opts.type).slice(0, 40) : undefined,
    },
    ip,
    agent: String(agent || '').slice(0, 200) || null,
    note: String(note || '').slice(0, 500),
    status: 'pending',
  };
  await fs.mkdir(modDir(), { recursive: true });
  await fs.appendFile(pendingFile(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

async function readPending() {
  let text;
  try {
    text = await fs.readFile(pendingFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated final line must not lose the rest.
    }
  }
  // Later entries win, so a decision recorded after a proposal supersedes it.
  const byId = new Map();
  for (const e of out) byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
  return [...byId.values()];
}

export async function listPending({ status = 'pending', limit = 200 } = {}) {
  const all = await readPending();
  return all
    .filter((e) => !status || e.status === status)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export async function getPending(id) {
  return (await readPending()).find((e) => e.id === id) || null;
}

async function decide(id, status, by) {
  await fs.mkdir(modDir(), { recursive: true });
  await fs.appendFile(
    pendingFile(),
    JSON.stringify({ id, status, decidedAt: new Date().toISOString(), decidedBy: by }) + '\n',
    'utf8'
  );
}

/**
 * Apply a proposal. The write goes through the normal store path, so it gets a
 * revision, provenance and an index update exactly as any other write does —
 * with the original submitter's details preserved rather than the operator's.
 */
export async function approve(id, { by = 'operator' } = {}) {
  const e = await getPending(id);
  if (!e || e.status !== 'pending') return null;
  const clean = {};
  for (const [k, v] of Object.entries(e.opts || {})) if (v !== undefined) clean[k] = v;
  await wiki.writePage(e.slug, e.content, {
    ...clean,
    provenance: {
      via: 'pending',
      ip: e.ip,
      agent: e.agent,
      context: `proposal ${e.id} approved by ${by}`,
    },
  });
  await decide(id, 'approved', by);
  return e;
}

export async function reject(id, { by = 'operator' } = {}) {
  const e = await getPending(id);
  if (!e || e.status !== 'pending') return null;
  await decide(id, 'rejected', by);
  return e;
}

export async function pendingCount() {
  return (await listPending()).length;
}

// --- shadowing --------------------------------------------------------------
//
// Telling an abuser they are blocked is telling them what to change. "403
// blocked" means find a new address; "422 rejected" means try a different
// payload. Every honest error is a hint, and a determined abuser is running a
// loop that reads those hints.
//
// So a writer who has already been judged abusive gets a response that looks
// exactly like success, and their content goes nowhere. There is no signal to
// iterate against, and the cheapest outcome for them is to assume it worked and
// stop.
//
// Two limits stated plainly, because this is the kind of measure that gets
// oversold:
//
//   - It fools a script, not a person. Anyone who opens the page in another
//     browser sees their edit is not there. It raises the cost of finding out;
//     it does not make finding out impossible.
//   - It is deception, so it is reserved for writers an operator has already
//     blocked. A stranger acting in good faith is told the truth — that their
//     edit is queued — because they have earned an honest answer and lying to
//     them would just waste the time of someone trying to help.

const shadowFile = () => path.join(modDir(), 'shadow.jsonl');

/**
 * Record what a blocked writer tried to submit, and hand back a response
 * indistinguishable from a real write.
 *
 * The content is kept. A blocked writer's attempts are the evidence for why the
 * block was right, and the material an investigation would want.
 */
export async function shadowWrite({ slug, content, ip = null, agent = null, session = null } = {}) {
  const clean = wiki.slugify(String(slug || ''));
  const body = String(content ?? '');
  try {
    await fs.mkdir(modDir(), { recursive: true });
    await fs.appendFile(
      shadowFile(),
      JSON.stringify({
        at: new Date().toISOString(),
        slug: clean,
        bytes: Buffer.byteLength(body, 'utf8'),
        content: body.slice(0, 20000),
        ip,
        agent: String(agent || '').slice(0, 200) || null,
        session: session || null,
      }) + '\n',
      'utf8'
    );
  } catch {
    // Losing the record must not change the response — that would be the tell.
  }
  // An id in the same shape a real proposal gets, so the response the caller
  // sees is indistinguishable from the one they were getting before the block.
  return {
    id: `pe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    slug: clean,
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

export async function shadowLog({ limit = 200 } = {}) {
  let text;
  try {
    text = await fs.readFile(shadowFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* truncated tail */
    }
  }
  return out.reverse().slice(0, limit);
}

// --- rate limiting ----------------------------------------------------------
//
// In-process and deliberately simple. The real limiter belongs at the edge,
// where it can drop a flood before it reaches Node at all — this is the floor
// that applies when nothing is in front, not the ceiling.

const hits = new Map();

export function rateLimit(key, { max = 10, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const k = String(key || 'anon');
  const rec = hits.get(k);
  if (!rec || now > rec.reset) {
    hits.set(k, { n: 1, reset: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  rec.n++;
  if (rec.n > max) return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
  return { ok: true, remaining: max - rec.n };
}

// Unbounded growth would be its own denial of service. Swept lazily rather than
// on a timer so an idle process does no work.
export function sweepRateLimit() {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return hits.size;
}
