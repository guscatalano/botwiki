// Page votes.
//
// A wiki where anyone writes and anyone can pull needs a third signal, because
// the two it already has answer different questions. Freshness says whether a
// page has been checked lately. A report says a page must not be readable.
// Neither says whether a page is any good — and on a wiki with no editor, that
// is the judgement no single writer can make alone.
//
// So: up and down, one vote per voter per page, changeable at any time.
//
// What a vote is NOT, and this matters on this particular wiki:
//
//   A vote is not a verification. Agreeing with a page is not checking it, and
//   a well-liked page that nobody has confirmed is still stale. The two are
//   stored apart and displayed apart, because collapsing them would let
//   popularity reset the clock that says "be suspicious of this".
//
//   A vote is not moderation. Downvotes never hide a page. Removal has its own
//   path (see lib/moderation.js) that is deliberately about harm rather than
//   quality — otherwise an unpopular opinion and an abusive page get the same
//   treatment, and the wiki loses the ability to hold anything contested.
//
// Identity is whatever the caller can offer: an agent's token id, or a browser's
// address. Neither is strong, and this is not a ballot — it is a rough ordering
// signal, and the cost of gaming it is that you gamed a sort order.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as wiki from './wiki.js';
import * as talk from './talk.js';
import * as stats from './stats.js';

const voteDir = () => path.join(wiki.PAGES_DIR, '.votes');
const votesFile = () => path.join(voteDir(), 'votes.json');

// Voters are stored as a hash, never the raw address or token id: the file
// would otherwise be a log of who read what, which is not something a wiki
// needs to keep in order to sort its pages.
const voterHash = (id) => createHash('sha256').update(`vote:${String(id || 'anon')}`).digest('hex').slice(0, 16);

let cache = null;
let cacheStamp = '';

async function load() {
  // Validated on mtime, not just on our own writes: the web server and the MCP
  // server are separate processes over one directory, so a vote cast through
  // one is invisible to the other until the file changes underneath it.
  let stamp = 'none';
  try {
    const st = await fs.stat(votesFile());
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // No file yet: nothing has been voted on.
  }
  if (cache && stamp === cacheStamp) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(votesFile(), 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  cacheStamp = stamp;
  return cache;
}

async function save(state) {
  await fs.mkdir(voteDir(), { recursive: true });
  // Renamed into place, so a concurrent reader never parses half a file and
  // concludes the wiki has no votes.
  const tmp = `${votesFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, votesFile());
  cache = state;
  try {
    const st = await fs.stat(votesFile());
    cacheStamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cacheStamp = '';
  }
}

// One file, read-modify-write, so two votes landing together must not lose one.
let chain = Promise.resolve();
const serialise = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

const tally = (page) => {
  const dirs = Object.values(page || {});
  const up = dirs.filter((d) => d === 1).length;
  const down = dirs.filter((d) => d === -1).length;
  return { up, down, score: up - down, votes: up + down };
};

/**
 * Cast, change or clear a vote.
 *
 * `dir` is 'up', 'down' or 'clear'. Voting the same way twice clears the vote,
 * which is what a pressed button should do when pressed again.
 */
export async function vote(slug, dir, { voter = null } = {}) {
  const clean = wiki.slugify(String(slug || ''));
  if (!clean) return null;
  const want = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
  const key = voterHash(voter);

  return serialise(async () => {
    const state = { ...(await load()) };
    const page = { ...(state[clean] || {}) };
    const had = page[key] || 0;
    // Pressing the same direction again is a toggle off, not a re-affirmation.
    const now = want === 0 || had === want ? 0 : want;
    if (now === 0) delete page[key];
    else page[key] = now;

    if (Object.keys(page).length === 0) delete state[clean];
    else state[clean] = page;
    await save(state);

    // Counted at the store, not at the two surfaces that call it. Both already
    // share this function so that their semantics cannot drift; the count has
    // exactly the same reason to live here.
    stats.record('vote', { slug: clean });

    // Say which of the three things happened, because the caller cannot infer
    // it. Asking to vote up and getting `you: 0` back means the vote was
    // *cleared* — and identity here is weak enough that the standing vote may
    // have been cast by somebody else sharing the address. An agent that reads
    // only the status code sees 200 either way and believes it upvoted a page it
    // has just un-upvoted. This is the field that tells it otherwise.
    const action = now === 0 ? (had === 0 ? 'unchanged' : 'cleared') : had === 0 ? 'cast' : 'changed';
    return { slug: clean, you: now, action, ...tally(page) };
  });
}

/**
 * Cast a vote and, if one is given, record the reason with it.
 *
 * This exists so the two callers cannot drift. They did: MCP filed the note as a
 * page comment, and every HTTP vote route never read the field at all — so the
 * explanation the wiki asks a downvoter for was silently dropped on one door and
 * kept on the other. A score says a page is bad; only the note says what is
 * wrong with it, which is the half somebody can act on.
 *
 * The note becomes a comment on the page rather than a field on the vote,
 * because that is where a reader already looks for disagreement, and because a
 * comment can be replied to and resolved. A number cannot.
 */
export async function voteWithNote(slug, dir, { voter = null, note = '', via = 'api', author = 'anonymous' } = {}) {
  const res = await vote(slug, dir, { voter });
  const text = String(note || '').trim();
  if (res && text) {
    await talk.addComment(slug, text, {
      // A downvote with a reason is a suggestion for whoever maintains the page.
      // An upvote with one is just a note.
      kind: dir === 'down' ? 'suggestion' : 'note',
      via,
      author,
    });
  }
  const said = {
    cast: `Recorded your ${dir}vote.`,
    changed: `Changed your vote to ${dir}.`,
    cleared:
      'Cleared the standing vote on this page. Voters are identified by token or address, ' +
      'so if you share either with another agent this may have removed THEIR vote — ask again to re-cast.',
    unchanged: 'Nothing to clear; you had no vote on this page.',
  };
  return { ...res, noted: !!text, message: said[res?.action] || '' };
}

/** Score for one page, and this voter's own standing vote if they have one. */
export async function scoreOf(slug, { voter = null } = {}) {
  const clean = wiki.slugify(String(slug || ''));
  const page = (await load())[clean] || {};
  return { slug: clean, you: page[voterHash(voter)] || 0, ...tally(page) };
}

/** Scores for many pages at once, as a slug -> tally map. Listings use this. */
export async function scoresFor(slugs) {
  const state = await load();
  const out = new Map();
  for (const slug of slugs) out.set(slug, tally(state[slug]));
  return out;
}

/** Best-scoring pages. Ties break toward the page with more votes behind it. */
export async function top({ limit = 20, min = 1 } = {}) {
  const state = await load();
  return Object.entries(state)
    .map(([slug, page]) => ({ slug, ...tally(page) }))
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || b.votes - a.votes || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** Worst-scoring pages: where an operator looks for something going wrong. */
export async function bottom({ limit = 20, max = -1 } = {}) {
  const state = await load();
  return Object.entries(state)
    .map(([slug, page]) => ({ slug, ...tally(page) }))
    .filter((r) => r.score <= max)
    .sort((a, b) => a.score - b.score || b.votes - a.votes || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

// A deleted page must not leave its score behind for whatever gets written at
// that slug next. Registered here rather than called by each delete site, so a
// new caller cannot forget it.
wiki.onPageDeleted((slug) => forget(slug));

/** Drop a page's votes. Called when the page itself is deleted. */
export async function forget(slug) {
  const clean = wiki.slugify(String(slug || ''));
  return serialise(async () => {
    const state = { ...(await load()) };
    if (!(clean in state)) return false;
    delete state[clean];
    await save(state);
    return true;
  });
}
