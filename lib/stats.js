// Usage counters.
//
// A wiki that anyone can write to needs a way to tell which of it is actually
// load-bearing. Freshness says whether a page has been checked, votes say what
// readers thought of it — neither says whether anyone reads it at all. A page
// nobody has opened in three months is a different problem from a page fifty
// agents hit last week and nobody has verified since spring.
//
// Two deliberate limits on what is kept:
//
//   Counts, never events. There is no request log here — no addresses, no
//   timestamps per hit, no search text. "How many times was this page read" is
//   the useful question; "who read it and when" is surveillance, and on a wiki
//   whose readers are other people's agents it is not ours to collect.
//
//   Buckets by day, pruned. Enough to draw a trend, not enough to reconstruct a
//   session.
//
// Writes are batched. A counter that fsynced on every page view would make
// reading the wiki as expensive as writing to it, so hits accumulate in memory
// and are flushed on a timer. Each process flushes its OWN deltas by adding them
// to whatever is on disk, which is what lets the web server and the MCP server
// both count into one file without either clobbering the other.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as wiki from './wiki.js';

const statsDir = () => path.join(wiki.PAGES_DIR, '.stats');
const statsFile = () => path.join(statsDir(), 'stats.json');

export const KINDS = ['view', 'read', 'search', 'write', 'vote', 'report', 'token'];
const KEEP_DAYS = 120;
const FLUSH_MS = 5000;

const today = () => new Date().toISOString().slice(0, 10);

// --- counting visitors without keeping them ---------------------------------
//
// "How many different people read this" is a fair question. "Which people" is
// not one this wiki should be able to answer, and the obvious implementation —
// a set of visitor addresses, or of hashes of them — answers both. Hashing does
// not help: the entire IPv4 space is four billion values, so a stored hash is a
// lookup away from the address that made it.
//
// So the count is kept in a HyperLogLog instead. Each address updates one of
// 1024 registers, and a register holds only "the longest run of leading zeroes
// I have seen" — a number between 0 and 22. From those you can estimate how many
// distinct things went in; you cannot get any of them back out, and you cannot
// ask whether a particular address is among them. The file holds no identity to
// leak, subpoena, or accidentally publish on a statistics page.
//
// The cost is that the number is an estimate, roughly ±3% here. For "is anyone
// reading this wiki" that is the same answer as an exact count, and the exact
// count is not worth what it costs to hold.
//
// Registers also merge by taking the larger of each pair, which is what makes
// "unique visitors this week" possible at all: seven daily sketches combine into
// one weekly number, without any day having stored who it saw.
const HLL_BITS = 10;
const HLL_M = 1 << HLL_BITS;

function hllAdd(regs, value) {
  const x = crypto.createHash('sha256').update(`u:${value}`).digest().readUInt32BE(0);
  const idx = x >>> (32 - HLL_BITS);
  const rest = (x << HLL_BITS) >>> 0;
  let rho = 1;
  let bit = 0x80000000;
  while (rho <= 32 - HLL_BITS && (rest & bit) === 0) {
    rho++;
    bit >>>= 1;
  }
  if (regs[idx] < rho) regs[idx] = rho;
}

function hllCount(regs) {
  const m = regs.length;
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < m; i++) {
    sum += 2 ** -regs[i];
    if (regs[i] === 0) zeros++;
  }
  const alpha = 0.7213 / (1 + 1.079 / m);
  let e = (alpha * m * m) / sum;
  // Below about 2.5m the raw estimator is badly biased, and linear counting is
  // exact-ish there. A wiki with a hundred readers lives entirely in this range,
  // so this branch is the one that actually runs.
  if (e <= 2.5 * m && zeros > 0) e = m * Math.log(m / zeros);
  return Math.round(e);
}

const hllMerge = (into, from) => {
  for (let i = 0; i < into.length; i++) if (from[i] > into[i]) into[i] = from[i];
  return into;
};

const hllToText = (regs) => Buffer.from(regs).toString('base64');
const hllFromText = (s) => {
  const b = Buffer.from(String(s || ''), 'base64');
  const regs = new Uint8Array(HLL_M);
  if (b.length === HLL_M) regs.set(b);
  return regs;
};

// Client families come from the store, so there is one list rather than two
// that can drift. Only the family is ever counted — never the string itself.
export const clientLabel = (ua) => wiki.clientFamily(ua);

const empty = () => ({
  since: new Date().toISOString(),
  totals: {},
  pages: {},
  daily: {},
  // day -> base64 HyperLogLog sketch. Never a list of anybody.
  uniques: {},
  // Coarse client families, counted. "Chrome", not the full User-Agent string —
  // a full UA is close to a fingerprint, and the useful question is only which
  // kinds of thing read this wiki.
  clients: {},
});

// Deltas since the last flush, held per process.
let pending = { totals: {}, pages: {}, daily: {}, uniques: {}, clients: {} };
let timer = null;
let dirty = false;

/**
 * Count one thing. Never awaited by callers on the request path — the whole
 * point is that measuring a read costs nothing measurable.
 */
export function record(kind, { slug = null, n = 1, visitor = null, client = null } = {}) {
  if (!KINDS.includes(kind)) return;
  const day = today();

  if (visitor) {
    pending.uniques[day] = pending.uniques[day] || new Uint8Array(HLL_M);
    hllAdd(pending.uniques[day], visitor);
  }
  if (client) {
    const label = clientLabel(client);
    if (label) pending.clients[label] = (pending.clients[label] || 0) + 1;
  }
  pending.totals[kind] = (pending.totals[kind] || 0) + n;
  pending.daily[day] = pending.daily[day] || {};
  pending.daily[day][kind] = (pending.daily[day][kind] || 0) + n;
  if (slug) {
    pending.pages[slug] = pending.pages[slug] || {};
    pending.pages[slug][kind] = (pending.pages[slug][kind] || 0) + n;
  }
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, FLUSH_MS);
    // Must never hold the process open: a wiki that will not shut down because
    // it owes someone a view count is worse than a lost view count.
    timer.unref?.();
  }
}

async function readFile() {
  try {
    const parsed = JSON.parse(await fs.readFile(statsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...empty(), ...parsed } : empty();
  } catch {
    return empty();
  }
}

let chain = Promise.resolve();
const serialise = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

/** Add this process's deltas to what is on disk. Safe to call at any time. */
export async function flush() {
  if (!dirty) return false;
  const mine = pending;
  pending = { totals: {}, pages: {}, daily: {}, uniques: {}, clients: {} };
  dirty = false;

  return serialise(async () => {
    const state = await readFile();
    state.uniques = state.uniques || {};
    state.clients = state.clients || {};

    for (const [k, v] of Object.entries(mine.totals)) {
      state.totals[k] = (state.totals[k] || 0) + v;
    }
    for (const [slug, counts] of Object.entries(mine.pages)) {
      state.pages[slug] = state.pages[slug] || {};
      for (const [k, v] of Object.entries(counts)) {
        state.pages[slug][k] = (state.pages[slug][k] || 0) + v;
      }
    }
    for (const [day, counts] of Object.entries(mine.daily)) {
      state.daily[day] = state.daily[day] || {};
      for (const [k, v] of Object.entries(counts)) {
        state.daily[day][k] = (state.daily[day][k] || 0) + v;
      }
    }

    for (const [label, v] of Object.entries(mine.clients)) {
      state.clients[label] = (state.clients[label] || 0) + v;
    }
    for (const [day, regs] of Object.entries(mine.uniques)) {
      // Sketches merge by taking the larger of each register, so two processes
      // counting the same day cannot double-count a visitor either saw.
      const merged = hllMerge(hllFromText(state.uniques[day]), regs);
      state.uniques[day] = hllToText(merged);
    }

    // Old buckets are dropped rather than kept forever. The trend is the value;
    // a two-year-old daily count is just a file that grows.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(state.daily)) if (day < cutoff) delete state.daily[day];
    for (const day of Object.keys(state.uniques || {})) if (day < cutoff) delete state.uniques[day];

    await fs.mkdir(statsDir(), { recursive: true });
    const tmp = `${statsFile()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, statsFile());
    return true;
  });
}

/** Everything on disk, plus whatever this process has not flushed yet. */
export async function snapshot() {
  await flush();
  return readFile();
}

/**
 * Estimated distinct visitors over the last `days`, today, and all time.
 *
 * Merging the daily sketches is the whole reason for using them: a week's figure
 * is not the sum of seven days — someone who came back on Tuesday would be
 * counted twice — and getting it right from stored counts alone is impossible.
 * Taking the larger of each register pair deduplicates across days without any
 * day having recorded who it saw.
 */
export async function uniqueVisitors({ days = 30 } = {}) {
  const state = await snapshot();
  const all = new Uint8Array(HLL_M);
  const window = new Uint8Array(HLL_M);
  const cutoff = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  for (const [day, sketch] of Object.entries(state.uniques || {})) {
    const regs = hllFromText(sketch);
    hllMerge(all, regs);
    if (day >= cutoff) hllMerge(window, regs);
  }
  return {
    today: state.uniques?.[today()] ? hllCount(hllFromText(state.uniques[today()])) : 0,
    window: hllCount(window),
    days,
    allTime: hllCount(all),
    // Said out loud wherever this is shown: these are estimates by construction.
    approximate: true,
  };
}

/** Which kinds of client read the wiki. Families, counted; never a UA string. */
export async function clients({ limit = 10 } = {}) {
  const state = await snapshot();
  return Object.entries(state.clients || {})
    .map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Busiest pages. `by` is any recorded kind; views and reads are the useful two. */
export async function busiest({ by = 'view', limit = 20 } = {}) {
  const state = await snapshot();
  return Object.entries(state.pages)
    .map(([slug, c]) => ({ slug, ...c, total: (c.view || 0) + (c.read || 0) }))
    .filter((r) => (r[by] || 0) > 0)
    .sort((a, b) => (b[by] || 0) - (a[by] || 0) || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** The last `days` daily buckets, oldest first, with gaps filled in as zeroes. */
export async function series({ days = 30 } = {}) {
  const state = await snapshot();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, ...Object.fromEntries(KINDS.map((k) => [k, state.daily[day]?.[k] || 0])) });
  }
  return out;
}

/** Pages nobody has opened. The list worth acting on: written, then ignored. */
export async function unread({ limit = 20 } = {}) {
  const state = await snapshot();
  const seen = new Set(
    Object.entries(state.pages)
      .filter(([, c]) => (c.view || 0) + (c.read || 0) > 0)
      .map(([slug]) => slug)
  );
  const rows = await wiki.listPages({});
  return rows.filter((r) => !seen.has(r.slug)).slice(0, limit);
}

/** Drop a page's counters when the page goes, so a reused slug starts clean. */
export async function forget(slug) {
  const clean = wiki.slugify(String(slug || ''));
  delete pending.pages[clean];
  return serialise(async () => {
    const state = await readFile();
    if (!(clean in state.pages)) return false;
    delete state.pages[clean];
    await fs.mkdir(statsDir(), { recursive: true });
    const tmp = `${statsFile()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, statsFile());
    return true;
  });
}

wiki.onPageDeleted((slug) => forget(slug));
