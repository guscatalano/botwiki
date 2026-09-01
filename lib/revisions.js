// Explicit revision history, owned by the wiki rather than borrowed from git.
//
// Every write appends one line to `pages/.history/<slug>.jsonl`. That location
// is deliberate, for the same reason as `.talk/`: the page walker skips
// dot-directories, so history never leaks into search, listings or the graph,
// while still sitting inside the one directory that `tar` backs up.
//
// Why not git, which was the first implementation:
//   - Granularity was wrong. Only the hourly snapshot timer committed, so
//     several edits inside an hour collapsed into a single revision.
//   - It shells out once per revision to read old content: N+1 subprocesses to
//     render one history page.
//   - It is an external dependency the store should not need.
//   - It does not migrate. A row per revision moves into SQL unchanged; a git
//     repo does not.
//
// Git snapshots still run and are still a fine backup. They are just no longer
// what the wiki calls history.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as wiki from './wiki.js';

// Resolved lazily: wiki.js imports this module, so reading PAGES_DIR at module
// load would run before wiki.js has finished initialising it.
export const historyDir = () => path.join(wiki.PAGES_DIR, '.history');

const hash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 16);

function logPath(slug) {
  // Reuse the page slug validator so history inherits its traversal defence.
  const { slug: clean } = wiki.pathForSlug(slug);
  const dir = historyDir();
  const abs = path.resolve(dir, `${clean}.jsonl`);
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!abs.startsWith(root)) {
    throw new wiki.WikiError(`History path escapes the history directory: ${slug}`, 'invalid_slug');
  }
  return { slug: clean, abs };
}

/**
 * Append one revision. Called by writePage/deletePage, so every write is
 * recorded at the moment it happens rather than whenever a timer next fires.
 */
export async function record(slug, { raw = '', op = 'update', meta = {}, provenance = null } = {}) {
  const { slug: clean, abs } = logPath(slug);
  const prior = await listRevisions(clean, { limit: 1 });
  const contentHash = hash(raw);

  // A rewrite that changes nothing is not a revision. The librarian rewrites a
  // whole file to record a verification, and that IS an event worth keeping —
  // but a no-op save from the editor is not.
  if (op === 'update' && prior[0] && prior[0].hash === contentHash) return null;

  const entry = {
    id: `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    at: new Date().toISOString(),
    op,
    hash: contentHash,
    bytes: Buffer.byteLength(raw),
    lines: raw ? raw.split('\n').length : 0,
    title: meta.title || null,
    type: meta.type || null,
    tags: meta.tags || [],
    verified_at: meta.verified_at || null,
    provenance,
    // Full content per revision. Pages are a couple of KB; a hundred revisions
    // of one is a few hundred KB. Storing diffs would save space and cost a
    // reconstruction step on every read, which is the wrong trade at this size.
    raw,
  };

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/** Revisions of one page, newest first. */
export async function listRevisions(slug, { limit = 50, withContent = false } = {}) {
  const { abs } = logPath(slug);
  let text;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      out.push(withContent ? e : { ...e, raw: undefined });
    } catch {
      // A truncated final line (killed mid-append) must not lose the rest.
    }
  }
  out.reverse();
  return out.slice(0, Math.max(1, limit));
}

export async function getRevision(slug, id) {
  const all = await listRevisions(slug, { limit: 10000, withContent: true });
  return all.find((r) => r.id === id) || null;
}

// --- diff -------------------------------------------------------------------

/** Longest common subsequence over lines. No dependency, fine at page size. */
function lcsDiff(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ t: ' ', line: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', line: aLines[i++] });
    } else {
      out.push({ t: '+', line: bLines[j++] });
    }
  }
  while (i < n) out.push({ t: '-', line: aLines[i++] });
  while (j < m) out.push({ t: '+', line: bLines[j++] });
  return out;
}

/** What one revision changed, against the revision before it. */
export async function diffOf(slug, id) {
  const all = await listRevisions(slug, { limit: 10000, withContent: true });
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const after = all[idx];
  const before = all[idx + 1]; // the list is newest-first
  const rows = lcsDiff((before?.raw || '').split('\n'), (after.raw || '').split('\n'));

  // Trim runs of unchanged lines to a little context, like a unified diff.
  const CTX = 3;
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, k) => {
    if (r.t === ' ') return;
    for (let x = Math.max(0, k - CTX); x <= Math.min(rows.length - 1, k + CTX); x++) keep[x] = true;
  });
  const lines = [];
  let skipping = false;
  rows.forEach((r, k) => {
    if (keep[k]) {
      skipping = false;
      lines.push(r.t + r.line);
    } else if (!skipping) {
      skipping = true;
      lines.push('@@ ...');
    }
  });

  return {
    id,
    at: after.at,
    op: after.op,
    from: before?.id || null,
    added: rows.filter((r) => r.t === '+').length,
    removed: rows.filter((r) => r.t === '-').length,
    patch: lines.join('\n'),
  };
}

// --- across the wiki --------------------------------------------------------

async function walkLogs(dir = null, prefix = '') {
  dir = dir || historyDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkLogs(path.join(dir, e.name), rel)));
    else if (e.name.endsWith('.jsonl')) out.push(rel.slice(0, -6));
  }
  return out;
}

/** Who has edited a page, and how often. */
export async function contributorsOf(slug) {
  const revs = await listRevisions(slug, { limit: 10000 });
  const by = new Map();
  for (const r of revs) {
    const who = r.provenance?.claimed?.agent || r.provenance?.observed?.via || 'unknown';
    if (!by.has(who)) by.set(who, { who, edits: 0, models: new Set(), first: r.at, last: r.at });
    const e = by.get(who);
    e.edits++;
    if (r.provenance?.claimed?.model) e.models.add(r.provenance.claimed.model);
    if (r.at < e.first) e.first = r.at;
    if (r.at > e.last) e.last = r.at;
  }
  return [...by.values()]
    .map((e) => ({ ...e, models: [...e.models] }))
    .sort((a, b) => b.edits - a.edits);
}

/** Recent activity across every page, newest first. */
export async function recentChanges({ limit = 40 } = {}) {
  const all = [];
  for (const slug of await walkLogs()) {
    for (const r of await listRevisions(slug, { limit: 200 })) all.push({ ...r, page: slug });
  }
  all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return all.slice(0, Math.max(1, limit));
}

export async function hasHistory(slug) {
  return (await listRevisions(slug, { limit: 1 })).length > 0;
}
