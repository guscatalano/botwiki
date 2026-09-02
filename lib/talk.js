// Per-page discussion threads — the wiki's equivalent of a Talk: page.
//
// Comments live in `<pages>/.talk/<slug>.md`, one file per page. That location is
// deliberate: `walk()` in wiki.js skips dot-directories, so talk never leaks into
// listings, search, or the graph, while still sitting inside the pages git repo
// and so getting the same history and hourly snapshots for free.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as wiki from './wiki.js';

export const TALK_DIR = path.join(wiki.PAGES_DIR, '.talk');

export const KINDS = ['note', 'question', 'stale', 'contradiction', 'suggestion'];

const HEADER = '<!-- botwiki-talk v1 -->';

function talkPath(slug) {
  // Reuse the page slug validator so talk paths inherit its traversal defence.
  const { slug: clean } = wiki.pathForSlug(slug);
  const abs = path.resolve(TALK_DIR, `${clean}.md`);
  const root = TALK_DIR.endsWith(path.sep) ? TALK_DIR : TALK_DIR + path.sep;
  if (!abs.startsWith(root)) {
    throw new wiki.WikiError(`Talk path escapes the talk directory: ${slug}`, 'invalid_slug');
  }
  return { slug: clean, abs };
}

const oneLine = (v, max = 200) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);

function newId() {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// --- serialise / parse -----------------------------------------------------

function render(slug, comments) {
  const out = [`# Talk: ${slug}`, '', HEADER, ''];
  for (const c of comments) {
    out.push(`## ${c.id} · ${c.at} · ${c.author || 'anonymous'}`);
    const meta = {
      kind: c.kind,
      status: c.status,
      key: c.key,
      model: c.model,
      host: c.host,
      session: c.session,
      via: c.via,
      ip: c.ip,
      resolved_at: c.resolvedAt,
      resolved_by: c.resolvedBy,
      resolution: c.resolution,
    };
    for (const [k, v] of Object.entries(meta)) if (v) out.push(`${k}: ${v}`);
    out.push('');
    out.push(c.body.trimEnd());
    out.push('');
  }
  return out.join('\n');
}

function parse(raw) {
  const comments = [];
  const blocks = raw.split(/^## /m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const head = lines.shift() || '';
    const [id, at, ...rest] = head.split('·').map((s) => s.trim());
    const c = { id, at, author: rest.join('·').trim() || 'anonymous', kind: 'note', status: 'open' };
    let i = 0;
    for (; i < lines.length; i++) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
      if (!m) break;
      const key = m[1];
      const val = m[2].trim();
      if (key === 'resolved_at') c.resolvedAt = val;
      else if (key === 'resolved_by') c.resolvedBy = val;
      else c[key] = val;
    }
    c.body = lines.slice(i).join('\n').trim();
    if (c.id) comments.push(c);
  }
  return comments;
}

// --- api -------------------------------------------------------------------

export async function listComments(slug) {
  const { abs } = talkPath(slug);
  try {
    return parse(await fs.readFile(abs, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function addComment(slug, body, opts = {}) {
  const { slug: clean, abs } = talkPath(slug);
  const text = String(body ?? '').trim();
  if (!text) throw new wiki.WikiError('A comment needs a body.', 'empty_comment');

  // A `key` makes a comment idempotent. An automated reviewer runs on a timer
  // and must not restate the same finding every week: if the same key is
  // already present and unresolved, this is a no-op. A resolved one stays
  // resolved unless the finding is genuinely different.
  if (opts.key) {
    const prior = (await listComments(clean)).find((c) => c.key === opts.key);
    if (prior) return { ...prior, deduped: true };
  }

  const kind = KINDS.includes(opts.kind) ? opts.kind : 'note';
  const comment = {
    id: newId(),
    key: oneLine(opts.key, 120),
    at: new Date().toISOString(),
    author: oneLine(opts.author || (opts.via === 'web' ? 'browser' : 'unknown'), 80),
    kind,
    status: 'open',
    model: oneLine(opts.model, 80),
    host: oneLine(opts.host, 80),
    session: oneLine(opts.session, 80),
    via: oneLine(opts.via, 32),
    ip: opts.ip ? oneLine(wiki.normaliseIp(opts.ip), 64) : '',
    body: text,
  };

  const existing = await listComments(clean);
  existing.push(comment);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, render(clean, existing), 'utf8');
  return comment;
}

export async function resolveComment(slug, id, opts = {}) {
  const { slug: clean, abs } = talkPath(slug);
  const comments = await listComments(clean);
  const target = comments.find((c) => c.id === id);
  if (!target) return null;
  target.status = 'resolved';
  target.resolvedAt = new Date().toISOString();
  target.resolvedBy = oneLine(opts.by || 'unknown', 80);
  if (opts.resolution) target.resolution = oneLine(opts.resolution, 200);
  await fs.writeFile(abs, render(clean, comments), 'utf8');
  return target;
}

export async function reopenComment(slug, id) {
  const { slug: clean, abs } = talkPath(slug);
  const comments = await listComments(clean);
  const target = comments.find((c) => c.id === id);
  if (!target) return null;
  target.status = 'open';
  delete target.resolvedAt;
  delete target.resolvedBy;
  delete target.resolution;
  await fs.writeFile(abs, render(clean, comments), 'utf8');
  return target;
}

/** Open-comment counts for every page that has any. Cheap enough to call per request. */
export async function openCounts() {
  const counts = new Map();
  const walk = async (dir, prefix = '') => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.md')) {
        const slug = rel.slice(0, -3);
        const open = (await listComments(slug)).filter((c) => c.status !== 'resolved').length;
        if (open) counts.set(slug, open);
      }
    }
  };
  await walk(TALK_DIR);
  return counts;
}

/** Every open comment across the wiki, newest first. Powers the review queue. */
export async function allOpen() {
  const out = [];
  for (const [slug] of await openCounts()) {
    for (const c of await listComments(slug)) {
      if (c.status !== 'resolved') out.push({ ...c, page: slug });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
