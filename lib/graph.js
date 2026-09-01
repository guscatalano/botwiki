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
import { buildIndex, cosine } from './vectors.js';
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

export async function buildGraph({
  minSimilarity = 0.08,
  maxSimilarPerNode = 3,
  includeSimilar = true,
  includeTags = true,
  minStrength = 0.04,
} = {}) {
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

  // 1. explicit links, counted rather than merely noted
  const broken = [];
  const outLinks = new Map();
  const directed = new Set();
  for (const p of pages) {
    let out = 0;
    for (const l of await wiki.linksIn(p.body)) {
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
    const vecs = buildIndex(
      pages.map(
        (p) => `${p.title} ${p.tags.join(' ')} ${p.body.replace(/\[\[[^\]]*\]\]/g, ' ')}`
      )
    ).vectors;
    for (let i = 0; i < N; i++) {
      const scored = [];
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const s = cosine(vecs[i], vecs[j]);
        if (s >= minSimilarity) scored.push([j, s]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      for (const [j, s] of scored.slice(0, maxSimilarPerNode)) {
        const e = ev(pages[i].slug, pages[j].slug);
        e.sim = Math.max(e.sim, s);
      }
    }
  }

  // --- score every pair on one comparable scale ---
  const edges = [];
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

  return {
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
}

/**
 * What is this page related to, and why. Powers the MCP `wiki_related` tool and
 * the "Related" block on a page.
 */
export async function relatedTo(slug, { limit = 8 } = {}) {
  const clean = wiki.slugify(slug);
  const g = await buildGraph();
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
