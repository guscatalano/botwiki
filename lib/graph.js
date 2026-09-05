// Builds the weighted association graph over the wiki.
//
// Three kinds of evidence that two pages are related:
//   link     — explicit [[wikilinks]], counted; mutual links count for more,
//              and links from pages that link everything count for less.
//   tag      — shared tags, weighted by how rare the tag is. Sharing `postgres`
//              means far more than both carrying `proxmox`.
//   similar  — TF-IDF cosine over page bodies. Finds ties nobody wrote down.
//
// Each pair gets ONE edge carrying all three, combined with noisy-OR into a
// `strength` in 0..1. `type` names whichever kind dominates, for colouring.
// Without weights every edge of a given kind looked identical, which made the
// graph a uniform mesh telling you nothing about what is actually central.

import * as wiki from './wiki.js';
import { buildIndexCached, corpusStamp, cosine } from './vectors.js';
import { loadTypes, stalenessOf } from './types.js';
import { openCounts } from './talk.js';

const groupOf = (slug) => (slug.includes('/') ? slug.split('/')[0] : 'root');

function summarise(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('---') || t.startsWith('>')) continue;
    return t.replace(/[*_`]/g, '').replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, '$3$1').slice(0, 180);
  }
  return '';
}
const pairKey = (a, b) => (a < b ? `${a}::${b}` : `${b}::${a}`);

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Combine independent evidence without letting it exceed certainty — noisy-OR.
 * Two weak signals together are more than either alone, but never a third one.
 */
const noisyOr = (...parts) => 1 - parts.reduce((acc, p) => acc * (1 - clamp01(p)), 1);

// Corpora at or below this get exact all-pairs similarity. It is n², but at a few
// hundred pages that is milliseconds, and being exact keeps small wikis — and the
// test suite — behaving as they always did.
const EXACT_SIMILARITY_MAX = 500;

// How many of a page's rarest terms are used to propose candidates. This is the
// knob that keeps candidate generation from growing with the corpus.
const PROBE_TERMS = 30;

/**
 * Similarity edges via the inverted index, for corpora too large to compare
 * pairwise. For each page: take its indexed terms, ask which other pages share
 * the distinctive ones, and score only those.
 *
 * The vectors are truncated to the terms the index kept, so scores are close to
 * but not identical with the exact path. That is the trade being made — an
 * approximate edge list that exists beats an exact one that never finishes.
 *
 * Returns [slugA, slugB, score] triples, or null if the index cannot serve it.
 */
async function similarByIndex(pages, { minSimilarity, maxSimilarPerNode }) {
  const inv = await wiki.indexInverted();
  if (!inv) return null;
  const { vectors: vecs, byTerm, docs } = inv;
  const slugs = pages.map((p) => p.slug);
  const N = docs || pages.length;

  // The index is a cache and can name pages this graph does not have: one that
  // was deleted since the last reindex, or one quarantined — readPage hides
  // those, so they are absent from `pages` and still present in the postings.
  //
  // An edge to a slug that is not a node is not a cosmetic problem. It is fatal
  // to the renderer: 3d-force-graph throws "node not found" while initialising
  // its link force and the whole view dies. It survived this long because the
  // node budget filtered dangling edges out as a side effect of trimming, so
  // every view except the unlimited one was accidentally safe — which is
  // precisely why "all" broke and 1200 did not.
  const present = new Set(slugs);

  // df comes straight from the postings lists — no second query.
  const idf = (t) => Math.log(1 + N / ((byTerm.get(t)?.length || 0) + 1));

  // Terms held by a large share of the corpus match nearly everything and
  // separate nothing, so they are never used to propose a candidate. They still
  // count when scoring, where idf already discounts them.
  const maxDf = Math.max(2, Math.floor(N * 0.15));

  // Weight and normalise once per page, then reuse for every comparison.
  const weighted = new Map();
  for (const [slug, tfs] of vecs) {
    const v = new Map();
    let norm = 0;
    for (const [t, tf] of tfs) {
      const w = (1 + Math.log(tf)) * idf(t);
      if (w > 0) {
        v.set(t, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    weighted.set(slug, v);
  }

  const dot = (a, b) => {
    // Walk the shorter vector; the cost is min(|a|,|b|), not |corpus|.
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let s = 0;
    for (const [t, w] of small) {
      const o = big.get(t);
      if (o) s += w * o;
    }
    return s;
  };

  // Only a handful of edges per node survive, so scoring hundreds of candidates
  // to keep three is where the time went once candidate generation was bounded.
  // Shared-rare-term count is a good enough proxy to pre-rank on, and cosine only
  // has to separate the top of that list.
  const CANDIDATE_LIMIT = Math.max(20, maxSimilarPerNode * 12);
  const out = [];
  const overlap = new Map();

  for (const slug of slugs) {
    const mine = weighted.get(slug);
    if (!mine || !mine.size) continue;

    // Candidates come from the page's RAREST terms only.
    //
    // Walking every term's postings sounds thorough and is quadratic: as the
    // corpus grows so does each posting list, so the work per page grows with it.
    // Probing the rarest terms instead bounds the work by construction — a rare
    // term has a short list by definition — and loses almost nothing, because a
    // rare shared term is exactly the strong evidence of similarity. Common
    // terms still count when scoring, where idf has already discounted them.
    overlap.clear();
    const probes = [...mine.keys()]
      .map((t) => [t, byTerm.get(t)?.length || 0])
      .filter(([, df]) => df > 1 && df <= maxDf)
      .sort((a, b) => a[1] - b[1])
      .slice(0, PROBE_TERMS);

    for (const [term] of probes) {
      for (const other of byTerm.get(term)) {
        if (other === slug || !present.has(other)) continue;
        overlap.set(other, (overlap.get(other) || 0) + 1);
      }
    }
    if (!overlap.size) continue;

    let candidates = [...overlap.entries()];
    if (candidates.length > CANDIDATE_LIMIT) {
      candidates.sort((a, b) => b[1] - a[1]);
      candidates = candidates.slice(0, CANDIDATE_LIMIT);
    }

    const scored = [];
    for (const [other] of candidates) {
      const theirs = weighted.get(other);
      if (!theirs) continue;
      const s = dot(mine, theirs);
      if (s >= minSimilarity) scored.push([other, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    for (const [other, s] of scored.slice(0, maxSimilarPerNode)) out.push([slug, other, s]);
  }
  return out;
}

// One built graph, kept until the corpus changes.
//
// relatedTo() calls buildGraph() to find one page's neighbours, and the page
// view calls relatedTo(), so every single page read was opening all 217 files
// and computing all-pairs similarity to answer a question about one node. That
// was the second of the two reasons a page took seconds to serve.
//
// Keyed on the corpus stamp rather than a local counter: the web server and the
// MCP server are separate processes over one directory, so a write through one
// must invalidate the other's copy. The stamp is derived from what is stored —
// slug, size and updated date — so it changes for both.
//
// Only the newest is kept. Once the corpus moves, an older stamp can never be
// asked for again, and a graph is large enough that holding several would be a
// real cost.
let graphMemo = { key: null, graph: null };
let rebuilding = null;

export async function buildGraph({
  // Accept the last built graph rather than waiting for one that matches the
  // corpus, and let the rebuild happen behind the request.
  //
  // Off by default, deliberately. A function that quietly hands back stale data
  // unless you knew to ask is a trap, and the existing tests caught exactly that
  // when this was the other way round. The one caller that wants it is
  // relatedTo(), which every page view calls: building the graph is seconds of
  // work at a real corpus size and any write invalidates it, so a blocking
  // rebuild makes nearly every page view during a burst of writing pay for it —
  // measured at ~3s against ~180ms warm. A "related pages" list one edit out of
  // date costs nothing like that, and this wiki's rule is that derived data is
  // advisory and never blocking.
  allowStale = false,
  // Null means "scale it to the corpus" — see the taper below. A number
  // overrides, so the graph page and the tests can still pin it.
  minSimilarity = null,
  maxSimilarPerNode = null,
  includeSimilar = true,
  includeTags = true,
  minStrength = 0.04,
  // Corpora this size or smaller get exact all-pairs similarity. Exposed so an
  // operator can force exact on a larger wiki, and so the approximation can be
  // measured against the exact answer on the same corpus.
  exactSimilarityMax = EXACT_SIMILARITY_MAX,
  // Tags with more members than this contribute no pairwise evidence.
  maxTagFanout = 150,
} = {}) {
  const rows = await wiki.listPages({});

  // Similarity is worth least exactly where there is most of it.
  //
  // A TF-IDF edge says "these two read alike". On a few hundred varied pages
  // that is a real finding and often the only thing tying two folders together.
  // On a corpus where a thousand pages are the same subject in the same voice,
  // everything reads alike, and the edges stop distinguishing anything while
  // still being drawn. Measured on this wiki: similarity was 5% of the edges
  // among the 300 best-connected pages and 49% across all 1,384, which is the
  // whole difference between a graph with structure and a hairball.
  //
  // So the allowance tapers as the corpus grows. Explicit links and shared tags
  // do not taper — those are things somebody actually did, and they stay true
  // at any size.
  const corpus = rows.length;
  const simPerNode =
    maxSimilarPerNode ?? (corpus <= 500 ? 3 : corpus <= 1500 ? 2 : 1);
  const simFloor =
    minSimilarity ?? (corpus <= 500 ? 0.08 : corpus <= 1500 ? 0.14 : 0.2);

  const memoKey = `${corpusStamp(rows, 'graph')}|${simFloor}|${simPerNode}|${includeSimilar}|${includeTags}|${minStrength}|${exactSimilarityMax}|${maxTagFanout}`;
  if (graphMemo.key === memoKey && graphMemo.graph) return graphMemo.graph;

  const opts = { minSimilarity: simFloor, maxSimilarPerNode: simPerNode, includeSimilar, includeTags, minStrength, exactSimilarityMax, maxTagFanout };

  // Stale copy on hand and the caller can live with it: hand it over and bring
  // the graph up to date behind them. One rebuild at a time — a burst of writes
  // must not start a rebuild per request, which would be slower than never
  // caching at all.
  if (allowStale && graphMemo.graph) {
    if (!rebuilding) {
      rebuilding = buildGraph(opts)
        .catch(() => null)
        .finally(() => {
          rebuilding = null;
        });
    }
    return graphMemo.graph;
  }

  const slugs = await wiki.listSlugs();
  const pages = [];
  for (const slug of slugs) {
    const p = await wiki.readPage(slug);
    if (p) pages.push(p);
  }

  const index = new Map(pages.map((p, i) => [p.slug, i]));
  const N = pages.length;

  // Evidence is accumulated per pair first, then scored once. A pair that is
  // linked AND shares tags AND reads similarly is genuinely stronger than one
  // with a single kind of tie — the old "keep the strongest type" rule threw
  // that away.
  const pairs = new Map();
  const ev = (a, b) => {
    const key = pairKey(a, b);
    if (!pairs.has(key)) {
      pairs.set(key, {
        a: a < b ? a : b, b: a < b ? b : a,
        mentions: 0, fromA: 0, fromB: 0, mutual: false, tags: [], sim: 0,
      });
    }
    return pairs.get(key);
  };

  // Every page is already loaded, so link targets can be resolved against this
  // rather than re-walking the tree for each one.
  const knownSlugs = new Set(pages.map((p) => p.slug));

  // 1. explicit links, counted rather than merely noted
  const broken = [];
  const outLinks = new Map();
  const directed = new Set();
  for (const p of pages) {
    let out = 0;
    for (const l of await wiki.linksIn(p.body, { known: knownSlugs })) {
      if (!l.exists) {
        broken.push({ from: p.slug, to: l.slug });
        continue;
      }
      if (l.slug === p.slug || !index.has(l.slug)) continue;
      out++;
      directed.add(`${p.slug}>${l.slug}`);
      const rec = ev(p.slug, l.slug);
      rec.mentions++;
      if (rec.a === p.slug) rec.fromA++;
      else rec.fromB++;
    }
    outLinks.set(p.slug, out);
  }
  for (const e of pairs.values()) {
    e.mutual = directed.has(`${e.a}>${e.b}`) && directed.has(`${e.b}>${e.a}`);
  }

  // 2. shared tags, weighted by how rare the tag is
  const tagIdf = new Map();
  if (includeTags) {
    const byTag = new Map();
    for (const p of pages) {
      for (const t of p.tags) {
        const key = t.toLowerCase();
        if (!byTag.has(key)) byTag.set(key, []);
        byTag.get(key).push(p.slug);
      }
    }
    for (const [tag, members] of byTag) {
      if (members.length < 2) continue;
      // A tag on nearly every page carries almost no information about any
      // particular pair; one shared by two pages is a strong statement.
      const idf = Math.log(N / members.length) / Math.log(Math.max(2, N));
      tagIdf.set(tag, idf);
      if (idf <= 0.02) continue;
      // A tag held by hundreds of pages is a category, not a relationship, and
      // pairing its members is where the graph actually went quadratic: every
      // tag costs members² pairs, so one tag on 200 pages is 20,000 of them. The
      // idf guard above says the same thing about information but never fires,
      // because a tag can be far too broad to pair on while still looking rare
      // against a large corpus.
      if (members.length > maxTagFanout) continue;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          ev(members[i], members[j]).tags.push({ tag, idf });
        }
      }
    }
  }

  // 3. content similarity
  if (includeSimilar && N > 1) {
    // Strip [[wikilinks]] before vectorising. A link is already counted as link
    // evidence; letting its target text also drive the similarity score counts
    // the same signal twice, and makes any index page look "similar" to
    // everything it lists.
    // Below the threshold, compare every pair — it is exact, and at these sizes
    // the n² is a few milliseconds. Above it, n² stops being payable (72s at
    // 4,000 pages) and candidates come from the inverted index instead: only
    // pages sharing a distinctive term can score above zero anyway.
    const approx = N > exactSimilarityMax ? await similarByIndex(pages, { minSimilarity: simFloor, maxSimilarPerNode: simPerNode }) : null;

    if (approx) {
      for (const [a, b, s] of approx) {
        const e = ev(a, b);
        e.sim = Math.max(e.sim, s);
      }
    } else {
      const vecs = buildIndexCached(corpusStamp(pages, 'graph'), () =>
        pages.map(
          (p) => `${p.title} ${p.tags.join(' ')} ${p.body.replace(/\[\[[^\]]*\]\]/g, ' ')}`
        )
      ).vectors;
      for (let i = 0; i < N; i++) {
        const scored = [];
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const s = cosine(vecs[i], vecs[j]);
          if (s >= simFloor) scored.push([j, s]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        for (const [j, s] of scored.slice(0, simPerNode)) {
          const e = ev(pages[i].slug, pages[j].slug);
          e.sim = Math.max(e.sim, s);
        }
      }
    }
  }

  // --- score every pair on one comparable scale ---
  let edges = [];
  // Saturating curve rather than a hard cap. A linear scale with a ceiling puts
  // half the graph at exactly 1.0, which is how you end up back at "everything
  // looks the same" — this keeps spreading them apart forever.
  const sat = (x, k) => (x <= 0 ? 0 : x / (x + k));

  for (const e of pairs.values()) {
    // A link is damped by how many links its SOURCE page emits: one of `home`'s
    // twenty links says much less than one of three. Damping per direction
    // matters — taking the max across the pair meant one non-hub endpoint
    // cancelled the damping entirely.
    const hub = (slug) => clamp01(6 / Math.max(6, outLinks.get(slug) || 0));
    const linkRaw =
      (e.fromA * hub(e.a) + e.fromB * hub(e.b)) * (e.mutual ? 1.7 : 1);

    const linkScore = sat(linkRaw, 2);
    const tagScore = sat(e.tags.reduce((s, t) => s + t.idf, 0), 0.7);
    const simScore = sat(e.sim, 0.25);

    // Links are directed even though tags and similarity are not. A runbook that
    // cites a host three times depends on it; the host mentioning the runbook
    // once does not depend on the runbook. Keep one edge per pair, but carry the
    // asymmetry so "what breaks if I change this" is answerable.
    const dirA = sat(e.fromA * hub(e.a) * (e.mutual ? 1.7 : 1), 2); // a -> b
    const dirB = sat(e.fromB * hub(e.b) * (e.mutual ? 1.7 : 1), 2); // b -> a
    const direction =
      !e.mentions ? 'none' : e.mutual ? 'mutual' : e.fromA ? 'a->b' : 'b->a';

    const strength = noisyOr(linkScore, tagScore, simScore);
    if (strength < minStrength) continue;

    // `type` and `strength` are orthogonal on purpose. Type names the most
    // TRUSTWORTHY evidence present — a human writing [[x]] outranks a computed
    // guess however high the cosine — while strength says how much evidence
    // there is in total. A weak explicit link is still an explicit link.
    const type = e.mentions ? 'link' : e.tags.length ? 'tag' : 'similar';

    edges.push({
      source: e.a,
      target: e.b,
      type,
      strength: Number(strength.toFixed(3)),
      direction,
      // Directed link strength: how much A points at B, and B at A.
      strengthAB: Number(dirA.toFixed(3)),
      strengthBA: Number(dirB.toFixed(3)),
      evidence: {
        mentions: e.mentions,
        mutual: e.mutual,
        fromSource: e.fromA,
        fromTarget: e.fromB,
        sharedTags: e.tags.map((t) => t.tag),
        similarity: e.sim ? Number(e.sim.toFixed(3)) : 0,
      },
      scores: {
        link: Number(linkScore.toFixed(3)),
        tag: Number(tagScore.toFixed(3)),
        similar: Number(simScore.toFixed(3)),
      },
    });
  }
  edges.sort((a, b) => b.strength - a.strength);

  // Two degrees: how many things a page touches, and how strongly. Node size
  // uses the weighted one so a page tied loosely to ten others does not outrank
  // one that is genuinely central.
  const degree = new Map();
  const wdegree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
    wdegree.set(e.source, (wdegree.get(e.source) || 0) + e.strength);
    wdegree.set(e.target, (wdegree.get(e.target) || 0) + e.strength);
  }

  // A graph that cannot show which pages are stale or contested is decorative.
  // Both are cheap to attach here and let the view render state, not just shape.
  const registry = await loadTypes();
  const comments = await openCounts();

  const nodes = pages.map((p) => ({
    id: p.slug,
    title: p.title,
    tags: p.tags,
    group: groupOf(p.slug),
    bytes: p.bytes,
    updated: p.updated,
    degree: degree.get(p.slug) || 0,
    weightedDegree: Number((wdegree.get(p.slug) || 0).toFixed(2)),
    summary: p.meta.summary || summarise(p.body),
    provenance: p.provenance,
    type: p.type || null,
    staleness: stalenessOf(p, registry),
    openComments: comments.get(p.slug) || 0,
  }));

  // Last line of defence, and cheap. Every renderer here assumes an edge names
  // two nodes it can find, and one that does not takes the whole view down
  // rather than drawing badly — so this is enforced where the graph is made
  // instead of hoping each consumer filters. Anything dropped is reported, so a
  // silent leak upstream cannot hide behind the guard that catches it.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const dangling = edges.filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  if (dangling.length) {
    console.warn(
      `[graph] dropped ${dangling.length} edge(s) naming a page that is not in the graph:`,
      [...new Set(dangling.flatMap((e) => [e.source, e.target].filter((s) => !nodeIds.has(s))))]
        .slice(0, 5)
        .join(', ')
    );
    edges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  }

  const built = {
    nodes,
    edges,
    broken,
    groups: [...new Set(nodes.map((n) => n.group))].sort(),
    stats: {
      pages: nodes.length,
      edges: edges.length,
      links: edges.filter((e) => e.type === 'link').length,
      tagEdges: edges.filter((e) => e.type === 'tag').length,
      similarEdges: edges.filter((e) => e.type === 'similar').length,
      orphans: nodes.filter((n) => n.degree === 0).length,
      strong: edges.filter((e) => e.strength >= 0.6).length,
      weak: edges.filter((e) => e.strength < 0.25).length,
      meanStrength: edges.length
        ? Number((edges.reduce((s, e) => s + e.strength, 0) / edges.length).toFixed(3))
        : 0,
    },
  };

  graphMemo = { key: memoKey, graph: built };
  return built;
}

/**
 * The busiest `limit` nodes, and only the edges between them.
 *
 * Trimming happens here rather than inside buildGraph so the memo stays a whole
 * graph: one build serves every budget, and raising the limit costs a filter
 * rather than a rebuild.
 *
 * Ranked by degree because that is what makes a graph legible — hubs and the
 * clusters around them. The cost is that it hides the periphery, and the
 * periphery is where orphans live, so the result says what it left out and how
 * many of those were unconnected. A view that silently drops four fifths of a
 * wiki is worse than a slow one.
 */
export function trimGraph(g, limit) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0 || g.nodes.length <= max) {
    return { ...g, shown: g.nodes.length, omitted: 0, omittedOrphans: 0, limit: null };
  }

  const degree = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  const ranked = [...g.nodes].sort(
    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.id.localeCompare(b.id)
  );
  const keep = new Set(ranked.slice(0, max).map((n) => n.id));
  const dropped = ranked.slice(max);

  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target));

  return {
    ...g,
    nodes,
    edges,
    groups: [...new Set(nodes.map((n) => n.group))].sort(),
    shown: nodes.length,
    omitted: dropped.length,
    omittedOrphans: dropped.filter((n) => !degree.get(n.id)).length,
    limit: max,
    // The full corpus figures stay, so a caller can tell how much it is seeing.
    stats: { ...g.stats, shownNodes: nodes.length, shownEdges: edges.length },
  };
}

/** Drop the built graph. For tests, and for anything that changes the corpus
 *  without going through a write — the stamp catches ordinary edits by itself. */
export const clearGraphMemo = () => {
  graphMemo = { key: null, graph: null };
};

/**
 * What is this page related to, and why. Powers the MCP `wiki_related` tool and
 * the "Related" block on a page.
 */
export async function relatedTo(slug, { limit = 8 } = {}) {
  const clean = wiki.slugify(slug);
  const g = await buildGraph({ allowStale: true });
  if (!g.nodes.some((n) => n.id === clean)) return null;

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = [];
  for (const e of g.edges) {
    const other = e.source === clean ? e.target : e.target === clean ? e.source : null;
    if (!other) continue;
    const n = byId.get(other);
    if (n) {
      // Re-express direction from the caller's point of view rather than from
      // the edge's arbitrary a/b ordering.
      const iAmSource = e.source === clean;
      const dir =
        e.direction === 'mutual' || e.direction === 'none'
          ? e.direction
          : (e.direction === 'a->b') === iAmSource
            ? 'out'
            : 'in';
      out.push({
        slug: other,
        title: n.title,
        type: e.type,
        strength: e.strength,
        direction: dir,
        outStrength: iAmSource ? e.strengthAB : e.strengthBA,
        inStrength: iAmSource ? e.strengthBA : e.strengthAB,
        evidence: e.evidence,
      });
    }
  }

  // Strength first — an inferred but strong tie beats a token explicit link.
  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, limit);
}
