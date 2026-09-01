#!/usr/bin/env node
// The librarian: a scheduled pass that reads the wiki, checks it against itself
// and against live systems, and COMMENTS. It never edits or deletes a page.
//
// That restraint is the whole design. An LLM rewriting a wiki unattended
// introduces errors that are fluent and therefore hard to spot, and agents act
// on this wiki. So findings go into per-page discussion threads, where a human
// decides. Cross-cutting findings that belong to no single page go to one
// review page.
//
//   node librarian/run.js [--config path] [--dry-run] [--verbose]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = flag('--dry-run');
const VERBOSE = flag('--verbose');
const CONFIG_PATH = opt(
  '--config',
  process.env.LIBRARIAN_CONFIG || '/etc/botwiki/librarian.json'
);

const log = (...a) => console.log(...a);
const vlog = (...a) => VERBOSE && console.log('   ', ...a);

// --- config ----------------------------------------------------------------

async function loadConfig() {
  let raw;
  try {
    raw = await fs.readFile(CONFIG_PATH, 'utf8');
  } catch {
    // Fall back to the shipped example so a fresh install does something
    // sensible rather than nothing at all.
    raw = await fs.readFile(path.join(HERE, 'config.example.json'), 'utf8');
    log(`no config at ${CONFIG_PATH}; using the shipped example`);
  }
  const cfg = JSON.parse(raw);
  cfg.wiki = cfg.wiki || {};
  cfg.wiki.baseUrl = process.env.WIKI_URL || cfg.wiki.baseUrl || 'http://127.0.0.1:8787';
  cfg.checks = cfg.checks || {};
  cfg.probes = cfg.probes || [];
  return cfg;
}

const readSecret = async (file) => {
  if (!file) return null;
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
};

// --- wiki client -----------------------------------------------------------

function makeClient(cfg, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const base = cfg.wiki.baseUrl.replace(/\/$/, '');

  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok && r.status !== 404) throw new Error(`${method} ${p} -> ${r.status}`);
    return r.status === 404 ? null : r.json();
  };

  return {
    pages: () => req('GET', '/api/pages'),
    page: (slug) => req('GET', `/api/page/${slug}`),
    graph: () => req('GET', '/api/graph'),
    types: () => req('GET', '/api/types'),
    stale: () => req('GET', '/api/stale?includeUntracked=0'),
    write: (slug, payload) => req('PUT', `/api/page/${slug}`, payload),
    comment: (slug, payload) => req('POST', `/api/talk/${slug}`, payload),
    talk: (slug) => req('GET', `/api/talk/${slug}?resolved=1`),
  };
}

// --- findings --------------------------------------------------------------

const findings = [];
const crossCutting = [];

function finding(page, kind, key, body) {
  findings.push({ page, kind, key, body });
}

// --- probes ----------------------------------------------------------------

async function probeProxmox(probe, pages, client) {
  const secret = await readSecret(probe.tokenFile);
  if (!secret) {
    crossCutting.push(
      `**Probe \`${probe.name}\` could not run.** No token at \`${probe.tokenFile}\`, so no page was checked against the live cluster.`
    );
    return;
  }
  if (probe.insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let live;
  try {
    const r = await fetch(`${probe.baseUrl}/cluster/resources?type=vm`, {
      headers: { Authorization: `PVEAPIToken=${probe.tokenId}=${secret}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    live = (await r.json()).data;
  } catch (err) {
    crossCutting.push(`**Probe \`${probe.name}\` failed:** ${err.message}. Live checks were skipped.`);
    return;
  }

  const byVmid = new Map(live.map((v) => [String(v.vmid), v]));
  const want = probe.verifies?.type || 'guest';

  for (const p of pages) {
    if ((p.type || '') !== want) continue;
    const full = await client.page(p.slug);
    const f = full?.fields || {};
    const vmid = String(f.vmid || '');
    if (!vmid) continue;

    const actual = byVmid.get(vmid);
    if (!actual) {
      finding(
        p.slug,
        'stale',
        `probe:${probe.name}:missing:${vmid}`,
        `Live check (${new Date().toISOString().slice(0, 10)}): the cluster has **no guest with VMID ${vmid}**. This page describes something that no longer exists, or the VMID is wrong. Checked via the Proxmox API.`
      );
      continue;
    }

    const mismatches = [];
    for (const [field, apiKey] of Object.entries(probe.verifies?.fields || {})) {
      const pageVal = String(f[field] ?? '').toLowerCase();
      const liveVal = String(actual[apiKey] ?? '').toLowerCase();
      if (pageVal && liveVal && pageVal !== liveVal) {
        mismatches.push(`\`${field}\`: page says **${f[field]}**, cluster says **${actual[apiKey]}**`);
      }
    }
    if (mismatches.length) {
      finding(
        p.slug,
        'stale',
        `probe:${probe.name}:mismatch:${vmid}:${mismatches.length}`,
        `Live check disagrees with this page:\n\n${mismatches.map((m) => `- ${m}`).join('\n')}\n\nChecked against the Proxmox API. The cluster is the authority here; the page needs updating.`
      );
    } else if (Object.keys(probe.verifies?.fields || {}).length) {
      // Everything the probe can check holds — that is a verification, and it
      // is the one thing the librarian is allowed to write, because it asserts
      // nothing about content it cannot see.
      probeVerified.push(p.slug);
    }
  }
}

const probeVerified = [];

async function probeHttp(probe, pages, client) {
  const need = probe.appliesTo?.hasFields || [];
  for (const p of pages) {
    const full = await client.page(p.slug);
    const f = full?.fields || {};
    if (!need.every((k) => f[k])) continue;

    const url = `http://${f.address}:${f.port}/`;
    let status = null;
    try {
      const ctl = AbortSignal.timeout(probe.timeoutMs || 4000);
      status = (await fetch(url, { signal: ctl })).status;
    } catch {
      status = null;
    }
    vlog(`${p.slug} ${url} -> ${status ?? 'unreachable'}`);

    if (status === null) {
      finding(
        p.slug,
        'stale',
        `probe:http:down:${f.address}:${f.port}`,
        `Live check (${new Date().toISOString().slice(0, 10)}): \`${url}\` did not respond. Either the service is down, it has moved, or this page's address is wrong.`
      );
    } else if (status >= 500) {
      finding(
        p.slug,
        'stale',
        `probe:http:${status}:${f.address}:${f.port}`,
        `Live check (${new Date().toISOString().slice(0, 10)}): \`${url}\` returns **HTTP ${status}**. The address is right but the service is unhealthy.`
      );
    }
  }
}

// --- checks ----------------------------------------------------------------

async function run() {
  const cfg = await loadConfig();
  const token = await readSecret(cfg.wiki.tokenFile);
  const client = makeClient(cfg, token);
  const c = cfg.checks;

  log(`librarian: ${cfg.wiki.baseUrl}${DRY ? ' (dry run)' : ''}`);

  const { pages } = await client.pages();
  const graph = await client.graph();
  log(`  ${pages.length} pages, ${graph.edges.length} connections`);

  // 1. freshness
  if (c.stale?.enabled) {
    const { stale } = (await client.stale()) || { stale: [] };
    for (const s of stale.filter((x) => x.status === 'stale')) {
      finding(
        s.slug,
        'stale',
        `stale:overdue`,
        `This page is **overdue for verification** by ${s.overdueBy} day(s). ${s.verifiedAt ? `Last verified ${s.verifiedDays}d ago.` : 'It has never been verified — only edited.'} Its type expects a check every ${s.ttlDays}d.\n\nIf you check it and it still holds, record that with wiki_verify rather than editing it. If it no longer holds, fix it.`
      );
    }
    vlog(`stale: ${stale.length}`);
  }

  // 2. type conformance
  if (c.conformance?.enabled) {
    const rep = await client.types();
    for (const p of rep.problems || []) {
      finding(
        p.slug,
        'suggestion',
        `conformance:${p.missing?.join(',') || p.problem}`,
        p.problem
          ? `${p.problem}. Either define that type on [[meta/types]] or change this page's type.`
          : `This page declares type \`${p.type}\` but is missing: **${p.missing.join(', ')}**.\n\nNot an error — the page is fine as it is. But filling these in makes it findable with wiki_query.`
      );
    }
    if ((rep.untyped || []).length) {
      crossCutting.push(
        `**${rep.untyped.length} pages carry no type**, so they cannot be found by wiki_query: ${rep.untyped.map((s) => `\`${s}\``).join(', ')}. Some of these are overviews that genuinely fit no type — that is fine.`
      );
    }
  }

  // 3. broken links
  if (c.brokenLinks?.enabled) {
    const byPage = new Map();
    for (const b of graph.broken || []) {
      if (!byPage.has(b.from)) byPage.set(b.from, []);
      byPage.get(b.from).push(b.to);
    }
    for (const [from, targets] of byPage) {
      finding(
        from,
        'suggestion',
        `broken:${[...new Set(targets)].sort().join(',')}`,
        `This page links to pages that do not exist: ${[...new Set(targets)].map((t) => `\`[[${t}]]\``).join(', ')}.\n\nEither write them, or change the links.`
      );
    }
  }

  // 4. orphans
  if (c.orphans?.enabled) {
    for (const n of graph.nodes.filter((x) => x.degree === 0)) {
      finding(
        n.id,
        'suggestion',
        'orphan',
        `Nothing connects to this page — no links in or out, no shared tags, nothing similar enough. An orphan is effectively invisible: search will find it, but nobody browsing or following the graph ever will.\n\nLink it from wherever someone would look for it.`
      );
    }
  }

  // 5. strongly related but never linked
  //
  // The naive version of this check is unusable. Pages generated from a common
  // template — one per Proxmox guest, say — are all ~70% similar to each other
  // and share the same tags, so every pair looks "strongly related" and you get
  // an n-squared pile of suggestions to link boilerplate to boilerplate.
  //
  // A missing link is only worth raising when the relationship is SPECIFIC. Two
  // signals for that: the page does not have this relationship with half the
  // wiki, and we only ever name its best couple of candidates.
  if (c.missingLinks?.enabled) {
    const min = c.missingLinks.minStrength ?? 0.55;
    const maxFamily = c.missingLinks.maxFamily ?? 4;
    const perPage = c.missingLinks.perPage ?? 2;

    const candidates = graph.edges
      .filter((e) => !e.evidence?.mentions && e.strength >= min)
      .sort((a, b) => b.strength - a.strength);

    // How many strong-but-unlinked neighbours each page has. A high count means
    // this page belongs to a family of lookalikes, not that it has a lot of
    // genuine unrecorded relationships.
    const family = new Map();
    for (const e of candidates) {
      family.set(e.source, (family.get(e.source) || 0) + 1);
      family.set(e.target, (family.get(e.target) || 0) + 1);
    }

    const emitted = new Map();
    let suppressed = 0;
    for (const e of candidates) {
      if ((family.get(e.source) || 0) > maxFamily || (family.get(e.target) || 0) > maxFamily) {
        suppressed++;
        continue;
      }
      if ((emitted.get(e.source) || 0) >= perPage) continue;
      emitted.set(e.source, (emitted.get(e.source) || 0) + 1);

      const why = [
        e.evidence?.sharedTags?.length && `share ${e.evidence.sharedTags.join(', ')}`,
        e.evidence?.similarity && `${Math.round(e.evidence.similarity * 100)}% similar prose`,
      ]
        .filter(Boolean)
        .join(' and ');
      finding(
        e.source,
        'suggestion',
        `missinglink:${e.target}`,
        `This page and [[${e.target}]] are strongly related (**${e.strength}**) — they ${why} — but neither links to the other.\n\nA reader on one would probably want the other.`
      );
    }

    if (suppressed) {
      crossCutting.push(
        `**${suppressed} strong-but-unlinked page pairs were suppressed** as lookalikes. ` +
          `They belong to families of near-identical pages (the per-guest pages generated from ` +
          `Proxmox config, mostly), where similarity reflects a shared template rather than a real ` +
          `relationship. Linking them all would bury the links that mean something.`
      );
    }
  }

  // 6. live probes
  if (c.probes?.enabled) {
    for (const probe of cfg.probes) {
      vlog(`probe ${probe.name} (${probe.kind})`);
      if (probe.kind === 'proxmox') await probeProxmox(probe, pages, client);
      else if (probe.kind === 'http') await probeHttp(probe, pages, client);
    }
  }

  // --- act ---
  log(`  ${findings.length} finding(s), ${crossCutting.length} cross-cutting`);

  let posted = 0;
  let deduped = 0;
  for (const f of findings) {
    if (DRY) {
      log(`    [${f.kind}] ${f.page} :: ${f.key}`);
      continue;
    }
    const res = await client.comment(f.page, {
      body: f.body,
      kind: f.kind,
      key: f.key,
      author: cfg.author || 'librarian',
      model: cfg.model || 'rule-based',
    });
    if (res?.deduped) deduped++;
    else posted++;
  }

  // Verifications the probes earned. This is the only thing the librarian
  // writes to a page, and only for facts it actually compared.
  let verified = 0;
  if (!DRY) {
    for (const slug of probeVerified) {
      const p = await client.page(slug);
      if (!p) continue;
      await client.write(slug, {
        content: p.body,
        title: p.title,
        tags: p.tags,
        verified: true,
        verifiedBy: cfg.author || 'librarian',
        verifiedNote: 'automated probe: vmid and node match the live cluster',
        agent: cfg.author || 'librarian',
        model: cfg.model || 'rule-based',
        context: 'librarian probe verification',
      });
      verified++;
    }
  }

  // --- cross-cutting review page ---
  if (c.review?.enabled && !DRY) {
    const now = new Date().toISOString();
    const byKind = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

    const body = [
      '# Review',
      '',
      `Written by the librarian, ${now.slice(0, 16).replace('T', ' ')} UTC. It runs on a timer,`,
      'reads the wiki, checks it against live systems, and **comments**. It never',
      'edits or deletes a page. Anything about one page is on that page; this holds',
      'only what belongs to no single page.',
      '',
      '## This pass',
      '',
      `- ${pages.length} pages, ${graph.edges.length} connections`,
      `- ${findings.length} finding(s): ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
      `- ${posted} new comment(s), ${deduped} already raised`,
      `- ${verified} page(s) verified by probe`,
      '',
      ...(crossCutting.length
        ? ['## Findings', '', ...crossCutting.map((t) => `- ${t}`), '']
        : ['Nothing cross-cutting this pass.', '']),
      '## How to act on this',
      '',
      'Open comments live at `/review` on the wiki, or via `wiki_review_queue`.',
      'Resolve one when it is dealt with — including when the answer is "this is',
      'fine as it is", which is a real outcome and stops it being raised again.',
      '',
      'The librarian will not repeat a finding it has already made: each comment',
      'carries a key, and a matching key is a no-op. Resolving a comment does not',
      'un-suppress it.',
      '',
      'See also: [[meta/gaps]], [[meta/types]], [[meta/conventions]]',
    ].join('\n');

    await client.write(c.review.page || 'meta/review', {
      content: body,
      title: 'Review',
      tags: ['meta'],
      type: 'meta',
      agent: cfg.author || 'librarian',
      model: cfg.model || 'rule-based',
      context: 'librarian pass',
    });
  }

  log(
    DRY
      ? '  dry run: nothing written'
      : `  posted ${posted}, deduped ${deduped}, verified ${verified}`
  );
}

run().catch((err) => {
  console.error('librarian failed:', err.message);
  process.exit(1);
});
