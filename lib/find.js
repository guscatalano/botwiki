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
import { buildIndex, cosine, overlap, terms } from './vectors.js';
import { loadTypes, stalenessOf } from './types.js';

const stripLinks = (s) => s.replace(/\[\[[^\]]*\]\]/g, ' ');

/**
 * @param {string} context  free text: a question, a symptom, a task
 */
export async function find(context, { limit = 5, type, tag, minScore = 0.02 } = {}) {
  const query = String(context || '').trim();
  if (!query) return { query, results: [], considered: 0 };

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
  const index = buildIndex(
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
