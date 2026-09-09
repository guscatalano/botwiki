// Query expansion from the corpus's own vocabulary.
//
// The gap this closes: wiki.search() and find() both match on shared words, so
// "the box keeps dropping off the network" never reaches a page that says
// "the igc0 trunk flaps" — the two share no term, and cosine over no overlap is
// zero however good the ranking is.
//
// Embeddings solve this by knowing English. That is not available here and does
// not need to be, because the relationship worth knowing is not general: it is
// that on THIS wiki, `network` and `igc0` appear on the same pages. The corpus
// already states its own vocabulary relationships and nobody was reading them.
//
// So: count which terms co-occur, keep each term's strongest neighbours, and let
// a query borrow them. This is distributional semantics with no model, no
// dependency, no network call and no per-query cost beyond a Map lookup.
//
// What it cannot do is relate two things the wiki has never discussed together.
// That is a real limit and it is the honest boundary of the technique.

import * as wiki from './wiki.js';
import * as index from './index-db.js';

// Terms per page that take part in the co-occurrence count.
//
// This is the one number that decides whether building the table is fast or
// slow, because the work is quadratic in it: every page contributes n*(n-1)/2
// pairs. At 163 terms per page — the measured average — that is 13k pairs per
// page and 20M for a corpus of 1,500. At 40 it is 780 and 1.2M, which is under
// a second. The terms dropped are the page's weakest, which are the ones whose
// co-occurrence means least.
const TERMS_PER_PAGE = 40;

// Neighbours kept per term. Twenty is more than a query can use; the point of
// keeping a few spare is that pruning happens once and querying happens often.
const NEIGHBOURS = 20;

// A term on one page relates nothing to anything. A term on half the corpus
// relates everything to everything. Both ends are noise, and excluding them is
// most of what makes the result usable rather than merely correct.
const MIN_DF = 2;
const MAX_DF_RATIO = 0.15;

// Rebuilt when the corpus changes — but not more often than this. Associations
// move slowly: one page in fifteen hundred cannot meaningfully change what
// `network` is related to, and rebuilding per write would put a corpus-sized
// scan on the write path of a wiki whose whole point is being written to.
const REBUILD_COOLDOWN_MS = Number(process.env.WIKI_ASSOC_COOLDOWN_MS) || 5 * 60 * 1000;

let table = null; // Map<term, Array<[term, weight]>>
let builtStamp = null;
let builtAt = 0;
let building = null;

/** Whether an association table exists yet. */
export const ready = () => table !== null;

export function stats() {
  return {
    ready: table !== null,
    terms: table ? table.size : 0,
    builtAt: builtAt ? new Date(builtAt).toISOString() : null,
    stamp: builtStamp,
  };
}

/**
 * Build the term→neighbours table from the stored page vocabularies.
 *
 * Reads page_terms rather than the markdown: the index already holds each
 * page's terms with frequencies, so this costs no file I/O and no re-parsing.
 */
async function build() {
  // Three times what each page will contribute, because the selection below
  // needs room to discard. Pulling exactly TERMS_PER_PAGE and then filtering
  // would leave pages with almost nothing after the common words are removed.
  const rows = await index.allPageTerms({ perPage: TERMS_PER_PAGE * 3 });
  if (!rows) return null;

  // Document frequency first, so both ends of the noise can be excluded before
  // any pair is counted. Counting pairs and filtering afterwards would do the
  // expensive part on exactly the terms being thrown away.
  const df = new Map();
  for (const [, termList] of rows) {
    for (const { term } of termList) df.set(term, (df.get(term) || 0) + 1);
  }
  const pages = rows.length || 1;
  // The ratio guard drops terms so common they relate everything to everything.
  // As a pure ratio it inverts on a small corpus: at 40 pages 15% is 6, at 11 it
  // is 1, and a wiki that has just been started ends up excluding every term
  // that appears more than once — which is every term worth relating. The floor
  // keeps it a guard against noise rather than a guard against having a corpus.
  const maxDf = Math.max(MIN_DF + 2, Math.floor(pages * MAX_DF_RATIO));
  const usable = (t) => {
    const n = df.get(t) || 0;
    return n >= MIN_DF && n <= maxDf;
  };

  const pairs = new Map(); // "a|b" -> count
  let sincePause = 0;
  const idf = (t) => Math.log(pages / ((df.get(t) || 0) + 1));
  for (const [, termList] of rows) {
    // Filter to usable terms FIRST, then rank what survives by tf-idf. Ranking
    // before filtering takes the page's commonest words — which are the
    // corpus's commonest words — so the terms that actually distinguish this
    // page from every other one never make the cut, and the table ends up
    // relating "content" to "appear" instead of "network" to "igc0".
    const kept = termList
      .filter((r) => usable(r.term))
      .sort((a, b) => (1 + Math.log(b.tf)) * idf(b.term) - (1 + Math.log(a.tf)) * idf(a.term))
      .slice(0, TERMS_PER_PAGE)
      .map((r) => r.term);
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        // One key per unordered pair, so a and b are counted together rather
        // than as two independent halves that can disagree.
        const key = kept[i] < kept[j] ? `${kept[i]}|${kept[j]}` : `${kept[j]}|${kept[i]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
    // Yield periodically. This runs in the same process as the web server, and
    // a second of blocked event loop is a second of every other request waiting.
    if (++sincePause >= 200) {
      sincePause = 0;
      await new Promise((r) => setImmediate(r));
    }
  }

  // Score by pointwise mutual information rather than raw count, or the answer
  // is just "the commonest terms" for every input: two terms that each appear
  // 500 times and co-occur 50 are less related than two that appear 10 times
  // and co-occur 8, and raw counts say the opposite.
  const scored = new Map();
  const add = (from, to, weight) => {
    let list = scored.get(from);
    if (!list) scored.set(from, (list = []));
    list.push([to, weight]);
  };
  for (const [key, count] of pairs) {
    if (count < MIN_DF) continue;
    const [a, b] = key.split('|');
    const pmi = Math.log((count * pages) / ((df.get(a) || 1) * (df.get(b) || 1)));
    if (pmi <= 0) continue;
    add(a, b, pmi);
    add(b, a, pmi);
  }

  const out = new Map();
  for (const [term, list] of scored) {
    list.sort((x, y) => y[1] - x[1]);
    out.set(term, list.slice(0, NEIGHBOURS));
  }
  return out;
}

/**
 * Make sure a table exists, rebuilding it if the corpus has moved on.
 *
 * Never blocks a caller on a rebuild it did not need: if a usable table exists
 * it is returned immediately and any refresh happens behind it. The first call
 * on a cold process does wait, because returning nothing would silently disable
 * expansion and look like the feature not working.
 */
// How often the corpus is re-fingerprinted to see whether a rebuild is due.
// Checking on every call cost a listPages() per query — around 14ms on the
// public corpus, paid on the request path to answer a question whose answer
// cannot change more than once every REBUILD_COOLDOWN_MS anyway.
const STAMP_CHECK_MS = 30_000;
let stampCheckedAt = 0;

export async function ensure() {
  // A warm table plus a recent check is the common case by far, and it should
  // cost nothing at all.
  if (table && Date.now() - stampCheckedAt < STAMP_CHECK_MS) return table;

  let stamp = null;
  try {
    const pages = await wiki.listPages();
    const { corpusStamp } = await import('./vectors.js');
    stamp = corpusStamp(pages, 'assoc');
    stampCheckedAt = Date.now();
  } catch {
    stamp = builtStamp;
  }

  const stale = stamp !== builtStamp && Date.now() - builtAt > REBUILD_COOLDOWN_MS;
  if (table && !stale) return table;
  if (building) return table || building;

  building = build()
    .then((built) => {
      if (built) {
        table = built;
        builtStamp = stamp;
        builtAt = Date.now();
      }
      return table;
    })
    .catch(() => table)
    .finally(() => {
      building = null;
    });

  // A cold process waits; a warm one keeps serving the table it has.
  return table || building;
}

/**
 * Terms to add to a query, with the weight they should carry.
 *
 * Weighted well below the terms someone actually typed. An expansion term is a
 * guess about intent, and a guess that can outvote the query is how expansion
 * makes good searches worse in order to rescue bad ones.
 */
export async function expand(queryTerms, { limit = 12, weight = 0.35 } = {}) {
  const t = await ensure();
  if (!t) return [];
  const seen = new Set(queryTerms);
  const scores = new Map();
  for (const q of queryTerms) {
    const neighbours = t.get(q);
    if (!neighbours) continue;
    for (const [term, pmi] of neighbours) {
      if (seen.has(term)) continue;
      // A term suggested by two different query words is more likely to be what
      // the query is about than one suggested by either alone.
      scores.set(term, (scores.get(term) || 0) + pmi);
    }
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, score]) => ({ term, weight: weight * Math.min(1, score / 4) }));
}

/** Drop the table, so the next ensure() rebuilds. For tests. */
export function reset() {
  table = null;
  builtStamp = null;
  builtAt = 0;
  stampCheckedAt = 0;
}
