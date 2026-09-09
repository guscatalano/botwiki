// Porter stemming, so that `flaps`, `flapping` and `flapped` are one term.
//
// Everything retrieval-shaped in this wiki runs through vectors.terms(): search
// candidate selection, the TF-IDF space find() projects into, the graph's
// similarity edges, the live feed's query anonymiser. All of them currently
// treat a word and its own plural as unrelated, which is why "the trunk keeps
// flapping" does not find a page that says "the trunk flaps".
//
// Written out rather than depended on. It is a 1980 algorithm that has not
// changed and never will, the whole thing is below, and this project's rule is
// to think hard before adding a package. A dependency that can break a deploy is
// a poor trade for 150 lines that cannot.
//
// The important part for THIS corpus is not the algorithm, it is skipWord()
// below: half of what makes this wiki worth searching is identifiers, and an
// identifier that gets stemmed stops matching itself.

const C = '[^aeiou]';
const V = '[aeiouy]';
const CS = `(?:${C}(?!y))`; // a consonant, where y is treated as a vowel after one
const VS = `(?:${V})`;

// m > 0, m > 1: Porter's "measure", the count of vowel-consonant sequences.
const MGR0 = new RegExp(`^${CS}*${VS}+${CS}`);
const MGR1 = new RegExp(`^${CS}*(?:${VS}+${CS}){2}`);
const MEQ1 = new RegExp(`^${CS}*${VS}+${CS}(?!${VS})`);
const HAS_VOWEL = /[aeiouy]/;

const measureGreater = (stem, n) => (n === 0 ? MGR0.test(stem) : MGR1.test(stem));

/**
 * Words this stemmer must not touch.
 *
 * An identifier is not English and stemming one silently breaks the thing it
 * names. `igc0` and `vmbr0` are safe by accident — they contain digits — but
 * the ones that are pure letters are not, and this wiki is full of them:
 * hostnames, error codes, commands, config keys. So the rule is conservative in
 * the direction that costs least: a token only gets stemmed if it looks like an
 * ordinary English word, and anything else is left exactly as written.
 *
 * The cost of skipping a real word is that it fails to match its own plural,
 * which is where we already are. The cost of stemming an identifier is that it
 * stops matching itself, which is worse than where we already are.
 */
function skipWord(w) {
  return (
    w.length < 4 || // too short to have a suffix worth removing
    /[^a-z]/.test(w) || // digits, dots, dashes, underscores: not a word
    !HAS_VOWEL.test(w) // an acronym like `dhcp` or `ssh`
  );
}

/** Porter step 1a: plurals. */
function step1a(w) {
  if (/sses$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return w.slice(0, -2);
  if (/ss$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Porter step 1b: past tense and gerunds. */
function step1b(w) {
  if (/eed$/.test(w)) {
    const stem = w.slice(0, -3);
    return measureGreater(stem, 0) ? w.slice(0, -1) : w;
  }
  let m = /^(.+?)(ed|ing)$/.exec(w);
  if (!m || !HAS_VOWEL.test(m[1])) return w;
  const stem = m[1];
  if (/(at|bl|iz)$/.test(stem)) return `${stem}e`;
  // A doubled final consonant came from the suffix, not the word: hopping ->
  // hop, not hopp. Except l, s and z, which double legitimately.
  if (/([^aeiouylsz])\1$/.test(stem)) return stem.slice(0, -1);
  if (MEQ1.test(stem)) return `${stem}e`;
  return stem;
}

/** Porter step 1c: terminal y to i, when there is a vowel before it. */
function step1c(w) {
  const m = /^(.*[aeiouy].*)y$/.exec(w);
  return m ? `${m[1]}i` : w;
}

const STEP2 = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
  ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
  ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
  ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

const STEP3 = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
  ['ical', 'ic'], ['ful', ''], ['ness', ''],
];

const STEP4 = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment',
  'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
];

function suffixStep(w, table) {
  for (const [suffix, replacement] of table) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      return measureGreater(stem, 0) ? stem + replacement : w;
    }
  }
  return w;
}

function step4(w) {
  // `ion` only comes off after s or t, or "nation" becomes "nat".
  const ion = /^(.+?)(s|t)ion$/.exec(w);
  if (ion && measureGreater(ion[1] + ion[2], 1)) return ion[1] + ion[2];
  for (const suffix of STEP4) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      return measureGreater(stem, 1) ? stem : w;
    }
  }
  return w;
}

function step5(w) {
  let out = w;
  if (out.endsWith('e')) {
    const stem = out.slice(0, -1);
    if (measureGreater(stem, 1) || (MEQ1.test(stem) && !/^.*[^aeiouy][aeiouy][^aeiouywxy]$/.test(stem))) {
      out = stem;
    }
  }
  if (/ll$/.test(out) && measureGreater(out.slice(0, -1), 1)) out = out.slice(0, -1);
  return out;
}

// Stemming the same word twice is common — every page mentioning it, every
// query. The corpus vocabulary is tens of thousands of terms, so this stays
// small, and it turns the whole thing into a map lookup after first sight.
const memo = new Map();
const MEMO_MAX = 50000;

/** The stem of one already-lowercased token. Identifiers pass through. */
export function stem(word) {
  const w = String(word);
  if (skipWord(w)) return w;
  const hit = memo.get(w);
  if (hit !== undefined) return hit;

  let out = step1c(step1b(step1a(w)));
  out = suffixStep(out, STEP2);
  out = suffixStep(out, STEP3);
  out = step4(out);
  out = step5(out);
  // Never stem a word down to nothing useful; a one or two letter stem matches
  // half the corpus and is worse than not stemming at all.
  if (out.length < 3) out = w;

  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(w, out);
  return out;
}

export const clearStemMemo = () => memo.clear();
