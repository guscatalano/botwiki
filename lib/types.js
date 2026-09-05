// Page types, and how fresh a page of that type is expected to be.
//
// Types are defined IN THE WIKI, on the `meta/types` page, as a markdown table.
// That is deliberate: adding a type should not require touching code or
// redeploying, and the definition should be readable by the people who use it.
//
// Nothing is enforced at write time. A page missing a required field is still
// written — an agent holding most of the facts must not be blocked from
// recording them. Conformance is reported instead, and surfaces as discussion
// comments, so a schema violation is advice rather than an error.

import * as wiki from './wiki.js';

export const TYPES_PAGE = 'meta/types';

// Frontmatter keys the wiki itself owns; never treated as type fields.
// Bookkeeping the server writes into frontmatter. Listed here so it is not
// mistaken for a field the page declared about itself — `updated_host`,
// `updated_session` and `updated_token` were missing, which meant an edit record
// showed up as if it were part of the page's own data.
export const RESERVED = new Set([
  'title', 'tags', 'summary', 'type', 'ttl', 'updated', 'updated_at', 'updated_via',
  'updated_ip', 'updated_agent', 'updated_model', 'updated_context',
  'updated_host', 'updated_session', 'updated_token',
  'verified_at', 'verified_by', 'verified_note', 'aliases', 'see_also',
]);

const splitCell = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim().replace(/^`|`$/g, ''))
    .filter((x) => x && x !== '-' && x !== '—');

const parseTtl = (s) => {
  const v = String(s || '').trim().toLowerCase();
  if (!v || v === '-' || v === '—' || v === 'never') return null;
  const m = /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'd')[0];
  return unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : unit === 'y' ? n * 365 : n;
};

/**
 * Read the type registry out of the wiki. A malformed or missing table yields an
 * empty registry, which means "no types defined" — the wiki keeps working, just
 * without typing. Failing open matters more here than being strict.
 */
export async function loadTypes() {
  const page = await wiki.readPage(TYPES_PAGE);
  const types = new Map();
  if (!page) return types;

  for (const line of page.body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const name = cells[0].replace(/^`|`$/g, '').toLowerCase();
    if (!name || name === 'type' || /^-+$/.test(name)) continue; // header / separator
    types.set(name, {
      type: name,
      required: splitCell(cells[1]),
      optional: splitCell(cells[2]),
      ttlDays: parseTtl(cells[3]),
      description: (cells[4] || '').trim(),
    });
  }
  return types;
}

/** The custom (non-reserved) frontmatter keys a page actually carries. */
export function fieldsOf(page) {
  const out = {};
  for (const [k, v] of Object.entries(page.meta || {})) {
    if (!RESERVED.has(k)) out[k] = v;
  }
  return out;
}

/** Compare a page against its declared type. Advisory only. */
export function checkPage(page, types) {
  const declared = String(page.meta?.type || '').toLowerCase();
  if (!declared) return { type: null, known: false, missing: [], extra: [], ok: true };

  const def = types.get(declared);
  if (!def) {
    return {
      type: declared,
      known: false,
      missing: [],
      extra: [],
      ok: false,
      problem: `type "${declared}" is not defined on ${TYPES_PAGE}`,
    };
  }

  const have = new Set(Object.keys(fieldsOf(page)));
  const missing = def.required.filter((f) => !have.has(f));
  const allowed = new Set([...def.required, ...def.optional]);
  const extra = [...have].filter((f) => !allowed.has(f));

  return { type: declared, known: true, def, missing, extra, ok: missing.length === 0 };
}

// --- staleness -------------------------------------------------------------

const DAY = 86400000;

/**
 * How out of date a page is. Deliberately separates two different questions:
 * when it was last CHANGED, and when someone last CONFIRMED it is still true.
 * A page nobody has touched in a year may be perfectly accurate; a page edited
 * yesterday may never have been checked against reality.
 */
export function stalenessOf(page, types) {
  const meta = page.meta || {};
  const declared = String(meta.type || '').toLowerCase();
  const def = types?.get(declared);

  const ttlDays = parseTtl(meta.ttl) ?? def?.ttlDays ?? null;
  const editedAt = meta.updated_at || page.updated || null;
  const verifiedAt = meta.verified_at || null;

  const age = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);
  const editedDays = age(editedAt);
  const verifiedDays = age(verifiedAt);

  // Freshness is measured from the last positive statement that the page is
  // right — a verification if there is one, otherwise the last edit.
  const sinceDays = verifiedDays ?? editedDays;

  let status = 'unknown';
  if (ttlDays == null) status = verifiedAt ? 'verified' : 'untracked';
  else if (sinceDays == null) status = 'unknown';
  // A page nobody has ever confirmed cannot be `fresh`, however recently it was
  // written. Otherwise rewriting the prose on a never-checked page makes it look
  // current, which is exactly the inflation the verified/edited split exists to
  // prevent. It can still age out to `stale` on the usual schedule.
  else if (sinceDays <= ttlDays * 0.7) status = verifiedAt ? 'fresh' : 'aging';
  else if (sinceDays <= ttlDays) status = 'aging';
  else status = 'stale';

  return {
    status,
    ttlDays,
    sinceDays,
    editedAt,
    editedDays,
    verifiedAt,
    verifiedDays,
    verifiedBy: meta.verified_by || null,
    verifiedNote: meta.verified_note || null,
    neverVerified: !verifiedAt,
    overdueBy: ttlDays != null && sinceDays != null ? Math.max(0, sinceDays - ttlDays) : 0,
  };
}

export function describeStaleness(s) {
  if (!s) return '';
  const since = s.verifiedAt
    ? `verified ${s.verifiedDays}d ago${s.verifiedBy ? ` by ${s.verifiedBy}` : ''}`
    : s.editedDays != null
      ? `never verified; last edited ${s.editedDays}d ago`
      : 'never verified';
  if (s.ttlDays == null) return since;
  return `${s.status} — ${since}, review every ${s.ttlDays}d` +
    (s.overdueBy ? `, overdue by ${s.overdueBy}d` : '');
}

// --- querying --------------------------------------------------------------

const matchValue = (actual, want) => {
  const a = String(actual ?? '').toLowerCase();
  const w = String(want ?? '').toLowerCase();
  return a === w || a.includes(w);
};

/**
 * Every page of a type, optionally filtered on its fields.
 * `where` matches case-insensitively on substrings, because a wiki's field
 * values are written by humans and will not be normalised.
 */
export async function queryPages({ type, where = {}, tag, limit = 100 } = {}) {
  const types = await loadTypes();
  const out = [];
  for (const slug of await wiki.listSlugs()) {
    const page = await wiki.readPage(slug);
    if (!page) continue;
    const declared = String(page.meta?.type || '').toLowerCase();
    if (type && declared !== String(type).toLowerCase()) continue;
    if (tag && !page.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;

    const fields = fieldsOf(page);
    const hit = Object.entries(where).every(([k, v]) => matchValue(fields[k], v));
    if (!hit) continue;

    out.push({
      slug: page.slug,
      title: page.title,
      type: declared || null,
      tags: page.tags,
      fields,
      summary: page.meta.summary || '',
      staleness: stalenessOf(page, types),
      conformance: checkPage(page, types),
    });
  }
  return out.slice(0, limit);
}

/** Type registry plus how many pages carry each type. */
export async function typeReport() {
  const types = await loadTypes();
  const counts = new Map();
  const untyped = [];
  const problems = [];

  for (const slug of await wiki.listSlugs()) {
    const page = await wiki.readPage(slug);
    if (!page) continue;
    const c = checkPage(page, types);
    if (!c.type) {
      untyped.push(slug);
      continue;
    }
    counts.set(c.type, (counts.get(c.type) || 0) + 1);
    if (!c.ok) problems.push({ slug, ...c });
  }

  return {
    types: [...types.values()].map((t) => ({ ...t, count: counts.get(t.type) || 0 })),
    unknownTypes: [...counts.keys()].filter((t) => !types.has(t)),
    untyped,
    problems,
  };
}

/** Pages whose freshness has lapsed, worst first. */
/**
 * Every page with its freshness, unfiltered.
 *
 * staleReport() answers "what needs checking", which is the actionable half and
 * deliberately drops everything that is fine. The other half is a real question
 * too — "what can I rely on" — and it cannot be answered from a report that
 * excludes the answer. Both now come from here.
 *
 * Uses the same index path: freshness is computed from frontmatter alone, so a
 * whole-wiki freshness sweep never has to open a page.
 */
export async function freshnessReport({ state = null } = {}) {
  const types = await loadTypes();
  const want = state && state !== 'all' ? String(state) : null;
  const out = [];

  const push = (row, s) => {
    if (want && s.status !== want) return;
    out.push({ slug: row.slug, title: row.title, type: row.type || null, ...s });
  };

  // listPages rather than indexFreshnessRows: that query excludes pages with
  // neither a type nor a ttl, which is right for "what is overdue" — nothing is
  // overdue without a schedule — and wrong here, because those pages are exactly
  // the `untracked` state this report exists to show. listPages is also
  // index-backed, carries the same columns, and already drops pulled pages.
  for (const r of await wiki.listPages({})) {
    push(
      r,
      stalenessOf(
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
      )
    );
  }
  return sortByUrgency(out);
}

// Most overdue first. `fresh` sorts by how recently it was confirmed instead,
// because on that list the top of the page should be what you can trust most.
const URGENCY = { stale: 4, aging: 3, untracked: 2, fresh: 1, unknown: 0 };
const sortByUrgency = (rows) =>
  rows.sort(
    (a, b) =>
      (URGENCY[b.status] || 0) - (URGENCY[a.status] || 0) ||
      (a.status === 'fresh'
        ? (a.verifiedDays ?? 1e9) - (b.verifiedDays ?? 1e9)
        : (b.overdueBy || 0) - (a.overdueBy || 0))
  );

export async function staleReport({ includeUntracked = false } = {}) {
  const types = await loadTypes();
  const out = [];

  // Freshness is computed from frontmatter alone, so the index can answer it
  // without opening a page. Pages carrying neither a ttl nor a type are excluded
  // by the query rather than read and discarded.
  try {
    await wiki.ensureIndex();
    const rows = await wiki.indexFreshnessRows();
    if (rows) {
      for (const r of rows) {
        const s = stalenessOf(
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
        );
        if (s.status === 'stale' || s.status === 'aging' || (includeUntracked && s.status === 'untracked')) {
          out.push({ slug: r.slug, title: r.title, type: r.type || null, ...s });
        }
      }
      const byRank = { stale: 3, aging: 2, untracked: 1 };
      return out.sort((a, b) => (byRank[b.status] || 0) - (byRank[a.status] || 0) || b.overdueBy - a.overdueBy);
    }
  } catch {
    // Index unavailable — walk the files instead.
  }

  for (const slug of await wiki.listSlugs()) {
    const page = await wiki.readPage(slug);
    if (!page) continue;
    const s = stalenessOf(page, types);
    if (s.status === 'stale' || s.status === 'aging' || (includeUntracked && s.status === 'untracked')) {
      out.push({ slug: page.slug, title: page.title, type: page.meta?.type || null, ...s });
    }
  }
  const rank = { stale: 3, aging: 2, untracked: 1 };
  return out.sort((a, b) => (rank[b.status] || 0) - (rank[a.status] || 0) || b.overdueBy - a.overdueBy);
}
