// TF-IDF vectors over page text. Shared by the graph (page-to-page similarity)
// and by find() (free-text-to-page similarity), so both agree about what makes
// two pieces of text alike.

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
  return (
    String(text)
      .toLowerCase()
      // Drop fenced code — shell transcripts otherwise dominate every vector.
      .replace(/```[\s\S]*?```/g, ' ')
      .match(/[a-z][a-z0-9._-]{2,}/g) || []
  ).filter((t) => !STOP.has(t) && !/^\d+$/.test(t));
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
