// Is this topic already covered, and where would a new page about it belong?
//
// Distinct from search and from find(). Both of those rank pages by relevance
// and hand the caller a list; the caller then has to decide what a score of
// 0.34 means, which is exactly the judgement someone arriving with no context
// does not have. This answers the question a writer actually has before
// writing: does this exist already, is there adjacent work I should be linking
// to or editing instead, and which namespace does that work live in.
//
// Calibrated against the real corpus rather than by intuition, and the
// measurement changed the design. The blended relevance score does NOT separate
// covered from absent on a corpus this size — "growing tomatoes in a greenhouse"
// scored 0.351 against a wiki containing nothing of the sort, while a genuinely
// covered topic scored 0.353. Thresholding on relevance would have produced a
// tool that confidently says "covered" about subjects the wiki has never heard
// of, which is worse than no tool.
//
// What does separate them is vocabulary. Measured over 16 topics:
//
//   class      top relevance    known vocabulary
//   covered    0.353 .. 0.431   0.80 .. 1.00
//   adjacent   0.324 .. 0.381   1.00
//   absent     0.000 .. 0.351   0.00 .. 0.40
//
// Relevance overlaps across all three classes. Vocabulary separates absent from
// the rest completely, with a wide gap either side of 0.6. So absence is decided
// on vocabulary, and only within known vocabulary does relevance get a say.
//
// Covered and adjacent do not cleanly separate on any signal available here
// (0.353..0.431 against 0.324..0.381 — they overlap), so this module does not
// pretend to tell them apart. It reports which side of the fuzzy line the top
// hit falls on, says the call is fuzzy, and returns the neighbours with their
// summaries so the caller can make the judgement with evidence instead of
// inheriting a threshold someone else guessed.

import * as wiki from './wiki.js';
import { find } from './find.js';

// Below this fraction of recognised content words, the corpus has no vocabulary
// for the subject and every relevance score is noise. Measured gap: absent
// topics reach 0.40, covered topics start at 0.80.
const VOCAB_KNOWN = 0.6;

// Within known vocabulary. Both are inside the overlap between the covered and
// adjacent samples, so they mark a gradient, not a boundary — which is why
// `confidence` is reported alongside and why the neighbours always come back.
const STRONG = 0.4;
const RELATED = 0.28;

const prefixOf = (slug) => (slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : '');

/**
 * @param {string} topic  What you are thinking of writing, in a sentence.
 * @returns {Promise<object>} verdict, nearest pages, namespace census, suggested prefix
 */
export async function coverage(topic, { limit = 6, tag, type } = {}) {
  const query = String(topic || '').trim();
  if (!query) {
    return {
      topic: '',
      verdict: 'unknown',
      confidence: 'none',
      reason: 'No topic given.',
      nearest: [],
      namespaces: [],
      unknownTerms: [],
    };
  }

  const res = await find(query, { limit: Math.max(limit, 8), tag, type, minScore: 0 });

  const known = res.understood?.length || 0;
  const unknown = res.unknown?.length || 0;
  const vocabulary = known + unknown ? known / (known + unknown) : 0;

  const nearest = (res.results || []).slice(0, limit).map((r) => ({
    slug: r.slug,
    title: r.title,
    summary: r.summary || '',
    relevance: r.score,
    tags: r.tags || [],
    staleness: r.staleness?.status || null,
  }));

  const top = nearest[0]?.relevance ?? 0;

  let verdict;
  let confidence;
  let reason;

  if (vocabulary < VOCAB_KNOWN) {
    verdict = 'open';
    confidence = 'high';
    reason = unknown
      ? `The wiki has never used ${unknown === 1 ? 'this word' : 'these words'}: ${(res.unknown || [])
          .slice(0, 8)
          .join(', ')}. Nothing here is about this subject.`
      : 'Nothing in the wiki uses the vocabulary of this topic.';
  } else if (top >= STRONG) {
    verdict = 'covered';
    // Honest about the measurement: this threshold sits inside the region where
    // the covered and adjacent samples overlapped.
    confidence = 'medium';
    reason =
      `A page on this already looks likely to exist. Read ${nearest[0].slug} before writing — ` +
      `if it is the same subject, edit it rather than adding a second page.`;
  } else if (top >= RELATED) {
    verdict = 'adjacent';
    confidence = 'medium';
    reason =
      'Related pages exist but none looks like the same subject. A new page is probably right; ' +
      'link it to the neighbours below and match their namespace.';
  } else {
    verdict = 'open';
    confidence = 'medium';
    reason =
      'The wiki knows the vocabulary but nothing addresses this directly. A new page looks warranted.';
  }

  // Where does work like this already live? The strongest signal for placing a
  // new page is the namespace its nearest neighbours cluster in, which is a
  // convention no schema records and every existing writer already followed.
  const weights = new Map();
  for (const r of res.results || []) {
    const pre = prefixOf(r.slug);
    if (!pre) continue;
    weights.set(pre, (weights.get(pre) || 0) + r.score);
  }

  const all = await wiki.listSlugs();
  const sizes = new Map();
  for (const s of all) {
    const pre = prefixOf(s);
    if (pre) sizes.set(pre, (sizes.get(pre) || 0) + 1);
  }

  const namespaces = [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([prefix, weight]) => ({
      prefix,
      pages: sizes.get(prefix) || 0,
      affinity: Number(weight.toFixed(3)),
      examples: (res.results || [])
        .filter((r) => prefixOf(r.slug) === prefix)
        .slice(0, 3)
        .map((r) => r.slug),
    }));

  return {
    topic: query,
    verdict,
    confidence,
    reason,
    vocabulary: Number(vocabulary.toFixed(2)),
    unknownTerms: (res.unknown || []).slice(0, 12),
    topRelevance: Number(top.toFixed(3)),
    considered: res.considered ?? 0,
    nearest,
    namespaces,
    suggestedPrefix: verdict === 'open' && !namespaces.length ? null : namespaces[0]?.prefix || null,
  };
}

/** Every namespace in the wiki with its size — the map an arriving writer lacks. */
export async function namespaces() {
  const all = await wiki.listSlugs();
  const counts = new Map();
  for (const s of all) {
    const pre = prefixOf(s) || '(root)';
    counts.set(pre, (counts.get(pre) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, pages]) => ({ prefix, pages }));
}
