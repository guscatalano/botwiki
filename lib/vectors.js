// TF-IDF vectors over page text. Shared by the graph (page-to-page similarity)
// and by find() (free-text-to-page similarity), so both agree about what makes
// two pieces of text alike.
import { stem } from './stem.js';

export const STOP = new Set(
  `a an the and or but if then else for of to in on at by with from as is are was were be been being
   it its this that these those there here what which who whom whose when where why how all any both
   each few more most other some such no nor not only own same so than too very can will just do does
   did doing have has had having i you he she we they them his her their our your my me him us
   about after again against before below between during into through under up down out off over
   further once because while above also may might must should would could shall
   use used using make makes made get gets got run runs running set sets need needs
   page wiki see also via e.g i.e etc
   want need know tell show find give me my our thing stuff something anything
   does did doing where when what which who why how`.split(/\s+/)
);

export function terms(text) {
  const out = [];
  // Matched before lower-casing, because CASE IS EVIDENCE. An all-caps token is
  // an identifier — EACCES, DHCP, VLAN, TLS — not an English word, and stemming
  // one mangles it (EACCES would become `eacc`). Lower-casing first threw that
  // signal away before anything could use it.
  const raw =
    String(text)
      // Drop fenced code — shell transcripts otherwise dominate every vector.
      .replace(/```[\s\S]*?```/g, ' ')
      .match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || [];
  for (const token of raw) {
    // `._-` are allowed inside a token so identifiers survive whole (pve-01,
    // wan0.100), but a TRAILING one is sentence punctuation that the pattern
    // swallowed: `content.` was a different term from `content`, and both sat
    // in the index competing with each other.
    const trimmed = token.replace(/[._-]+$/, '');
    if (trimmed.length < 3) continue;
    const lower = trimmed.toLowerCase();
    if (STOP.has(lower) || /^\d+$/.test(lower)) continue;
    // Two or more letters, no lower-case at all: an acronym or an error code.
    out.push(/^[A-Z][A-Z0-9._-]+$/.test(trimmed) ? lower : stem(lower));
  }
  return out;
}

/**
 * The same tokens, unstemmed, paired with their stems.
 *
 * For the one caller that has to show a human what was matched rather than use
 * it as a key: the live feed's query anonymiser looks a term up by its stem but
 * must print the word someone actually typed. `restor` is a correct index key
 * and a poor thing to publish.
 */
export function termPairs(text) {
  const raw =
    String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || [];
  const out = [];
  for (const token of raw) {
    const trimmed = token.replace(/[._-]+$/, '');
    if (trimmed.length < 3) continue;
    const lower = trimmed.toLowerCase();
    if (STOP.has(lower) || /^\d+$/.test(lower)) continue;
    out.push({ raw: lower, stem: /^[A-Z][A-Z0-9._-]+$/.test(trimmed) ? lower : stem(lower) });
  }
  return out;
}

function normalise(vec) {
  let norm = 0;
  for (const w of vec.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of vec) vec.set(t, w / norm);
  return vec;
}

/**
 * Build an index over a corpus. Keeps the document frequencies so a query
 * written later can be projected into the same space.
 */
export function buildIndex(docs) {
  const df = new Map();
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const t of terms(d)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });

  const N = docs.length || 1;
  const idf = (t) => Math.log(1 + N / ((df.get(t) || 0) + 1));

  const vectors = tfs.map((tf) => {
    const vec = new Map();
    for (const [t, count] of tf) {
      const w = (1 + Math.log(count)) * idf(t);
      if (w > 0) vec.set(t, w);
    }
    return normalise(vec);
  });

  return {
    vectors,
    df,
    N,
    idf,
    /** Project arbitrary text into the same space as the corpus. */
    vectorise(text) {
      const tf = new Map();
      for (const t of terms(text)) tf.set(t, (tf.get(t) || 0) + 1);
      const vec = new Map();
      for (const [t, count] of tf) {
        // Unknown terms get the idf of a term seen once: a rare word the corpus
        // has never seen should still count for something if it appears at all.
        const w = (1 + Math.log(count)) * idf(t);
        if (w > 0) vec.set(t, w);
      }
      return normalise(vec);
    },
  };
}

export function cosine(a, b) {
  // Walk the smaller vector; both are already L2-normalised.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) dot += w * o;
  }
  return dot;
}

/** Which terms actually drove a match — used to explain a result. */
export function overlap(a, b, limit = 6) {
  const out = [];
  for (const [t, w] of a) {
    const o = b.get(t);
    if (o) out.push([t, w * o]);
  }
  return out
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([t]) => t);
}

// --- memoised index builds --------------------------------------------------
//
// The corpus only changes when someone writes, but every search, find and graph
// request rebuilt the whole TF-IDF space from scratch — linear in corpus size,
// on the request path. Measured: 8.8s for one wiki_find over 4,000 pages.
//
// The stamp is derived from pages the caller has already loaded, so validating
// the cache costs no extra I/O. `docsFn` is a thunk because building the document
// strings is itself linear, and there is no reason to pay it on a hit.

const indexMemo = new Map();
const INDEX_MEMO_MAX = 4;

/**
 * A cheap fingerprint of a page set. FNV-1a over slug/size/updated, so it is one
 * pass with no large intermediate string — the point is to stay usable on a
 * corpus far bigger than the one that motivated it.
 *
 * `salt` separates callers that vectorise the same pages differently: the graph
 * strips wikilinks before vectorising, find repeats title and tags for weight.
 */
export function corpusStamp(pages, salt = '') {
  let h = 0x811c9dc5;
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(salt);
  for (const p of pages) mix(`${p.slug}|${p.bytes}|${p.updated};`);
  return `${salt}:${pages.length}:${(h >>> 0).toString(36)}`;
}

export function buildIndexCached(stamp, docsFn) {
  if (stamp && indexMemo.has(stamp)) return indexMemo.get(stamp);
  const index = buildIndex(docsFn());
  if (stamp) {
    // Insertion-ordered, so the first key is the least recently added.
    if (indexMemo.size >= INDEX_MEMO_MAX) indexMemo.delete(indexMemo.keys().next().value);
    indexMemo.set(stamp, index);
  }
  return index;
}

export const clearIndexMemo = () => indexMemo.clear();
