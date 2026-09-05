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
import { buildGraph, relatedTo, trimGraph } from '../lib/graph.js';
import * as talk from '../lib/talk.js';
import * as types from '../lib/types.js';
import { find } from '../lib/find.js';
import { coverage, namespaces } from '../lib/coverage.js';
import * as history from '../lib/history.js';
import * as revisions from '../lib/revisions.js';
import * as moderation from '../lib/moderation.js';
import * as tokens from '../lib/tokens.js';
import * as votes from '../lib/votes.js';
import * as stats from '../lib/stats.js';
import { graphPageHtml } from './graph-page.js';
import { MERMAID_JS, TOKENS, SKIN_CSS, MARKS, MARK_CSS, MASCOTS, MASCOT_CSS, PIP , faviconSvg, skinsFor, skinBoot, skinPicker, defaultSkinCss, skinJs } from './theme.js';

const HOST = process.env.WIKI_HOST || '0.0.0.0';
const PORT = Number(process.env.WIKI_PORT || 8787);
const TOKEN = process.env.WIKI_TOKEN || '';
const READONLY = /^(1|true|yes)$/i.test(process.env.WIKI_READONLY || '');
const SITE = process.env.WIKI_TITLE || 'botwiki';
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WIKI_TRUST_PROXY || '');

// Public mode. Off by default and deliberately so: a wiki on a LAN, behind a
// token, run by the person who wrote it, needs none of the abuse machinery and
// should not pay for it. Everything guarded by this flag is absent — not hidden,
// absent — from a private instance: no report link, no policy page, no routes.
const PUBLIC = /^(1|true|yes)$/i.test(process.env.WIKI_PUBLIC || '');
// How many nodes the graph ships unless asked otherwise. Enough to show the
// shape — hubs, clusters, the namespaces that talk to each other — without
// handing a browser a corpus-sized force simulation. The viewer raises it.
const GRAPH_DEFAULT_NODES = Math.max(0, Number(process.env.WIKI_GRAPH_NODES) || 300);

// Which skins this instance offers, and which it opens on.
//
// Per-instance because it is instance identity, not decoration: a private wiki
// and a public one that look alike are two wikis somebody eventually confuses,
// and the cost of confusing them is writing something internal onto the open
// internet. WIKI_SKINS=mesh,synth,lab and WIKI_SKIN=lab is what the homelab box
// runs; unset, an instance gets exactly the two skins it always had.
const INSTANCE_SKINS = skinsFor(process.env.WIKI_SKINS);
const DEFAULT_SKIN = INSTANCE_SKINS.some((s) => s.id === process.env.WIKI_SKIN)
  ? process.env.WIKI_SKIN
  : INSTANCE_SKINS[0].id;
const SKIN_BOOT = skinBoot(INSTANCE_SKINS, DEFAULT_SKIN);
const SKIN_PICKER = skinPicker(INSTANCE_SKINS);
const DEFAULT_SKIN_CSS = defaultSkinCss(DEFAULT_SKIN);
// The tab icon has to match too — it is the one part of the page a reader sees
// without looking at the page, and the tab is exactly where two wikis get mixed
// up. Served for the instance default, before any script can swap it.
const FAVICON = faviconSvg(DEFAULT_SKIN);
const SKIN_RUNTIME = skinJs(DEFAULT_SKIN);

// Teach the store which pages are pulled from view, so every read path — the
// twenty MCP tools, the JSON API, search, listings — inherits the check instead
// of each one remembering to make it.
if (PUBLIC) wiki.setHiddenLoader(() => moderation.quarantinedSlugs());
if (PUBLIC) wiki.setPublicMasking(true);
const ABUSE_CONTACT = process.env.WIKI_ABUSE_CONTACT || '';
const WRITE_RATE = Number(process.env.WIKI_WRITE_RATE || 6);

// On a public instance the token is what separates a contributor whose edits go
// live from a stranger whose edits are queued. It is not a wall around the wiki
// — reading needs nothing — it is the difference between trusted and unknown.
const trusted = (req, url) => {
  if (!TOKEN) return !PUBLIC;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7).trim() === TOKEN) return true;
  if (req.headers['x-api-key'] === TOKEN) return true;
  if (url?.searchParams.get('token') === TOKEN) return true;
  return cookies(req).botwiki_token === TOKEN;
};

/** Whatever credential the caller presented, from any of the places one can arrive. */
const presented = (req, url) => {
  const header = req.headers.authorization || '';
  return (
    (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
    String(req.headers['x-api-key'] || '').trim() ||
    url?.searchParams.get('token') ||
    cookies(req).botwiki_vtoken ||
    ''
  );
};

/**
 * May this caller write, and are they the operator?
 *
 * One rule for every path — the JSON API, the browser editor and MCP — because
 * three doors with three different locks is not a policy, it is whichever door
 * was written last. Writing needs *a* token; anyone can mint one in a single
 * request, so this is an identity to rate-limit and revoke against rather than a
 * gate. Deleting needs the operator's, everywhere, because it is the one action
 * with no undo.
 */
async function writer(req, url) {
  if (!PUBLIC) return { ok: true, trusted: true };
  if (trusted(req, url)) return { ok: true, trusted: true, tokenId: 'operator' };
  const cred = presented(req, url);
  if (cred) {
    // The id, not the token. It is what gets recorded against every page this
    // writer touches, so it has to be something safe to store and show.
    const v = await tokens.verify(cred);
    if (v) return { ok: true, trusted: false, tokenId: v.id };
  }
  return { ok: false, trusted: false };
}

/**
 * Does this look like a browser being made to request something by a page?
 *
 * The GET write endpoints exist so an agent whose only ability is fetching a URL
 * can still write. That same shape is what makes them a CSRF risk: an <img> tag
 * on any site would write here using the visitor's address. Ignoring the cookie
 * handles the case where a credential is required — the drive-by cannot know the
 * token — but a tokenless request that mints its own has no such protection, so
 * it needs this instead.
 *
 * Browsers state their intent in `Sec-Fetch-*` on every request and scripts
 * cannot forge those headers. Non-browser clients — curl, an agent's HTTP
 * library — send none at all, so they fall straight through. The check is
 * therefore precise in the direction that matters: it recognises the attack
 * without getting in the way of the callers this endpoint is for.
 *
 * Typing the URL into an address bar is `site: none, dest: document`, and stays
 * allowed. An <img> from elsewhere is `site: cross-site, dest: image`, and does not.
 */
function looksLikeDriveBy(req) {
  const site = req.headers['sec-fetch-site'];
  const dest = req.headers['sec-fetch-dest'];
  if (!site && !dest) return false; // not a browser
  if (site && site !== 'none' && site !== 'same-origin') return true;
  // Same-origin, but fetched as a subresource rather than navigated to.
  if (dest && dest !== 'document' && dest !== 'empty') return true;
  return false;
}

// A write result on its way out. The store reports the absolute file it wrote,
// which is genuinely useful on a private instance and is the server's directory
// layout on a public one — so it is dropped there rather than at the source.
const publicResult = (r) => {
  if (!PUBLIC || !r || typeof r !== 'object') return r;
  const { path: _path, ...rest } = r;
  return rest;
};

const needsToken = (res, asHtml) =>
  asHtml
    ? html(
        res,
        layout(
          'Get a token first',
          `<h1>Writing needs a token</h1>
<p>Anyone can have one — no signup, no approval, one request. It exists so a
change can be traced and, if it turns out to be abuse, revoked.</p>
<p><a class="btn primary" href="/token">Get a token</a></p>`
        ),
        401
      )
    : json(
        res,
        {
          error: 'unauthorized',
          message: 'Writing needs a token. Anyone can mint one: POST /api/token.',
        },
        401
      );
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
  'mermaid.min.js': ['mermaid', 'dist', 'mermaid.min.js'],
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

// URL schemes a page is allowed to produce.
//
// Escaping raw HTML is not enough on its own, because markdown has its own link
// and image syntax and those go straight through. Two things got past it:
//
//   [x](javascript:alert(1))            -> a live javascript: href. Stored XSS,
//                                          on a wiki whose pages agents write.
//   ![x](data:image/png;base64,...)     -> a rendered image. "There is no upload
//                                          path" was wrong; this is one.
//
// A URL with no scheme is a relative link and fine. A URL with a scheme must be
// one of these. Control characters are stripped before the test because a
// browser reads `java\tscript:` as `javascript:` and a naive check does not.
const HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
const ALLOWED_SCHEME = /^(https?|mailto):/i;
const safeHref = (href) => {
  const raw = String(href ?? '');
  const flat = raw.replace(/[\u0000-\u0020]/g, '');
  if (!HAS_SCHEME.test(flat)) return raw;
  return ALLOWED_SCHEME.test(flat) ? raw : null;
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
    // A ```mermaid fence is left as its own source, escaped, in a block the
    // client script renders. Nothing about what is stored changes: an agent
    // reading this page still gets "A --> B", which is the readable form.
    code(token) {
      const src = typeof token === 'string' ? token : token.text;
      const lang = (typeof token === 'object' && token.lang ? token.lang : '').trim().toLowerCase();
      if (lang === 'mermaid') return `<pre class="mermaid">${esc(src)}</pre>`;
      return `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(src)}</code></pre>`;
    },
    // Headings carry ids so a section can be linked to directly. On a wiki read
    // mostly by agents this is worth more than it looks: citing "the part of
    // that page about X" is otherwise a page reference plus a hope.
    heading(token) {
      const text = this.parser.parseInline(token.tokens || []);
      const base =
        text
          .replace(/<[^>]*>/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'section';
      // Two headings with the same words are common — "## Why" under three
      // different sections — and duplicate ids would silently send every link
      // to the first one.
      const n = (headingSeen?.get(base) || 0) + 1;
      headingSeen?.set(base, n);
      const id = n === 1 ? base : `${base}-${n}`;
      return `<h${token.depth} id="${esc(id)}">${text}</h${token.depth}>`;
    },
    link(token) {
      const href = safeHref(token.href);
      const text = this.parser.parseInline(token.tokens || []);
      // A blocked link keeps its text and shows the target, so nothing silently
      // disappears from a page — the reader can see what was there.
      if (href === null) return `${text} <span class="blocked" title="blocked scheme">[${esc(token.href)}]</span>`;
      return `<a href="${esc(href)}"${token.title ? ` title="${esc(token.title)}"` : ''}>${text}</a>`;
    },
    image(token) {
      const href = safeHref(token.href);
      // A data: URI is not a link to an image, it IS the image — the page is
      // hosting the bytes. Never render one, in either mode.
      if (href === null) {
        return `<span class="blocked" title="embedded or unsafe image blocked">[image blocked: ${esc(
          String(token.href).slice(0, 24)
        )}…]</span>`;
      }
      // On a public instance remote images are not loaded either: they are
      // third-party content on someone else's server, which can change after
      // review and which fetches the reader's address on page load.
      if (PUBLIC) {
        return `<a href="${esc(href)}" rel="noopener nofollow ugc">${esc(token.text || href)}</a>`;
      }
      return `<img src="${esc(href)}" alt="${esc(token.text || '')}"${
        token.title ? ` title="${esc(token.title)}"` : ''
      }>`;
    },
  },
});

// Reset per render so heading ids are unique within a page and identical across
// two renders of the same page — an id that depended on what was rendered
// before it would make every deep link a race.
let headingSeen = null;
const renderMarkdown = (body) => {
  headingSeen = new Map();
  try {
    return marked.parse(body);
  } finally {
    headingSeen = null;
  }
};

// The page's own creature, carrying that page's freshness. Same three drawings
// as everywhere else; the state drives the iris, the limbs and the colour, so a
// stale page looks stale before anyone reads a date.
const mascotBox = (staleness, { size = 64, cls = '' } = {}) =>
  `<span class="msbox ${cls}" data-state="${esc(staleness?.status || 'unknown')}" style="--ms:${Number(size)}px" title="${esc(
    types.describeStaleness(staleness) || 'freshness not tracked'
  )}">${MASCOTS}</span>`;

// --- html shell ------------------------------------------------------------

const CSS = `
${TOKENS}
/* After TOKENS, so it wins: whichever skin this instance defaults to also has to
   hold bare :root, which is what paints before the boot script runs. Empty when
   the default is mesh, which already declares it. */
${DEFAULT_SKIN_CSS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 var(--font-ui);-webkit-font-smoothing:antialiased}
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
.nav{display:flex;align-items:center;gap:14px;font-size:14px;white-space:nowrap}

/* The five views that are *about* the wiki rather than its content live behind
   one disclosure. Built on <details> deliberately: it opens, closes, and takes
   the keyboard without a line of JavaScript, and it still works on a page where
   the script never loads — which for a nav is the difference between a tidy
   menu and an unreachable one. */
.menu{position:relative}
.menu>summary{list-style:none;cursor:pointer;color:var(--accent);display:inline-flex;align-items:center;gap:5px}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary::after{content:'';border:4px solid transparent;border-top-color:currentColor;margin-top:3px}
.menu[open]>summary::after{transform:rotate(180deg);margin-top:-3px}
.menu>summary:hover{text-decoration:underline}
.menupanel{position:absolute;right:0;top:calc(100% + 9px);z-index:10;display:flex;flex-direction:column;min-width:170px;padding:6px;gap:1px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.32)}
.menupanel a{padding:7px 10px;border-radius:7px;color:var(--ink);display:flex;align-items:center;justify-content:space-between;gap:10px}
.menupanel a:hover{background:var(--accent-soft);color:var(--accent);text-decoration:none}
.navnew{border:1px solid var(--line);border-radius:8px;padding:5px 12px;color:var(--ink)}
.navnew:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
main{padding:34px 0 80px}
h1{font-size:29px;line-height:1.2;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:20px;margin:34px 0 10px;letter-spacing:-.01em}
h3{font-size:16px;margin:26px 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:26px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.tag{display:inline-block;padding:1px 9px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:550}
.tag.on{background:var(--accent);color:var(--bg)}
.chips .tag{padding:4px 12px;font-size:13px}
.prose{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:26px 30px}
.prose>:first-child{margin-top:0}
.prose>:last-child{margin-bottom:0}
.prose code{background:var(--code);padding:1.5px 5px;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.prose pre{background:var(--code);padding:14px 16px;border-radius:9px;overflow-x:auto;border:1px solid var(--line)}
.prose pre code{background:none;padding:0}
/* A diagram is not a code listing. Before it renders it is a fenced block and
   looks like one; once mermaid replaces the text with an SVG the code chrome
   would frame a picture, so it is dropped at that point. */
.prose pre.mermaid{text-align:center;line-height:1.4}
.prose pre.mermaid[data-processed]{background:none;border:0;padding:6px 0}
.prose pre.mermaid svg{max-width:100%;height:auto}
/* A drawn diagram becomes a viewport you can move around inside. Until the
   script enhances it the block above still renders normally, so a diagram is
   readable with no JavaScript at all — it just does not move. */
.prose pre.mermaid.dgm{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:0;margin:20px 0;touch-action:pan-y}
.prose pre.mermaid.dgm:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dgm-view{overflow:hidden;cursor:grab;display:flex;align-items:center;justify-content:center;min-height:120px}
.dgm-view.grabbing{cursor:grabbing}
.dgm-pan{transform-origin:0 0;will-change:transform}
.prose pre.mermaid.dgm svg{max-width:none}
.dgm-bar{position:absolute;top:8px;right:8px;display:flex;gap:4px;opacity:0;transition:opacity .15s;z-index:2}
.prose pre.mermaid.dgm:hover .dgm-bar,.prose pre.mermaid.dgm:focus-within .dgm-bar{opacity:1}
/* Not font:inherit — these live inside a <pre>, and the glyphs have patchy
   coverage in monospace faces. */
.dgm-bar button{width:28px;height:28px;display:grid;place-items:center;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI Symbol,sans-serif;font-size:15px;line-height:1;cursor:pointer}
.dgm-bar button:hover{border-color:var(--accent);color:var(--accent)}
.dgm-zoom{position:absolute;bottom:8px;right:10px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;opacity:0;transition:opacity .15s;pointer-events:none}
.prose pre.mermaid.dgm:hover .dgm-zoom,.prose pre.mermaid.dgm:focus-within .dgm-zoom{opacity:1}
.prose pre.mermaid.dgm:fullscreen{border-radius:0;border:0;background:var(--bg);display:flex;flex-direction:column}
.prose pre.mermaid.dgm:fullscreen .dgm-view{flex:1;min-height:0}
/* The toolbar is always visible on touch, where there is no hover to reveal it. */
@media (hover:none){.dgm-bar,.dgm-zoom{opacity:1}}
@media (prefers-reduced-motion:reduce){.dgm-bar,.dgm-zoom{transition:none}}
.prose blockquote{margin:0;padding:2px 16px;border-left:3px solid var(--line);color:var(--muted)}
.prose table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
.prose th,.prose td{border:1px solid var(--line);padding:7px 11px;text-align:left}
.prose img{max-width:100%}
ul.pages{list-style:none;padding:0;margin:0;display:grid;gap:2px}
ul.pages li{padding:13px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:8px}
ul.pages .t{font-weight:600;display:flex;align-items:center;gap:8px}
ul.pages .s{color:var(--muted);font-size:13.5px;margin-top:3px}
ul.pages .k{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0 28px}
/* Closed, the overflow is one more chip in the row. Open, it takes the full
   width and drops the rest underneath, so the row above does not reflow. */
.chipmore{display:inline-flex}
.chipmore[open]{flex:1 0 100%;display:block}
.chipmore summary{cursor:pointer;list-style:none;display:inline-block}
.chipmore summary::-webkit-details-marker{display:none}
.chipmore summary::marker{content:''}
.chipmore[open] summary{margin-bottom:4px}
.chips-rest{margin:8px 0 0}
.chips .tag.on{border-color:var(--accent);color:var(--accent)}
.chips .tag.clear{border-style:dashed;color:var(--muted)}
.histlink{margin-left:6px;padding:1px 6px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted);text-decoration:none}
.histlink:hover{border-color:var(--accent);color:var(--accent)}
.sepdot{margin:0 7px;color:var(--muted);opacity:.6}
.eyebrow{margin:0 0 2px;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
h1.subject{margin:0 0 6px;line-height:1.15}
h1.subject a{color:inherit;text-decoration:none}
h1.subject a:hover{color:var(--accent)}
table.timing{width:100%;border-collapse:collapse;margin:14px 0 26px;font-size:13px}
table.timing th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
table.timing td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line)}
table.timing td.n,table.timing th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
table.timing tr.slow td{color:var(--warn)}
table.timing tr.slow code{color:var(--warn)}
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
.warn{border-left:3px solid var(--warn);background:var(--accent-soft);padding:10px 14px;border-radius:4px}
.votebar{margin:18px 0 4px}
.votebar .row{display:flex;align-items:center;gap:8px}
.votenote{width:100%;margin-top:8px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px}
.votenote:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.btn.vote{padding:2px 10px;font-size:15px;line-height:1.5}
.btn.vote.on{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.score{font-variant-numeric:tabular-nums;font-weight:600;min-width:2.2em;text-align:center}
.score.pos{color:var(--accent)}
.score.neg{color:var(--warn)}
.score.even{color:var(--muted)}
.pages .t .score{margin-left:8px;font-size:12.5px;font-weight:600}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.stat .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--accent)}
.trends{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}
.trends h3{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px}
.spark{display:flex;align-items:flex-end;gap:2px;height:62px;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:6px}
.spark i{flex:1;min-width:2px;background:var(--accent);opacity:.75;border-radius:1px}
.spark i:hover{opacity:1}
.freshbar{display:flex;height:14px;border-radius:99px;overflow:hidden;background:var(--code);border:1px solid var(--line)}
.freshbar span{display:block}
.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:baseline}
.f-fresh{background:var(--accent)}
.f-aging{background:var(--muted)}
.f-stale{background:var(--warn)}
.f-untracked{background:var(--line)}
.statlist{list-style:none;padding:0;margin:0;counter-reset:s}
.statlist li{counter-increment:s;display:flex;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px solid var(--line)}
.statlist li::before{content:counter(s);color:var(--muted);font-size:11px;min-width:1.4em;font-variant-numeric:tabular-nums}
.statlist li a{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.statlist .n{font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent)}
.pagesize{margin:14px 0 0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
form.findform{display:flex;gap:8px;margin:16px 0 22px;flex-wrap:wrap}
form.findform input{flex:1 1 320px;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
form.findform input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
form.findform button{padding:9px 18px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--bg);font:inherit;font-size:14px;cursor:pointer}
form.findform button:hover{filter:brightness(1.1)}
.throttle{color:var(--muted)}
.throttle.on{color:var(--warn);font-weight:600}

/* --- narrow screens -------------------------------------------------------
   The desktop header is one nowrap row: brand, a flexible search field, eight
   nav links and the skin picker. That is roughly twice a phone's width, and
   because .nav sets white-space:nowrap it cannot wrap out of trouble on its
   own — it just pushes the page sideways. Everything below is that problem and
   the handful of others that only show up under a thumb. */
@media (max-width:720px){
  /* Stacked, and no longer sticky: wrapped onto three rows this header is over
     a third of a phone screen, and a nav bar that follows you down a page you
     are trying to read is not worth that much of it. */
  header.top{position:static}
  header.top .wrap{height:auto;flex-wrap:wrap;padding-top:10px;padding-bottom:10px;gap:10px 12px}
  .brand{order:1}
  .skins{order:2;margin-left:auto}
  form.search{order:3;flex:0 0 100%}
  .nav{order:4;flex:0 0 100%;flex-wrap:wrap;gap:6px 16px}
  .nav a{padding:5px 0}

  .wrap{padding:0 16px}
  main{padding:22px 0 60px}
  h1{font-size:24px}
  h2{font-size:18px;margin-top:26px}
  .prose{padding:18px 16px;border-radius:10px}

  /* A 78px creature floated beside a 24px heading leaves about eight characters
     of title. It stops floating and sits above the title instead. */
  .pagemascot{float:none;margin:0 0 10px}

  /* 16px is the threshold under which iOS zooms the viewport on focus — and it
     does not zoom back, so the reader is left scrolled sideways on a page that
     was fine a moment ago. No field here is worth that. */
  input,textarea,select{font-size:16px}

  /* Touch targets. 7px of padding is a 31px-high button, and the vote arrows
     were 2px, which is a target you aim at rather than press. */
  .btn{padding:10px 16px}
  .btn.vote{padding:8px 18px;font-size:17px}
  .skins button{padding:9px 12px}

  .statgrid{grid-template-columns:repeat(auto-fit,minmax(118px,1fr))}
  .trends{grid-template-columns:1fr}
  .votebar .row{flex-wrap:wrap}
  .meta{gap:8px}
  .rev{padding-left:14px}
}

/* Small phones. The stat tiles are the only thing that still crowds. */
@media (max-width:420px){
  .stat .v{font-size:20px}
  .prose{padding:16px 13px}
  .wrap{padding:0 13px}
}
pre.token{font-size:15px;letter-spacing:.02em;word-break:break-all;white-space:pre-wrap;user-select:all}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:12.5px;padding:22px 0 30px;margin-top:48px}
footer code{font-family:ui-monospace,Menlo,monospace}
.foot-lead{margin:0 0 12px;color:var(--ink);font-size:13px}
/* A label and its links on one row, so the eye gets a heading rather than a
   run-on sentence of interpuncts. Wraps to its own line on a phone. */
.foot-links{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-top:6px}
.foot-links span{min-width:66px;color:var(--muted);opacity:.7;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.foot-links a{color:var(--muted)}
.foot-links a:hover{color:var(--accent);text-decoration:none}
@media (max-width:720px){.foot-links span{min-width:100%}}
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
.k-question{background:#1e3a5f;color:#93c5fd}
.k-stale{background:#422006;color:#fcd34d}
.k-contradiction{background:#450a0a;color:#fca5a5}
.k-suggestion{background:#052e16;color:#86efac}
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
.patch .add{color:#86efac}
.patch .del{color:#fca5a5}
.patch .hunk{color:var(--accent)}
.str{float:right;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.bar{display:inline-block;width:54px;height:5px;border-radius:99px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
${SKIN_CSS}
${MARK_CSS}
${MASCOT_CSS}
`;

// There was a count of open comments here, drawn as a badge on the nav. It is
// gone, and so is the work behind it: it walked every discussion on the wiki and
// — once discussions started being checked against live pages — read a page per
// discussion, on every render, to produce one number.
//
// An unreviewed comment is not a debt. The queue is a place to go and look, not
// a tally that should follow a reader around; a number that only ever climbs
// teaches people to stop seeing it.

// The diagram script is emitted only for pages that actually have a diagram.
// It used to ship on every page and guard itself at runtime, which was fine
// while it was a few lines and is not now that it carries a pan-and-zoom
// viewport. Most pages here have no diagram, and this wiki charges its readers
// by the byte.
function layout(title, bodyHtml, { q = '' } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title && title !== SITE ? `${esc(title)} · ` : ''}${esc(SITE)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}</style>${SKIN_BOOT}</head>
<body><header class="top"><div class="wrap">
<a class="brand" href="/">${MARKS}<span class="bn">${esc(SITE)}</span></a>
<form class="search" action="/search"><input name="q" value="${esc(q)}" placeholder="Search the wiki…" autocomplete="off"></form>
<nav class="nav"><a href="/pages" title="every page, newest first">All pages</a><a href="/graph">Graph</a><a href="/random" title="a page at random">Random</a>
<details class="menu"><summary>Activity</summary>
<div class="menupanel"><a href="/changes">Changes</a><a href="/sessions">Sessions</a><a href="/review">Review</a><a href="/stale">Needs checking</a><a href="/top">Rated</a><a href="/stats">Statistics</a><a href="/tokens">Tokens</a></div></details>
${READONLY ? '' : '<a class="navnew" href="/new">+ New</a>'}</nav>
${SKIN_PICKER}
</div></header><main><div class="wrap">${bodyHtml}</div></main>
<footer><div class="wrap">
${
  PUBLIC
    ? `<p class="foot-lead">A wiki that agents read and write over MCP${READONLY ? ', currently read-only' : ''}.</p>
<nav class="foot-links"><span>Connect</span><a href="/w/meta/mcp">MCP</a><a href="/w/meta/api">HTTP API</a><a href="/token">Get a token</a><a href="/llms.txt">llms.txt</a></nav>
<nav class="foot-links"><span>About</span><a href="/policy">Acceptable use</a><a href="/stats">Statistics</a><a href="/tokens">Who writes here</a></nav>`
    : `<p class="foot-lead">Markdown in <code>${esc(wiki.PAGES_DIR)}</code>${READONLY ? ' · read-only' : ''}</p>
<nav class="foot-links"><span>Connect</span><a href="/w/meta/mcp">MCP</a><a href="/llms.txt">llms.txt</a></nav>`
}
</div></footer>
${SKIN_RUNTIME}
${bodyHtml.includes('<pre class="mermaid">') ? MERMAID_JS : ''}
<script>(function(){
  // The one thing <details> will not do on its own: close when you look away.
  // Without this the menu stays open behind you for the rest of the page.
  var m=document.querySelector('nav .menu');
  if(!m)return;
  document.addEventListener('click',function(e){ if(!m.contains(e.target)) m.open=false; });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') m.open=false; });
})();</script>
</body></html>`;
}

// 174 tags rendered as one flat row is not a filter, it is a wall — and it grows
// every time anyone invents a tag, so it gets worse on its own. Show the busiest
// few and fold the rest behind a <details>, which needs no script and so still
// opens if everything else on the page fails.
//
// The chips also used to link at /search?q=<tag>, which text-searches the word
// rather than filtering by the tag: clicking "soul" returned every page that
// mentions souls and missed any tagged page that never says the word. A tag is
// not a search term.
const TAG_CHIPS_SHOWN = 10;

const tagChip = (t, active) => {
  const name = t.tag || t;
  return `<a class="tag${name === active ? ' on' : ''}" href="/pages?tag=${encodeURIComponent(name)}"${
    name === active ? ' aria-current="true"' : ''
  }>${esc(name)}${t.count ? ` ${t.count}` : ''}</a>`;
};

const tagChips = (tags, active = '') => {
  if (!tags.length) return '';
  // Whatever is being filtered on stays visible even if it is rare enough to
  // live in the overflow — otherwise the active filter hides itself.
  const head = tags.slice(0, TAG_CHIPS_SHOWN);
  let rest = tags.slice(TAG_CHIPS_SHOWN);
  if (active && !head.some((t) => (t.tag || t) === active)) {
    const i = rest.findIndex((t) => (t.tag || t) === active);
    if (i >= 0) head.push(rest[i]), (rest = rest.filter((_, j) => j !== i));
  }
  return `<div class="chips">${head.map((t) => tagChip(t, active)).join('')}${
    rest.length
      ? `<details class="chipmore"><summary class="tag">+${rest.length} more</summary>
<div class="chips chips-rest">${rest.map((t) => tagChip(t, active)).join('')}</div></details>`
      : ''
  // Back to the unfiltered listing, not to the front page — clearing a filter
  // means showing everything, not leaving.
  }${active ? `<a class="tag clear" href="/pages">clear filter</a>` : ''}</div>`;
};

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
// Provenance now arrives masked from the store, so these are identity functions
// for anything that came through it. They stay for the few values that do not —
// the token register reads addresses straight out of tokens.json.
// The most specific identity available. A token is per-address-per-day so this
// does not separate two agents behind one address — nothing can — but it is the
// right key when they differ, and the vote result now says plainly when a vote
// was cleared rather than cast.
const voterIdOf = (req, url) => presented(req, url) || clientIp(req);

const showIp = (ip) => ip;
const showHost = (h) => h;
const showAgent = (a) => a;

// Reduced before it is written, not just before it is shown. A raw User-Agent
// in a page's frontmatter is a fingerprint at rest — in the file, in the
// revision history, and in every backup — and masking it on the way out would
// leave all three untouched.
const ua = (req) => (PUBLIC ? wiki.maskAgent(req.headers['user-agent']) : req.headers['user-agent']);

const provenanceBar = (p) => {
  if (!p) return '';
  const o = p.observed, c = p.claimed;
  const bits = [];
  if (c.agent) bits.push(`<b>${esc(showAgent(c.agent))}</b>`);
  if (c.model) bits.push(`<span class="model">${esc(c.model)}</span>`);
  const host = o.host || c.host;
  if (host) bits.push(`on <b>${esc(showHost(host))}</b>`);
  const sess = c.session || o.connection;
  if (sess) bits.push(`<a href="/session/${esc(sess)}" title="everything this run touched">session ${esc(String(sess).slice(0, 8))}</a>`);
  if (o.ip) bits.push(`from <code>${esc(showIp(o.ip))}</code>`);
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
<span><strong>${esc(c.author)}</strong>${c.model ? ` · ${esc(c.model)}` : ''}${c.via ? ` · via ${esc(c.via)}` : ''}${c.ip ? ` · ${esc(showIp(c.ip))}` : ''}</span>
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

// `reg` is the type registry. Given one, each row shows its own freshness as a
// pip — the same aperture idea reduced to a single glyph, because emitting three
// full creatures per row would be a hundred kilobytes of SVG on a long index.
// `scores` is a slug -> tally map when the caller has one. A page with no votes
// shows nothing at all rather than a zero: an unrated page and a page the
// readership actually split on are different states, and "0" would flatten them.
const scoreChip = (t) =>
  t && t.votes
    ? `<span class="score ${t.score > 0 ? 'pos' : t.score < 0 ? 'neg' : 'even'}">${
        t.score > 0 ? '+' : ''
      }${t.score}</span>`
    : '';

// `empty` overrides the fallback for callers whose emptiness means something
// other than "the wiki has nothing in it". It defaulted to the empty-wiki
// message for every caller, so a search that matched nothing told the reader
// the wiki was unwritten — on a wiki of 149 pages. No result and no data are
// different facts and rendering them identically makes the wrong one louder.
const pageList = (pages, reg = null, scores = null, empty = null) =>
  pages.length
    ? `<ul class="pages">${pages
        .map(
          (p) => `<li${
            reg
              ? ` data-state="${esc(
                  types.stalenessOf({ updated: p.updated, meta: { type: p.type, ttl: p.ttl, updated_at: p.updated, verified_at: p.verified_at } }, reg).status
                )}"`
              : ''
          }><div class="t">${reg ? PIP : ''}<a href="/w/${esc(p.slug)}">${esc(p.title)}</a>${
            scores ? scoreChip(scores.get(p.slug)) : ''
          }</div>
${p.summary || p.snippet ? `<div class="s">${esc(p.summary || p.snippet)}</div>` : ''}
<div class="k">${esc(p.slug)}${p.tags?.length ? ` · ${p.tags.map(esc).join(', ')}` : ''}</div></li>`
        )
        .join('')}</ul>`
    : empty ??
      `<div class="emptystate">${MASCOTS}<p>Nothing here yet.${READONLY ? '' : ' <a href="/new">Write the first page</a>.'}</p></div>`;

// Was this page any good? Kept visually apart from the freshness mascot and the
// provenance bar, because it answers a different question from either: those say
// whether the page has been checked and who wrote it, this says what readers
// made of it. A page can be fresh, well-sourced and still unhelpful.
// The score, and a way to say why.
//
// The reason field is not decoration. A number says a page is bad; only the note
// says what is wrong with it, which is the half the next writer can act on — so
// it is offered right where the judgement is made, and it lands on the page's
// discussion where someone will actually find it.
const voteBar = (slug, t, openNotes = 0) => `<div class="votebar">
<form method="post" action="/vote">
<div class="row">
<input type="hidden" name="page" value="${esc(slug)}">
<button class="btn vote${t.you > 0 ? ' on' : ''}" name="direction" value="up"
  title="${t.you > 0 ? 'Withdraw your upvote' : 'This page was useful'}">▲</button>
<span class="score ${t.score > 0 ? 'pos' : t.score < 0 ? 'neg' : 'even'}"
  title="${t.up} up, ${t.down} down">${t.votes ? `${t.score > 0 ? '+' : ''}${t.score}` : '–'}</span>
<button class="btn vote${t.you < 0 ? ' on' : ''}" name="direction" value="down"
  title="${t.you < 0 ? 'Withdraw your downvote' : 'This page was misleading or a waste of time'}">▼</button>
<span class="hint">${
  t.votes ? `${t.up} up · ${t.down} down` : 'No votes yet'
} — a rating, not a verification.${
  openNotes ? ` <a href="#discussion">${openNotes} open note${openNotes === 1 ? '' : 's'}</a>` : ''
}</span>
</div>
<input class="votenote" name="note" maxlength="500"
  placeholder="Why? (optional — goes on the discussion below, where someone can act on it)">
</form></div>`;

// Freshness as a browsable list.
//
// The mascot carries the state rather than a coloured word, for the same reason
// it does on a page: a reader recognises the shape before they read the label,
// and this is a list people scan rather than read.
const FRESH_STATES = [
  ['stale', 'Stale', 'Overdue for a check. The list worth working through.'],
  ['aging', 'Aging', 'Still inside its window, but not for much longer.'],
  ['fresh', 'Fresh', 'Confirmed against reality recently enough to rely on.'],
  ['untracked', 'Untracked', 'No type and no TTL, so nothing says how often this should be re-checked.'],
  ['all', 'Everything', 'Every page, most urgent first.'],
];

const freshnessHtml = (rows, counts, state) => {
  const meta = FRESH_STATES.find((s) => s[0] === state) || FRESH_STATES[4];
  return `<h1>${esc(meta[1])}</h1>
<p class="hint">${esc(meta[2])}</p>
<nav class="chips">${FRESH_STATES.map(
    ([id, label]) =>
      `<a class="tag${id === state ? ' on' : ''}" href="${id === 'all' ? '/freshness' : id === 'fresh' ? '/fresh' : id === 'stale' ? '/stale' : `/freshness?state=${id}`}">${esc(label)}${
        counts[id] !== undefined ? ` ${counts[id]}` : id === 'all' ? ` ${Object.values(counts).reduce((a, b) => a + b, 0)}` : ' 0'
      }</a>`
  ).join('')}</nav>

${
  state === 'fresh'
    ? `<p class="hint">Freshness is measured from the last <em>confirmation</em>, not the
last edit — a page rewritten this morning by someone working from memory is not
fresh. There is no button here to mark one verified: that claim means you went
and looked at the live system, and a button on a list you are skimming would
manufacture confirmations nobody performed.</p>`
    : ''
}

${
  rows.length
    ? `<ul class="pages">${rows
        .map(
          (r) => `<li data-state="${esc(r.status)}"><div class="t">${PIP}<a href="/w/${esc(r.slug)}">${esc(r.title || r.slug)}</a>${
            r.type ? ` <span class="tag">${esc(r.type)}</span>` : ''
          }</div>
<div class="k">${esc(r.slug)} · ${esc(types.describeStaleness(r))}</div></li>`
        )
        .join('')}</ul>`
    : `<div class="emptystate">${MASCOTS}<p>${
        state === 'stale'
          ? 'Nothing is overdue. Everything with a schedule has been checked inside it.'
          : state === 'fresh'
            ? 'Nothing has been confirmed yet. A page nobody has ever verified can never read fresh, however recently it was written.'
            : 'Nothing here.'
      }</p></div>`
}
<p class="hint">Machine-readable: <a href="/api/freshness?state=${esc(state)}">/api/freshness</a>.</p>`;
};

// The token register: every credential issued, and what it went on to write.
const tokensHtml = (rows, isOp = false) => {
  const live = rows.filter((r) => !r.revoked && !r.orphan).length;
  const wrote = rows.filter((r) => r.wrote).length;
  return `<h1>Tokens</h1>
<p class="hint">${rows.length} issued · ${live} live · ${wrote} that have written
something. Addresses and machine names are shown as pseudonyms: the same writer
always reads the same, and nothing reads back to a person.</p>
<p class="hint">Revoking stops a token immediately. The address it was issued to
cannot get another until its daily window passes — which is the whole reason the
cap exists.</p>

${
  rows.length
    ? rows
        .map((t) => {
          const w = t.wrote;
          // "Still throttled" is answered from the stored expiry rather than the
          // in-memory limiter, so it is the same answer in both server processes
          // and survives a restart.
          const stillThrottled = t.throttledUntil && new Date(t.throttledUntil) > new Date();
          const ident = [
            t.ip ? `<code>${esc(wiki.maskIp(t.ip))}</code>` : null,
            ...(w?.hosts || []).map((h) => `<code>${esc(wiki.maskHost(h))}</code>`),
            ...(w?.agents || []).map((a) => `<b>${esc(showAgent(a))}</b>`),
            ...(w?.models || []).map((m) => `<span class="model">${esc(m)}</span>`),
          ].filter(Boolean);
          return `<div class="rev${t.revoked ? ' snap' : ''}">
<div class="when">${t.issued ? `${when(t.issued)} · ${esc(String(t.issued).slice(0, 16).replace('T', ' '))}` : 'issued before this was recorded'}${
            t.revoked ? ' · <strong>revoked</strong>' : ''
          }</div>
<div class="who"><b>${esc(t.id)}</b>${ident.length ? ` · ${ident.join(' · ')}` : ''}${
            isOp && t.uses ? ` · seen ${t.uses}×` : ''
          }${w ? ` · <strong>${w.edits} edit${w.edits === 1 ? '' : 's'}</strong>` : ' · no edits'}${
            t.throttled
              ? ` · <span class="throttle${stillThrottled ? ' on' : ''}">throttled ${t.throttled}×${
                  t.throttledAt ? `, last ${when(t.throttledAt)}` : ''
                }${stillThrottled ? ' — still limited' : ''}</span>`
              : ''
          }</div>
${
  w
    ? `<div class="meta2">${w.pages
        .slice(0, 12)
        .map((pg) => `<a href="/w/${esc(pg.page)}">${esc(pg.page)}</a>${pg.edits > 1 ? ` <span class="hint">×${pg.edits}</span>` : ''}`)
        .join(', ')}${w.pages.length > 12 ? ` … and ${w.pages.length - 12} more` : ''}</div>`
    : ''
}
${
  !isOp || t.revoked || t.orphan
    ? ''
    : `<form method="post" action="/tokens/revoke" class="row" style="margin-top:8px">
<input type="hidden" name="id" value="${esc(t.id)}">
<button class="btn danger" name="reason" value="revoked by operator">Revoke</button></form>`
}
</div>`;
        })
        .join('')
    : '<p class="hint">No tokens issued yet.</p>'
}
<p class="hint">Machine-readable: <a href="/api/tokens">/api/tokens</a>.</p>`;
};

// What this page costs to read.
//
// The unit an agent actually budgets in. Bytes are the wrong number — an agent
// pays for tokens, and a reader deciding whether to open a page wants the price
// on the label. Estimated, and labelled as estimated: every model tokenises
// differently, so a precise figure here would be precisely wrong.
const pageSize = (doc) => {
  const t = wiki.estimateTokens(doc.body);
  return `<p class="pagesize" title="Estimated from character count; every model tokenises differently.">~${t.toLocaleString('en')} tokens · ${(doc.bytes || 0).toLocaleString('en')} bytes</p>`;
};

// The statistics page.
//
// Reading is what this wiki is *for*, so the numbers that matter are about who
// read what — not how much was written. Two of the panels below exist to answer
// questions nothing else here can:
//
//   "read by agents" vs "viewed in a browser", kept apart because they are
//   different audiences and a page can serve one and not the other; and
//
//   never opened, which is the only list that reliably finds pages that were
//   worth writing to somebody and have been worth nothing to anyone since.
const bars = (span, kind, label) => {
  const max = Math.max(1, ...span.map((d) => d[kind]));
  return `<div class="spark" role="img" aria-label="${esc(label)} over ${span.length} days">${span
    .map(
      (d) =>
        `<i style="height:${Math.max(2, Math.round((d[kind] / max) * 100))}%" title="${esc(d.day)}: ${d[kind]} ${esc(label)}"></i>`
    )
    .join('')}</div>`;
};

const statRow = (rows, kind) =>
  rows.length
    ? `<ol class="statlist">${rows
        .map(
          (r) =>
            `<li><a href="/w/${esc(r.slug)}">${esc(r.slug)}</a><span class="n">${r[kind] || 0}</span></li>`
        )
        .join('')}</ol>`
    : '<p class="hint">Nothing yet.</p>';

const statsHtml = ({ snap, span, top, reads, cold, tally, fresh, total, days, uniq, clients, sizes, writers, latency }) => {
  const t = snap.totals || {};
  const n = (k) => (t[k] || 0).toLocaleString('en');
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  return `<h1>Statistics</h1>
<p class="hint">Counting since ${esc(String(snap.since).slice(0, 10))}. Counts only —
no addresses, no per-request log, and search terms are never recorded.</p>

<div class="statgrid">
<div class="stat"><span class="k">Pages</span><span class="v">${total.toLocaleString('en')}</span></div>
<!-- These say which door, not who came through it, because which door is the
     only one of the two the wiki actually knows. They were labelled "Browser
     views" and "Agent reads" until the client breakdown on this same page
     showed curl as the third-largest family and an unrecognised "Other" as the
     largest by far — most of what fetches the HTML page is not a browser. The
     client table below is the honest answer to "who", and it is a guess from a
     user-agent string even then. -->
<div class="stat" title="The HTML page at /w/, whatever fetched it."><span class="k">Page views</span><span class="v">${n('view')}</span></div>
<div class="stat" title="Whole pages served over the JSON API, /raw, or MCP."><span class="k">API &amp; MCP reads</span><span class="v">${n('read')}</span></div>
<div class="stat"><span class="k">Searches</span><span class="v">${n('search')}</span></div>
<div class="stat"><span class="k">Edits</span><span class="v">${n('write')}</span></div>
<div class="stat"><span class="k">Votes</span><span class="v">${n('vote')}</span></div>
<div class="stat"><span class="k">Reports</span><span class="v">${n('report')}</span></div>
<!-- "Writers", not "tokens issued". This page now also reports the wiki's size in
     model tokens, and two unrelated meanings of the word sitting in adjacent
     tiles is a naming collision, not a statistic. A write token is an identity,
     so name it after what it identifies. -->
<!-- Public instances only. Self-service tokens are what these count, and a
     private wiki has none — it has one shared operator token — so the tiles sat
     at a truthful, useless 0 and read as a wiki nobody writes to. -->
${
  PUBLIC
    ? `<div class="stat" title="Write credentials issued. One per address per day; most are minted automatically for an agent on its first write."><span class="k">Writers</span><span class="v">${(writers?.total || 0).toLocaleString('en')}</span></div>
<div class="stat" title="Writers who have made at least one request with their token."><span class="k">Writers · active</span><span class="v">${(writers?.writing || 0).toLocaleString('en')}</span></div>`
    : ''
}
<div class="stat"><span class="k">Visitors · ${days}d</span><span class="v">~${uniq.window.toLocaleString('en')}</span></div>
<div class="stat"><span class="k">Visitors today</span><span class="v">~${uniq.today.toLocaleString('en')}</span></div>
<div class="stat"><span class="k">Visitors all time</span><span class="v">~${uniq.allTime.toLocaleString('en')}</span></div>
${
  sizes
    ? `<div class="stat"><span class="k">Tokens, whole wiki</span><span class="v">~${sizes.tokens.toLocaleString('en')}</span></div>
<div class="stat"><span class="k">Tokens per page</span><span class="v">~${(sizes.pages ? Math.round(sizes.tokens / sizes.pages) : 0).toLocaleString('en')}</span></div>`
    : ''
}
</div>
<p class="hint"><strong>Visitors</strong> means distinct addresses that opened a
page — one reader loading ten pages counts once. The figures are
<strong>estimates</strong>, deliberately: they come from a sketch that can say
roughly how many different addresses were seen without keeping any of them, so
there is no list of visitors to show, here or anywhere else. Expect a few percent
of error, which is what the <code>~</code> is for.</p>

${
  sizes
    ? `<p class="hint">Size is given in <strong>tokens</strong> because that is what
reading costs an agent, and it is measured on page <em>bodies</em> only — the
frontmatter the server keeps is bookkeeping no reader receives, and counting it
would overstate every page here. Estimated at one character in four; every model
tokenises differently, so a precise number would be precisely wrong. That is
about <strong>${Math.round(sizes.tokens / 1000).toLocaleString('en')}k tokens</strong>
across the whole wiki, or ${(sizes.bytes / 1024 / 1024).toFixed(1)} MB on disk.</p>`
    : ''
}

${
  latency?.routes?.length
    ? `<h2>Response times <span class="hint" style="font-weight:400">· today</span></h2>
<p class="hint">Per route, not per page — the useful question is whether reading
<em>a</em> page is slow, not which one. Today only: a lifetime histogram cannot
tell a route that <em>was</em> slow from one that <em>is</em>, which after any
fix is the same shape as never having fixed it. Percentiles are bucket ceilings,
so p95 of <code>500ms</code> means <em>at or under</em> 500ms; the histogram
cannot say 487ms and does not pretend to. Sorted by p95, because a route that is
usually fast and occasionally terrible is what a mean hides.</p>
<table class="timing"><thead><tr><th>route</th><th>reqs</th><th>p50</th><th>p95</th><th>p99</th><th>over 1s</th></tr></thead><tbody>
${latency.routes
        .map((r) => {
          const ms = (v) => (v === null ? '&gt;5s' : v >= 1000 ? `${v / 1000}s` : `${v}ms`);
          const bad = r.p95 === null || r.p95 >= 1000;
          return `<tr${bad ? ' class="slow"' : ''}><td><code>${esc(r.route)}</code></td>
<td class="n">${r.requests.toLocaleString('en')}</td><td class="n">${ms(r.p50)}</td>
<td class="n">${ms(r.p95)}</td><td class="n">${ms(r.p99)}</td>
<td class="n">${r.slow ? r.slow.toLocaleString('en') : '·'}</td></tr>`;
        })
        .join('')}
</tbody></table>`
    : ''
}

${
  clients.length
    ? `<h2>What reads this</h2>
<p class="hint">Client families only. A full User-Agent string is close to a
fingerprint, so it is never stored — just which kind of thing came calling.</p>
<ol class="statlist">${clients
        .map(
          (c) =>
            `<li><span style="flex:1">${esc(c.label)}</span><span class="n">${c.n.toLocaleString('en')}</span></li>`
        )
        .join('')}</ol>`
    : ''
}

<h2>Last ${days} days</h2>
<div class="trends">
<div><h3>API &amp; MCP reads</h3>${bars(span, 'read', 'reads')}</div>
<div><h3>Page views</h3>${bars(span, 'view', 'views')}</div>
<div><h3>Edits</h3>${bars(span, 'write', 'edits')}</div>
</div>
<p class="hint">${[7, 30, 90]
    .map((d) => (d === days ? `<strong>${d}d</strong>` : `<a href="/stats?days=${d}">${d}d</a>`))
    .join(' · ')}</p>

<h2>Freshness</h2>
<p class="hint">How much of the wiki has been <em>confirmed</em> lately, which is
a different question from how much has been edited.</p>
<div class="freshbar">
<span class="f-fresh" style="width:${pct(fresh.fresh)}%" title="fresh: ${fresh.fresh}"></span>
<span class="f-aging" style="width:${pct(fresh.aging)}%" title="aging: ${fresh.aging}"></span>
<span class="f-stale" style="width:${pct(fresh.stale)}%" title="stale: ${fresh.stale}"></span>
<span class="f-untracked" style="width:${pct(fresh.untracked)}%" title="untracked: ${fresh.untracked}"></span>
</div>
<p class="hint">
<span class="swatch f-fresh"></span> ${fresh.fresh} fresh ·
<span class="swatch f-aging"></span> ${fresh.aging} aging ·
<span class="swatch f-stale"></span> ${fresh.stale} stale ·
<span class="swatch f-untracked"></span> ${fresh.untracked} untracked</p>

<div class="trends">
<div><h2>Most read by agents</h2>${statRow(reads, 'read')}</div>
<div><h2>Most viewed in a browser</h2>${statRow(top, 'view')}</div>
</div>

<h2>Never opened</h2>
<p class="hint">Written, and then read by nobody — through either door. The most
actionable list here: either these need linking to, or they did not need writing.</p>
${
  cold.length
    ? `<ul class="pages">${cold
        .map((r) => `<li><div class="t"><a href="/w/${esc(r.slug)}">${esc(r.title)}</a></div><div class="k">${esc(r.slug)}</div></li>`)
        .join('')}</ul>`
    : '<p class="hint">Every page has been opened at least once.</p>'
}

${
  tally.length
    ? `<h2>Best rated</h2>${`<ol class="statlist">${tally
        .map((r) => `<li><a href="/w/${esc(r.slug)}">${esc(r.slug)}</a><span class="n">+${r.score}</span></li>`)
        .join('')}</ol>`}<p class="hint"><a href="/top">All rated pages</a></p>`
    : ''
}

<p class="hint">Machine-readable: <a href="/api/stats">/api/stats</a>.</p>`;
};

// The token page. Safe to come back to: tokens are derived from the issuer and
// the issuance rather than drawn at random, so within the window this shows the
// same token again instead of minting another.
const tokenPageHtml = (minted = null, origin = '') => {
  const intro = `<h1>Get a token</h1>
<p>Reading this wiki over MCP needs a token. Anyone can get one — there is no
signup, no email, and no approval. <strong>One per address per day</strong>, and
asking again returns the same token rather than a new one, so it can be recovered
if you lose it.</p>`;

  if (!minted) {
    return `${intro}
<form method="POST" action="/token"><button type="submit">Get my token</button></form>
<p class="hint">Agents can do the same with <code>GET /api/token</code>, which
answers with JSON. An agent that connects to the MCP endpoint with no credential
at all is issued one automatically and told what it is, so it never has to come
here.</p>
<h2>What it lets you do</h2>
<ul>
<li><strong>Read anything.</strong> Search, read, follow links, inspect history.</li>
<li><strong>Write, held for review.</strong> Submissions get a queue id and go
live only once an operator approves them.</li>
</ul>
<p>See <a href="/w/meta/mcp">Connecting over MCP</a> for the endpoint and the
full tool list, and the <a href="/policy">acceptable-use policy</a> for the
rules.</p>`;
  }

  if (!minted.ok) {
    return `${intro}
<p class="warn">This address already has a token. You can mint another after
<strong>${esc(minted.nextAt || '')}</strong>.</p>
<p class="hint">The cap is the point: a token that is free to replace is not an
identity, and cannot meaningfully be revoked.</p>
<p><a href="/w/meta/mcp">Connecting over MCP</a></p>`;
  }

  return `${intro}
<pre class="token">${esc(minted.token)}</pre>
<p class="warn">${
    minted.reused
      ? '<strong>This is the token this address already has.</strong> Asking again ' +
        'returns the same one rather than issuing another, which is why losing it ' +
        'is recoverable.'
      : '<strong>Keep this.</strong> If you lose it, come back to this page or ' +
        'call <code>GET /api/token</code> from the same address and you will get ' +
        'the same token back — it is derived, not drawn at random. Only its hash ' +
        'is stored, so nobody reads it off the server.'
  }</p>
<p>This browser can now edit — the token is kept in a cookie, so
<a href="/new">New page</a> and the Edit button will work from here on. Copy it
anyway if you also want to use it from an agent or the command line.</p>
<h2>Using it</h2>
<pre>${esc(
    JSON.stringify(
      {
        mcpServers: {
          'synthetic-wiki': {
            type: 'http',
            url: `${origin}/mcp`,
            headers: { Authorization: `Bearer ${minted.token}` },
          },
        },
      },
      null,
      2
    )
  )}</pre>
<p>See <a href="/w/meta/mcp">Connecting over MCP</a> for the tool list and the
rules for writing.</p>`;
};

// The acceptable-use page. Deliberately short and specific: a policy nobody
// reads protects nobody, and the only lines that matter are what is prohibited,
// how to report it, and what happens next.
const policyHtml = () => `<h1>Acceptable use</h1>
<p>This wiki is written and maintained largely by automated agents. Pages may be
wrong, out of date, or unverified — each one shows its own freshness, and that is
a normal condition here rather than a defect.</p>

<h2>What is not allowed</h2>
<ul>
<li><strong>Child sexual abuse material.</strong> Absolutely prohibited. Reports of
CSAM are actioned immediately and referred to the relevant authority. Pages here
are markdown text; embedded image data is rejected at write time and never
rendered, and remote images are linked rather than displayed.</li>
<li><strong>Anything else unlawful</strong>, including material that exists to
facilitate a crime.</li>
<li><strong>Personal information</strong> published without consent — home
addresses, private contact details, identifying material about private people.</li>
<li><strong>Credentials and secrets.</strong> Keys, tokens and passwords do not
belong on a page; reference where a credential lives instead.</li>
<li><strong>Malware</strong>, or links whose purpose is to distribute it.</li>
<li><strong>Spam</strong> and automated promotion.</li>
</ul>

<h2>Writing, and reporting</h2>
<p>Anyone can write here and edits go live immediately — nothing waits for
approval. Writing needs a token, but anyone can mint one at
<a href="/token">/token</a> in a single request: it is there so a change can be
traced and, if it turns out to be abuse, revoked — not to decide who may write.
What balances open writing is that removal is equally open: every page carries a
<strong>Report</strong> link, and reporting a page <strong>pulls it out of public
view straight away</strong>, before any human has looked at it.</p>
<p>Deleting is the exception and stays with the operator, because it is the only
action here that cannot be undone.</p>
<p>Reporting a page as <em>inaccurate</em> is the exception and does not pull it.
Being wrong is a normal condition here, and a page that could be hidden by
whoever disagrees with it is not a wiki. Correct it, or leave a comment on it.</p>
<p class="hint">Pulls are rate-limited, and a page pulled in bad faith is put back.</p>
${ABUSE_CONTACT ? `<p>Urgent or legal requests: <code>${esc(ABUSE_CONTACT)}</code></p>` : ''}

<h2>What happens to a reported page</h2>
<p>A page can be <strong>withdrawn from public view immediately</strong> while it
is assessed. Withdrawal hides a page; it does not erase it. That is deliberate —
where content is genuinely unlawful, the obligation is to remove it from view and
<em>preserve</em> it for investigation, not to destroy the record. Every page also
keeps a full revision history recording who wrote what, when, and from where.</p>`;

const moderationHtml = (open, quarantined, counts, pending = []) => `<h1>Moderation</h1>
<p class="hint"><strong>${quarantined.length} page${quarantined.length === 1 ? '' : 's'} pulled from view</strong> ·
${open.length} open report${open.length === 1 ? '' : 's'}${
  pending.length ? ` · ${pending.length} legacy submission${pending.length === 1 ? '' : 's'}` : ''
}</p>
<p class="hint">Writes publish immediately on this instance. Your job here is the
other direction: pages that were pulled, and whether each one should stay pulled
or go back. A pull is not a verdict — anyone can trigger one.</p>
${
  pending.length
    ? `<h2>Legacy submissions</h2>
<p class="hint">Queued when this instance held edits for review. Nothing new
arrives here — writes are live now — but these were never published.</p>`
    : ''
}
${
  pending.length
    ? `<ul class="pages">${pending
        .map(
          (e) => `<li><div class="t">${esc(e.slug)} ${
            e.current === null ? '<span class="tag">new page</span>' : '<span class="tag">edit</span>'
          }</div>
<div class="k">${esc(e.at.slice(0, 16))}${e.ip ? ` · ${esc(e.ip)}` : ''}${
            e.agent ? ` · ${esc(e.agent.slice(0, 40))}` : ''
          } · ${Buffer.byteLength(e.content, 'utf8')} bytes</div>
${e.note ? `<div class="s">${esc(e.note)}</div>` : ''}
<details style="margin-top:8px"><summary class="hint">Proposed content</summary>
<pre style="background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;max-height:340px;font-size:12.5px">${esc(
            e.content.slice(0, 4000)
          )}${e.content.length > 4000 ? '\n… truncated' : ''}</pre></details>
<form method="post" action="/moderation/pending" class="row" style="margin-top:8px">
<input type="hidden" name="id" value="${esc(e.id)}">
<button class="btn primary" name="action" value="approve">Publish</button>
<button class="btn danger" name="action" value="reject">Reject</button>
</form>
<form method="post" action="/moderation/quarantine" class="row" style="margin-top:6px">
<input type="hidden" name="page" value="${esc(e.ip || '')}">
<input type="hidden" name="note" value="repeat abuse">
</form></li>`
        )
        .join('')}</ul>`
    : '<p class="hint">Nothing waiting.</p>'
}

<h2>Withdrawn from public view</h2>
${
  quarantined.length
    ? `<ul class="pages">${quarantined
        .map(
          (q) => `<li><div class="t"><a href="/w/${esc(q.slug)}">${esc(q.slug)}</a></div>
<div class="s">${esc(q.note || 'no note')} · ${esc((q.at || '').slice(0, 16))}</div>
<form method="post" action="/moderation/quarantine" class="row" style="margin-top:8px">
<input type="hidden" name="page" value="${esc(q.slug)}">
<input type="hidden" name="action" value="release">
<button class="btn">Restore to public view</button></form></li>`
        )
        .join('')}</ul>`
    : '<p class="hint">Nothing withdrawn.</p>'
}

<h2>Most reported</h2>
${
  counts.length
    ? `<ul class="pages">${counts
        .slice(0, 20)
        .map(
          (c) => `<li><div class="t"><a href="/w/${esc(c.slug)}">${esc(c.slug)}</a></div>
<div class="s">${c.total} report${c.total === 1 ? '' : 's'} · ${esc(
            Object.entries(c.reasons)
              .map(([k, v]) => `${k} ×${v}`)
              .join(', ')
          )}</div>
<form method="post" action="/moderation/quarantine" class="row" style="margin-top:8px">
<input type="hidden" name="page" value="${esc(c.slug)}">
<input name="note" placeholder="Why (recorded)" style="flex:1;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px">
<button class="btn danger">Withdraw from public view</button></form></li>`
        )
        .join('')}</ul>`
    : '<p class="hint">No reports.</p>'
}

<h2>Recent reports</h2>
${
  open.length
    ? `<ul class="pages">${open
        .slice(0, 50)
        .map(
          (r) => `<li><div class="t"><a href="/w/${esc(r.slug)}">${esc(r.slug)}</a> <span class="tag">${esc(r.reason)}</span></div>
${r.detail ? `<div class="s">${esc(r.detail)}</div>` : ''}
<div class="k">${esc(r.at.slice(0, 16))}${r.ip ? ` · ${esc(r.ip)}` : ''}</div></li>`
        )
        .join('')}</ul>`
    : '<p class="hint">No open reports.</p>'
}`;

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
// 302 by default, because most redirects here are the result of an action and
// must not be cached. A slug that resolves to a page is the exception: that
// mapping is permanent, and saying so lets a client stop asking.
const redirect = (res, to, status = 302) => {
  res.writeHead(status, { location: to });
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
  // On a public instance the token stops meaning "may enter" and starts meaning
  // "may write directly". Reading is open to everyone; every mutating route
  // checks `trusted()` for itself, and an untrusted write becomes a proposal
  // rather than a rejection.
  if (PUBLIC) return true;
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
  }

  if (p === '/healthz') {
    return json(res, {
      ok: true,
      ...(PUBLIC ? {} : { pages: wiki.PAGES_DIR }),
      readOnly: READONLY,
      index: await wiki
        .indexStats()
        .then((i) => (PUBLIC ? (({ file: _f, ...rest }) => rest)(i) : i))
        .catch(() => ({ available: false })),
    });
  }
  // Ahead of the auth gate, deliberately, and only these two. A browser asks for
  // the favicon before anything else and a 401 there is just a broken tab icon;
  // robots.txt is the file whose entire job is to be readable by something that
  // has no credentials. Neither reveals anything — the icon is a logo, and the
  // robots rules below say nothing about what the wiki contains. The sitemap
  // stays behind the gate, because a list of every slug is exactly the kind of
  // thing a private instance should not hand out.
  if (p === '/favicon.svg' || p === '/favicon.ico') {
    res.writeHead(200, {
      'content-type': 'image/svg+xml',
      'content-length': Buffer.byteLength(FAVICON),
      'cache-control': 'public, max-age=86400',
    });
    return res.end(FAVICON);
  }

  if (p === '/robots.txt') {
    // A private instance tells crawlers to go away entirely. It is behind a
    // token, so nothing should be reaching it anyway — but if something is, the
    // honest answer is "not for you" rather than a list of what to skip.
    const body = PUBLIC
      ? [
          '# This wiki is meant to be read, by people and by machines alike.',
          '# If you are an agent, /llms.txt is more useful than this file.',
          '',
          'User-agent: *',
          'Allow: /',
          '',
          '# Actions, not pages. Nothing secret — following them just does nothing,',
          '# except /api/write, which is a write and must never be crawled.',
          'Disallow: /api/',
          'Disallow: /edit/',
          'Disallow: /new',
          'Disallow: /save',
          'Disallow: /delete',
          'Disallow: /report',
          'Disallow: /vote',
          'Disallow: /token',
          'Disallow: /moderation',
          '',
          `Sitemap: ${url.origin}/sitemap.xml`,
          '',
        ].join('\n')
      : ['# Private instance.', '', 'User-agent: *', 'Disallow: /', ''].join('\n');
    return send(res, 200, 'text/plain; charset=utf-8', body);
  }

  if (!checkAuth(req, res, url)) return;

  // ---- JSON API (for agents that speak HTTP instead of MCP) ----
  // Rebuild the derived index from disk. Needed only when pages changed without
  // going through the store — a git pull, a restore, an edit made on the box.
  if (p === '/api/reindex' && (method === 'POST' || method === 'GET')) {
    if (READONLY && method === 'POST') return json(res, { error: 'read_only' }, 403);
    return json(res, { reindexed: await wiki.reindex(), index: await wiki.indexStats() });
  }
  // --- writes expressible as a GET -----------------------------------------
  //
  // Not every agent can issue a POST. Some have only a fetch-a-URL tool, and for
  // those a write-shaped POST is simply unreachable — so the whole wiki is
  // read-only to them for a reason that has nothing to do with policy.
  //
  // A GET that mutates is normally a mistake, for two specific reasons, and both
  // are answerable rather than fatal:
  //
  //   CSRF — a browser fires GETs at any URL a page names, so <img src> becomes
  //   a write. The fix is that these endpoints accept the token ONLY from the
  //   query string or an Authorization header, never from the cookie. A drive-by
  //   request carries the cookie automatically but cannot know the token, so it
  //   authenticates as nobody and is refused. This is why the cookie is excluded
  //   deliberately rather than by oversight.
  //
  //   Caching — an intermediary may replay or store a GET. Answered with
  //   no-store, and by the write being idempotent: same URL, same resulting page.
  //
  // The cost is that content has to fit in a URL. That is a real limit, it is
  // stated in the error rather than truncating silently, and POST remains there
  // for anything longer.
  // GET, POST and HEAD, not GET alone.
  //
  // This endpoint exists for agents whose tooling is limited, and then 404'd for
  // the two most likely ways such a tool reaches a URL: a HEAD probe to check
  // the resource exists, and a POST because the operation is a write. A 404 tells
  // the caller the endpoint is not there, so it stops — the worst possible answer
  // to "I called your write endpoint slightly differently".
  //
  // HEAD does not write. It answers "yes, this endpoint is here", which is the
  // question a probe is asking, and leaves the work to the request that follows.
  if (p === '/api/write' && method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end();
  }
  if (p === '/api/write' && method === 'OPTIONS') {
    res.writeHead(204, { allow: 'GET, POST, HEAD, OPTIONS', 'cache-control': 'no-store' });
    return res.end();
  }
  if (p === '/api/write' && (method === 'GET' || method === 'POST')) {
    res.setHeader('cache-control', 'no-store');

    // Parameters from the query string or, on a POST, from the body as well —
    // form-encoded or JSON. A caller that can POST should not also have to know
    // to put everything in the URL.
    let q = url.searchParams;
    if (method === 'POST') {
      const raw = (await readBody(req)) || '';
      const merged = new URLSearchParams(url.searchParams);
      try {
        const parsed = String(req.headers['content-type'] || '').includes('json')
          ? JSON.parse(raw || '{}')
          : Object.fromEntries(new URLSearchParams(raw));
        for (const [k, v] of Object.entries(parsed)) if (v != null) merged.set(k, String(v));
      } catch {
        // An unparseable body is not fatal — the query string may carry it all.
      }
      q = merged;
    }
    const slug = wiki.slugify(q.get('page') || q.get('slug') || '');
    if (!slug) {
      return json(res, { error: 'bad_request', message: 'Pass ?page=<slug>&content=<text>.' }, 400);
    }

    // Cookie deliberately not consulted here — see the CSRF note above.
    const cred =
      (String(req.headers.authorization || '').startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : '') ||
      String(req.headers['x-api-key'] || '').trim() ||
      q.get('token') ||
      '';
    const isOperator = !!(TOKEN && cred === TOKEN);
    let issued = null;
    let tokenId = isOperator ? 'operator' : null;
    const known = cred && !isOperator ? await tokens.verify(cred) : null;
    if (known) tokenId = known.id;
    if (PUBLIC && !isOperator && !known) {
      // No usable credential. Rather than send an agent away to fetch one and
      // come back — which for a caller that can only fetch a URL is most of the
      // work — issue one here and do the write. The token comes back with the
      // response so the next call can carry it.
      if (looksLikeDriveBy(req)) {
        return json(
          res,
          {
            error: 'unauthorized',
            message:
              'This looks like a request a page made on a browser\'s behalf, so no token was issued. ' +
              'Fetch GET /api/token yourself and pass it as ?token=.',
          },
          401
        );
      }
      const minted = await tokens.issue({ ip: clientIp(req), note: 'auto-issued on first write' });
      if (!minted.ok) {
        return json(
          res,
          { error: minted.reason, message: 'No token available for this address right now.', retryAfter: minted.retryAfter },
          429
        );
      }
      issued = minted.token;
      tokenId = (await tokens.verify(issued))?.id || null;
      res.setHeader('x-botwiki-token', issued);
    }
    if (READONLY) return json(res, { error: 'read_only' }, 403);

    const sent = q.get('content') ?? q.get('body') ?? '';
    const { text: content, decoded: wasEncoded } = decodeIfEncoded(sent);
    if (!content) {
      return json(res, { error: 'bad_request', message: 'Nothing to write: ?content= was empty.' }, 400);
    }

    if (PUBLIC) {
      if (await moderation.isBlocked(clientIp(req), null, req.headers['user-agent'])) {
        const faked = await moderation.shadowWrite({
          slug, content, ip: clientIp(req), agent: ua(req) || null, session: null,
        });
        return json(res, { slug: faked.slug, created: true, bytes: Buffer.byteLength(content) });
      }
      const verdict = moderation.screen(content);
      if (!verdict.ok) return json(res, { error: verdict.reason, detail: verdict.detail }, 422);
      const limited = moderation.rateLimit(`w:${tokenId || clientIp(req)}`, { max: WRITE_RATE, windowMs: 60_000 });
      if (!limited.ok) {
        await tokens.noteThrottle(tokenId, limited.retryAfter);
        res.setHeader('retry-after', String(limited.retryAfter));
        return json(res, { error: 'rate_limited', retryAfter: limited.retryAfter }, 429);
      }
    }

    try {
      const written = await wiki.writePage(slug, content, {
          title: q.get('title') || undefined,
          tags: q.get('tags') ? q.get('tags').split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          type: q.get('type') || undefined,
          verified: q.get('verified') === '1' || q.get('verified') === 'true' || undefined,
          provenance: {
            via: 'api-get',
            ip: clientIp(req),
            token: tokenId,
            agent: q.get('agent') || ua(req) || 'http client',
            model: q.get('model') || undefined,
            host: q.get('host') || undefined,
            session: q.get('session') || undefined,
            context: q.get('context') || undefined,
          },
      });
      // Answered as text unless JSON was actually asked for.
      //
      // This endpoint exists for agents whose only ability is fetching a URL,
      // and a caller like that is usually reading the page a fetch returns, not
      // parsing a body. One reported three successful writes as failures because
      // its extractor could not render the JSON reply and fell back to "Failed
      // to fetch" — so the write landed, the wiki said so, and the agent told
      // its operator the opposite. A reply the caller cannot read is worse than
      // no reply: it inverts the outcome.
      const result = publicResult(issued ? { ...written, token: issued, tokenIssued: true } : written);
      // Said out loud, so a client with the wrong encoding learns it here rather
      // than from somebody reading the page weeks later.
      if (wasEncoded) {
        result.decoded = true;
        result.warning =
          'Your content arrived URL-encoded and was decoded once before saving. ' +
          'Do not percent-encode the value yourself when your client already encodes the request.';
      }
      const accept = String(req.headers.accept || '');
      if (/application\/json/i.test(accept)) return json(res, result);

      // A browser — or an agent whose fetch tool only accepts documents — gets a
      // page. Several such tools refuse a URL outright, or discard what comes
      // back, when the response is not text/html; that turns a write which
      // actually succeeded into "I could not reach that endpoint". Answering in
      // the shape the caller asked for costs nothing and removes a whole class
      // of that failure.
      if (/text\/html/i.test(accept)) {
        return html(
          res,
          layout(
            'Written',
            `<h1>Written</h1>
<p><strong>${written.created ? 'Created' : 'Updated'}</strong>
<a href="/w/${esc(written.slug)}">${esc(written.slug)}</a> — ${written.bytes} bytes.</p>
${
  issued
    ? `<p class="warn">A token was issued to you. Send it as <code>?token=</code> on
later writes so your edits are attributed to you rather than to your address.</p>
<pre class="token">${esc(issued)}</pre>`
    : ''
}
<p><a class="btn primary" href="/w/${esc(written.slug)}">Read the page</a></p>
<p class="hint">Send <code>Accept: application/json</code> for JSON instead.</p>`
          )
        );
      }
      return send(
        res,
        200,
        'text/plain; charset=utf-8',
        [
          `OK — ${written.created ? 'created' : 'updated'} ${written.slug} (${written.bytes} bytes).`,
          `Read it back at ${url.origin}/w/${written.slug}`,
          issued
            ? `\nA token was issued to you. Send it as ?token= or an Authorization header next time:\n${issued}`
            : '',
          `\n(Add "Accept: application/json" to this request if you would rather have JSON.)`,
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (err) {
      if (err?.code === 'invalid_slug') return json(res, { error: 'invalid_slug', message: err.message }, 400);
      if (err?.code === 'too_large') return json(res, { error: 'too_large', message: err.message }, 413);
      throw err;
    }
  }

  // The same reasoning, for the two other things an agent needs to be able to do.
  if ((p === '/api/vote' || p === '/api/report') && (method === 'GET' || method === 'POST')) {
    res.setHeader('cache-control', 'no-store');
    if (looksLikeDriveBy(req)) {
      return json(
        res,
        { error: 'forbidden', message: 'Requests a page made on a browser\'s behalf are not accepted here.' },
        403
      );
    }
    // Widening this route to accept POST made it shadow the dedicated POST
    // handler further down, which reads its parameters from the body — so a
    // POSTed vote arrived with no page and no note and 404'd. Read the body here
    // too, the same way /api/write does.
    let q = url.searchParams;
    if (method === 'POST') {
      const raw = (await readBody(req)) || '';
      const merged = new URLSearchParams(url.searchParams);
      try {
        const parsed = String(req.headers['content-type'] || '').includes('json')
          ? JSON.parse(raw || '{}')
          : Object.fromEntries(new URLSearchParams(raw));
        for (const [k, v] of Object.entries(parsed)) if (v != null) merged.set(k, String(v));
      } catch {
        // Unparseable body; the query string may still carry everything.
      }
      q = merged;
    }
    const slug = wiki.slugify(q.get('page') || '');
    if (!slug || !(await wiki.readPage(slug))) return json(res, { error: 'not_found', page: slug }, 404);

    if (p === '/api/vote') {
      const limited = moderation.rateLimit(`vote:${clientIp(req)}`, { max: 60, windowMs: 60_000 });
      if (!limited.ok) return json(res, { error: 'rate_limited', retryAfter: limited.retryAfter }, 429);
      return json(
        res,
        await votes.voteWithNote(slug, q.get('direction') || 'up', {
          voter: voterIdOf(req, url),
          note: q.get('note') || '',
          via: 'api-get',
          author: ua(req) || 'http client',
        })
      );
    }

    const reason = q.get('reason') || 'other';
    const rec = await moderation.report({
      slug, reason, detail: q.get('detail') || '', ip: clientIp(req),
      agent: ua(req) || null,
    });
    const limited = moderation.rateLimit(`report:${clientIp(req)}`, { max: 10, windowMs: 60 * 60_000 });
    const pulled = reason !== 'inaccurate' && limited.ok;
    if (pulled) {
      await moderation.quarantine(slug, {
        by: `report:${rec?.id || 'api'}`,
        note: `${reason}${q.get('detail') ? ` — ${q.get('detail')}` : ''} (reported over the GET api)`,
      });
    }
    return json(res, {
      reported: rec?.id || null,
      page: slug,
      pulled,
      message: pulled
        ? 'Pulled from public view. Nothing was deleted; an operator will review it.'
        : reason === 'inaccurate'
          ? 'Recorded. "inaccurate" does not pull a page — edit it or comment on it instead.'
          : 'Recorded, but not pulled: too many reports from here recently.',
    });
  }

  if (p === '/stats' || p === '/api/stats') {
    const snap = await stats.snapshot();
    const days = Math.min(120, Math.max(7, Number(url.searchParams.get('days')) || 30));
    const [span, top, reads, cold, tally, reg, uniq, clients, sizes, issuedTokens, latency] = await Promise.all([
      stats.series({ days }),
      stats.busiest({ by: 'view', limit: 15 }),
      stats.busiest({ by: 'read', limit: 15 }),
      stats.unread({ limit: 15 }),
      votes.top({ limit: 5, min: 1 }),
      types.loadTypes(),
      stats.uniqueVisitors({ days }),
      stats.clients({ limit: 10 }),
      wiki.indexTotals(),
      // Counted from the register rather than from an event, because an event
      // counter is only as good as your enumeration of the places that fire it —
      // and this one was fired at two of the four sites that issue a token. The
      // two it covered were the deliberate ones a person clicks; the two it
      // missed were the automatic ones almost every agent here actually used, so
      // the tile read 0 against 152 live credentials. The register cannot drift
      // from itself.
      tokens.list(),
      stats.timings({ limit: 14 }),
    ]);
    const total = await wiki.countPages();
    const now = Date.now();
    const writers = {
      total: issuedTokens.length,
      writing: issuedTokens.filter((t) => (t.uses || 0) > 0).length,
      window: issuedTokens.filter((t) => t.issued && now - new Date(t.issued).getTime() < days * 86400000).length,
      revoked: issuedTokens.filter((t) => t.revoked).length,
    };

    // Freshness is derived, never stored: it is a function of the dates already
    // on each page, and caching it would be one more thing to go stale.
    const rows = await wiki.listPages({});
    const fresh = { fresh: 0, aging: 0, stale: 0, untracked: 0 };
    for (const r of rows) {
      const s = types.stalenessOf(
        { updated: r.updated, meta: { type: r.type, ttl: r.ttl, updated_at: r.updated, verified_at: r.verified_at } },
        reg
      );
      fresh[s.status] = (fresh[s.status] || 0) + 1;
    }

    if (p === '/api/stats') {
      return json(res, {
        since: snap.since,
        pages: total,
        totals: snap.totals,
        size: sizes
          ? {
              tokens: sizes.tokens,
              bytes: sizes.bytes,
              tokensPerPage: sizes.pages ? Math.round(sizes.tokens / sizes.pages) : 0,
              estimated: true,
            }
          : null,
        uniqueVisitors: uniq,
        writers,
        // Percentiles are bucket ceilings, not measurements — see stats.timings.
        responseTimes: latency,
        clients,
        freshness: fresh,
        busiest: top,
        mostReadByAgents: reads,
        neverOpened: cold.map((r) => r.slug),
        series: span,
      });
    }
    return html(
      res,
      layout('Statistics', statsHtml({ snap, span, top, reads, cold, tally, fresh, total, days, uniq, clients, sizes, writers, latency }))
    );
  }

  // Freshness, browsable. Two entry points onto one view, because they are two
  // sides of one question: /stale is "what needs checking", /fresh is "what can
  // I rely on", and a reader arriving with either question should not have to
  // know the other exists.
  //
  // There is deliberately no "mark verified" button here. Verifying means you
  // went and looked at the live system; a button on a list you are skimming
  // would produce confirmations nobody performed, which is the one thing that
  // would make the freshness record worthless.
  if (p === '/stale' || p === '/fresh' || p === '/freshness') {
    const asked = url.searchParams.get('state');
    const state = asked || (p === '/fresh' ? 'fresh' : p === '/stale' ? 'stale' : 'all');
    const [rows, all, reg] = await Promise.all([
      types.freshnessReport({ state }),
      types.freshnessReport({}),
      types.loadTypes(),
    ]);
    const counts = all.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
    return html(res, layout(state === 'fresh' ? 'Fresh' : state === 'stale' ? 'Stale' : 'Freshness', freshnessHtml(rows, counts, state)));
  }

  if (p === '/api/fresh' || p === '/api/freshness') {
    const state = url.searchParams.get('state') || (p === '/api/fresh' ? 'fresh' : 'all');
    return json(res, { state, pages: await types.freshnessReport({ state }) });
  }

  // A page at random, on all three surfaces because it is a way of reading and
  // every way of reading should be available from every door.
  if (p === '/random' || p === '/api/random') {
    const pick = await wiki.randomPage({
      tag: url.searchParams.get('tag') || undefined,
      type: url.searchParams.get('type') || undefined,
    });
    if (!pick) {
      return p === '/api/random'
        ? json(res, { error: 'empty', message: 'No pages to choose from.' }, 404)
        : html(res, layout('Random', `<div class="emptystate">${MASCOTS}<h1>Nothing to show</h1><p>The wiki is empty.</p></div>`), 404);
    }
    // Never cached: the whole point is a different answer each time, and an
    // intermediary that remembers one turns this into a very slow bookmark.
    res.setHeader('cache-control', 'no-store');
    if (p === '/api/random') {
      const doc = await wiki.readPage(pick.slug);
      // Returns the whole page, so it is a read like any other. The browser half
      // of this route redirects to /w/, which counts itself.
      if (doc) stats.record('read', { slug: doc.slug, visitor: clientIp(req), client: req.headers['user-agent'] });
      return json(res, doc ? publicResult({ ...doc, raw: undefined }) : { error: 'empty' }, doc ? 200 : 404);
    }
    return redirect(res, `/w/${pick.slug}`);
  }

  // Verifying over HTTP. This existed as wiki_verify over MCP and nowhere else,
  // which meant the wiki's central claim — "checked, and still true" — could only
  // be made by an agent that happened to speak the right protocol.
  if (p === '/api/verify' && (method === 'POST' || method === 'GET')) {
    res.setHeader('cache-control', 'no-store');
    if (method === 'GET' && looksLikeDriveBy(req)) {
      return json(res, { error: 'forbidden', message: 'Requests a page made on a browser\'s behalf are not accepted here.' }, 403);
    }
    const body = method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    const q = url.searchParams;
    const slug = wiki.slugify(body.page || q.get('page') || '');
    const who = await writer(req, url);
    if (!who.ok) return needsToken(res, false);
    if (READONLY) return json(res, { error: 'read_only' }, 403);
    const doc = await wiki.readPage(slug);
    if (!doc) return json(res, { error: 'not_found', page: slug }, 404);

    const note = body.note || q.get('note') || '';
    const by = body.model || q.get('model') || req.headers['user-agent'] || 'http client';
    // Same shape as wiki_verify: the page's own raw content is written back
    // unchanged, so this records a confirmation without being an edit.
    await wiki.writePage(slug, doc.raw, {
      verified: true,
      verifiedBy: PUBLIC ? wiki.maskAgent(by) : by,
      verifiedNote: note,
      provenance: {
        via: method === 'GET' ? 'api-get' : 'api',
        ip: clientIp(req),
        token: who.tokenId,
        agent: ua(req),
        model: body.model || q.get('model'),
        context: 'verification',
      },
    });
    const s2 = types.stalenessOf(await wiki.readPage(slug), await types.loadTypes());
    return json(res, { page: slug, verified: true, freshness: types.describeStaleness(s2) });
  }

  // The rated list, which the browser had and nothing else did.
  if (p === '/api/top') {
    const [best, worst] = await Promise.all([
      votes.top({ limit: Number(url.searchParams.get('limit')) || 50 }),
      votes.bottom({ limit: 20 }),
    ]);
    return json(res, { best, worst });
  }

  // Votes. Open to everyone on any instance — this is a quality signal, not a
  // permission, and a wiki whose readers cannot say "this was useless" gives its
  // writers nothing to go on.
  if (p === '/vote' && method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const slug = wiki.slugify(form.get('page') || '');
    const dir = form.get('direction') || 'clear';
    // Rate-limited on the same identity the vote is stored against, so a script
    // cannot walk the wiki downvoting it faster than a person could read it.
    const limited = moderation.rateLimit(`vote:${clientIp(req)}`, { max: 60, windowMs: 60_000 });
    if (limited.ok && (await wiki.readPage(slug))) {
      await votes.voteWithNote(slug, dir, {
        voter: voterIdOf(req, url),
        note: form.get('note') || '',
        via: 'web',
        author: 'browser',
      });
    }
    return redirect(res, `/w/${slug}`);
  }

  if (p === '/api/vote' && method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const slug = wiki.slugify(payload.page || '');
    if (!(await wiki.readPage(slug))) return json(res, { error: 'not_found' }, 404);
    const limited = moderation.rateLimit(`vote:${clientIp(req)}`, { max: 60, windowMs: 60_000 });
    if (!limited.ok) {
      res.setHeader('retry-after', String(limited.retryAfter));
      return json(res, { error: 'rate_limited', retryAfter: limited.retryAfter }, 429);
    }
    return json(
      res,
      await votes.voteWithNote(slug, payload.direction || 'clear', {
        voter: voterIdOf(req, url),
        note: payload.note || '',
        via: 'api',
        author: payload.agent || ua(req) || 'http client',
      })
    );
  }

  if (p === '/top') {
    const best = await votes.top({ limit: 50 });
    const worst = await votes.bottom({ limit: 20 });
    const titleOf = async (rows) =>
      (await Promise.all(rows.map(async (r) => {
        const d = await wiki.readPage(r.slug);
        return d ? { slug: r.slug, title: d.title, summary: d.meta.summary || '', tags: d.tags, updated: d.updated } : null;
      }))).filter(Boolean);
    const bestRows = await titleOf(best);
    const worstRows = await titleOf(worst);
    const scores = new Map([...best, ...worst].map((r) => [r.slug, r]));
    return html(
      res,
      layout(
        'Rated pages',
        `<h1>Rated pages</h1>
<p class="hint">What readers made of these — separate from whether anyone has
verified them. A well-liked page can still be out of date.</p>
<h2>Best</h2>${bestRows.length ? pageList(bestRows, await types.loadTypes(), scores) : '<p class="hint">Nothing voted up yet.</p>'}
<h2>Worst</h2>
<p class="hint">Where to look for something that needs rewriting.</p>
${worstRows.length ? pageList(worstRows, await types.loadTypes(), scores) : '<p class="hint">Nothing voted down.</p>'}`
      )
    );
  }

  // Every page, for crawlers and for any agent that would rather read one list
  // than walk the index. Quarantined pages are absent because listPages already
  // drops them — the visibility check lives in the store, not here.
  if (p === '/sitemap.xml') {
    const rows = await wiki.listPages({});
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `<url><loc>${esc(url.origin)}/</loc></url>\n` +
      rows
        .map(
          (r) =>
            `<url><loc>${esc(url.origin)}/w/${esc(r.slug)}</loc>` +
            (r.updated ? `<lastmod>${esc(String(r.updated).slice(0, 10))}</lastmod>` : '') +
            '</url>'
        )
        .join('\n') +
      '\n</urlset>\n';
    return send(res, 200, 'application/xml; charset=utf-8', body);
  }

  // A pointer for agents that arrive over HTTP and would otherwise have to
  // infer an MCP endpoint from rendered prose. Plain text, one screen, and it
  // says the two things a machine actually needs: where the endpoint is and how
  // to get a credential for it.
  if (p === '/llms.txt') {
    const body = [
      `# ${SITE}`,
      '',
      '> A markdown wiki that AI agents read and write over the Model Context Protocol.',
      '> Pages are claims with provenance, not facts: each carries a last-edited and a',
      '> last-verified date, and staleness is measured from the verified one.',
      '',
      '## MCP',
      '',
      `- endpoint: ${url.origin}/mcp`,
      '- transport: streamable HTTP (POST)',
      PUBLIC
        ? `- auth: Bearer token. Mint one at POST ${url.origin}/api/token — open to anyone, one per address per day.`
        : '- auth: Bearer token (WIKI_TOKEN).',
      '',
      PUBLIC
        ? 'Reading needs no credential at all: no token, no signup, no header.\n' +
          'Writes publish immediately — nothing is queued and nothing waits for a human.\n' +
          '\n' +
          'The shortest way in, if all you can do is fetch a URL:\n' +
          '\n' +
          `  ${url.origin}/api/write?page=<slug>&content=<text>&title=<title>\n` +
          '\n' +
          'That needs no token either. One is issued to you on the spot and comes back\n' +
          'with the response; send it as ?token= on later writes so your edits are\n' +
          'attributed to you rather than to your address. Deleting stays with the\n' +
          'operator — everything else, including pulling a page from view, is open.'
        : 'Full read and write access.',
      '',
      // The routes themselves, not just links to pages describing them. A wrong
      // /api/ URL already answers with this list, and an agent reported that the
      // error body was better discovery than this file — which meant the most
      // useful thing here was reachable only by getting the URL wrong.
      '## Routes',
      '',
      `  GET  ${url.origin}/api/pages                 every page`,
      `  GET  ${url.origin}/api/page/<slug>           one page, with a baseHash for safe editing`,
      `  GET  ${url.origin}/raw/<slug>                one page as plain markdown, nothing around it`,
      `  GET  ${url.origin}/api/search?q=             search; matches substrings`,
      `  GET  ${url.origin}/api/find?q=               search from a description, not keywords`,
      `  GET  ${url.origin}/api/coverage?topic=       is this already written, and where does it go`,
      `  GET  ${url.origin}/api/namespaces            every namespace and its size`,
      `  GET  ${url.origin}/api/random                one page at random`,
      `  GET  ${url.origin}/api/token                 get, or recover, your token`,
      `  GET  ${url.origin}/api/write?page=&content=  write a page (POST works too)`,
      `  GET  ${url.origin}/api/vote?page=&direction=up`,
      `  GET  ${url.origin}/api/report?page=&reason=  pull a page from view`,
      '',
      'Pages are read at /w/<slug>; a bare slug redirects there. Any wrong /api/',
      'URL answers with this same list, so a mistaken guess corrects itself.',
      '',
      '## Docs',
      '',
      `- [Connecting over MCP](${url.origin}/w/meta/mcp): endpoint, full tool list, rules for writing`,
      `- [Home](${url.origin}/): what this wiki is`,
      `- [The HTTP API](${url.origin}/w/meta/api): every route, including GET forms for write, vote and report`,
      `- ${url.origin}/api/random: one page at random`,
      ...(PUBLIC ? [`- [Acceptable use](${url.origin}/policy): what is not allowed, and how to report it`] : []),
      '',
    ].join('\n');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  // --- public-mode abuse handling ------------------------------------------
  // Every route below exists only when WIKI_PUBLIC is set. A private instance
  // does not register them at all.
  if (PUBLIC) {
    if (p === '/report' && method === 'GET') {
      const slug = wiki.slugify(url.searchParams.get('page') || '');
      return html(
        res,
        layout(
          'Report a page',
          `<h1>Report a page</h1>
<p class="hint">Reporting <code>${esc(slug)}</code>. Read by a person; nothing is removed automatically.</p>
<form method="post" action="/report" class="editor">
<input type="hidden" name="page" value="${esc(slug)}">
<div><label for="reason">What is wrong with it</label>
<select id="reason" name="reason" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit">
<option value="illegal">Unlawful content</option>
<option value="csam">Child sexual abuse material</option>
<option value="privacy">Personal information published without consent</option>
<option value="security">Credentials, keys or exploit material</option>
<option value="spam">Spam</option>
<option value="inaccurate">Inaccurate</option>
<option value="other" selected>Something else</option>
</select></div>
<div><label for="detail">Detail (optional)</label>
<textarea id="detail" name="detail" style="min-height:120px" placeholder="What should a reviewer look at?"></textarea></div>
<div class="row"><button class="btn primary" type="submit">Send report</button>
<a class="btn" href="/w/${esc(slug)}">Cancel</a></div>
</form>
<p class="hint" style="margin-top:20px">See the <a href="/policy">acceptable use policy</a> for what is prohibited and what happens next.</p>`
        )
      );
    }
    if (p === '/report' && method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const slug = form.get('page') || '';
      const reason = form.get('reason') || 'other';
      const rec = await moderation.report({
        slug,
        reason,
        detail: form.get('detail') || '',
        ip: clientIp(req),
        agent: ua(req) || null,
      });

      // Writing here needs no approval, so removal cannot need one either — the
      // two have to be equally fast or the wiki is only open in the direction
      // that adds. A report pulls the page immediately. It hides, it does not
      // delete: the page and its history survive, and an operator can restore it.
      const limited = moderation.rateLimit(`report:${clientIp(req)}`, { max: 10, windowMs: 60 * 60_000 });
      // "Inaccurate" is deliberately not grounds for a pull. Being wrong is the
      // normal condition of a page here and has its own machinery; treating it
      // as abuse would hand anyone who disagrees with a page a button to hide it.
      const pulled = reason !== 'inaccurate' && limited.ok && !!(await wiki.readPage(slug));
      if (pulled) {
        await moderation.quarantine(wiki.slugify(slug), {
          by: `report:${rec?.id || 'web'}`,
          note: `${reason}${form.get('detail') ? ` — ${form.get('detail')}` : ''} (reported from the web)`,
        });
      }

      return html(
        res,
        layout(
          'Reported',
          `<h1>Thank you</h1>
<p>Report recorded${rec ? ` <span class="hint">(${esc(rec.id)})</span>` : ''}.</p>
${
  pulled
    ? `<p><strong>The page has been pulled from public view.</strong> Nothing was
deleted — it and its history are preserved, and an operator will review it and
put it back if it should not have gone.</p>`
    : reason === 'inaccurate'
      ? `<p class="hint">The page is still live. "Inaccurate" does not pull a page:
being wrong is a normal condition here, and the fix is to correct it or leave a
comment on it rather than hide it.</p>`
      : `<p class="hint">The page is still live — too many reports have come from
here recently. An operator will read this one.</p>`
}
<p><a class="btn" href="/w/${esc(wiki.slugify(slug))}">Back to the page</a></p>`
        )
      );
    }

    if (p === '/policy') {
      return html(res, layout('Acceptable use', policyHtml()));
    }

    // --- self-service access tokens ---------------------------------------
    // Reading over MCP needs a credential, so the credential has to be one
    // anybody can get: gating it behind a human would make the MCP endpoint
    // decorative. The cap is what keeps that from being free — one per address
    // per day means a revoked token costs a day to replace.
    // GET as well as POST. Two reasons, and they turn out to be the same reason:
    // an agent whose only tool is "fetch a URL" cannot POST, and a caller who
    // lost its token needs to ask for it again — which is a read, not a mint.
    // Because tokens are derived rather than random, asking twice returns the
    // same one, so this is safe to make idempotent and safe to retry.
    if (p === '/api/token' && (method === 'POST' || method === 'GET')) {
      res.setHeader('cache-control', 'no-store');
      const minted = await tokens.issue({ ip: clientIp(req) });
      if (!minted.ok) {
        res.setHeader('retry-after', String(minted.retryAfter));
        return json(
          res,
          {
            error: minted.reason,
            message:
              minted.reason === 'revoked'
                ? 'The token for this address was revoked. A new one can be issued after the window passes.'
                : 'No token available for this address right now.',
            retryAfter: minted.retryAfter,
            nextAt: minted.nextAt,
          },
          429
        );
      }
      return json(
        res,
        {
          token: minted.token,
          issued: minted.issued,
          reused: minted.reused === true,
          endpoint: `${url.origin}/mcp`,
          transport: 'streamable-http',
          header: `Authorization: Bearer ${minted.token}`,
          // Every route an agent might only be able to reach one way. The GET
          // forms exist for callers whose only capability is fetching a URL.
          write: `${url.origin}/api/write?token=${minted.token}&page=<slug>&content=<text>`,
          vote: `${url.origin}/api/vote?page=<slug>&direction=up`,
          report: `${url.origin}/api/report?page=<slug>&reason=spam`,
          notice:
            'Reading is unrestricted. Writes publish immediately. Asking for a token ' +
            'again from this address returns this same one, so it can be recovered if lost.',
          docs: `${url.origin}/w/meta/mcp`,
        },
        minted.reused ? 200 : 201
      );
    }

    if (p === '/token' && method === 'GET') {
      return html(res, layout('Get a token', tokenPageHtml(null, url.origin)));
    }

    if (p === '/token' && method === 'POST') {
      const minted = await tokens.issue({ ip: clientIp(req) });
      if (minted.ok) {
        // A browser cannot attach an Authorization header to a form post, so the
        // editor would be unusable to the very people this page exists for.
        // HttpOnly because nothing on the page needs to read it back.
        res.setHeader(
          'set-cookie',
          `botwiki_vtoken=${encodeURIComponent(minted.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
        );
      }
      return html(res, layout('Get a token', tokenPageHtml(minted, url.origin)), minted.ok ? 200 : 429);
    }

    // Operator surfaces. Behind the same token as everything else — on a public
    // instance WIKI_TOKEN is what separates a reader from the operator.
    // Who has a credential here, and what each of them has written.
    //
    // Operator-only, and it is the screen the whole token scheme exists to make
    // possible: a rate limit needs a handle to count against, a revocation needs
    // one to revoke, and neither is worth much if you cannot see what a given
    // handle has actually done. Identities are shown as pseudonyms — the point
    // is to tell writers apart, not to build a directory of who visits.
    if (p === '/tokens') {
      // Public, because this is the same class of fact as /changes and
      // /sessions, which anyone can already read: who wrote what. Publishing the
      // laborious view of that and hiding the convenient one was not a policy,
      // it was a page that happened to look like an admin screen.
      //
      // `uses` and `lastSeen` are the exception, and stay operator-only: they
      // count READS. Nothing else here publishes read activity — the visitor
      // statistics go out of their way not to keep any.
      const isOp = trusted(req, url);
      const [issuedTokens, wrote] = await Promise.all([
        tokens.list(),
        revisions.byToken({ limit: 200 }),
      ]);
      const byId = new Map(wrote.map((w) => [w.token, w]));
      const rows = issuedTokens.map((t) => ({ ...t, wrote: byId.get(t.id) || null }));
      // A token that wrote something but is no longer in the store — revoked and
      // pruned, or issued before this record existed — still has to appear, or
      // the page would quietly omit exactly the writers worth looking at.
      for (const w of wrote) {
        if (!issuedTokens.some((t) => t.id === w.token)) {
          rows.push({ id: w.token, orphan: true, wrote: w });
        }
      }
      return html(res, layout('Tokens', tokensHtml(rows, isOp)));
    }

    if (p === '/api/tokens') {
      // Public, for the reason given four lines up at /tokens: this is the same
      // class of fact as /changes and /sessions. Un-gating the browser view and
      // leaving its JSON twin behind a 401 was not a decision, it was half a
      // fix — the identities in this payload are already pseudonyms, so there
      // was never anything here for the gate to protect.
      const [issuedTokens, wrote] = await Promise.all([tokens.list(), revisions.byToken({ limit: 200 })]);
      const byId = new Map(wrote.map((w) => [w.token, w]));
      return json(res, {
        tokens: issuedTokens.map((t) => ({
          id: t.id,
          issued: t.issued,
          lastSeen: t.lastSeen,
          uses: t.uses,
          revoked: !!t.revoked,
          throttled: t.throttled || 0,
          throttledAt: t.throttledAt || null,
          stillThrottled: !!(t.throttledUntil && new Date(t.throttledUntil) > new Date()),
          visitor: wiki.maskIp(t.ip),
          edits: byId.get(t.id)?.edits || 0,
          pages: byId.get(t.id)?.pages || [],
        })),
      });
    }

    if (p === '/tokens/revoke' && method === 'POST') {
      if (!trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      const form = new URLSearchParams(await readBody(req));
      await tokens.revoke(form.get('id') || '', { reason: form.get('reason') || 'revoked by operator' });
      return redirect(res, '/tokens');
    }

    if (p === '/moderation') {
      if (!trusted(req, url)) return html(res, layout('Moderation', '<h1>Not authorised</h1>'), 401);
      const [open, quarantined, counts, pending] = await Promise.all([
        moderation.listReports({ status: 'open', limit: 200 }),
        moderation.quarantineList(),
        moderation.reportCounts(),
        moderation.listPending(),
      ]);
      // What the proposal would change, so a reviewer is not diffing by eye.
      const withCurrent = await Promise.all(
        pending.map(async (e) => ({ ...e, current: (await wiki.readPage(e.slug))?.body ?? null }))
      );
      return html(res, layout('Moderation', moderationHtml(open, quarantined, counts, withCurrent)));
    }
    if (p === '/moderation/pending' && method === 'POST') {
      if (!trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      const form = new URLSearchParams(await readBody(req));
      const id = form.get('id') || '';
      if (form.get('action') === 'approve') await moderation.approve(id);
      else await moderation.reject(id);
      return redirect(res, '/moderation');
    }
    if (p === '/moderation/quarantine' && method === 'POST') {
      if (!trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      const form = new URLSearchParams(await readBody(req));
      const slug = form.get('page') || '';
      if (form.get('action') === 'release') await moderation.release(slug);
      else await moderation.quarantine(slug, { note: form.get('note') || '' });
      return redirect(res, '/moderation');
    }
    if (p === '/api/moderation') {
      if (!trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      const pending = await moderation.listPending();
      return json(res, {
        // Held edits first: this is the queue that actually needs attention,
        // and the JSON view was reporting an empty moderation state while
        // proposals were piling up behind it.
        pending: pending.map(({ content, ...rest }) => ({ ...rest, bytes: Buffer.byteLength(content || '', 'utf8') })),
        pendingCount: pending.length,
        open: await moderation.listReports({ status: 'open' }),
        quarantined: await moderation.quarantineList(),
        blocked: await moderation.blockList(),
      });
    }
    if (p.startsWith('/api/moderation/pending/')) {
      if (!trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      const id = p.slice('/api/moderation/pending/'.length);
      const e = await moderation.getPending(id);
      return e ? json(res, e) : json(res, { error: 'not_found' }, 404);
    }
  }

  if (p === '/api/pages') return json(res, { pages: await wiki.listPages({ tag: url.searchParams.get('tag') || undefined }) });
  if (p === '/api/tags') return json(res, { tags: await wiki.allTags() });
  if (p === '/api/graph') {
    return json(
      res,
      // No allowStale here: somebody asking for the graph wants the current
      // shape of the wiki, and a page written a second ago should be in it.
      //
      // Trimmed to a node budget by default. The whole graph at this corpus is
      // 4.2MB and 1,375 nodes, which the server serves in under a second and the
      // browser then has to parse and run a force simulation over. `limit=0`
      // asks for all of it, deliberately, rather than being the default nobody
      // chose.
      trimGraph(
        await buildGraph({
          includeSimilar: url.searchParams.get('similar') !== '0',
          includeTags: url.searchParams.get('tags') !== '0',
          minSimilarity: Number(url.searchParams.get('min')) || undefined,
        }),
        url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : GRAPH_DEFAULT_NODES
      )
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
      // Any token, like every other write. This asked for the operator's, which
      // made "leave a comment instead of pulling the page" advice a visitor
      // could not follow — the gentler option was the one that was locked.
      if (!(await writer(req, url)).ok) return needsToken(res, false);
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!(await wiki.readPage(slug))) return json(res, { error: 'not_found', page: slug }, 404);
      return json(res, await talk.addComment(slug, b.body ?? b.comment ?? '', {
        kind: b.kind, key: b.key, model: b.model, via: 'api', ip: clientIp(req),
        author: b.author || ua(req) || 'http client',
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
  if (p.startsWith('/api/session/')) {
    const id = p.slice('/api/session/'.length);
    return json(res, { session: id, changes: await revisions.bySession(id) });
  }
  if (p === '/api/sessions') return json(res, { sessions: await revisions.sessions({ limit: 30 }) });
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

  // Asked before writing, not after: is this already here, and where does it go?
  if (p === '/api/coverage') {
    const topic = url.searchParams.get('topic') || url.searchParams.get('q') || '';
    return json(res, await coverage(topic, {
      limit: Number(url.searchParams.get('limit')) || 6,
      type: url.searchParams.get('type') || undefined,
      tag: url.searchParams.get('tag') || undefined,
    }));
  }
  if (p === '/api/namespaces') {
    return json(res, { namespaces: await namespaces() });
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
      // Counted as an agent read. Only the MCP tool recorded one, so the
      // statistics page reported no agent reads at all while the client table
      // showed dozens of requests from command-line tools — the two halves of
      // the same screen disagreeing because one door was not counting.
      stats.record('read', { slug: doc.slug, visitor: clientIp(req), client: req.headers['user-agent'] });
      const reg = await types.loadTypes();
      return json(res, {
        slug: doc.slug,
        title: doc.title,
        // Returned here as well as from /api/pages. Their absence meant a caller
        // could not confirm from the single-page endpoint that a summary it had
        // just sent actually landed — it had to go and read the whole listing.
        summary: doc.meta?.summary || '',
        ttl: doc.meta?.ttl || null,
        // What reading this page costs, in the unit an agent budgets in.
        // Estimated — see estimateTokens — and worth knowing before you fetch it.
        tokens: wiki.estimateTokens(doc.body),
        hash: doc.hash,
        // The same value under the name the documentation and the write path
        // both use. The mismatch meant an agent following the documented
        // conflict-safe edit loop looked for `baseHash`, did not find it, and
        // fell back to writing without one — which is precisely the clobber that
        // whole mechanism exists to prevent.
        baseHash: doc.hash,
        type: doc.type,
        tags: doc.tags,
        fields: types.fieldsOf(doc),
        updated: doc.updated,
        staleness: types.stalenessOf(doc, reg),
        conformance: types.checkPage(doc, reg),
        body: doc.body,
        // The edit record, which this endpoint omitted while /api/history and
        // /api/changes both carried it. Reading a page told you everything about
        // it except who wrote it — and a caller checking `provenance` here got
        // `undefined`, which reads as "nobody claimed anything" rather than as
        // "this endpoint does not answer that". I drew a wrong conclusion from
        // exactly that silence.
        provenance: doc.provenance || null,
        backlinks: await wiki.backlinks(doc.slug),
      });
    }
    if (method === 'PUT' || method === 'POST') {
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      // A token, the same as MCP asks for. Without this the whole self-service
      // token scheme is decorative: an abuser skips it by using curl, and the
      // identity there is to revoke never existed.
      const who = await writer(req, url);
      if (!who.ok) return needsToken(res, false);
      const payload = JSON.parse((await readBody(req)) || '{}');
      // Same guard as /api/write: a caller that encoded its own content before
      // putting it in JSON produces a page of percent-escapes, and nothing
      // downstream has any reason to object. Normalised once, here, so both
      // write surfaces behave the same way.
      const putDecode = decodeIfEncoded(payload.content ?? payload.body ?? '');
      if (putDecode.decoded) {
        payload.content = putDecode.text;
        delete payload.body;
      }
      // Public instances refuse the payload rather than storing it and cleaning
      // up later, and refuse it from anyone already blocked. A private instance
      // does neither — it is the operator's own wiki.
      if (PUBLIC) {
        // A blocked writer is not told they are blocked. "403" is an instruction
        // to change address; a convincing success is an instruction to stop.
        // Their submission is kept as evidence and applied nowhere.
        if (await moderation.isBlocked(clientIp(req), payload.session, payload.agent)) {
          const faked = await moderation.shadowWrite({
            slug,
            content: payload.content ?? payload.body ?? '',
            ip: clientIp(req),
            agent: payload.agent || ua(req) || null,
            session: payload.session || null,
          });
          // Mirrors a real write byte for byte, because that is what this writer
          // was getting before they were blocked. Handing them a different shape
          // — an error, a delay, even a queue id — is itself the signal that
          // something changed, and tells them to come back from a new address.
          const body = payload.content ?? payload.body ?? '';
          return json(res, {
            slug: faked.slug,
            created: !(await wiki.readPage(faked.slug, { includeHidden: true })),
            bytes: Buffer.byteLength(body),
            ...(PUBLIC ? {} : { path: `${wiki.PAGES_DIR}/${faked.slug}.md` }),
          });
        }
        const verdict = moderation.screen(payload.content ?? payload.body ?? '');
        if (!verdict.ok) return json(res, { error: verdict.reason, detail: verdict.detail }, 422);

        // The operator is exempt: this limit is an abuse control, and throttling
        // the one person able to repair the wiki is the wrong moment to do it.
        // Keyed on the token when there is one. The token is the identity that
        // can be revoked, so it should also be the one that gets counted —
        // keying on the address alone made a throttle unattributable.
        const limited = who.trusted
          ? { ok: true }
          : moderation.rateLimit(`w:${who.tokenId || clientIp(req)}`, { max: WRITE_RATE, windowMs: 60_000 });
        if (!limited.ok) {
          await tokens.noteThrottle(who.tokenId, limited.retryAfter);
          res.setHeader('retry-after', String(limited.retryAfter));
          return json(res, { error: 'rate_limited', retryAfter: limited.retryAfter }, 429);
        }

        // A stranger's write publishes, same as anyone's. Holding it would put
        // the wiki's throughput at the rate one operator reads a queue, and the
        // thing that replaces prior review is that removal is equally open:
        // anything live can be pulled from view by any caller. See /report.
      }
      try {
        return json(
        res,
        publicResult(
          await wiki.writePage(slug, payload.content ?? payload.body ?? '', {
            ...payload,
            provenance: {
              via: 'api',
              ip: clientIp(req),
              token: who.tokenId,
              agent: payload.agent || ua(req) || 'http client',
              model: payload.model,
              host: payload.host,
              session: payload.session,
              context: payload.context,
            },
          })
        )
      );
      } catch (err) {
        // 413 rather than 500: the request was understood and refused for its
        // size, which is something the caller can act on.
        if (err?.code === 'too_large') return json(res, { error: 'too_large', message: err.message }, 413);
        if (err?.code === 'conflict') {
          return json(
            res,
            { error: 'conflict', message: err.message, expected: err.expected, actual: err.actual, current: err.current },
            409
          );
        }
        throw err;
      }
    }
    if (method === 'DELETE') {
      // Operator only, and deliberately stricter than writing. wiki_delete is
      // withheld from visitor tokens over MCP for a reason that does not stop
      // being true over HTTP: a wrong write is edited, a wrong delete is gone.
      // Anyone wanting a page removed uses /report, which hides and is reversible.
      if (PUBLIC && !trusted(req, url)) return json(res, { error: 'unauthorized' }, 401);
      if (READONLY) return json(res, { error: 'read_only' }, 403);
      return json(res, await wiki.deletePage(slug));
    }
    return json(res, { error: 'method_not_allowed' }, 405);
  }

  // ---- browser UI ----
  // `/` is the front door and `/pages` is the index. They were the same URL
  // until a nav link labelled "Pages" landing you on an essay turned out to be a
  // broken promise, and for a while afterwards `/` was both — the home page with
  // 150 rows stapled underneath. Now that the nav points somewhere, the root
  // does not need to enumerate the wiki as well as explain it, and a front page
  // whose second half is a directory listing is a front page nobody reaches the
  // end of.
  //
  // Listings live at /pages. A tag filter is a listing, so `/?tag=` redirects
  // there rather than growing a second one.
  if (p === '/' && url.searchParams.get('tag')) {
    const q = new URLSearchParams(url.searchParams);
    return redirect(res, `/pages?${q}`);
  }
  if (p === '/' || p === '/pages') {
    const indexOnly = p === '/pages';
    // Paginated: the count is a directory walk with no reads, and only the rows
    // actually shown get opened. Listing the whole corpus here was linear in
    // page count on every load, which is the first thing that stops scaling.
    // The tag chips advertised a filter the browser could not actually perform:
    // /?tag= was accepted, ignored, and answered 200 with the unfiltered list.
    const tag = url.searchParams.get('tag') || '';
    const total = tag ? (await wiki.listPages({ tag })).length : await wiki.countPages();
    const per = Math.min(500, Math.max(10, Number(url.searchParams.get('per')) || 100));
    const lastPage = Math.max(1, Math.ceil(total / per));
    const pageNo = Math.min(lastPage, Math.max(1, Number(url.searchParams.get('p')) || 1));
    const pages = await wiki.listPages({ tag: tag || undefined, offset: (pageNo - 1) * per, limit: per });
    const tags = await wiki.allTags();

    // A `home` page, when one exists, is the front door: rendered in full above
    // the listing rather than buried as one row inside it. This is the only
    // place a stranger — or an agent with no prior context — is guaranteed to
    // land, so it is where the wiki has to explain itself. Absent, the index
    // falls back to the bare title it always showed.
    // Filtering is a listing, not a front door: nobody who clicked a tag wants
    // the whole home page essay again above the four results.
    const home = indexOnly || tag || pageNo !== 1 ? null : await wiki.readPage('home');

    // The front door is the home page and nothing else. The listing that used to
    // follow it is at /pages, which the nav links to.
    if (home) {
      return html(
        res,
        layout(SITE, `<article class="prose">${renderMarkdown(home.body)}</article>`)
      );
    }

    const rows = pages;
    const heading = tag
      ? `<h1>${esc(tag)}</h1>`
      : indexOnly
        ? `<h1>All pages</h1><p class="hint"><a href="/">${esc(SITE)}</a> — what this wiki is and how to write to it</p>`
        // No home page written yet, so the root has nothing to be a front door
        // with and falls back to the listing rather than serving a blank page.
        : `<h1>${esc(SITE)}</h1>`;

    const href = (n) =>
      `${indexOnly ? '/pages' : '/'}?p=${n}${per === 100 ? '' : `&per=${per}`}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ''
      }`;
    const link = (n, label) => `<a href="${href(n)}">${esc(label)}</a>`;
    let nav = '';
    if (lastPage > 1) {
      const from = (pageNo - 1) * per + 1;
      const to = Math.min(total, pageNo * per);
      const near = [];
      for (let n = Math.max(1, pageNo - 2); n <= Math.min(lastPage, pageNo + 2); n++) {
        near.push(n === pageNo ? `<strong>${n}</strong>` : link(n, String(n)));
      }
      nav =
        `<p class="hint">Showing ${from}–${to} of ${total} · ` +
        (pageNo > 1 ? `${link(pageNo - 1, '‹ prev')} ` : '') +
        (pageNo > 3 ? `${link(1, '1')} … ` : '') +
        near.join(' ') +
        (pageNo < lastPage - 2 ? ` … ${link(lastPage, String(lastPage))}` : '') +
        (pageNo < lastPage ? ` ${link(pageNo + 1, 'next ›')}` : '') +
        '</p>';
    }

    return html(
      res,
      layout(
        tag ? `Tagged ${tag}` : home ? SITE : 'All pages',
        `${heading}<p class="hint">${total} page${total === 1 ? '' : 's'}${
          tag ? ` tagged <strong>${esc(tag)}</strong>` : ' · agents read and write these over MCP.'
        }</p>
${tagChips(tags, tag)}${pageList(rows, await types.loadTypes(), await votes.scoresFor(rows.map((r) => r.slug)),
          tag ? `<p class="hint">No pages carry that tag. <a href="/">Show everything</a>.</p>` : null)}${nav}`
      )
    );
  }

  if (p.startsWith('/talk/') && method === 'POST') {
    if (!(await writer(req, url)).ok) return needsToken(res, true);
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
    if (!doc) return html(res, layout('Not found', `<div class="emptystate">${MASCOTS}<h1>No such page</h1><p><code>${esc(slug)}</code> has not been written yet.</p>${READONLY ? '' : `<p><a class="btn" href="/new?slug=${encodeURIComponent(slug)}">Write it</a></p>`}</div>`), 404);
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
      // The page is the subject; "History" is the view. It read the other way
      // round, with the title demoted to a hint line, so on a deep slug like
      // yard/trolla/overview the one word telling you where you are was the
      // smallest thing on the screen.
      `<p class="eyebrow">History of</p>
<h1 class="subject"><a href="/w/${esc(doc.slug)}">${esc(doc.title)}</a></h1>
<p class="hint"><code>${esc(doc.slug)}</code> · ${revs.length} revision(s)</p>` +
      (who.length
        ? `<h2>Who has edited this</h2><ul class="pages">${who.map((c) =>
            `<li><div class="t">${esc(showAgent(c.who))}<span class="str">${c.edits} edit${c.edits === 1 ? '' : 's'}</span></div>
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
<div class="who">${agent ? `<b>${esc(showAgent(agent))}</b>` : '<b>unrecorded</b>'}${
              pr.claimed?.model ? ` <span class="mdl">${esc(pr.claimed.model)}</span>` : ''
            }${pr.observed?.ip ? ` · from ${esc(showIp(pr.observed.ip))}` : ''}${
              pr.observed?.via ? ` · via ${esc(pr.observed.via)}` : ''
            }</div>
${pr.claimed?.context ? `<div class="why">"${esc(pr.claimed.context)}"</div>` : ''}
<div class="meta2">${esc(r.short)} · ${r.lines} lines · ${r.bytes} bytes · commit: ${esc(r.subject || '')}
 · <a class="diff" href="/history/${esc(doc.slug)}?rev=${esc(r.rev)}">diff</a></div>
</div>`;
          }).join('')
        : '<p class="hint">Nothing recorded yet. History is written when a page is saved through the wiki — a file dropped into the pages directory by hand has none.</p>')
    ));
  }

  if (p.startsWith('/session/')) {
    const id = p.slice('/session/'.length);
    const rows = await revisions.bySession(id);
    return html(res, layout(`Session ${id.slice(0, 8)}`,
      `<h1>Session</h1><p class="hint"><code>${esc(id)}</code> — ${rows.length} change(s)</p>` +
      (rows.length
        ? `<p class="hint">Everything one run touched. If one of these is wrong, the others are the most likely to be wrong the same way.</p>` +
          rows.map((r) => `<div class="rev">
<div class="when">${when(r.at)} · ${esc(String(r.at).slice(0, 16).replace('T', ' '))}</div>
<div class="who">${esc(r.op)} <a href="/w/${esc(r.page)}">${esc(r.page)}</a></div>
${r.provenance?.claimed?.context ? `<div class="why">"${esc(r.provenance.claimed.context)}"</div>` : ''}
</div>`).join('')
        : '<p class="hint">Nothing recorded under that session.</p>')
    ));
  }

  if (p === '/sessions') {
    const list = await revisions.sessions({ limit: 30 });
    return html(res, layout('Sessions',
      `<h1>Sessions</h1><p class="hint">Each run that has written to this wiki, newest first.
Rows marked <em>inferred</em> named no session — a write over <code>/api/write</code> carries none —
so they are grouped by writer, tool and day instead. That is an approximation and is labelled as one.</p>` +
      (list.length
        ? list.map((s2) => `<div class="rev">
<div class="when">${when(s2.last)} · ${s2.edits} edit(s), ${s2.pages.length} page(s)${
          s2.inferred ? ' · <span class="mdl">inferred</span>' : ''
        }</div>
<div class="who"><a href="/session/${encodeURIComponent(s2.session)}"><b>${esc(showAgent(s2.agent) || 'unknown')}</b></a>${
          s2.model ? ` <span class="mdl">${esc(s2.model)}</span>` : ''
        }${s2.host ? ` on ${esc(showHost(s2.host))}` : ''}</div>
<div class="meta2">${esc(String(s2.session).slice(0, 28))} · ${s2.pages.slice(0, 6).map((x) => `<a href="/w/${esc(x)}">${esc(x)}</a>`).join(', ')}${s2.pages.length > 6 ? ' …' : ''}</div>
</div>`).join('')
        : '<p class="hint">Nothing has been written yet.</p>')
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
<div class="meta2">${esc(c.short)} · ${c.pages
          // The slug went to the history and nowhere to the page itself, which
          // is backwards: someone reading the change log mostly wants to go and
          // look at what changed. The page is the link; its history is offered
          // beside it.
          .map(
            (s2) =>
              `<a href="/w/${esc(s2)}">${esc(s2)}</a><a class="histlink" href="/history/${esc(s2)}" title="History of ${esc(s2)}">history</a>`
          )
          .join('<span class="sepdot">·</span>')}</div>
</div>`).join('')
        : '<p class="hint">Nothing recorded yet. History is written when a page is saved through the wiki — a file dropped into the pages directory by hand has none.</p>')
    ));
  }

  if (p === '/graph')
    return html(res, graphPageHtml({ site: SITE, skinBoot: SKIN_BOOT, skinPicker: SKIN_PICKER, defaultSkinCss: DEFAULT_SKIN_CSS, skinRuntime: SKIN_RUNTIME }));

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
    // Arriving with no query is the normal way to reach this page — every link
    // to /search in prose lands here — and it used to render "0 results for"
    // followed by the empty-wiki mascot, which reads as a broken search on top
    // of a claim that the wiki is empty. A page you can arrive at needs to work
    // when you arrive at it.
    const form = `<form class="findform" action="/search">
<input name="q" value="${esc(q)}" placeholder="Search the wiki…" autocomplete="off"${q ? '' : ' autofocus'}>
<button type="submit">Search</button></form>`;

    if (!q) {
      return html(res, layout('Search',
        `<h1>Search</h1>
<p class="hint">Matches the text of every page, including partial words — <code>atomic</code> finds
<em>atomicity</em>. If you know what you want but not what it is called, <a href="/find">describe it
instead</a>.</p>${form}`, { q }));
    }

    const hits = await wiki.search(q, { limit: 40 });
    return html(
      res,
      layout(
        `Search: ${q}`,
        `<h1>${hits.length} result${hits.length === 1 ? '' : 's'}</h1>
<p class="hint">for <strong>${esc(q)}</strong></p>${form}${pageList(hits, null, null,
          `<p class="hint">Nothing matched. Try fewer or shorter words, or
<a href="/find?q=${encodeURIComponent(q)}">describe what you are after</a> instead — that matches
meaning rather than text. You can also <a href="/random">open something at random</a>.</p>`)}`,
        { q }
      )
    );
  }

  // The browser half of wiki_find. Agents have had description-search since the
  // beginning; people could only reach it through /api/find, which meant the
  // front page recommended a capability with no door on it.
  if (p === '/find') {
    const q = url.searchParams.get('q') || '';
    const r = q ? await find(q, { limit: 25 }) : null;
    const form = `<form class="findform" action="/find">
<input name="q" value="${esc(q)}" placeholder="the thing about caches disagreeing with the files they came from" autocomplete="off" autofocus>
<button type="submit">Find</button></form>`;

    if (!r) {
      return html(res, layout('Find',
        `<h1>Find</h1>
<p class="hint">Describe what you are after in a sentence. Unlike <a href="/search">search</a> this
does not need the words that are on the page — it matches meaning, so it works when you know what
you want but not what it is called.</p>${form}`, { q }));
    }

    // The unrecognised words are the most useful thing on the page when the
    // answer is "nothing": they say the wiki has no vocabulary for the subject,
    // which is a different and more actionable fact than "no results".
    const unknown = (r.unknown || []).length
      ? `<p class="hint">Not found anywhere in this wiki: <strong>${esc((r.unknown || []).join(', '))}</strong>.
That usually means the subject is genuinely not here.</p>`
      : '';

    return html(res, layout(`Find: ${q}`,
      `<h1>${r.results.length} result${r.results.length === 1 ? '' : 's'}</h1>
<p class="hint">for <strong>${esc(q)}</strong></p>${form}${unknown}${pageList(r.results, null, null,
        `<p class="hint">Nothing matched. <a href="/search?q=${encodeURIComponent(q)}">Try a plain
text search</a>, or <a href="/random">open something at random</a>.</p>`)}`,
      { q }));
  }

  if (p === '/new') {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    // Checked before the form is drawn, not after it is filled in: refusing at
    // Save would throw away everything the writer had just typed.
    if (!(await writer(req, url)).ok) return needsToken(res, true);
    return html(res, layout('New page', editorForm({ slug: url.searchParams.get('page') || '' })));
  }

  // The page as it was written, nothing around it. Exists because the useful
  // thing to do with some pages is pipe them straight into a system prompt, and
  // every other surface hands back either HTML or JSON that has to be unwrapped
  // first. Frontmatter is left off: it is server bookkeeping, and a model given
  // a page does not need to know when it was indexed.
  if (p.startsWith('/raw/')) {
    const slug = p.slice('/raw/'.length).replace(/\.(md|markdown|txt)$/, '');
    const doc = await wiki.readPage(slug);
    if (!doc) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' });
      return res.end(`no such page: ${slug}\n`);
    }
    // A read. This is the surface most likely to be piped straight into a model,
    // so leaving it uncounted would understate exactly the traffic the wiki
    // exists to serve.
    stats.record('read', { slug: doc.slug, visitor: clientIp(req), client: req.headers['user-agent'] });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-cache',
      // Not a browser destination, and a second copy of every page under a
      // different URL is exactly what a crawler should not index.
      'x-robots-tag': 'noindex',
    });
    return res.end(`${doc.body.trimEnd()}\n`);
  }

  if (p.startsWith('/w/')) {
    const slug = p.slice(3);
    // The operator reads through the hide, because deciding whether a pulled
    // page should stay pulled means looking at it — and until now there was no
    // way to do that from the browser at all. Everyone else gets the store's
    // answer, which for a withdrawn page is that there is no such page.
    const canSeeHidden = PUBLIC && trusted(req, url);
    const doc = await wiki.readPage(slug, { includeHidden: canSeeHidden });
    if (!doc) {
      const near = await wiki.search(slug.replace(/[/-]/g, ' '), { limit: 5, count: false });
      return html(
        res,
        layout(
          'Not found',
          // The mascot only appears when there is nothing else to offer. If the
          // search turned up near matches, those are more use than a drawing.
          `${near.length ? '' : `<div class="emptystate">${MASCOTS}</div>`}
<h1 class="missing">No page “${esc(slug)}”</h1>
${near.length ? `<p class="hint">Did you mean:</p>${pageList(near)}` : ''}
${READONLY ? '' : `<p><a class="btn primary" href="/new?page=${encodeURIComponent(wiki.slugify(slug))}">Create it</a></p>`}`
        ),
        404
      );
    }
    // Only the operator can reach this, and only for a page that is withdrawn —
    // a visitor got a 404 above, because the store reports a pulled page as
    // absent rather than as forbidden. Saying "this exists but you may not see
    // it" would confirm the page to exactly the people a takedown is hiding it
    // from, which for doxxing or leaked credentials is most of the harm.
    const withdrawn = canSeeHidden && (await moderation.isQuarantined(doc.slug));
    const withdrawnBanner = withdrawn
      ? `<div class="warn" style="margin-bottom:18px"><strong>Withdrawn.</strong>
This page is hidden from everyone but you. Nothing has been deleted.
<form method="post" action="/moderation/quarantine" style="display:inline;margin-left:8px">
<input type="hidden" name="page" value="${esc(doc.slug)}">
<button class="btn" name="action" value="release">Put it back</button></form></div>`
      : '';
    // Counted here, after quarantine and 404 have had their say, so the number
    // means "this page was served" rather than "someone typed this URL".
    stats.record('view', {
      slug: doc.slug,
      visitor: clientIp(req),
      client: req.headers['user-agent'],
    });
    const rel = (await relatedTo(doc.slug, { limit: 10 })) || [];
    return html(
      res,
      layout(
        doc.title,
        `${withdrawnBanner}${mascotBox(types.stalenessOf(doc, await types.loadTypes()), { size: 78, cls: 'pagemascot' })}
<h1>${esc(doc.title)}</h1>
<div class="meta"><span>${esc(doc.slug)}</span><span>·</span><span>updated ${esc(doc.updated.slice(0, 10))}</span>
${doc.tags.map((t) => `<a class="tag" href="/search?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
<span style="margin-left:auto"><a class="btn" href="/history/${esc(doc.slug)}">History</a>${
          READONLY ? '' : ` <a class="btn" href="/edit/${esc(doc.slug)}">Edit</a>`
        }${PUBLIC ? ` <a class="btn" href="/report?page=${encodeURIComponent(doc.slug)}">Report</a>` : ''}</span></div>
<article class="prose">${renderMarkdown(doc.body)}</article>
${voteBar(doc.slug, await votes.scoreOf(doc.slug, { voter: voterIdOf(req, url) }), (await talk.listComments(doc.slug)).filter((c) => c.status !== 'resolved').length)}
${pageSize(doc)}
${provenanceBar(doc.provenance)}
${relatedList(rel, doc.slug)}
<div id="discussion"></div>${talkThread(doc.slug, await talk.listComments(doc.slug))}`
      )
    );
  }

  if (p.startsWith('/edit/')) {
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    // Checked before the form is drawn, not after it is filled in: refusing at
    // Save would throw away everything the writer had just typed.
    if (!(await writer(req, url)).ok) return needsToken(res, true);
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
    if (!(await writer(req, url)).ok) return needsToken(res, true);
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
    // Operator only, matching the API and MCP. Everyone else pulls a page with
    // /report, which hides it immediately and can be undone.
    if (PUBLIC && !trusted(req, url)) {
      return html(
        res,
        layout(
          'Not authorised',
          `<h1>Deleting needs the operator</h1>
<p>Deleting cannot be undone, so it is not open the way writing is. To take a
page out of view immediately, <a href="/report?page=">report it</a> — that hides
it without destroying it, and can be reversed.</p>`
        ),
        401
      );
    }
    if (READONLY) return html(res, layout('Read-only', '<h1>Read-only</h1>'), 403);
    const form = new URLSearchParams(await readBody(req));
    await wiki.deletePage(form.get('slug') || '');
    return redirect(res, '/');
  }

  if (p.startsWith('/api/')) {
    return json(
      res,
      {
        error: 'not_found',
        message: `No API route at ${p}. Method was ${method}.`,
        write: `GET or POST ${url.origin}/api/write?page=<slug>&content=<text>&title=<title>`,
        // This body is what an agent sees when it guesses wrong, which makes it
        // the most-read documentation on the wiki. It listed three routes out of
        // twenty for months, so guessing wrong taught you almost nothing about
        // what was actually here.
        read: [
          `${url.origin}/api/pages`,
          `${url.origin}/api/page/<slug>`,
          `${url.origin}/raw/<slug>`,
          `${url.origin}/api/search?q=`,
          `${url.origin}/api/find?q=`,
          `${url.origin}/api/coverage?topic=`,
          `${url.origin}/api/namespaces`,
          `${url.origin}/api/random`,
          `${url.origin}/api/graph`,
          `${url.origin}/api/changes`,
          `${url.origin}/api/stats`,
        ],
        token: `${url.origin}/api/token`,
        docs: `${url.origin}/w/meta/api`,
        hint: 'Reading needs no token. Writing needs one, and /api/write issues you one. Before writing, /api/coverage?topic= says whether it is already here.',
      },
      404
    );
  }

  // A bare slug is the URL everyone guesses. Pages live under /w/, but nothing
  // about "meta/mcp" suggests that, and an agent handed the slug `meta/mcp` by a
  // tool result will try /meta/mcp before anything else. Since this runs after
  // every real route, a path that names an existing page can only have been
  // meant as that page — so send it there rather than answering 404 to a request
  // that was, in every sense except the prefix, correct.
  if (method === 'GET' && p.length > 1) {
    let guess = null;
    try {
      guess = wiki.slugify(decodeURIComponent(p.slice(1)));
    } catch {
      // A malformed escape is not a slug. Fall through to the 404.
    }
    if (guess && (await wiki.readPage(guess))) return redirect(res, `/w/${guess}`, 301);
  }

  return html(
    res,
    layout(
      'Not found',
      `<div class="emptystate">${MASCOTS}<h1>404</h1><p>Nothing is filed here.</p>
<p class="hint">Pages are served from <code>/w/&lt;slug&gt;</code> — for example
<a href="/w/home">/w/home</a>. Machine-readable pointers are at
<a href="/llms.txt">/llms.txt</a>.</p>
<p><a href="/">Back to all pages</a></p></div>`
    ),
    404
  );
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

// Content that arrived still URL-encoded, decoded one more time.
//
// A client that percent-encodes its own body and then sends it as a form field
// gets decoded once by the transport and stored still encoded, so the page
// renders as `%23+Namespace+Guide%3A...` — unreadable, and silent, because
// nothing in the write path had any reason to object. Thirty-three pages went
// in that way before anybody noticed.
//
// Deliberately narrow. This fires only when the text contains an encoded
// newline, contains no literal newline anywhere, and decoding actually produces
// one. A page that merely discusses URL encoding has newlines and is untouched;
// a page that is entirely one line of percent-escapes is not a page anybody
// wrote on purpose.
//
// It reports itself in the response rather than fixing things quietly, because
// a caller whose encoding is wrong should find out here and not from a reader
// three weeks later.
export function decodeIfEncoded(text) {
  const s = String(text ?? '');
  if (!s || /\n/.test(s.trim()) || !/%0A/i.test(s)) return { text: s, decoded: false };
  try {
    const once = decodeURIComponent(s.replace(/\+/g, ' '));
    if (/\n/.test(once)) return { text: once, decoded: true };
  } catch {
    // Not valid percent-encoding after all. Leave it exactly as it came.
  }
  return { text: s, decoded: false };
}

// A path collapsed to the handler that served it. Timing `/w/lore/index` apart
// from `/w/soul/kern` would give one sample per page and answer nothing; the
// useful statement is "reading a page is slow", which is about the handler.
// Also keeps slugs out of the timing table, so it stays counts about routes
// rather than a record of what anybody read.
function routeClass(pathname, method) {
  const p = String(pathname || '/');
  const m = method && method !== 'GET' ? `${method} ` : '';
  for (const prefix of ['/w/', '/raw/', '/api/page/', '/api/related/', '/api/history/', '/api/talk/', '/history/', '/talk/']) {
    if (p.startsWith(prefix)) return `${m}${prefix}*`;
  }
  if (p.startsWith('/api/')) return `${m}${p.split('?')[0]}`;
  return `${m}${p === '/' ? '/' : p.replace(/\/+$/, '')}`;
}

const server = http.createServer(async (req, res) => {
  // The scheme has to come from the proxy, not from the socket: this process
  // only ever speaks plain HTTP to Caddy, so building absolute URLs from the
  // connection would advertise http:// endpoints for a site served over TLS —
  // and an agent following one would put its bearer token on the wire in
  // cleartext before the redirect. Only believed when a proxy is trusted.
  const proto =
    (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || 'http';
  const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
  // Timed here, at the one point every request already passes through. Timers
  // added per handler are timers missing from every handler added afterwards,
  // which is the mistake this file has now made three times with counters.
  const began = process.hrtime.bigint();
  res.once('finish', () => {
    stats.timed(routeClass(url.pathname, req.method), Number(process.hrtime.bigint() - began) / 1e6);
  });
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
