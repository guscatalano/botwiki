// Core wiki store: markdown files on disk are the single source of truth.
// Shared by the MCP server (agents) and the web server (humans).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STOP } from './vectors.js';
import * as revisions from './revisions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PAGES_DIR = path.resolve(
  process.env.WIKI_DIR || path.join(HERE, '..', 'pages')
);

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export class WikiError extends Error {
  constructor(message, code = 'wiki_error') {
    super(message);
    this.code = code;
  }
}

/**
 * A write whose base is no longer current. Carries the live content so the
 * caller can merge rather than guess — losing an edit silently is the failure
 * mode this whole mechanism exists to prevent.
 */
export class ConflictError extends WikiError {
  constructor(slug, expected, actual, current) {
    super(
      `Conflict on "${slug}": the page changed since you read it ` +
        `(you based this on ${expected}, current is ${actual}). ` +
        `Re-read it, merge your change into the current content, and write again.`,
      'conflict'
    );
    this.slug = slug;
    this.expected = expected;
    this.actual = actual;
    this.current = current;
  }
}

/** Content hash a caller passes back as `baseHash` to prove what it edited. */
export const contentHash = (s) =>
  createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);

// --- write locking ----------------------------------------------------------
//
// The web server and the MCP server are separate processes writing the same
// directory, and agents write concurrently, so serialising within one process
// is not enough. An exclusive-create lockfile is the simplest thing that is
// actually correct across processes on one filesystem.

const LOCK_DIR = path.join(PAGES_DIR, '.locks');
const LOCK_STALE_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withPageLock(slug, fn) {
  const lockFile = path.join(LOCK_DIR, `${slug.replace(/\//g, '__')}.lock`);
  await fs.mkdir(LOCK_DIR, { recursive: true });

  let handle = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await fs.open(lockFile, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Break a lock left behind by a process that died holding it.
      try {
        const st = await fs.stat(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      await sleep(20 + Math.random() * 30);
    }
  }
  if (!handle) {
    throw new WikiError(`Timed out waiting to write "${slug}" — another writer is holding it.`, 'locked');
  }

  try {
    await handle.write(String(process.pid));
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
  }
}

export function slugify(input) {
  return String(input)
    .trim()
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/\\+/g, '/')
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg
        .replace(/[^a-z0-9._\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.-]+/, '')
    )
    .filter(Boolean)
    .join('/');
}

// Resolve a slug to an absolute path, refusing anything that escapes PAGES_DIR.
// slugify() alone would quietly rewrite "../../etc/passwd" into "etc/passwd";
// rejecting outright gives the caller a real error instead of a phantom miss.
export function pathForSlug(slug) {
  const raw = String(slug ?? '').trim();
  if (
    /^[/\\]/.test(raw) ||
    /^[a-zA-Z]:[/\\]/.test(raw) ||
    raw.split(/[/\\]/).some((seg) => seg === '..' || seg === '.') ||
    raw.includes('\0')
  ) {
    throw new WikiError(
      `Refusing page name ${JSON.stringify(slug)}: it must be a relative wiki slug, not a filesystem path.`,
      'invalid_slug'
    );
  }
  const clean = slugify(raw);
  if (!clean || !SLUG_RE.test(clean)) {
    throw new WikiError(
      `Invalid page name: ${JSON.stringify(slug)}. Use lowercase letters, digits and dashes, optionally in folders (e.g. "runbooks/restore-db").`,
      'invalid_slug'
    );
  }
  const abs = path.resolve(PAGES_DIR, `${clean}.md`);
  const root = PAGES_DIR.endsWith(path.sep) ? PAGES_DIR : PAGES_DIR + path.sep;
  if (!abs.startsWith(root)) {
    throw new WikiError(`Page name escapes the wiki directory: ${slug}`, 'invalid_slug');
  }
  return { slug: clean, abs };
}

// --- frontmatter -----------------------------------------------------------

function parseList(value) {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'tags' || key === 'aliases' || key === 'see_also') {
        meta[key] = parseList(value);
      } else {
        meta[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
  return { meta, body: body.replace(/^\s*\n/, '') };
}

export function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function titleFrom(meta, body, slug) {
  if (meta.title) return meta.title;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return h1[1].trim();
  return slug
    .split('/')
    .pop()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- reading ---------------------------------------------------------------

async function walk(dir, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await walk(path.join(dir, e.name), rel)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(rel.slice(0, -3));
    }
  }
  return out;
}

export async function listSlugs() {
  return (await walk(PAGES_DIR)).sort();
}

export async function readPage(slug) {
  const { slug: clean, abs } = pathForSlug(slug);
  let raw;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const stat = await fs.stat(abs);
  const { meta, body } = parseFrontmatter(raw);
  return {
    slug: clean,
    path: abs,
    title: titleFrom(meta, body, clean),
    tags: meta.tags || [],
    meta,
    body,
    raw,
    updated: meta.updated_at || stat.mtime.toISOString(),
    bytes: stat.size,
    type: meta.type || null,
    hash: contentHash(raw),
    provenance: provenanceOf(meta),
  };
}

/**
 * Split the edit record into what the server saw and what the caller claimed.
 * Anything under `claimed` is unverified by construction — an agent could put
 * whatever it liked there — so callers should present it as an assertion.
 */
export function provenanceOf(meta = {}) {
  const observed = {};
  if (meta.updated_via) observed.via = meta.updated_via;
  if (meta.updated_ip) observed.ip = meta.updated_ip;

  const claimed = {};
  if (meta.updated_agent) claimed.agent = meta.updated_agent;
  if (meta.updated_model) claimed.model = meta.updated_model;
  if (meta.updated_context) claimed.context = meta.updated_context;

  const at = meta.updated_at || null;
  if (!at && !Object.keys(observed).length && !Object.keys(claimed).length) return null;
  return { at, observed, claimed };
}

/** One-line human summary of who last touched a page. */
export function describeProvenance(p) {
  if (!p) return 'no edit record';
  const who = p.claimed.agent || (p.observed.via === 'web' ? 'a browser' : 'an unnamed client');
  const model = p.claimed.model ? ` (${p.claimed.model})` : '';
  const from = p.observed.ip ? ` from ${p.observed.ip}` : '';
  const via = p.observed.via ? ` via ${p.observed.via}` : '';
  return `${who}${model}${from}${via}`;
}

// A single frontmatter line must not be able to forge extra lines.
const oneLine = (v, max = 240) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);

export function normaliseIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  return s === '::1' ? '127.0.0.1' : s;
}

export async function writePage(slug, content, opts = {}) {
  const { slug: clean } = pathForSlug(slug);
  return withPageLock(clean, () => writeLocked(clean, content, opts));
}

async function writeLocked(slug, content, opts = {}) {
  const { slug: clean, abs } = pathForSlug(slug);
  const existing = await readPage(clean);

  // Optimistic concurrency. A caller that passes the hash it read is guaranteed
  // either to apply its change to that exact content or to be told it is stale.
  // A caller that passes nothing keeps the old last-write-wins behaviour.
  if (opts.baseHash !== undefined && opts.baseHash !== null) {
    const actual = existing ? contentHash(existing.raw) : null;
    if (actual !== opts.baseHash) {
      throw new ConflictError(clean, opts.baseHash, actual, existing?.raw ?? null);
    }
  }

  const incoming = parseFrontmatter(String(content ?? ''));

  // Frontmatter precedence: explicit args > frontmatter in the new content > what
  // the page already had, so a caller can send a bare body and keep its metadata.
  const meta = { ...(existing?.meta || {}), ...incoming.meta };
  if (opts.title) meta.title = opts.title;
  if (opts.tags) meta.tags = Array.isArray(opts.tags) ? opts.tags : parseList(String(opts.tags));
  if (!meta.title) meta.title = titleFrom(meta, incoming.body, clean);
  meta.updated = new Date().toISOString().slice(0, 10);

  // Who changed this, and why. `via` and `ip` are observed by the server and are
  // trustworthy; `agent`, `model` and `context` are self-reported by the caller
  // and are only as honest as the caller. readPage() keeps that split visible.
  // Typed fields live in frontmatter alongside title/tags. Nothing validates
  // them here on purpose — see lib/types.js for why conformance is advisory.
  if (opts.type !== undefined) meta.type = oneLine(opts.type, 40).toLowerCase();
  if (opts.ttl !== undefined) meta.ttl = oneLine(opts.ttl, 20);
  if (opts.fields && typeof opts.fields === 'object') {
    for (const [k, v] of Object.entries(opts.fields)) {
      const key = oneLine(k, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!key) continue;
      if (v === null || v === '') delete meta[key];
      else meta[key] = Array.isArray(v) ? v.map((x) => oneLine(x, 80)) : oneLine(v, 300);
    }
  }

  // A verification is a distinct act from an edit: "I checked, this is still
  // true" rather than "I changed it".
  if (opts.verified) {
    meta.verified_at = new Date().toISOString();
    if (opts.verifiedBy) meta.verified_by = oneLine(opts.verifiedBy, 80);
    if (opts.verifiedNote) meta.verified_note = oneLine(opts.verifiedNote, 240);
  }

  const p = opts.provenance || {};
  meta.updated_at = new Date().toISOString();
  if (p.via) meta.updated_via = oneLine(p.via, 32);
  if (p.ip) meta.updated_ip = oneLine(normaliseIp(p.ip), 64);
  if (p.agent) meta.updated_agent = oneLine(p.agent, 80);
  if (p.model) meta.updated_model = oneLine(p.model, 80);
  if (p.context) meta.updated_context = oneLine(p.context, 240);

  const out = `${buildFrontmatter(meta)}\n\n${incoming.body.trimEnd()}\n`;

  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Write-then-rename: a reader never sees a half-written page, even if the
  // process dies mid-write.
  const tmp = `${abs}.${process.pid}.tmp`;
  await fs.writeFile(tmp, out, 'utf8');
  await fs.rename(tmp, abs);

  await revisions.record(clean, {
    raw: out,
    op: existing ? (opts.verified ? 'verify' : 'update') : 'create',
    meta,
    provenance: provenanceOf(meta),
  });

  return {
    slug: clean,
    path: abs,
    created: !existing,
    bytes: Buffer.byteLength(out),
    hash: contentHash(out),
  };
}

export async function deletePage(slug) {
  const { slug: clean, abs } = pathForSlug(slug);
  return withPageLock(clean, async () => {
    const existing = await readPage(clean);
    try {
      await fs.unlink(abs);
    } catch (err) {
      if (err.code === 'ENOENT') return { slug: clean, deleted: false };
      throw err;
    }
    // A deletion is an event in the page's history, and the last content is
    // kept so the page can be brought back.
    await revisions.record(clean, {
      raw: existing?.raw || '',
      op: 'delete',
      meta: existing?.meta || {},
      provenance: existing ? provenanceOf(existing.meta) : null,
    });
    return { slug: clean, deleted: true };
  });
}

function firstProse(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('|')) continue;
    return t.replace(/[*_`]/g, '').slice(0, 200);
  }
  return '';
}

export async function listPages({ tag, type } = {}) {
  const pages = [];
  for (const slug of await listSlugs()) {
    const page = await readPage(slug);
    if (!page) continue;
    if (tag && !page.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;
    if (type && String(page.type || '').toLowerCase() !== String(type).toLowerCase()) continue;
    pages.push({
      slug: page.slug,
      title: page.title,
      type: page.type,
      tags: page.tags,
      updated: page.updated,
      bytes: page.bytes,
      summary: page.meta.summary || firstProse(page.body),
    });
  }
  return pages;
}

export async function allTags() {
  const counts = new Map();
  for (const p of await listPages()) {
    for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// --- search ----------------------------------------------------------------

function tokenize(s) {
  const raw = String(s).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [];
  // Body matching is substring-based, so a two-letter word like "in" would match
  // almost every page and drown the real terms. Drop stopwords and very short
  // words — unless the whole query is one of them, in which case honour it.
  const kept = raw.filter((t) => t.length >= 3 && !STOP.has(t));
  return kept.length ? kept : raw;
}

function snippetFor(body, terms) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      const ctx = [lines[i - 1], lines[i], lines[i + 1]]
        .filter((l) => l != null && l.trim())
        .join(' ')
        .trim();
      return ctx.length > 280 ? `${ctx.slice(0, 280)}…` : ctx;
    }
  }
  return firstProse(body);
}

/**
 * Ranked full-text search. Weighting: title > slug/tags > headings > body.
 * Scans files on every call, so it can never serve a stale index; fine well into
 * the low thousands of pages.
 */
export async function search(query, { limit = 10, tag } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = [...new Set(tokenize(q))];
  const phrase = q.toLowerCase();
  const results = [];

  for (const slug of await listSlugs()) {
    const page = await readPage(slug);
    if (!page) continue;
    if (tag && !page.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;

    const title = page.title.toLowerCase();
    const slugL = page.slug.toLowerCase();
    const tagsL = page.tags.join(' ').toLowerCase();
    const bodyL = page.body.toLowerCase();
    const headings = (page.body.match(/^#{1,6}\s+.*$/gm) || []).join('\n').toLowerCase();

    let score = 0;
    let hits = 0;
    for (const t of terms) {
      let termScore = 0;
      if (title.includes(t)) termScore += 12;
      if (slugL.includes(t)) termScore += 8;
      if (tagsL.includes(t)) termScore += 8;
      if (headings.includes(t)) termScore += 4;
      const bodyHits = bodyL.split(t).length - 1;
      if (bodyHits) termScore += Math.min(6, 1 + Math.log2(bodyHits));
      if (termScore) hits++;
      score += termScore;
    }
    if (!hits) continue;

    if (terms.length > 1) score *= hits / terms.length; // reward covering the whole query
    if (title.includes(phrase)) score += 25;
    else if (bodyL.includes(phrase)) score += 10;

    results.push({
      slug: page.slug,
      title: page.title,
      tags: page.tags,
      updated: page.updated,
      score: Math.round(score * 10) / 10,
      snippet: snippetFor(page.body, terms),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

// --- links -----------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// A page documenting the [[…]] syntax shows it inside code. Those are examples,
// not links — counting them produces phantom broken links in the graph.
const stripCode = (md) =>
  md.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');

export async function linksIn(body) {
  const slugs = new Set(await listSlugs());
  const out = [];
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const target = slugify(m[1]);
    out.push({ slug: target, label: (m[2] || m[1]).trim(), exists: slugs.has(target) });
  }
  return out;
}

export async function backlinks(slug) {
  const clean = slugify(slug);
  const out = [];
  for (const s of await listSlugs()) {
    if (s === clean) continue;
    const page = await readPage(s);
    if (!page) continue;
    if ((await linksIn(page.body)).some((l) => l.slug === clean)) {
      out.push({ slug: page.slug, title: page.title });
    }
  }
  return out;
}
