// The graph view. Two renderers over one set of navigation controls:
//   2D — d3 force layout in SVG. The default, and the one to find things with.
//   3D — 3d-force-graph. Prettier, harder to read; a toggle, not a replacement.
//
// The sidebar, search, detail panel and selection are shared, so switching
// renderer never costs you your place. Both libraries are vendored, not CDN.

import { TOKENS, GROUP_VARS, SKIN_BOOT, SKIN_PICKER, SKIN_CSS, SKIN_JS, MARKS, MARK_CSS } from './theme.js';

export function graphPageHtml({ site = 'botwiki' } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Graph · ${site}</title>
<style>
${TOKENS}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.6 var(--font-ui);overflow:hidden;-webkit-font-smoothing:antialiased}
${SKIN_CSS}
${MARK_CSS}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button{font:inherit;cursor:pointer}

.app{display:grid;grid-template-rows:56px 1fr;height:100%}
.shell{display:grid;grid-template-columns:246px 1fr 0;min-height:0;transition:grid-template-columns .22s ease}
.shell.detail{grid-template-columns:246px 1fr 312px}

header{display:flex;align-items:center;gap:13px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--panel);z-index:6}
.brand{font-weight:650;font-size:15.5px;letter-spacing:-.015em;color:var(--ink)}
.brand span{color:var(--accent)}
.sep{width:1px;height:22px;background:var(--line);flex:none}
.spacer{flex:1}
#q{padding:7px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font:inherit;font-size:13.5px;width:220px}
#q:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.toggles{display:flex;gap:3px}
.chip{display:flex;align-items:center;gap:6px;padding:5px 11px;border-radius:99px;font-size:12.5px;color:var(--muted);user-select:none;border:1px solid transparent;transition:.15s;white-space:nowrap}
.chip:hover{background:var(--accent-soft)}
.chip input{display:none}
.chip .sw{width:15px;height:0;border-top:2px solid currentColor;opacity:.5}
.chip.dashed .sw{border-top-style:dashed}
.chip.on{color:var(--ink);background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 20%,transparent)}
.chip.on .sw{opacity:1}
.ico{width:31px;height:31px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);transition:.15s}
.ico:hover{color:var(--accent);border-color:var(--accent)}
.modesw{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.modesw button{padding:5px 11px;border:0;background:var(--panel);color:var(--muted);font-size:12.5px;font-weight:560}
.modesw button.on{background:var(--accent);color:#fff}
.strwrap{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);white-space:nowrap}
.strwrap #strlbl{min-width:46px;text-align:right;font-variant-numeric:tabular-nums}
.strwrap input[type=range]{width:92px;accent-color:var(--accent)}
.hopwrap{display:none;align-items:center;gap:7px;font-size:12px;color:var(--muted);white-space:nowrap}
.hopwrap.on{display:flex}
.hopwrap #hoplbl{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
.hopwrap input[type=range]{width:56px;accent-color:var(--accent)}
.chip .sw.dot{width:9px;height:9px;border:0;border-radius:50%;background:currentColor}

.side{border-right:1px solid var(--line);background:var(--panel);overflow-y:auto;padding:12px 0 30px}
.side h4{margin:14px 16px 5px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:650;display:flex;align-items:center;gap:7px}
.side h4 .sw{width:8px;height:8px;border-radius:50%;flex:none}
.side h4 .n{margin-left:auto;font-weight:500;opacity:.7}
.side a.item{display:block;padding:5px 16px 5px 31px;color:var(--ink);font-size:13.5px;border-left:2px solid transparent;line-height:1.4}
.side a.item:hover{background:var(--accent-soft);text-decoration:none}
.side a.item.sel{background:var(--accent-soft);border-left-color:var(--accent);font-weight:600}
.side a.item small{display:block;color:var(--muted);font-size:11.5px;font-family:ui-monospace,Menlo,monospace}
.side .none{padding:20px 16px;color:var(--muted);font-size:13px}

.stage{position:relative;min-width:0;background:var(--bg);overflow:hidden}
#viewport{position:absolute;inset:0}
#viewport>*{width:100%;height:100%}
svg{display:block;cursor:grab}
svg.grabbing{cursor:grabbing}
.hull{stroke-linejoin:round;pointer-events:none}
.link{fill:none;stroke-linecap:round}
.node{cursor:pointer}
.node circle.body{stroke:var(--bg);stroke-width:1.7}
.node circle.ring{pointer-events:none}
.node circle.badge{pointer-events:none}
.label{font-size:11.5px;font-weight:520;fill:var(--muted);pointer-events:none;paint-order:stroke;stroke:var(--bg);stroke-width:3.5px;stroke-linejoin:round}
.node.sel .label,.node.hot .label{fill:var(--ink);font-weight:650}

.legendbar{position:absolute;left:14px;bottom:14px;display:flex;gap:6px;flex-wrap:wrap;max-width:70%;z-index:3}
.gchip{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;font-size:11.5px;background:var(--panel);border:1px solid var(--line);color:var(--muted);user-select:none;cursor:pointer}
.gchip .d{width:8px;height:8px;border-radius:50%}
.gchip.off{opacity:.4}
/* One chip per namespace, and namespaces only ever get added, so this row grew
   until it covered the corner of the canvas it sits on. Three, then a fold.
   The panel opens upward because the bar is anchored to the bottom of the
   stage and downward is off the screen. */
.legendmore{position:relative}
.legendmore summary{list-style:none;cursor:pointer}
.legendmore summary::-webkit-details-marker{display:none}
.legendmore summary::marker{content:''}
.legendrest{display:none}
.legendmore[open] .legendrest{display:flex;flex-wrap:wrap;gap:6px;position:absolute;left:0;bottom:calc(100% + 6px);
  max-height:46vh;overflow-y:auto;padding:8px;border-radius:10px;background:var(--panel);border:1px solid var(--line);
  width:max-content;max-width:min(52vw,420px);box-shadow:0 8px 24px rgba(0,0,0,.28)}
.stage.night .legendmore[open] .legendrest{background:rgba(18,20,30,.9);border-color:rgba(255,255,255,.14)}
.zoombar{position:absolute;right:14px;bottom:14px;display:flex;flex-direction:column;gap:5px;z-index:3}
.stats{position:absolute;right:14px;top:14px;font-size:11.5px;color:var(--muted);text-align:right;line-height:1.6;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 11px;z-index:3}
.stats b{color:var(--ink);font-variant-numeric:tabular-nums}
.tip{position:absolute;pointer-events:none;padding:7px 11px;border-radius:8px;font-size:12.5px;background:var(--panel);border:1px solid var(--line);box-shadow:0 6px 20px rgba(0,0,0,.16);opacity:0;transition:opacity .12s;white-space:nowrap;z-index:9}
.tip.on{opacity:1}
.help{position:absolute;left:14px;top:14px;font-size:11.5px;color:var(--muted);opacity:.8;line-height:1.7;z-index:3}
/* The 3D view paints its own night sky, so overlays must not assume the page background. */
.stage.night .help{color:rgba(255,255,255,.62);opacity:1;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.stage.night .help kbd{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.2);color:#fff}
.stage.night .stats,.stage.night .gchip,.stage.night .ico{background:rgba(18,20,30,.72);border-color:rgba(255,255,255,.14);color:rgba(255,255,255,.7);backdrop-filter:blur(8px)}
.stage.night .stats b{color:#fff}
.stage.night .ico:hover{color:#fff;border-color:rgba(255,255,255,.45)}
.enc{display:none}
.stage.night .enc{display:flex;position:absolute;left:14px;top:60px;flex-direction:column;gap:5px;z-index:3;
  font-size:11px;color:rgba(255,255,255,.6);line-height:1.5;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.enc span{display:flex;align-items:center;gap:7px}
.enc i{display:inline-block;font-style:normal;width:26px;flex:none;text-align:center}
.enc i.thin{border-top:1px solid rgba(255,255,255,.5);width:12px}
.enc i.thick{border-top:3.5px solid rgba(255,255,255,.85);width:12px;margin-left:-4px}
.enc i.plain{border-top:2px solid rgba(136,146,176,.8);width:26px}
.enc i.flow{color:rgba(255,255,255,.8);letter-spacing:2px;font-size:13px}
.statuslegend{display:none;position:absolute;right:14px;bottom:60px;flex-direction:column;gap:5px;z-index:3;
  font-size:11px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
.statuslegend.on{display:flex}
.statuslegend span{display:flex;align-items:center;gap:7px}
.statuslegend i{width:11px;height:11px;border-radius:50%;border:2.2px solid;flex:none}
.statuslegend b{width:9px;height:9px;border-radius:50%;background:var(--warn);flex:none;margin-left:1px}
.stage.night .statuslegend{background:rgba(18,20,30,.72);border-color:rgba(255,255,255,.14);color:rgba(255,255,255,.7)}
.loading{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:13px;z-index:4;background:var(--bg)}

.detailpane{border-left:1px solid var(--line);background:var(--panel);overflow-y:auto;overflow-x:hidden}
.detailpane .inner{padding:18px 18px 40px;width:312px}
.detailpane h2{margin:0 0 3px;font-size:18px;letter-spacing:-.015em;line-height:1.25}
.detailpane .slug{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);word-break:break-all}
.detailpane .sum{margin:11px 0 0;font-size:13.5px;color:var(--muted);line-height:1.55}
.tagrow{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}
.tg{padding:1px 9px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:11.5px;font-weight:550}
.detailpane h5{margin:20px 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:650}
.rel{display:block;padding:7px 9px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;color:var(--ink);font-size:13px;line-height:1.35}
.rel:hover{border-color:var(--accent);text-decoration:none;background:var(--accent-soft)}
.rel .why{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.sbar{color:var(--accent);letter-spacing:1px;font-size:9px;vertical-align:1px}
.open{display:block;text-align:center;padding:9px;border-radius:9px;background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;margin-top:16px}
.open:hover{text-decoration:none;filter:brightness(1.06)}
.prov{margin-top:8px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;font-size:11.5px;color:var(--muted);line-height:1.55}
.prov b{color:var(--ink)}
.prov .mdl{display:inline-block;padding:0 6px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-weight:550}
.prov .why{margin-top:5px;font-style:italic;color:var(--ink)}
.prov .caveat{margin-top:6px;padding-top:5px;border-top:1px solid var(--line);opacity:.8}
kbd{font:inherit;font-size:11px;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.g3d-tip{padding:7px 10px;border-radius:8px;background:#111;color:#fff;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.g3d-tip small{display:block;opacity:.65;font-family:ui-monospace,Menlo,monospace;font-size:11px;margin-top:2px}
@media (max-width:900px){.shell,.shell.detail{grid-template-columns:1fr}.side,.detailpane,.help{display:none}}
/* Phones. The header is a nowrap row of brand, a 220px search field, the view
   toggles and the skin picker, sitting in a grid row fixed at 56px — so it
   overflows sideways and clips rather than wrapping. The row becomes auto and
   the field takes its own line. The graph itself is already touch-workable:
   d3-zoom and the 3d view both handle pinch and drag. */
@media (max-width:720px){
  .app{grid-template-rows:auto 1fr}
  header{flex-wrap:wrap;padding:8px 12px;gap:8px 10px}
  .brand{order:1}
  .skins{order:2;margin-left:auto}
  #q{order:3;width:100%;font-size:16px}
  .toggles{order:4}
  .sep{display:none}
  .toggles button{padding:8px 12px}
}
</style>${SKIN_BOOT}</head><body>
<div class="app">
<header>
  <a class="brand" href="/">${MARKS}<span class="bn">${site}</span></a>
  <div class="sep"></div>
  <input id="q" placeholder="Search pages, tags, slugs…" autocomplete="off" spellcheck="false">
  <div class="toggles">
    <label class="chip on" id="c-link"><input type="checkbox" id="e-link" checked><span class="sw"></span>links</label>
    <label class="chip on" id="c-tag"><input type="checkbox" id="e-tag" checked><span class="sw"></span>tags</label>
    <label class="chip on dashed" id="c-similar"><input type="checkbox" id="e-similar" checked><span class="sw"></span>similar</label>
  </div>
  <label class="strwrap" title="Hide connections weaker than this">
    <span id="strlbl">all</span>
    <input type="range" id="minstr" min="0" max="90" value="0" step="5">
  </label>
  <div class="spacer"></div>
  <div class="modesw"><button id="sGlobal">global</button><button id="sLocal">local</button></div>
  <label class="hopwrap" id="hopwrap" title="How many steps out from the focused page">
    <span id="hoplbl">1 hop</span>
    <input type="range" id="hops" min="1" max="3" value="1" step="1">
  </label>
  <label class="chip" id="c-status"><input type="checkbox" id="e-status"><span class="sw"></span>status</label>
  <div class="modesw"><button id="m2d">2D</button><button id="m3d">3D</button></div>
  <button class="ico" id="fit" title="Fit to view (F)">⤢</button>
  <button class="ico" id="relayout" title="Re-run layout">⟳</button>
  <div class="sep"></div>
  ${SKIN_PICKER}
  <a href="/">← pages</a>
</header>
<div class="shell" id="shell">
  <nav class="side" id="side"></nav>
  <div class="stage" id="stage">
    <div id="viewport"></div>
    <div class="help" id="help"></div>
    <div class="stats" id="stats"></div>
    <div class="legendbar" id="legend"></div>
    <div class="statuslegend" id="statuslegend">
      <span><i style="border-color:#3fa46a"></i>verified &amp; fresh</span>
      <span><i style="border-color:#7d8798;border-style:dashed"></i>never verified</span>
      <span><i style="border-color:#d99a2b"></i>due for a check</span>
      <span><i style="border-color:#e0563f"></i>stale</span>
      <span><b></b>open comments</span>
    </div>
    <div class="enc" id="enc">
      <span><i class="thin"></i><i class="thick"></i> thicker = stronger</span>
      <span><i class="flow">&#8250;&#8250;&#8250;</i> flows the way the link points</span>
      <span><i class="flow">&#8249;&#8250;</i> flows both ways = they cite each other</span>
      <span><i class="plain"></i> still = tag or similarity, no direction</span>
    </div>
    <div class="zoombar"><button class="ico" id="zin">+</button><button class="ico" id="zout">−</button></div>
    <div class="tip" id="tip"></div>
  </div>
  <aside class="detailpane" id="detail"><div class="inner" id="detailInner"></div></aside>
</div>
</div>
<script src="/vendor/d3.min.js"></script>
<script>
const GROUP_VARS = ${JSON.stringify(GROUP_VARS)};
const cssVar = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
const groupColor = g => cssVar('--g-' + g, cssVar('--accent', '#7c5cff'));

// The 3D view always sits on a dark backdrop, so mid-tone light-theme colours
// need lifting to read as luminous against it.
const LIT = new Map();
function lighten(hex, amt) {
  const k = hex + amt;
  if (LIT.has(k)) return LIT.get(k);
  let out = hex;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    const mix = (c) => Math.round(c + (255 - c) * amt);
    out = 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
  }
  LIT.set(k, out);
  return out;
}
const starColor = (g) => lighten(groupColor(g), 0.3);

// Status palette, used only when the status overlay is on. Deliberately not the
// cluster colours: this answers "can I trust this page", not "what is it about".
const STATUS = {
  stale: '#e0563f',
  aging: '#d99a2b',
  unverified: '#7d8798',
  ok: '#3fa46a',
};
function statusOf(n) {
  const s = n.staleness || {};
  if (s.status === 'stale') return 'stale';
  if (s.status === 'aging') return 'aging';
  if (s.neverVerified) return 'unverified';
  return 'ok';
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REL = { link: 'explicit link', tag: 'shared tag', similar: 'similar content' };

// ---- shared state -----------------------------------------------------------
// The raw payload stays canonical with string source/target. Each renderer gets its own
// copies, because both libraries mutate the objects they are handed.
let raw = { nodes: [], edges: [], groups: [], stats: {} };
let byId = new Map();
const show = { link: true, tag: true, similar: true };
const hidden = new Set();
let minStr = 0;   // hide connections weaker than this

// Local mode. Past a few hundred edges an overview of everything stops being
// useful — the literature on large-graph exploration lands on "search, show
// context, expand on demand" rather than better global layouts. Global stays,
// because it answers a different question (what shape is this wiki), but local
// is what you navigate with.
let scope = localStorage.getItem('botwiki.graph.scope') === 'local' ? 'local' : 'global';
let hops = Number(localStorage.getItem('botwiki.graph.hops')) || 1;
let showStatus = localStorage.getItem('botwiki.graph.status') === '1';
const expanded = new Set();   // nodes the user opened up beyond the hop radius
let localIds = null;          // null means "no restriction"
let filter = '', selectedId = null, hotId = null, view = null;
let mode = (localStorage.getItem('botwiki.graph.mode') === '3d' ? '3d' : '2d');

const stage = document.getElementById('stage');
const viewport = document.getElementById('viewport');
const tip = document.getElementById('tip');
const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });

// Size by WEIGHTED degree: a page tied loosely to ten others should not look
// more central than one with three strong ties.
const radius = n => 6 + Math.min(13, Math.sqrt(n.weightedDegree ?? n.degree ?? 0) * 3.6) + Math.min(3, (n.bytes || 0) / 2600);
const groupShown = n => !hidden.has(n.group);
const matches = n => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return n.id.toLowerCase().includes(f) || n.title.toLowerCase().includes(f) ||
         (n.tags || []).some(t => t.toLowerCase().includes(f)) ||
         (n.summary || '').toLowerCase().includes(f);
};
const nodeShown = n => groupShown(n) && matches(n) && (!localIds || localIds.has(n.id));
const edgeShown = e => {
  if (!show[e.type]) return false;
  if ((e.strength ?? 1) < minStr) return false;
  const a = byId.get(typeof e.source === 'object' ? e.source.id : e.source);
  const b = byId.get(typeof e.target === 'object' ? e.target.id : e.target);
  return !!a && !!b && nodeShown(a) && nodeShown(b);
};

// Breadth-first from the focus, plus the neighbours of anything explicitly
// expanded. Recomputed whenever the focus, radius or edge filters change.
function recomputeLocal() {
  if (scope !== 'local' || !selectedId) {
    localIds = null;
    return;
  }
  // Taking EVERY neighbour does not work on a graph this dense: average degree
  // is ~17, so two hops from any hub reaches the entire wiki and "local" stops
  // meaning anything. Degree-of-interest is the standard answer — rank a node's
  // neighbours and keep the best few. Six is enough to see a page in context and
  // few enough that a second hop stays legible.
  const TOP_N = 6;
  const ranked = new Map();
  for (const e of raw.edges) {
    if (!show[e.type] || (e.strength ?? 1) < minStr) continue;
    if (!ranked.has(e.source)) ranked.set(e.source, []);
    if (!ranked.has(e.target)) ranked.set(e.target, []);
    ranked.get(e.source).push([e.target, e.strength ?? 0]);
    ranked.get(e.target).push([e.source, e.strength ?? 0]);
  }
  const adj = new Map();
  for (const [id, list] of ranked) {
    adj.set(id, list.sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map((x) => x[0]));
  }
  const seen = new Set([selectedId]);
  let frontier = [selectedId];
  for (let d = 0; d < hops; d++) {
    const next = [];
    for (const id of frontier) {
      for (const o of adj.get(id) || []) {
        if (!seen.has(o)) { seen.add(o); next.push(o); }
      }
    }
    frontier = next;
  }
  // Expanded nodes bring their own neighbours in, however far out they sit.
  for (const id of expanded) {
    seen.add(id);
    for (const o of adj.get(id) || []) seen.add(o);
  }
  localIds = seen;
}

function neighbourIds(id) {
  const s = new Set(id ? [id] : []);
  if (id) for (const e of raw.edges) {
    if (!show[e.type] || (e.strength ?? 1) < minStr) continue;
    if (e.source === id) s.add(e.target);
    else if (e.target === id) s.add(e.source);
  }
  return s;
}
const strengthBar = (v) => {
  const filled = Math.max(1, Math.round((v || 0) * 5));
  return '<span class="sbar">' + '\u25CF'.repeat(filled) + '\u25CB'.repeat(5 - filled) + '</span>';
};
// Say WHY two pages are connected, not just how much.
const because = (r) => {
  const e = r.evidence || {};
  const bits = [];
  if (e.mentions) bits.push(e.mentions + ' link' + (e.mentions > 1 ? 's' : '') + (e.mutual ? ', mutual' : ''));
  if (e.sharedTags && e.sharedTags.length) bits.push('tags: ' + e.sharedTags.join(', '));
  if (e.similarity) bits.push(Math.round(e.similarity * 100) + '% similar');
  return esc(bits.join(' \u00B7 ') || REL[r.type]);
};

function relatedOf(id) {
  const out = [];
  for (const e of raw.edges) {
    if (!show[e.type] || (e.strength ?? 1) < minStr) continue;
    const o = e.source === id ? e.target : e.target === id ? e.source : null;
    const n = o && byId.get(o);
    if (n) out.push({ n, type: e.type, strength: e.strength ?? 0, evidence: e.evidence });
  }
  return out.sort((a, b) => b.strength - a.strength);
}

// ---- 2D renderer ------------------------------------------------------------
function makeView2D() {
  const svg = d3.select(viewport).append('svg');
  const gRoot = svg.append('g');
  const gHull = gRoot.append('g'), gLink = gRoot.append('g'), gNode = gRoot.append('g');
  const nodes = raw.nodes.map(n => ({ ...n }));
  const index = new Map(nodes.map(n => [n.id, n]));
  const links = raw.edges.map(e => ({ ...e }));
  let linkSel, nodeSel, sim;

  const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', ev => gRoot.attr('transform', ev.transform));
  svg.call(zoom).on('dblclick.zoom', null)
     .on('mousedown.c', () => svg.classed('grabbing', true))
     .on('mouseup.c', () => svg.classed('grabbing', false));
  svg.on('click', () => api.select(null));

  const { w, h } = size();
  const R = Math.min(w, h) * 0.29 + raw.groups.length * 12;
  const anchors = new Map(raw.groups.map((g, i) => {
    const a = (i / raw.groups.length) * Math.PI * 2 - Math.PI / 2;
    return [g, { x: Math.cos(a) * R, y: Math.sin(a) * R }];
  }));

  sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id)
      // Strong ties pull hard and sit close; weak ones barely tug at all.
      .distance(l => 150 - 95 * (l.strength ?? 0.3))
      .strength(l => 0.06 + 0.5 * (l.strength ?? 0.3)))
    .force('charge', d3.forceManyBody().strength(-560).distanceMax(720))
    .force('collide', d3.forceCollide(d => radius(d) + 19).iterations(2))
    .force('gx', d3.forceX(d => (anchors.get(d.group) || { x: 0 }).x).strength(0.11))
    .force('gy', d3.forceY(d => (anchors.get(d.group) || { y: 0 }).y).strength(0.11))
    .on('tick', ticked);

  const linkPath = d => {
    const dr = Math.hypot(d.target.x - d.source.x, d.target.y - d.source.y) * 1.9 || 1;
    return 'M' + d.source.x + ',' + d.source.y + 'A' + dr + ',' + dr + ' 0 0,1 ' + d.target.x + ',' + d.target.y;
  };

  function ticked() {
    if (linkSel) linkSel.attr('d', linkPath);
    if (nodeSel) nodeSel.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
    const data = raw.groups.filter(g => !hidden.has(g)).map(g => {
      const pts = nodes.filter(n => n.group === g && nodeShown(n)).map(n => [n.x, n.y]);
      return { g, hull: pts.length >= 3 ? d3.polygonHull(pts) : null };
    }).filter(d => d.hull);
    gHull.selectAll('path.hull').data(data, d => d.g).join('path')
      .attr('class', 'hull').attr('fill', d => groupColor(d.g)).attr('fill-opacity', .055)
      .attr('stroke', d => groupColor(d.g)).attr('stroke-opacity', .16).attr('stroke-width', 34)
      .attr('d', d => 'M' + d.hull.join('L') + 'Z');
  }

  const api = {
    refresh() {
      const vis = nodes.filter(groupShown);
      const ids = new Set(vis.map(n => n.id));
      const vlinks = links.filter(l =>
        show[l.type] && (l.strength ?? 1) >= minStr &&
        ids.has(l.source.id ?? l.source) && ids.has(l.target.id ?? l.target));

      linkSel = gLink.selectAll('path.link')
        .data(vlinks, d => (d.source.id ?? d.source) + '|' + (d.target.id ?? d.target))
        .join('path').attr('class', 'link')
        .attr('stroke-dasharray', d => d.type === 'similar' ? '2.5 5' : null);

      nodeSel = gNode.selectAll('g.node').data(vis, d => d.id).join(enter => {
        const g = enter.append('g').attr('class', 'node');
        g.append('circle').attr('class', 'ring');
        g.append('circle').attr('class', 'body');
        g.append('circle').attr('class', 'badge');
        g.append('text').attr('class', 'label').attr('text-anchor', 'middle');
        return g;
      });
      nodeSel.select('circle.body').attr('r', radius).attr('fill', d => groupColor(d.group))
        .attr('fill-opacity', d => d.degree === 0 ? .25 : 1);
      // Status is an overlay, never a replacement: the fill still says what the
      // page is about, the ring says whether you can trust it.
      nodeSel.select('circle.ring')
        .attr('r', d => radius(d) + 3.5)
        .attr('fill', 'none')
        .attr('stroke', d => (showStatus ? STATUS[statusOf(d)] : 'none'))
        .attr('stroke-width', d => (showStatus && statusOf(d) !== 'ok' ? 2.4 : 1.4))
        .attr('stroke-opacity', d => (showStatus ? (statusOf(d) === 'ok' ? .45 : .95) : 0))
        .attr('stroke-dasharray', d => (showStatus && statusOf(d) === 'unverified' ? '2 3' : null));
      nodeSel.select('circle.badge')
        .attr('r', d => (showStatus && d.openComments ? 4.2 : 0))
        .attr('cx', d => radius(d) * 0.78)
        .attr('cy', d => -radius(d) * 0.78)
        .attr('fill', cssVar('--warn', '#b4531f'))
        .attr('stroke', cssVar('--bg', '#fff'))
        .attr('stroke-width', 1.2);
      nodeSel.select('text.label').attr('dy', d => radius(d) + 13)
        .text(d => d.title.length > 26 ? d.title.slice(0, 25) + '…' : d.title);
      nodeSel
        .on('mouseenter', (ev, d) => { hotId = d.id; api.paint(); showTip(ev, d); })
        .on('mouseleave', () => { hotId = null; api.paint(); tip.classList.remove('on'); })
        .on('click', (ev, d) => { ev.stopPropagation(); expandAndSelect(d.id); })
        .on('dblclick', (ev, d) => { ev.stopPropagation(); location.href = '/w/' + d.id; })
        .call(d3.drag()
          .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(.28).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on('end', ev => { if (!ev.active) sim.alphaTarget(0); }));

      sim.nodes(nodes);
      sim.force('link').links(links.filter(l => show[l.type] && (l.strength ?? 1) >= minStr));
      sim.alpha(.7).restart();
      api.paint();
    },
    paint() {
      const focusId = hotId || selectedId;
      const near = neighbourIds(focusId);
      if (nodeSel) nodeSel
        .classed('sel', d => d.id === selectedId).classed('hot', d => d.id === hotId)
        .attr('opacity', d => !matches(d) ? .12 : (focusId && !near.has(d.id)) ? .18 : 1);
      if (linkSel) linkSel
        .attr('stroke', d => {
          const lit = focusId && (d.source.id === focusId || d.target.id === focusId);
          return lit ? cssVar('--accent', '#7c5cff')
            : d.type === 'similar' ? cssVar('--edge-similar', '#ddd') : cssVar('--edge', '#ccc');
        })
        .attr('opacity', d => {
          const lit = focusId && (d.source.id === focusId || d.target.id === focusId);
          if (lit) return .95;
          if (focusId) return .07;
          if (filter && !(matches(d.source) && matches(d.target))) return .07;
          return .12 + .68 * (d.strength ?? .3);
        })
        .attr('stroke-width', d => {
          const lit = focusId && (d.source.id === focusId || d.target.id === focusId);
          return (0.5 + 3.2 * (d.strength ?? .3)) * (lit ? 1.9 : 1);
        });
    },
    focus(id) {
      const n = index.get(id); if (!n) return;
      const { w, h } = size();
      svg.transition().duration(480).call(zoom.transform,
        d3.zoomIdentity.translate(w / 2, h / 2).scale(1.2).translate(-n.x, -n.y));
    },
    fit(ms = 480) {
      const vis = nodes.filter(groupShown); if (!vis.length) return;
      const { w, h } = size();
      const xs = d3.extent(vis, d => d.x), ys = d3.extent(vis, d => d.y), pad = 90;
      const k = Math.max(0.15, Math.min(2.2, Math.min((w - pad) / Math.max(1, xs[1] - xs[0]), (h - pad) / Math.max(1, ys[1] - ys[0]))));
      svg.transition().duration(ms).call(zoom.transform, d3.zoomIdentity
        .translate(w / 2, h / 2).scale(k).translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2));
    },
    relayout() { nodes.forEach(n => { n.fx = n.fy = null; }); sim.alpha(1).restart(); setTimeout(() => api.fit(), 900); },
    zoomBy(f) { svg.transition().duration(200).call(zoom.scaleBy, f); },
    settle() { sim.tick(220); ticked(); api.fit(0); },
    destroy() { sim.stop(); viewport.innerHTML = ''; },
    help: 'click a node to inspect &middot; double-click to open<br>drag to pan &middot; scroll to zoom &middot; <kbd>l</kbd> local/global &middot; <kbd>esc</kbd> clears',
  };
  return api;
}

// ---- 3D renderer ------------------------------------------------------------
function makeView3D() {
  const el = document.createElement('div');
  viewport.appendChild(el);
  const nodes = raw.nodes.map(n => ({ ...n }));
  const index = new Map(nodes.map(n => [n.id, n]));
  // Direction is drawn as MOTION, and motion means exactly one thing: which way
  // the citation runs. A stream flowing A -> B means A links B.
  //
  // The first version got this backwards — it used a one-way stream to mean a
  // MUTUAL link, so the most directional signal on screen was saying the one
  // thing it does not mean. The fix is to let the flow be literal: a one-way
  // edge gets one stream, and a mutual edge is split into two half-strength
  // links, one each way, so it flows in both directions at once.
  const links = [];
  for (const e of raw.edges) {
    if (e.direction === 'mutual') {
      links.push({ ...e, half: true });
      links.push({ ...e, source: e.target, target: e.source, flipped: true, half: true });
    } else if (e.direction === 'b->a') {
      links.push({ ...e, source: e.target, target: e.source, flipped: true });
    } else {
      links.push({ ...e });
    }
  }

  const lit = (d) => {
    const focusId = hotId || selectedId;
    return focusId && ((d.source.id ?? d.source) === focusId || (d.target.id ?? d.target) === focusId);
  };

  // Links below this do not animate at all — at ~400 edges every stream is a
  // mesh, and animating ones nobody cares about costs frames for no information.
  const PARTICLE_MIN = 0.3;
  // Rescale the animated band to 0..1 so dot count, dot size and speed each use
  // their full range instead of crowding into the top third.
  const t = (d) =>
    Math.max(0, Math.min(1, (((d.strength ?? PARTICLE_MIN) - PARTICLE_MIN) / (1 - PARTICLE_MIN))));

  // ---- galaxy layout --------------------------------------------------
  // Each folder becomes an arm of the galaxy. Arms are placed on a sphere in an
  // order derived from how much the folders actually link to each other, so
  // related regions end up as neighbours and unrelated ones end up across the
  // void — rather than wherever a generic force layout happens to fling them.
  const affinity = new Map();
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  for (const e of raw.edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b || a.group === b.group) continue;
    affinity.set(key(a.group, b.group), (affinity.get(key(a.group, b.group)) || 0) + (e.strength ?? 0.2));
  }

  // Greedy chain: start from the best-connected folder, then repeatedly append
  // whichever remaining folder is most tied to the one just placed.
  const remaining = new Set(raw.groups);
  const pull = (gr) => [...remaining].reduce((s, o) => s + (o === gr ? 0 : affinity.get(key(gr, o)) || 0), 0);
  const order = [];
  let cur = [...remaining].sort((a, b) => pull(b) - pull(a))[0];
  while (cur) {
    order.push(cur);
    remaining.delete(cur);
    cur = [...remaining].sort(
      (a, b) => (affinity.get(key(cur, b)) || 0) - (affinity.get(key(cur, a)) || 0) || pull(b) - pull(a)
    )[0];
  }

  // Fibonacci sphere: consecutive indices land near each other on the surface,
  // so the affinity ordering above translates directly into spatial proximity.
  const N = order.length;
  // Arm separation has to outrun the repulsion between individual nodes, or the
  // clusters bleed into each other and the structure stops being readable. It
  // scales with BOTH the number of arms and how many nodes each has to hold.
  const SPREAD = 420 + nodes.length * 7 + N * 55;
  const anchors = new Map();
  order.forEach((gr, i) => {
    if (N === 1) return anchors.set(gr, { x: 0, y: 0, z: 0 });
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    anchors.set(gr, { x: Math.cos(theta) * r * SPREAD, y: y * SPREAD, z: Math.sin(theta) * r * SPREAD });
  });

  // A plain custom force — d3 forces are just functions with .initialize().
  function clusterForce(strength) {
    let ns = [];
    const force = (alpha) => {
      const k = strength * alpha;
      for (const n of ns) {
        const a = anchors.get(n.group);
        if (!a) continue;
        n.vx += (a.x - n.x) * k;
        n.vy += (a.y - n.y) * k;
        n.vz += (a.z - n.z) * k;
      }
    };
    force.initialize = (arr) => { ns = arr; };
    return force;
  }

  const g = ForceGraph3D()(el)
    // A galaxy needs a night sky. The 3D view keeps a deep backdrop in both
    // themes so the cluster colours read as luminous rather than muddy.
    .backgroundColor('#080a12')
    .showNavInfo(false)
    .nodeRelSize(4)
    .nodeVal(d => Math.max(1, radius(d) * 0.55))
    .nodeColor(d =>
      d.id === selectedId ? '#ffffff'
        : showStatus ? lighten(STATUS[statusOf(d)], 0.12)
        : starColor(d.group))
    .nodeOpacity(0.92)
    .nodeResolution(12)
    .nodeVisibility(d => nodeShown(d))
    .nodeLabel(d => '<div class="g3d-tip">' + esc(d.title) + '<small>' + esc(d.id) +
      ' · ' + (d.degree || 0) + ' connection' + (d.degree === 1 ? '' : 's') +
      ' · weight ' + (d.weightedDegree ?? 0) +
      (d.staleness && d.staleness.status !== 'fresh' ? ' · ' + esc(d.staleness.status) : '') +
      (d.openComments ? ' · ' + d.openComments + ' open comment' + (d.openComments === 1 ? '' : 's') : '') +
      '</small></div>')
    .linkLabel(d => {
      const e = d.evidence || {};
      const why = [
        e.mentions && (e.mentions + ' link' + (e.mentions > 1 ? 's' : '')),
        e.sharedTags && e.sharedTags.length && ('tags: ' + e.sharedTags.join(', ')),
        e.similarity && (Math.round(e.similarity * 100) + '% similar'),
      ].filter(Boolean).join(' · ');
      const a = d.flipped ? d.target : d.source, b = d.flipped ? d.source : d.target;
      const arrow = d.direction === 'mutual' ? ' <-> ' : d.direction === 'none' ? ' -- ' : ' -> ';
      return '<div class="g3d-tip">' + esc((a.id ?? a)) + arrow + esc((b.id ?? b)) +
        '<small>strength ' + (d.strength ?? 0) + (why ? ' · ' + esc(why) : '') + '</small></div>';
    })
    .linkVisibility(edgeShown)
    .linkColor(d => (lit(d) ? '#ffffff' : d.type === 'similar' ? '#39415c' : '#55607a'))
    // Thickness IS the weight: a hairline for a 0.1 tie, a rope for a 0.9 one.
    .linkWidth(d => (lit(d) ? 2.6 : 0.18 + 3.4 * Math.pow(d.strength ?? 0.3, 1.4)))
    .linkOpacity(0.38)
    // Motion only where direction is a real claim. A tag or similarity tie is
    // symmetric by nature and stays still — a moving stream there would assert a
    // dependency that does not exist.
    //
    // Particle count and speed both scale with strength, so a strong citation is
    // a busy fast stream and a weak one is a single slow dot. Weak links get no
    // particles at all: at ~400 edges every stream is a mesh, and animating the
    // ones nobody cares about costs frames for no information.
    // Only links at or above PARTICLE_MIN animate, so t() rescales that
    // surviving band across the full 0..1 range. Without it every animated link
    // sits in the top two-thirds of every scale and they all look the same,
    // which is the whole reason the graph was weighted in the first place.
    .linkDirectionalParticles(d =>
      d.direction === 'none' || (d.strength ?? 0) < PARTICLE_MIN ? 0 : 1 + Math.round(5 * t(d))
    )
    .linkDirectionalParticleWidth(d => 0.4 + 2.2 * t(d))
    .linkDirectionalParticleSpeed(d => 0.0025 + 0.007 * t(d))
    .linkDirectionalParticleColor(d => (lit(d) ? '#ffffff' : starColor(
      (typeof d.source === 'object' ? d.source.group : byId.get(d.source)?.group) || 'root'
    )))
    .onNodeHover(n => { hotId = n ? n.id : null; api.paint(); el.style.cursor = n ? 'pointer' : 'grab'; })
    .onNodeClick(n => { expandAndSelect(n.id); api.focus(n.id); })
    .onBackgroundClick(() => select(null))
    .d3AlphaDecay(0.019)
    .graphData({ nodes, links });

  // Strong general repulsion pushes everything apart; the cluster force pulls
  // each folder back to its own arm. The gap between those two is the void.
  g.d3Force('charge').strength(-190).distanceMax(900);
  // Stronger pull toward the arm centre keeps each cluster tight, which is what
  // makes the gaps between them read as gaps rather than as thinning.
  g.d3Force('cluster', clusterForce(0.34));
  if (g.d3Force('link')) {
    g.d3Force('link').strength((l) => (0.05 + 0.45 * (l.strength ?? 0.3)) * (l.half ? 0.5 : 1));
    g.d3Force('link').distance((l) => {
      const a = byId.get(l.source.id ?? l.source), b = byId.get(l.target.id ?? l.target);
      const base = 100 - 62 * (l.strength ?? 0.3);
      // A link that crosses folders should stretch, not drag the arms together.
      return a && b && a.group !== b.group ? base * 5 : base;
    });
  }

  const api = {
    refresh() { g.nodeVisibility(nodeShown).linkVisibility(edgeShown); api.paint(); },
    paint() {
      // Re-applying an accessor is how this library is told to repaint.
      g.nodeColor(g.nodeColor()).linkColor(g.linkColor()).linkWidth(g.linkWidth());
    },
    focus(id) {
      const n = index.get(id);
      if (!n || n.x == null) return;
      const d = 110, r = 1 + d / Math.max(1, Math.hypot(n.x, n.y, n.z));
      g.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 800);
    },
    fit() { g.zoomToFit(600, 60, n => nodeShown(n)); },
    relayout() { g.d3ReheatSimulation(); setTimeout(() => api.fit(), 1200); },
    zoomBy(f) {
      const c = g.cameraPosition();
      const k = 1 / f;
      g.cameraPosition({ x: c.x * k, y: c.y * k, z: c.z * k }, undefined, 200);
    },
    settle() { setTimeout(() => api.fit(), 700); },
    destroy() { try { g._destructor && g._destructor(); } catch {} viewport.innerHTML = ''; },
    help: 'click a node to inspect &middot; open it from the panel<br>drag to orbit &middot; right-drag to pan &middot; <kbd>l</kbd> local/global',
  };
  return api;
}

// ---- shared UI --------------------------------------------------------------
function showTip(ev, d) {
  tip.textContent = d.id +
    (d.degree ? '  ·  ' + d.degree + ' connection' + (d.degree === 1 ? '' : 's') : '  ·  unconnected') +
    (d.staleness && d.staleness.status !== 'fresh' ? '  ·  ' + d.staleness.status : '') +
    (d.openComments ? '  ·  ' + d.openComments + ' open' : '');
  tip.classList.add('on');
  const r = stage.getBoundingClientRect();
  tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - tip.offsetWidth - 10) + 'px';
  tip.style.top = Math.min(ev.clientY - r.top + 14, r.height - tip.offsetHeight - 10) + 'px';
}

function provHtml(p) {
  if (!p) return '<div class="prov">No edit record — written before edits were tracked.</div>';
  const o = p.observed || {}, c = p.claimed || {};
  const bits = [];
  if (c.agent) bits.push('<b>' + esc(c.agent) + '</b>');
  if (c.model) bits.push('<span class="mdl">' + esc(c.model) + '</span>');
  if (o.ip) bits.push('from ' + esc(o.ip));
  if (o.via) bits.push('via ' + esc(o.via));
  if (!bits.length && !p.at) return '';
  return '<div class="prov">' + bits.join(' · ') +
    (p.at ? '<br>' + esc(new Date(p.at).toLocaleString()) : '') +
    (c.context ? '<div class="why">“' + esc(c.context) + '”</div>' : '') +
    (Object.keys(c).length ? '<div class="caveat">agent, model and reason are self-reported; only the address and transport are observed</div>' : '') +
    '</div>';
}

// In local mode, opening a node also opens it up: its neighbours join the
// visible set rather than replacing it. That is the "expand on demand" half of
// the pattern — you accumulate a working subgraph instead of hopping between
// disconnected views.
function expandAndSelect(id) {
  if (scope === 'local' && selectedId && id !== selectedId) expanded.add(id);
  select(id);
}

function select(id) {
  selectedId = id;
  recomputeLocal();
  const shell = document.getElementById('shell');
  if (!id) {
    shell.classList.remove('detail');
    if (view) { view.refresh(); }
    syncSidebar();
    return;
  }
  const n = byId.get(id);
  if (!n) return;
  shell.classList.add('detail');
  const rel = relatedOf(id);
  document.getElementById('detailInner').innerHTML =
    '<h2>' + esc(n.title) + '</h2><div class="slug">' + esc(n.id) + '</div>' +
    (n.tags && n.tags.length ? '<div class="tagrow">' + n.tags.map(t => '<span class="tg">' + esc(t) + '</span>').join('') + '</div>' : '') +
    (n.summary ? '<p class="sum">' + esc(n.summary) + '</p>' : '') +
    '<a class="open" href="/w/' + encodeURI(n.id) + '">Open page →</a>' +
    '<h5>Last edited</h5>' + provHtml(n.provenance) +
    '<h5>Related · ' + rel.length + '</h5>' +
    (rel.length ? rel.map(r => '<a class="rel" href="#" data-go="' + esc(r.n.id) + '">' + esc(r.n.title) +
      '<span class="why">' + strengthBar(r.strength) + ' ' + because(r) +
      '</span></a>').join('') : '<div class="prov">Nothing connects to this page yet.</div>');

  document.querySelectorAll('#detailInner [data-go]').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      select(a.dataset.go);
      if (view) view.focus(a.dataset.go);
    }));
  if (view) view.refresh();
  syncSidebar();
}

function syncSidebar() {
  document.querySelectorAll('#side a.item').forEach(a =>
    a.classList.toggle('sel', a.dataset.id === selectedId));
}

function buildSidebar() {
  const side = document.getElementById('side');
  const vis = raw.nodes.filter(nodeShown);
  if (!vis.length) { side.innerHTML = '<div class="none">Nothing matches.</div>'; return; }
  let html = '';
  for (const g of raw.groups) {
    const items = vis.filter(n => n.group === g).sort((a, b) => a.title.localeCompare(b.title));
    if (!items.length) continue;
    html += '<h4><span class="sw" style="background:' + groupColor(g) + '"></span>' + esc(g) +
            '<span class="n">' + items.length + '</span></h4>';
    for (const n of items) {
      html += '<a class="item" data-id="' + esc(n.id) + '" href="#">' + esc(n.title) +
              '<small>' + esc(n.id) + '</small></a>';
    }
  }
  side.innerHTML = html;
  side.querySelectorAll('a.item').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); select(a.dataset.id); if (view) view.focus(a.dataset.id); });
    a.addEventListener('mouseenter', () => { hotId = a.dataset.id; if (view) view.paint(); });
    a.addEventListener('mouseleave', () => { hotId = null; if (view) view.paint(); });
  });
  syncSidebar();
}

// 3d-force-graph is 1.3MB, so it is only fetched if the 3D view is actually used.
let d3fgLoading = null;
function ensure3d() {
  if (typeof ForceGraph3D !== 'undefined') return Promise.resolve();
  if (d3fgLoading) return d3fgLoading;
  d3fgLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/3d-force-graph.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load the 3D renderer'));
    document.head.appendChild(s);
  });
  return d3fgLoading;
}

async function setMode(m) {
  const loading = document.createElement('div');
  if (m === '3d' && typeof ForceGraph3D === 'undefined') {
    loading.className = 'loading';
    loading.textContent = 'Loading 3D renderer…';
    stage.appendChild(loading);
  }
  try {
    if (m === '3d') await ensure3d();
  } catch (err) {
    loading.remove();
    alert('3D renderer unavailable: ' + err.message + '\\nStaying in 2D.');
    return;
  }
  loading.remove();

  if (view) view.destroy();
  mode = m;
  localStorage.setItem('botwiki.graph.mode', m);
  document.getElementById('m2d').classList.toggle('on', m === '2d');
  document.getElementById('m3d').classList.toggle('on', m === '3d');
  stage.classList.toggle('night', m === '3d');
  view = m === '3d' ? makeView3D() : makeView2D();
  document.getElementById('help').innerHTML = view.help;
  view.refresh();
  view.settle();
  if (selectedId) setTimeout(() => view.focus(selectedId), 400);
}

// ---- controls ---------------------------------------------------------------
document.getElementById('q').addEventListener('input', e => {
  filter = e.target.value.trim();
  buildSidebar();
  if (view) { view.refresh(); }
});
for (const t of ['link', 'tag', 'similar']) {
  document.getElementById('e-' + t).addEventListener('change', e => {
    show[t] = e.target.checked;
    document.getElementById('c-' + t).classList.toggle('on', e.target.checked);
    recomputeLocal();
    buildSidebar();
    if (view) view.refresh();
  });
}
function setScope(next) {
  scope = next;
  localStorage.setItem('botwiki.graph.scope', next);
  document.getElementById('sGlobal').classList.toggle('on', next === 'global');
  document.getElementById('sLocal').classList.toggle('on', next === 'local');
  document.getElementById('hopwrap').classList.toggle('on', next === 'local');
  expanded.clear();
  // Local mode with nothing focused would show an empty canvas, so focus the
  // most connected page rather than presenting a blank.
  if (next === 'local' && !selectedId && raw.nodes.length) {
    const hub = [...raw.nodes].sort((a, b) => (b.weightedDegree ?? 0) - (a.weightedDegree ?? 0))[0];
    select(hub.id);
    if (view) setTimeout(() => view.fit(), 60);
    return;
  }
  recomputeLocal();
  buildSidebar();
  if (view) { view.refresh(); setTimeout(() => view.fit(), 260); }
}

document.getElementById('sGlobal').addEventListener('click', () => scope !== 'global' && setScope('global'));
document.getElementById('sLocal').addEventListener('click', () => scope !== 'local' && setScope('local'));

document.getElementById('hops').addEventListener('input', (e) => {
  hops = Number(e.target.value);
  localStorage.setItem('botwiki.graph.hops', String(hops));
  document.getElementById('hoplbl').textContent = hops + ' hop' + (hops === 1 ? '' : 's');
  recomputeLocal();
  buildSidebar();
  if (view) { view.refresh(); setTimeout(() => view.fit(), 260); }
});

document.getElementById('e-status').addEventListener('change', (e) => {
  showStatus = e.target.checked;
  localStorage.setItem('botwiki.graph.status', showStatus ? '1' : '0');
  document.getElementById('c-status').classList.toggle('on', showStatus);
  document.getElementById('statuslegend').classList.toggle('on', showStatus);
  if (view) view.refresh();
});

document.getElementById('minstr').addEventListener('input', (e) => {
  minStr = Number(e.target.value) / 100;
  document.getElementById('strlbl').textContent = minStr ? '\u2265 ' + e.target.value : 'all';
  recomputeLocal();
  buildSidebar();
  if (view) view.refresh();
});
document.getElementById('fit').addEventListener('click', () => view && view.fit());
document.getElementById('relayout').addEventListener('click', () => view && view.relayout());
document.getElementById('zin').addEventListener('click', () => view && view.zoomBy(1.4));
document.getElementById('zout').addEventListener('click', () => view && view.zoomBy(1 / 1.4));
document.getElementById('m2d').addEventListener('click', () => mode !== '2d' && setMode('2d'));
document.getElementById('m3d').addEventListener('click', () => mode !== '3d' && setMode('3d'));
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    expanded.clear();
    select(null);
    document.getElementById('q').value = '';
    filter = '';
    recomputeLocal();
    buildSidebar();
    if (view) view.refresh();
  }
  if (e.key.toLowerCase() === 'l' && e.target.tagName !== 'INPUT') setScope(scope === 'local' ? 'global' : 'local');
  if (e.key === '/' && e.target.tagName !== 'INPUT') { e.preventDefault(); document.getElementById('q').focus(); }
  if (e.key.toLowerCase() === 'f' && e.target.tagName !== 'INPUT') view && view.fit();
  if (e.key.toLowerCase() === 'g' && e.target.tagName !== 'INPUT') setMode(mode === '2d' ? '3d' : '2d');
});

// ---- load -------------------------------------------------------------------
(async () => {
  const g = await (await fetch('/api/graph')).json();
  if (!g.nodes.length) {
    stage.innerHTML = '<div class="loading">No pages yet — <a href="/new" style="margin-left:5px">write one</a>.</div>';
    return;
  }
  raw = { nodes: g.nodes, edges: g.edges, groups: g.groups, stats: g.stats };
  byId = new Map(raw.nodes.map(n => [n.id, n]));

  document.getElementById('stats').innerHTML =
    '<b>' + g.stats.pages + '</b> pages · <b>' + g.stats.edges + '</b> links<br>' +
    g.stats.links + ' explicit · ' + g.stats.tagEdges + ' tag · ' + g.stats.similarEdges + ' similar<br>' +
    '<b>' + (g.stats.strong || 0) + '</b> strong · <b>' + (g.stats.weak || 0) + '</b> weak · avg ' +
    (g.stats.meanStrength ?? 0) +
    (g.stats.orphans ? '<br><b>' + g.stats.orphans + '</b> unconnected' : '');

  const counts = {};
  for (const n of raw.nodes) counts[n.group] = (counts[n.group] || 0) + 1;
  const LEGEND_SHOWN = 3;
  const chip = gr =>
    '<div class="gchip' + (hidden.has(gr) ? ' off' : '') + '" data-g="' + esc(gr) + '">' +
    '<span class="d" style="background:' + groupColor(gr) + '"></span>' +
    esc(gr) + ' ' + (counts[gr] || 0) + '</div>';
  // Biggest first, so the three that stay in the open are the three worth
  // having. A hidden group is kept out too — a filter you cannot see you
  // applied is how the graph ends up looking wrong for no visible reason.
  const ordered = raw.groups.slice().sort((a, b) =>
    (hidden.has(a) === hidden.has(b) ? 0 : hidden.has(a) ? -1 : 1) ||
    (counts[b] || 0) - (counts[a] || 0) || String(a).localeCompare(String(b)));
  const head = ordered.slice(0, LEGEND_SHOWN);
  const rest = ordered.slice(LEGEND_SHOWN);
  document.getElementById('legend').innerHTML =
    head.map(chip).join('') +
    (rest.length
      ? '<details class="legendmore"><summary class="gchip">+' + rest.length + ' more</summary>' +
        '<div class="legendrest">' + rest.map(chip).join('') + '</div></details>'
      : '');
  document.getElementById('legend').addEventListener('click', e => {
    const chip = e.target.closest('[data-g]'); if (!chip) return;
    hidden.has(chip.dataset.g) ? hidden.delete(chip.dataset.g) : hidden.add(chip.dataset.g);
    chip.classList.toggle('off', hidden.has(chip.dataset.g));
    if (view) view.refresh();
    buildSidebar();
  });

  document.getElementById('e-status').checked = showStatus;
  document.getElementById('c-status').classList.toggle('on', showStatus);
  document.getElementById('statuslegend').classList.toggle('on', showStatus);
  document.getElementById('hops').value = String(hops);
  document.getElementById('hoplbl').textContent = hops + ' hop' + (hops === 1 ? '' : 's');
  document.getElementById('sGlobal').classList.toggle('on', scope === 'global');
  document.getElementById('sLocal').classList.toggle('on', scope === 'local');
  document.getElementById('hopwrap').classList.toggle('on', scope === 'local');

  buildSidebar();
  const want = decodeURIComponent(location.hash.slice(1));
  if (want && byId.has(want)) selectedId = want;
  if (scope === 'local' && !selectedId && raw.nodes.length) {
    selectedId = [...raw.nodes].sort((a, b) => (b.weightedDegree ?? 0) - (a.weightedDegree ?? 0))[0].id;
  }
  recomputeLocal();
  await setMode(new URLSearchParams(location.search).get('3d') === '1' ? '3d' : mode);
  if (selectedId) select(selectedId);
})();

// The renderers read their colours from CSS variables through getComputedStyle
// at paint time, so a skin change is invisible to them until something redraws.
// setMode tears the view down and rebuilds it, which is exactly what is wanted.
window.addEventListener('skinchange', () => {
  buildSidebar();
  if (selectedId) syncSidebar();
  setMode(mode);
});
</script>${SKIN_JS}</body></html>`;
}
