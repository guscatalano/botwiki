// Page history, read out of the git repo the pages already live in.
//
// Nothing extra is stored. Every revision of a page carries its own frontmatter,
// so the edit record (who, what model, why, from where) travels with the content
// and can be recovered for any point in the past. The hourly snapshot timer and
// every write are already committing; this just reads it back.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as wiki from './wiki.js';
import * as revisions from './revisions.js';

const run = promisify(execFile);
const SEP = '\u001f'; // unit separator: cannot occur in a slug or a commit subject

async function git(args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await run('git', ['-C', wiki.PAGES_DIR, ...args], { maxBuffer });
    return stdout;
  } catch {
    // No git, not a repo, or an unknown revision. History is a nicety — never
    // let its absence break a page view.
    return null;
  }
}

export async function isRepo() {
  return (await git(['rev-parse', '--is-inside-work-tree'])) !== null;
}

const relPath = (slug) => {
  const { slug: clean } = wiki.pathForSlug(slug);
  return `${clean}.md`;
};

/**
 * Revisions of one page, newest first. Each carries the edit record as it was at
 * that revision, so you can see who claimed what at the time rather than only
 * what the current file says.
 */
export async function historyOf(slug, { limit = 25 } = {}) {
  // The revision log is authoritative. Git is consulted only for pages written
  // before the log existed, so old history is not lost.
  const own = await revisions.listRevisions(slug, { limit });
  if (own.length) {
    return own.map((r) => ({
      rev: r.id,
      short: r.id.slice(2, 9),
      at: r.at,
      subject: r.op,
      provenance: r.provenance,
      verifiedAt: r.verified_at || null,
      title: r.title,
      bytes: r.bytes,
      lines: r.lines,
      source: 'log',
    }));
  }
  return historyFromGit(slug, { limit });
}

async function historyFromGit(slug, { limit = 25 } = {}) {
  const rel = relPath(slug);
  const log = await git([
    'log',
    `--max-count=${Math.max(1, Math.min(200, limit))}`,
    '--follow',
    `--format=%H${SEP}%aI${SEP}%s`,
    '--',
    rel,
  ]);
  if (!log) return [];

  const revs = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rev, at, subject] = line.split(SEP);
      return { rev, short: rev.slice(0, 7), at, subject };
    });

  const out = [];
  for (const r of revs) {
    const blob = await git(['show', `${r.rev}:${rel}`]);
    if (blob === null) {
      out.push({ ...r, provenance: null, bytes: 0, missing: true });
      continue;
    }
    const { meta, body } = wiki.parseFrontmatter(blob);
    out.push({
      ...r,
      provenance: wiki.provenanceOf(meta),
      verifiedAt: meta.verified_at || null,
      verifiedBy: meta.verified_by || null,
      title: meta.title || null,
      bytes: Buffer.byteLength(blob),
      lines: body.split('\n').length,
    });
  }
  return out;
}

/** The unified diff a single revision made to this page. */
export async function diffOf(slug, rev) {
  // Revision ids start with r-; anything else is a git sha from the fallback.
  if (String(rev || '').startsWith('r-')) {
    const d = await revisions.diffOf(slug, rev);
    return d ? d.patch : null;
  }
  const rel = relPath(slug);
  if (!/^[0-9a-f]{4,40}$/i.test(String(rev || ''))) return null;
  // `git show <rev> -- <file>` gives the patch this commit applied to this file.
  const patch = await git(['show', '--format=%H%n%aI%n%s', '--patch', rev, '--', rel]);
  return patch || null;
}

/**
 * Who has touched a page, and how often. Answers "who owns this" without
 * needing to read every revision.
 */
export async function contributorsOf(slug) {
  const own = await revisions.contributorsOf(slug);
  if (own.length) return own;
  const revs = await historyOf(slug, { limit: 200 });
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

/** Recent activity across the whole wiki, for a "what changed lately" view. */
export async function recentChanges({ limit = 40 } = {}) {
  const own = await revisions.recentChanges({ limit });
  if (own.length) {
    return own.map((r) => ({
      rev: r.id,
      short: r.id.slice(2, 9),
      at: r.at,
      subject: `${r.op}${r.provenance?.claimed?.agent ? ' by ' + r.provenance.claimed.agent : ''}`,
      pages: [r.page],
    }));
  }
  return recentChangesFromGit({ limit });
}

async function recentChangesFromGit({ limit = 40 } = {}) {
  const log = await git([
    'log',
    `--max-count=${Math.max(1, Math.min(500, limit))}`,
    `--format=%H${SEP}%aI${SEP}%s`,
    '--name-only',
  ]);
  if (!log) return [];

  // git puts a blank line between each commit's header and its file list, so
  // splitting on blank lines runs commits together. Drive off the separator
  // instead: a line containing it starts a commit, anything else is a filename.
  const out = [];
  let cur = null;
  for (const line of log.split('\n')) {
    if (line.includes(SEP)) {
      if (cur?.pages.length) out.push(cur);
      const [rev, at, subject] = line.split(SEP);
      cur = { rev, short: rev.slice(0, 7), at, subject, pages: [] };
      continue;
    }
    const f = line.trim();
    if (!cur || !f) continue;
    if (f.endsWith('.md') && !f.startsWith('.talk/')) cur.pages.push(f.slice(0, -3));
  }
  if (cur?.pages.length) out.push(cur);
  return out;
}
