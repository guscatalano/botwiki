#!/usr/bin/env node
// botwiki web server: browser UI for humans + a plain JSON API for agents that
// speak HTTP rather than MCP.
//
// Env: WIKI_HOST, WIKI_PORT, WIKI_TOKEN, WIKI_READONLY, WIKI_DIR, WIKI_TITLE

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import * as wiki from '../lib/wiki.js';
import { buildGraph, relatedTo } from '../lib/graph.js';
import * as talk from '../lib/talk.js';
import * as types from '../lib/types.js';
import { find } from '../lib/find.js';
import * as history from '../lib/history.js';
import { graphPageHtml } from './graph-page.js';
import { TOKENS } from './theme.js';

const HOST = process.env.WIKI_HOST || '0.0.0.0';
const PORT = Number(process.env.WIKI_PORT || 8787);
const TOKEN = process.env.WIKI_TOKEN || '';
const READONLY = /^(1|true|yes)$/i.test(process.env.WIKI_READONLY || '');
const SITE = process.env.WIKI_TITLE || 'botwiki';
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WIKI_TRUST_PROXY || '');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Only believe X-Forwarded-For when something in front is actually setting it;
// otherwise any client could name its own address in the edit record.
const clientIp = (req) =>
  (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
  req.socket.remoteAddress;

// Vendored browser libraries. An explicit allow-list — never a path built from
// the request — so /vendor/ cannot be walked into node_modules at large.
const VENDOR = {
  'd3.min.js': ['d3', 'dist', 'd3.min.js'],
  '3d-force-graph.min.js': ['3d-force-graph', 'dist', '3d-force-graph.min.js'],
};

// --- markdown --------------------------------------------------------------

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// [[wikilinks]] as a real inline extension rather than a pre-pass over the raw
// markdown — a regex replace would also rewrite them inside `code spans` and
// fenced blocks, mangling any page that documents the syntax.
const wikilink = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    return src.indexOf('[[');
  },
  tokenizer(src) {
    const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src);
    if (!m) return undefined;
    return {
      type: 'wikilink',
      raw: m[0],
      slug: wiki.slugify(m[1]),
      label: (m[2] || m[1]).trim(),
    };
  },
  renderer(token) {
    return `<a href="/w/${token.slug}">${esc(token.label)}</a>`;
  },
};

// Pages can be written by agents, so raw HTML in a page is shown as text rather
// than executed. Markdown still renders normally.
marked.use({
  gfm: true,
  breaks: false,
  extensions: [wikilink],
  renderer: {
    html(token) {
      return esc(typeof token === 'string' ? token : token.text);
    },
  },
});

const renderMarkdown = (body) => marked.parse(body);

// --- html shell ------------------------------------------------------------

const CSS = `
${TOKENS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header.top{border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
.wrap{max-width:900px;margin:0 auto;padding:0 22px}
header.top .wrap{display:flex;align-items:center;gap:16px;height:58px}
.brand{font-weight:650;letter-spacing:-.01em;color:var(--ink);font-size:16px;white-space:nowrap}
.brand span{color:var(--accent)}
form.search{flex:1;display:flex}
form.search input{width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
form.search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.nav{display:flex;gap:14px;font-size:14px;white-space:nowrap}
main{padding:34px 0 80px}
h1{font-size:29px;line-height:1.2;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:20px;margin:34px 0 10px;letter-spacing:-.01em}
h3{font-size:16px;margin:26px 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:26px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.tag{display:inline-block;padding:1px 9px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:550}
.prose{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:26px 30px}
.prose>:first-child{margin-top:0}
.prose>:last-child{margin-bottom:0}
.prose code{background:var(--code);padding:1.5px 5px;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.prose pre{background:var(--code);padding:14px 16px;border-radius:9px;overflow-x:auto;border:1px solid var(--line)}
.prose pre code{background:none;padding:0}
.prose blockquote{margin:0;padding:2px 16px;border-left:3px solid var(--line);color:var(--muted)}
.prose table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
.prose th,.prose td{border:1px solid var(--line);padding:7px 11px;text-align:left}
.prose img{max-width:100%}
ul.pages{list-style:none;padding:0;margin:0;display:grid;gap:2px}
ul.pages li{padding:13px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:8px}
ul.pages .t{font-weight:600}
ul.pages .s{color:var(--muted);font-size:13.5px;margin-top:3px}
ul.pages .k{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0 28px}
.btn{display:inline-block;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.btn:hover{text-decoration:none;border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--warn)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.editor{display:grid;gap:12px}
.editor input,.editor textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit}
.editor textarea{min-height:60vh;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;line-height:1.6;resize:vertical}
label{font-size:13px;color:var(--muted);display:block;margin-bottom:4px}
.empty{color:var(--muted);padding:40px 0;text-align:center}
.hint{color:var(--muted);font-size:13px}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;padding:18px 0;margin-top:40px}
footer code{font-family:ui-monospace,Menlo,monospace}
.missing{color:var(--warn)}
.prov{margin:18px 0 0;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);font-size:12.5px;color:var(--muted)}
.prov-l b{color:var(--ink);font-weight:600}
.prov-l code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.prov .model{display:inline-block;padding:0 7px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:11.5px;font-weight:550}
.prov-why{margin-top:6px;color:var(--ink);font-style:italic}
.prov-note{margin-top:7px;padding-top:6px;border-top:1px solid var(--line);font-size:11.5px;opacity:.85}
.talk{margin-top:34px}
.cmt{border:1px solid var(--line);border-radius:10px;padding:13px 15px;margin-bottom:10px;background:var(--panel)}
.cmt.resolved{opacity:.55}
.cmt-h{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:7px}
.kind{padding:1px 8px;border-radius:99px;font-size:11px;font-weight:650;letter-spacing:.02em;text-transform:uppercase}
.k-note{background:var(--accent-soft);color:var(--accent)}
.k-question{background:#dbeafe;color:#1d4ed8}
.k-stale{background:#fef3c7;color:#b45309}
.k-contradiction{background:#fee2e2;color:#b91c1c}
.k-suggestion{background:#dcfce7;color:#15803d}
@media (prefers-color-scheme:dark){.k-question{background:#1e3a5f;color:#93c5fd}.k-stale{background:#422006;color:#fcd34d}.k-contradiction{background:#450a0a;color:#fca5a5}.k-suggestion{background:#052e16;color:#86efac}}
.cmt-b{font-size:14px;white-space:pre-wrap;line-height:1.6}
.cmt-b code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:.9em}
.cmt-id{font-family:ui-monospace,Menlo,monospace;font-size:11px;opacity:.6}
.cmt-res{margin-top:8px;padding-top:7px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.cmt-f{margin-left:auto;display:flex;gap:8px}
.mini{padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--muted);font-size:11.5px;cursor:pointer}
.mini:hover{border-color:var(--accent);color:var(--accent)}
.newc{border:1px dashed var(--line);border-radius:10px;padding:13px 15px;margin-top:12px}
.newc textarea{width:100%;min-height:76px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13.5px;resize:vertical}
.newc select{padding:6px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px}
.newc .row{margin-top:9px}
.badge{display:inline-block;padding:0 7px;border-radius:99px;background:var(--warn);color:#fff;font-size:11px;font-weight:650;margin-left:6px}
.rev{display:grid;grid-template-columns:auto 1fr;gap:0 14px;border-left:2px solid var(--line);padding:0 0 16px 16px;margin-left:6px;position:relative}
.rev::before{content:'';position:absolute;left:-6px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--bg)}
.rev.snap::before{background:var(--line)}
.rev .when{grid-column:1/-1;font-size:12px;color:var(--muted)}
.rev .who{grid-column:1/-1;margin-top:3px;font-size:13.5px}
.rev .who b{font-weight:620}
.rev .mdl{display:inline-block;padding:0 7px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:11.5px;font-weight:550}
.rev .why{grid-column:1/-1;margin-top:4px;font-size:13px;font-style:italic;color:var(--ink)}
.rev .meta2{grid-column:1/-1;margin-top:4px;font-size:11.5px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
.rev a.diff{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.patch{background:var(--code);border:1px solid var(--line);border-radius:9px;padding:13px 15px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5;white-space:pre}
.patch .add{color:#15803d}
.patch .del{color:#b91c1c}
.patch .hunk{color:var(--accent)}
@media (prefers-color-scheme:dark){.patch .add{color:#86efac}.patch .del{color:#fca5a5}}
.str{float:right;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.bar{display:inline-block;width:54px;height:5px;border-radius:99px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
`;

let openTotal = 0;   // refreshed per request in route(); only affects the nav badge

function layout(title, bodyHtml, { q = '' } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(SITE)}</title><style>${CSS}</style></head>
<body><header class="top"><div class="wrap">
<a class="brand" href="/">${esc(SITE)}<span>.</span></a>
<form class="search" action="/search"><input name="q" value="${esc(q)}" placeholder="Search the wiki…" autocomplete="off"></form>
<nav class="nav"><a href="/">All pages</a><a href="/graph">Graph</a><a href="/review">Review${openTotal ? `<span class="badge">${openTotal}</span>` : ''}</a><a href="/changes">Changes</a>${READONLY ? '' : '<a href="/new">New</a>'}</nav>
</div></header><main><div class="wrap">${bodyHtml}</div></main>
<footer><div class="wrap">Markdown in <code>${esc(wiki.PAGES_DIR)}</code> · agents query this wiki over MCP${READONLY ? ' · read-only' : ''}</div></footer>
</body></html>`;
}

const tagChips = (tags) =>
  tags.length
    ? `<div class="chips">${tags
        .map((t) => `<a class="tag" href="/search?q=${encodeURIComponent(t.tag || t)}">${esc(t.tag || t)}${t.count ? ` ${t.count}` : ''}</a>`)
        .join('')}</div>`
    : '';

const REL_LABEL = {
  link: 'linked',
  tag: 'shared tag',
  similar: 'similar content',
};

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return esc(String(iso).slice(0, 10));
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 20160) return `${Math.round(mins / 1440)}d ago`;
  return d.toISOString().slice(0, 10);
};

// The edit record, with the observed half visually separated from the claimed
// half. An agent can put anything in agent/model/reason, and the page should not
// pretend otherwise.
const provenanceBar = (p) => {
  if (!p) return '';
  const o = p.observed, c = p.claimed;
  const bits = [];
  if (c.agent) bits.push(`<b>${esc(c.agent)}</b>`);
  if (c.model) bits.push(`<span class="model">${esc(c.model)}</span>`);
  if (o.ip) bits.push(`from <code>${esc(o.ip)}</code>`);
  if (o.via) bits.push(`via ${esc(o.via)}`);
  if (!bits.length) return '';
  const claimed = Object.keys(c).length;
  return `<div class="prov">
<div class="prov-l">${bits.join(' · ')}${p.at ? ` · ${when(p.at)}` : ''}</div>
${c.context ? `<div class="prov-why">“${esc(c.context)}”</div>` : ''}
${claimed ? `<div class="prov-note" title="The server observes the address and transport. Everything else is whatever the editing client said about itself.">agent, model and reason are self-reported — only the address and transport are observed</div>` : ''}
</div>`;
};

// Show not just what is related, but why — an inferred edge and an asserted one
// deserve different amounts of trust.
const because = (r) => {
  const e = r.evidence || {};
  const bits = [];
  if (e.mentions) bits.push(`${e.mentions} link${e.mentions > 1 ? 's' : ''}${e.mutual ? ', mutual' : ''}`);
  if (e.sharedTags?.length) bits.push(`shares ${e.sharedTags.join(', ')}`);
  if (e.similarity) bits.push(`${Math.round(e.similarity * 100)}% similar`);
  return bits.join(' · ') || REL_LABEL[r.type];
};

const relatedList = (rel, slug) =>
  rel.length
    ? `<h2>Related</h2><ul class="pages">${rel
        .map(
          (r) => `<li><div class="t"><a href="/w/${esc(r.slug)}">${esc(r.title)}</a>
<span class="str"><span class="bar"><i style="width:${Math.round(r.strength * 100)}%"></i></span>${Math.round(r.strength * 100)}</span></div>
<div class="k">${esc(r.slug)} · ${esc(because(r))}</div></li>`
        )
        .join('')}</ul>
<p class="hint"><a href="/graph#${esc(slug)}">See this in the graph →</a></p>`
    : `<p class="hint" style="margin-top:28px">Nothing links here yet. <a href="/graph">See the graph</a>.</p>`;

const KIND_HINT = {
  note: '',
  question: 'needs a human answer',
  stale: 'page disagrees with reality',
  contradiction: 'page disagrees with another page',
  suggestion: 'a change worth making',
};

// The discussion thread. Deliberately below the page and visually distinct — it
// is commentary about the page, never part of what the page asserts.
const talkThread = (slug, comments) => {
  const open = comments.filter((c) => c.status !== 'resolved');
  const done = comments.filter((c) => c.status === 'resolved');
  const one = (c) => `<div class="cmt${c.status === 'resolved' ? ' resolved' : ''}" id="${esc(c.id)}">
<div class="cmt-h"><span class="kind k-${esc(c.kind)}">${esc(c.kind)}</span>
<span><strong>${esc(c.author)}</strong>${c.model ? ` · ${esc(c.model)}` : ''}${c.via ? ` · via ${esc(c.via)}` : ''}${c.ip ? ` · ${esc(c.ip)}` : ''}</span>
<span>· ${when(c.at)}</span><span class="cmt-id">${esc(c.id)}</span>
${
  READONLY
    ? ''
    : `<span class="cmt-f"><form method="post" action="/talk/${esc(slug)}/${c.status === 'resolved' ? 'reopen' : 'resolve'}">
<input type="hidden" name="id" value="${esc(c.id)}">
<button class="mini" type="submit">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></form></span>`
}</div>
<div class="cmt-b">${esc(c.body)}</div>
${c.resolution ? `<div class="cmt-res">Resolved: ${esc(c.resolution)}</div>` : ''}
</div>`;

  return `<div class="talk"><h2>Discussion${open.length ? `<span class="badge">${open.length} open</span>` : ''}</h2>
${
  comments.length
    ? open.map(one).join('') +
      (done.length
        ? `<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">${done.length} resolved</summary><div style="margin-top:10px">${done.map(one).join('')}</div></details>`
        : '')
    : '<p class="hint">Nothing has been raised about this page.</p>'
}
${
  READONLY
    ? ''
    : `<form class="newc" method="post" action="/talk/${esc(slug)}/add">
<textarea name="body" placeholder="Raise something about this page — a doubt, a question, something that has gone stale. The page itself stays unchanged." required></textarea>
<div class="row"><select name="kind">${Object.entries(KIND_HINT)
        .map(([k, h]) => `<option value="${k}">${k}${h ? ` — ${h}` : ''}</option>`)
        .join('')}</select>
<button class="btn primary" type="submit">Comment</button></div></form>`
}</div>`;
};

const pageList = (pages) =>
  pages.length
    ? `<ul class="pages">${pages
        .map(
          (p) => `<li><div class="t"><a href="/w/${esc(p.slug)}">${esc(p.title)}</a></div>
${p.summary || p.snippet ? `<div class="s">${esc(p.summary || p.snippet)}</div>` : ''}
<div class="k">${esc(p.slug)}${p.tags?.length ? ` · ${p.tags.map(esc).join(', ')}` : ''}</div></li>`
        )
        .join('')}</ul>`
    : `<div class="empty">Nothing here yet.${READONLY ? '' : ' <a href="/new">Write the first page</a>.'}</div>`;

// --- http plumbing ---------------------------------------------------------

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
const html = (res, body, status = 200) => send(res, status, 'text/html; charset=utf-8', body);
const json = (res, data, status = 200) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data, null, 2));
const redirect = (res, to) => {
  res.writeHead(302, { location: to });
  res.end();
};

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

// Bearer header for API clients; ?token=… (stored in a cookie) for the browser.
function checkAuth(req, res, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7).trim() === TOKEN) return true;
  if (req.headers['x-api-key'] === TOKEN) return true;
  const qt = url.searchParams.get('token');
  if (qt === TOKEN) {
    url.searchParams.delete('token');
    res.setHeader(
      'set-cookie',
      `botwiki_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
    );
    redirect(res, url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ''));
    return false;
  }
  if (cookies(req).botwiki_token === TOKEN) return true;

  if ((req.headers.accept || '').includes('text/html')) {
    html(
      res,
      layout(
        'Locked',
        `<h1>Locked</h1><p class="hint">This wiki requires a token. Open it as <code>?token=YOUR_TOKEN</code> once and it is remembered on this device.</p>`
      ),
      401
    );
  } else {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, { error: 'unauthorized' }, 401);
  }
  return false;
}

// --- routes ----------------------------------------------------------------

async function route(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';
  if (!p.startsWith('/api/') && !p.startsWith('/vendor/')) {
    try { openTotal = (await talk.allOpen()).length; } catch { openTotal = 0; }
  }

  if (p === '/healthz') return json(res, { ok: true, pages: wiki.PAGES_DIR, readOnly: READONLY });
  if (!checkAuth(req, res, url)) return;

  // ---- JSON API (for agents that speak HTTP instead of MCP) ----
  if (p === '/api/pages') return json(res, { pages: await wiki.listPages({ tag: url.searchParams.get('tag') || undefined }) });
  if (p === '/api/tags') return json(res, { tags: await wiki.allTags() });
  if (p === '/api/graph') {
    return json(
      res,
      await buildGraph({
        includeSimilar: url.searchParams.get('similar') !== '0',
        includeTags: url.searchParams.get('tags') !== '0',
        minSimilarity: Number(url.searchParams.get('min')) || undefined,
      })
    );
  }
  if (p.startsWith('/api/talk/')) {
    const slug = p.slice('/api/talk/'.length);
    if (method === 'GET') {
      const all = await talk.listComments(slug);
      return json(res, {
        page: wiki.slugify(slug),
        open: all.filter((c) => c.status !== 'resolved').length,
        comments: url.searchParams.get('resolved') === '1' ? all : all.filter((c) => c.status !== 'resolved'),
      });
    }
    if (method === 'POST') {
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!(await wiki.readPage(slug))) return json(res, { error: 'not_found', page: slug }, 404);
      return json(res, await talk.addComment(slug, b.body ?? b.comment ?? '', {
        kind: b.kind, key: b.key, model: b.model, via: 'api', ip: clientIp(req),
        author: b.author || req.headers['user-agent'] || 'http client',
      }));
    }
    return json(res, { error: 'method_not_allowed' }, 405);
  }
  if (p === '/api/review') return json(res, { open: await talk.allOpen() });
  if (p.startsWith('/api/history/')) {
    const slug = p.slice('/api/history/'.length);
    return json(res, {
      page: wiki.slugify(slug),
      revisions: await history.historyOf(slug, {
        limit: Number(url.searchParams.get('limit')) || 25,
      }),
      contributors: await history.contributorsOf(slug),
    });
  }
  if (p === '/api/changes') {
    return json(res, {
      changes: await history.recentChanges({ limit: Number(url.searchParams.get('limit')) || 40 }),
    });
  }
  if (p === '/api/types') return json(res, await types.typeReport());
  if (p === '/api/stale') {
    return json(res, {
      stale: await types.staleReport({
        includeUntracked: url.searchParams.get('includeUntracked') === '1',
      }),
    });
  }
  if (p === '/api/query') {
    const where = {};
    for (const [k, v] of url.searchParams) {
      if (!['type', 'tag', 'limit'].includes(k)) where[k] = v;
    }
    return json(res, {
      results: await types.queryPages({
        type: url.searchParams.get('type') || undefined,
        tag: url.searchParams.get('tag') || undefined,
        limit: Number(url.searchParams.get('limit')) || 100,
        where,
      }),
    });
  }
  if (p === '/api/find') {
    return json(res, await find(url.searchParams.get('q') || '', {
      limit: Number(url.searchParams.get('limit')) || 5,
      type: url.searchParams.get('type') || undefined,
      tag: url.searchParams.get('tag') || undefined,
    }));
  }

  if (p.startsWith('/api/related/')) {
    const slug = p.slice('/api/related/'.length);
    const rel = await relatedTo(slug);
    if (!rel) return json(res, { error: 'not_found', page: slug }, 404);
    return json(res, { page: wiki.slugify(slug), related: rel });
  }
  if (p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    return json(res, {
      query: q,
      results: await wiki.search(q, {
        limit: Number(url.searchParams.get('limit')) || 10,
        tag: url.searchParams.get('tag') || undefined,
      }),
    });
  }
  if (p.startsWith('/api/page/')) {
    const slug = p.slice('/api/page/'.length);
    if (method === 'GET') {
      const doc = await wiki.readPage(slug);
      if (!doc) return json(res, { error: 'not_found', page: slug }, 404);
      const reg = await types.loadTypes();
      return json(res, {
        slug: doc.slug,
        title: doc.title,
        type: doc.type,
        tags: doc.tags,
        fields: types.fieldsOf(doc),
        updated: doc.updated,
        staleness: types.stalenessOf(doc, reg),
        conformance: types.checkPage(doc, reg),
        body: doc.body,
        backlinks: await wiki.backlinks(doc.slug),
      });
    }
    if (method === 'PUT' || method === 'POST') {
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      const payload = JSON.parse((await readBody(req)) || '{}');
      return json(
        res,
        await wiki.writePage(slug, payload.content ?? payload.body ?? '', {
          ...payload,
          provenance: {
            via: 'api',
            ip: clientIp(req),
            agent: payload.agent || req.headers['user-agent'] || 'http client',
            model: payload.model,
            context: payload.context,
          },
        })
      );
    }
    if (method === 'DELETE') {
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      return json(res, await wiki.deletePage(slug));
    }
    return json(res, { error: 'method_not_allowed' }, 405);
  }

  // ---- browser UI ----
  if (p === '/') {
    const pages = await wiki.listPages();
    const tags = await wiki.allTags();
    return html(
      res,
      layout(
        'All pages',
        `<h1>${esc(SITE)}</h1><p class="hint">${pages.length} page${pages.length === 1 ? '' : 's'} · agents read and write these over MCP.</p>
${tagChips(tags)}${pageList(pages)}`
      )
    );
  }

  if (p.startsWith('/talk/') && method === 'POST') {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    const rest = p.slice('/talk/'.length);
    const at = rest.lastIndexOf('/');
    const slug = rest.slice(0, at);
    const action = rest.slice(at + 1);
    const form = new URLSearchParams(await readBody(req));
    if (action === 'add') {
      await talk.addComment(slug, form.get('body') || '', {
        kind: form.get('kind') || 'note', via: 'web', ip: clientIp(req), author: 'browser',
      });
    } else if (action === 'resolve') {
      await talk.resolveComment(slug, form.get('id') || '', { by: 'browser' });
    } else if (action === 'reopen') {
      await talk.reopenComment(slug, form.get('id') || '');
    }
    return redirect(res, `/w/${slug}#discussion`);
  }

  if (p === '/review') {
    const open = await talk.allOpen();
    const byKind = {};
    for (const c of open) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    return html(res, layout('Review queue',
      `<h1>Review queue</h1><p class="hint">${open.length} open comment(s) across the wiki${
        open.length ? ' — ' + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') : ''
      }.</p>` +
      (open.length
        ? open.map((c) => `<div class="cmt"><div class="cmt-h"><span class="kind k-${esc(c.kind)}">${esc(c.kind)}</span>
<a href="/w/${esc(c.page)}#${esc(c.id)}"><strong>${esc(c.page)}</strong></a>
<span>· ${esc(c.author)}${c.model ? ` · ${esc(c.model)}` : ''} · ${when(c.at)}</span></div>
<div class="cmt-b">${esc(c.body)}</div></div>`).join('')
        : '<p class="hint">Nothing needs attention. Either the wiki is in good shape or nobody is looking.</p>')
    ));
  }

  if (p.startsWith('/history/')) {
    const slug = p.slice('/history/'.length);
    const doc = await wiki.readPage(slug);
    if (!doc) return html(res, layout('Not found', '<h1>No such page</h1>'), 404);
    const revs = await history.historyOf(slug, { limit: 40 });
    const who = await history.contributorsOf(slug);
    const rev = url.searchParams.get('rev');

    let patch = '';
    if (rev) {
      const raw = await history.diffOf(slug, rev);
      patch = raw
        ? `<h2>Change ${esc(rev.slice(0, 7))}</h2><div class="patch">${raw
            .split('\n')
            .map((l) =>
              l.startsWith('+') && !l.startsWith('+++') ? `<span class="add">${esc(l)}</span>`
              : l.startsWith('-') && !l.startsWith('---') ? `<span class="del">${esc(l)}</span>`
              : l.startsWith('@@') ? `<span class="hunk">${esc(l)}</span>`
              : esc(l)
            )
            .join('\n')}</div>`
        : '<p class="hint">That revision could not be read.</p>';
    }

    return html(res, layout(`History of ${doc.title}`,
      `<h1>History</h1><p class="hint"><a href="/w/${esc(doc.slug)}">${esc(doc.title)}</a> · ${revs.length} revision(s)</p>` +
      (who.length
        ? `<h2>Who has edited this</h2><ul class="pages">${who.map((c) =>
            `<li><div class="t">${esc(c.who)}<span class="str">${c.edits} edit${c.edits === 1 ? '' : 's'}</span></div>
<div class="k">${c.models.length ? esc(c.models.join(', ')) + ' · ' : ''}${when(c.last)}</div></li>`).join('')}</ul>`
        : '') +
      patch +
      `<h2>Revisions</h2>` +
      (revs.length
        ? revs.map((r) => {
            const pr = r.provenance || { observed: {}, claimed: {} };
            const agent = pr.claimed?.agent;
            const isSnap = /^snapshot /.test(r.subject || '');
            return `<div class="rev${isSnap ? ' snap' : ''}">
<div class="when">${when(r.at)} · ${esc(String(r.at).slice(0, 16).replace('T', ' '))}</div>
<div class="who">${agent ? `<b>${esc(agent)}</b>` : '<b>unrecorded</b>'}${
              pr.claimed?.model ? ` <span class="mdl">${esc(pr.claimed.model)}</span>` : ''
            }${pr.observed?.ip ? ` · from ${esc(pr.observed.ip)}` : ''}${
              pr.observed?.via ? ` · via ${esc(pr.observed.via)}` : ''
            }</div>
${pr.claimed?.context ? `<div class="why">"${esc(pr.claimed.context)}"</div>` : ''}
<div class="meta2">${esc(r.short)} · ${r.lines} lines · ${r.bytes} bytes · commit: ${esc(r.subject || '')}
 · <a class="diff" href="/history/${esc(doc.slug)}?rev=${esc(r.rev)}">diff</a></div>
</div>`;
          }).join('')
        : '<p class="hint">No history — the pages directory is not a git repo.</p>')
    ));
  }

  if (p === '/changes') {
    const changes = await history.recentChanges({ limit: 60 });
    return html(res, layout('Recent changes',
      `<h1>Recent changes</h1><p class="hint">Every commit that touched a page, newest first.</p>` +
      (changes.length
        ? changes.map((c) => `<div class="rev">
<div class="when">${when(c.at)} · ${esc(String(c.at).slice(0, 16).replace('T', ' '))}</div>
<div class="who">${esc(c.subject)}</div>
<div class="meta2">${esc(c.short)} · ${c.pages.map((s2) => `<a href="/history/${esc(s2)}">${esc(s2)}</a>`).join(', ')}</div>
</div>`).join('')
        : '<p class="hint">No history — the pages directory is not a git repo.</p>')
    ));
  }

  if (p === '/graph') return html(res, graphPageHtml({ site: SITE }));

  // d3 is vendored from node_modules rather than a CDN, so the graph still works
  // when the container has no route to the internet.
  if (p.startsWith('/vendor/')) {
    const file = VENDOR[p.slice('/vendor/'.length)];
    if (!file) return send(res, 404, 'application/javascript', '/* unknown vendor file */');
    try {
      const buf = await fs.readFile(path.join(HERE, '..', 'node_modules', ...file));
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'public, max-age=86400',
      });
      return res.end(buf);
    } catch {
      return send(res, 500, 'application/javascript', '/* not installed: run npm install */');
    }
  }

  if (p === '/search') {
    const q = url.searchParams.get('q') || '';
    const hits = q ? await wiki.search(q, { limit: 40 }) : [];
    return html(
      res,
      layout(
        `Search: ${q}`,
        `<h1>${hits.length} result${hits.length === 1 ? '' : 's'}</h1>
<p class="hint">for <strong>${esc(q)}</strong></p>${pageList(hits)}`,
        { q }
      )
    );
  }

  if (p === '/new') {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    return html(res, layout('New page', editorForm({ slug: url.searchParams.get('page') || '' })));
  }

  if (p.startsWith('/w/')) {
    const slug = p.slice(3);
    const doc = await wiki.readPage(slug);
    if (!doc) {
      const near = await wiki.search(slug.replace(/[/-]/g, ' '), { limit: 5 });
      return html(
        res,
        layout(
          'Not found',
          `<h1 class="missing">No page “${esc(slug)}”</h1>
${near.length ? `<p class="hint">Did you mean:</p>${pageList(near)}` : ''}
${READONLY ? '' : `<p><a class="btn primary" href="/new?page=${encodeURIComponent(wiki.slugify(slug))}">Create it</a></p>`}`
        ),
        404
      );
    }
    const rel = (await relatedTo(doc.slug, { limit: 10 })) || [];
    return html(
      res,
      layout(
        doc.title,
        `<h1>${esc(doc.title)}</h1>
<div class="meta"><span>${esc(doc.slug)}</span><span>·</span><span>updated ${esc(doc.updated.slice(0, 10))}</span>
${doc.tags.map((t) => `<a class="tag" href="/search?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
<span style="margin-left:auto"><a class="btn" href="/history/${esc(doc.slug)}">History</a>${
          READONLY ? '' : ` <a class="btn" href="/edit/${esc(doc.slug)}">Edit</a>`
        }</span></div>
<article class="prose">${renderMarkdown(doc.body)}</article>
${provenanceBar(doc.provenance)}
${relatedList(rel, doc.slug)}
<div id="discussion"></div>${talkThread(doc.slug, await talk.listComments(doc.slug))}`
      )
    );
  }

  if (p.startsWith('/edit/')) {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    const slug = p.slice('/edit/'.length);
    const doc = await wiki.readPage(slug);
    return html(
      res,
      layout(
        `Edit ${slug}`,
        editorForm({
          slug,
          title: doc?.title || '',
          tags: (doc?.tags || []).join(', '),
          body: doc?.body || '',
          existing: !!doc,
        })
      )
    );
  }

  if (p === '/save' && method === 'POST') {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    const form = new URLSearchParams(await readBody(req));
    const slug = wiki.slugify(form.get('slug') || '');
    if (!slug) return html(res, layout('Error', '<h1>A page name is required</h1>'), 400);
    await wiki.writePage(slug, form.get('body') || '', {
      title: form.get('title') || undefined,
      tags: form.get('tags') || undefined,
      provenance: {
        via: 'web',
        ip: clientIp(req),
        agent: 'browser',
        context: form.get('context') || undefined,
      },
    });
    return redirect(res, `/w/${slug}`);
  }

  if (p === '/delete' && method === 'POST') {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    const form = new URLSearchParams(await readBody(req));
    await wiki.deletePage(form.get('slug') || '');
    return redirect(res, '/');
  }

  return html(res, layout('Not found', '<h1>404</h1><p><a href="/">Back to all pages</a></p>'), 404);
}

function editorForm({ slug = '', title = '', tags = '', body = '', existing = false }) {
  return `<h1>${existing ? 'Edit' : 'New'} page</h1>
<form class="editor" method="post" action="/save">
<div><label>Page name (slug — folders allowed, e.g. runbooks/restore-db)</label>
<input name="slug" value="${esc(slug)}" ${existing ? 'readonly' : ''} required placeholder="hosts/pve-01"></div>
<div><label>Title</label><input name="title" value="${esc(title)}" placeholder="Human-readable title"></div>
<div><label>Tags (comma separated)</label><input name="tags" value="${esc(tags)}" placeholder="proxmox, runbook"></div>
<div><label>Why this edit? (recorded with your address in the page's edit record)</label>
<input name="context" placeholder="e.g. corrected the backup path after the restore failed"></div>
<div><label>Markdown — link other pages with [[slug]]</label><textarea name="body" spellcheck="false">${esc(body)}</textarea></div>
<div class="row"><button class="btn primary" type="submit">Save</button>
${existing ? `<a class="btn" href="/w/${esc(slug)}">Cancel</a>` : '<a class="btn" href="/">Cancel</a>'}</div>
</form>
${existing ? `<form method="post" action="/delete" onsubmit="return confirm('Delete ${esc(slug)}?')" style="margin-top:14px">
<input type="hidden" name="slug" value="${esc(slug)}"><button class="btn danger" type="submit">Delete page</button></form>` : ''}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await route(req, res, url);
  } catch (err) {
    console.error('[web]', err);
    if (!res.headersSent) {
      const msg = err instanceof wiki.WikiError ? err.message : 'Internal error';
      const status = err instanceof wiki.WikiError ? 400 : 500;
      if ((req.headers.accept || '').includes('text/html')) {
        html(res, layout('Error', `<h1>Error</h1><p>${esc(msg)}</p>`), status);
      } else {
        json(res, { error: msg }, status);
      }
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `botwiki web on http://${HOST}:${PORT}\n` +
      `  pages: ${wiki.PAGES_DIR}\n` +
      `  auth:  ${TOKEN ? 'token required' : 'NONE (set WIKI_TOKEN before exposing this)'}\n` +
      `  mode:  ${READONLY ? 'read-only' : 'read-write'}`
  );
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
