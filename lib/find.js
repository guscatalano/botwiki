// find(): give it a vague description of what you are after and it returns a
// short list of pages that are probably relevant.
//
// wiki.search() is lexical — it wants the words that are actually on the page.
// That is the right tool when you know the term. It is the wrong tool when an
// agent has a situation rather than a keyword ("the backup job that writes to
// the NAS keeps failing"), because the words that matter are buried in a
// sentence full of words that do not.
//
// This projects the whole description into the same TF-IDF space the graph uses,
// which means common words fall away on their own and rare ones dominate. Then
// it blends in the lexical score, so an exact term still wins when there is one.

import * as wiki from './wiki.js';
import { buildIndexCached, corpusStamp, cosine, overlap, terms } from './vectors.js';
import { loadTypes, stalenessOf } from './types.js';

const stripLinks = (s) => s.replace(/\[\[[^\]]*\]\]/g, ' ');

/**
 * @param {string} context  free text: a question, a symptom, a task
 */
// Corpus size at which find switches from the in-memory vectors to the index.
// Set where the memo starts being a memory liability rather than where the two
// paths cross on speed — they never cross on speed.
const INDEX_FIND_MIN = 25000;

/**
 * find() over the index: no page is opened at all.
 *
 * Everything a result needs — title, type, tags, summary, freshness — is a
 * column, and the semantic side works from the stored term vectors rather than
 * re-reading and re-vectorising the corpus on every call. Returns null when the
 * index cannot answer, and the caller falls back to reading the files.
 */
async function findByIndex(query, { limit, type, tag, minScore }) {
  await wiki.ensureIndex();
  const qTerms = [...new Set(terms(query))];
  if (!qTerms.length) return null;

  // Targeted: postings for the query's terms only, never the whole table. The
  // earlier version pulled every posting in the corpus on each call, which made
  // find slower than the full scan it was replacing and put a hard memory
  // ceiling on how large a wiki could be. Scoring needs the terms a page shares
  // with the query plus that page's stored vector length — nothing else.
  const got = await wiki.indexScoringRows(qTerms, { type, tag });
  if (!got) return null;
  const { docs: N, df, rows } = got;
  const idf = (t) => Math.log(1 + N / ((df.get(t) || 0) + 1));
  const known = qTerms.filter((t) => (df.get(t) || 0) > 0);

  // Query vector, projected into the same space the pages were stored in.
  const qv = new Map();
  {
    const tf = new Map();
    for (const t of terms(query)) tf.set(t, (tf.get(t) || 0) + 1);
    let norm = 0;
    for (const [t, n] of tf) {
      const w = (1 + Math.log(n)) * idf(t);
      if (w > 0) {
        qv.set(t, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of qv) qv.set(t, w / norm);
  }

  // The lexical half still runs, and is itself index-narrowed now.
  const lexical = new Map();
  for (const hit of await wiki.search(query, { limit: 50, tag })) lexical.set(hit.slug, hit.score);
  const maxLex = Math.max(1, ...lexical.values());

  if (!rows.length && !lexical.size) {
    return {
      via: 'index',
      query,
      considered: N,
      understood: known,
      unknown: qTerms.filter((t) => !(df.get(t) > 0)),
      results: [],
    };
  }

  const types = await loadTypes();
  const scored = [];
  for (const r of rows) {
    // Only shared terms contribute to the dot product; the rest of the page's
    // vector is already accounted for by its stored norm.
    let sem = 0;
    const matched = [];
    for (const [t, w] of qv) {
      const tf = r.shared.get(t);
      if (!tf) continue;
      sem += w * (((1 + Math.log(tf)) * idf(t)) / (r.norm || 1));
      matched.push(t);
    }
    const lex = (lexical.get(r.slug) || 0) / maxLex;
    const score = 0.68 * sem + 0.32 * lex;
    scored.push({
      slug: r.slug,
      title: r.title,
      type: r.type || null,
      tags: r.tags,
      summary: r.summary || '',
      score: Number(score.toFixed(4)),
      semantic: Number(sem.toFixed(4)),
      lexical: Number(lex.toFixed(4)),
      matched: matched.slice(0, 6),
      staleness: stalenessOf(
        {
          updated: r.updated,
          meta: {
            type: r.type,
            ttl: r.ttl,
            updated_at: r.updated,
            verified_at: r.verified_at,
            verified_by: r.verified_by,
            verified_note: r.verified_note,
          },
        },
        types
      ),
    });
  }

  return {
    via: 'index',
    query,
    considered: N,
    understood: known,
    unknown: qTerms.filter((t) => !(df.get(t) > 0)),
    results: scored
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit)),
  };
}

export async function find(context, { limit = 5, type, tag, minScore = 0.02, scanAll = false, forceIndex = false } = {}) {
  const query = String(context || '').trim();
  if (!query) return { query, results: [], considered: 0 };

  // Which path is faster depends on whether the corpus fits in memory, and it is
  // not close in either direction. Below the threshold the in-memory TF-IDF memo
  // wins decisively — measured at 5,000 pages, 646ms against 1,089ms — because
  // nothing beats pre-normalised vectors already in the heap.
  //
  // Above it, that memo is the problem rather than the solution: it holds the
  // whole corpus, so it stops being possible long before the SQL does. The index
  // path is slower per query and has no ceiling, which is the right trade only
  // once the ceiling is in sight.
  if (!scanAll && (forceIndex || (await wiki.countPages().catch(() => 0)) > INDEX_FIND_MIN)) {
    const viaIndex = await findByIndex(query, { limit, type, tag, minScore }).catch(() => null);
    if (viaIndex) return viaIndex;
  }

  const slugs = await wiki.listSlugs();
  const pages = [];
  for (const slug of slugs) {
    const p = await wiki.readPage(slug);
    if (!p) continue;
    if (type && String(p.meta?.type || '').toLowerCase() !== String(type).toLowerCase()) continue;
    if (tag && !p.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;
    pages.push(p);
  }
  if (!pages.length) return { query, results: [], considered: 0 };

  // Title and tags repeated so they weigh more than a passing mention in prose.
  const index = buildIndexCached(corpusStamp(pages, 'find'), () =>
    pages.map(
      (p) =>
        `${p.title} ${p.title} ${p.tags.join(' ')} ${p.tags.join(' ')} ${stripLinks(p.body)}`
    )
  );
  const qv = index.vectorise(query);

  // The lexical side, so an exact identifier still beats a vague vibe.
  const lexical = new Map();
  for (const hit of await wiki.search(query, { limit: 50 })) lexical.set(hit.slug, hit.score);
  const maxLex = Math.max(1, ...lexical.values());

  const types = await loadTypes();
  const scored = pages.map((p, i) => {
    const sem = cosine(qv, index.vectors[i]);
    const lex = (lexical.get(p.slug) || 0) / maxLex;
    // Semantic leads, lexical corroborates. Both in 0..1 before blending.
    const score = 0.68 * sem + 0.32 * lex;
    return {
      slug: p.slug,
      title: p.title,
      type: p.meta?.type || null,
      tags: p.tags,
      summary: p.meta?.summary || '',
      score: Number(score.toFixed(4)),
      semantic: Number(sem.toFixed(4)),
      lexical: Number(lex.toFixed(4)),
      matched: overlap(qv, index.vectors[i]),
      staleness: stalenessOf(p, types),
    };
  });

  const results = scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  return {
    via: 'scan',
    query,
    considered: pages.length,
    // Terms of the query that exist anywhere in the corpus — the rest were
    // either stopwords or words this wiki has never heard of, which is itself
    // worth telling the caller.
    understood: [...new Set(terms(query))].filter((t) => index.df.has(t)),
    unknown: [...new Set(terms(query))].filter((t) => !index.df.has(t)),
    results,
  };
}
