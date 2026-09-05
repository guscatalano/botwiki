// Shared design tokens. The page views and the graph view both draw from these,
// so the two never drift apart.
//
// Two skins, both dark, both deliberate. There is no light theme and no
// following the OS preference: this is a committed look rather than a neutral
// surface, and a reader who picked the terminal skin does not want it turning
// into a light theme at sunrise.
//
// `mesh` is the base. It lives on bare :root as well as on its own attribute,
// so a page renders as intended before any script runs and stays correct if
// storage is unavailable or JavaScript never arrives.
//
// Everything is expressed as the same variable set, which is why skinning is
// cheap: the graph reads these too, so it re-colours itself with no extra work.

const UI_SANS = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const UI_MONO = 'ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace';

// The variables per skin, kept apart from the rules that apply them so the
// default can be repeated on bare `:root` without the values existing twice.
export const SKIN_VARS = {
  synth: `
  --bg:#07070a;--panel:#0f1014;--ink:#d9dde3;--muted:#8e959f;--line:#24262e;
  --accent:#d9a441;--accent-soft:#1c1710;--code:#101218;--warn:#c4483a;
  --g-root:#d9a441;--g-hosts:#6fa88c;--g-services:#c47a3a;--g-runbooks:#7f93b8;
  --g-meta:#7a7568;--g-decisions:#b06a8c;--g-scratch:#a89457;
  --edge:#2a2c34;--edge-similar:#1d1f26;
  --font-ui:${UI_SANS};
  --scan:rgba(255,255,255,.018);
  color-scheme:dark;`,
  mesh: `
  --bg:#050806;--panel:#0a0f0b;--ink:#b9f5d3;--muted:#4f9e74;--line:#17301f;
  --accent:#41e08a;--accent-soft:#0c2118;--code:#081008;--warn:#e0913a;
  --g-root:#41e08a;--g-hosts:#7ff0b0;--g-services:#e0913a;--g-runbooks:#2fbf74;
  --g-meta:#3f7a5c;--g-decisions:#a8f0c4;--g-scratch:#5fd49a;
  --edge:#1c3a28;--edge-similar:#122619;
  --font-ui:${UI_MONO};
  --scan:rgba(65,224,138,.03);
  color-scheme:dark;`,
  lab: `
  --bg:#070b12;--panel:#0d131d;--ink:#c3d4ea;--muted:#6f88a8;--line:#1c2838;
  --accent:#4aa3ff;--accent-soft:#0d1c2e;--code:#0a1119;--warn:#e0913a;
  --g-root:#4aa3ff;--g-hosts:#5fd0c8;--g-services:#e0913a;--g-runbooks:#8d9bf0;
  --g-meta:#5a7391;--g-decisions:#c98bd8;--g-scratch:#7fb4e0;
  --edge:#1d3350;--edge-similar:#15202e;
  --font-ui:${UI_MONO};
  --scan:rgba(74,163,255,.028);
  color-scheme:dark;`,
};

export const TOKENS = `
/* SYNTH — black and gold. Gold has meant "verified" here since the first mark,
   so the accent is already carrying the product's meaning rather than a mood. */
:root[data-skin="synth"]{${SKIN_VARS.synth}
}

/* MESH — phosphor terminal, and the default. Monochrome green by design, with
   amber reserved for fault, which is exactly how a Pip-Boy uses it. The typeface
   switches to mono because that is most of what makes a terminal read as a
   terminal.

   Declared on bare :root as well as on its own attribute: the attribute is what
   the picker sets, and the bare rule is what paints correctly before any script
   has run, or when storage is unavailable. Whichever skin is the default has to
   hold both. */
:root,
:root[data-skin="mesh"]{${SKIN_VARS.mesh}
}

/* LAB — cold blue. Offered only where an instance asks for it, and the reason it
   exists is instance identity rather than taste: a private wiki and a public one
   that look alike are two wikis somebody will eventually confuse, and the cost of
   confusing them is writing something internal onto the open internet.

   Distinguished by hue, not by brightness. The first version of this was a light
   paper theme, which was certainly unmistakable and also glaring next to two dark
   skins — and a skin nobody wants to look at gets switched away from, which
   defeats the whole point of having it. Gold, green, blue: three accents nobody
   confuses at a glance, all comfortable to sit in. */
:root[data-skin="lab"]{${SKIN_VARS.lab}
}

/* Scanlines, painted only where a skin asks for them. Fixed and inert so they
   never intercept a click. */
body::after{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:60;
  background:repeating-linear-gradient(to bottom,var(--scan) 0 1px,transparent 1px 3px);
}
`;

// --- marks -----------------------------------------------------------------
//
// One per skin, drawn at 24 units so they hold at 22px in the header. Both are
// emitted on every page and CSS shows the one matching the active skin —
// which means the mark swaps with no JavaScript and cannot flash the wrong one.
//
// They are the same objects from the design rounds, reduced until only the
// silhouette is left: the aperture and the rig.

export const MARK_SYNTH = `<svg class="mk mk-synth" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
<polygon points="12,7.5 15.9,9.75 15.9,14.25 12,16.5 8.1,14.25 8.1,9.75"
 fill="none" stroke="currentColor" stroke-width="1.3"/>
<g stroke="currentColor" stroke-width="1" opacity=".55">
<path d="M12 7.5 V2.4"/><path d="M15.9 14.25 L20.3 16.8"/><path d="M8.1 14.25 L3.7 16.8"/></g>
<circle cx="12" cy="12" r="1.7" fill="currentColor"/>
</svg>`;

export const MARK_MESH = `<svg class="mk mk-mesh" viewBox="0 0 24 24" aria-hidden="true">
<g stroke="currentColor" fill="none" stroke-linecap="round" stroke-width="1.3">
<path d="M9 9.5 L4.5 5.5"/><path d="M8.6 12 L2.6 11"/><path d="M9 14.5 L4.5 18.5"/>
<path d="M15 9.5 L19.5 5.5"/><path d="M15.4 12 L21.4 11"/><path d="M15 14.5 L19.5 18.5"/></g>
<polygon points="12,7.6 15.4,9.6 15.4,13.6 12,15.6 8.6,13.6 8.6,9.6"
 fill="none" stroke="currentColor" stroke-width="1.5"/>
<circle cx="12" cy="11.6" r="1.7" fill="currentColor"/>
</svg>`;

// LAB — a caliper over a rule. Drawn rather than borrowed because the point of
// this skin is that the private instance does not look like the public one, and
// the mark is the thing a reader recognises before they have read anything.
export const MARK_LAB = `<svg class="mk mk-lab" viewBox="0 0 24 24" aria-hidden="true">
<g stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round">
<path d="M4 19.5 H20"/>
<path d="M7 19.5 V16.5"/><path d="M12 19.5 V15"/><path d="M17 19.5 V16.5"/>
<path d="M8.5 4.5 L12 12 L15.5 4.5"/>
</g>
<circle cx="12" cy="12" r="1.7" fill="currentColor"/>
<path d="M8.5 4.5 H15.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

export const MARKS = `${MARK_SYNTH}${MARK_MESH}${MARK_LAB}`;

export const MARK_CSS = `
.mk{display:none;width:22px;height:22px;flex:none;color:var(--accent);vertical-align:-5px}
:root:not([data-skin]) .mk-mesh{display:inline-block}
:root[data-skin="synth"] .mk-synth{display:inline-block}
:root[data-skin="mesh"] .mk-mesh{display:inline-block}
/* Without this the lab skin matches no rule and the header shows no mark at all,
   which is how a new skin silently loses the logo. */
:root[data-skin="lab"] .mk-lab{display:inline-block}
.brand{display:inline-flex;align-items:center;gap:8px}
/* The old rule painted the only span in .brand with the accent, back when that
   span was just the trailing full stop. The site name now lives in one. */
.brand .bn{color:var(--ink)}
`;

// The skin picker, shared by the page views and the graph so the control looks
// and behaves the same in both.
const ALL_SKINS = [
  { id: 'mesh', label: 'Mesh' },
  { id: 'synth', label: 'Synth' },
  { id: 'lab', label: 'Lab' },
];

/**
 * Which skins an instance offers, and which it starts on.
 *
 * Per-instance because this is not only a matter of taste. A private wiki and a
 * public one that look identical are two wikis somebody will eventually mix up,
 * and the cost of mixing them up is writing something internal onto the open
 * internet. Giving the private box a look the public one does not have makes
 * that mistake visible before the writing rather than after it.
 *
 * The public instance is left with exactly the two skins it had.
 */
export function skinsFor(offered) {
  const want = String(offered || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Kept in the order asked for, so an instance can put its own skin first in
  // the picker rather than third behind the two it shares with everyone else.
  // Deduplicated, or a typo in the env file puts the same button in twice.
  const picked = want.length
    ? [...new Set(want)].map((id) => ALL_SKINS.find((s) => s.id === id)).filter(Boolean)
    : ALL_SKINS.slice(0, 2);
  return picked.length ? picked : ALL_SKINS.slice(0, 2);
}

export const SKINS = ALL_SKINS.slice(0, 2);

// Runs in <head>, before the body paints, so a chosen skin never flashes the
// default first. Deliberately tiny and deliberately wrapped in try/catch:
// storage throws in private windows and the page must still render.
//
// Always stamps an attribute, even for the default. Readers carrying the removed
// light skin have '' or nothing stored, and both resolve to mesh here rather
// than to an unstyled root; it also lets the picker mark the right button on the
// first paint instead of after the script runs.
export const SKIN_BOOT = skinBoot(SKINS, 'mesh');

/**
 * Stamps the attribute in <head> before the body paints.
 *
 * Takes the instance's own skin list and default, so a stored choice that this
 * instance does not offer — a reader who picked Lab at home and then opened the
 * public wiki — falls back to the default rather than to an unstyled root.
 */
export function skinBoot(list, dflt) {
  const ids = JSON.stringify(list.map((s) => s.id));
  const d = JSON.stringify(dflt);
  return `<script>try{var ok=${ids},d=${d},s=localStorage.getItem('botwiki-skin');document.documentElement.dataset.skin=ok.indexOf(s)>=0?s:d}catch(e){document.documentElement.dataset.skin=${d}}</script>`;
}

export const SKIN_PICKER = skinPicker(SKINS);

export function skinPicker(list) {
  return `<div class="skins" role="group" aria-label="Theme">${list
    .map((s) => `<button type="button" data-skin="${s.id}" aria-pressed="false">${s.label}</button>`)
    .join('')}</div>`;
}

/**
 * The default skin's variables, repeated on bare `:root`.
 *
 * The bare rule is what paints before any script has run and when storage is
 * unavailable, so whichever skin an instance defaults to has to hold it. mesh
 * already declares it inline above; anything else needs this, or the lab box
 * flashes a green terminal on every load before settling into paper.
 */
export function defaultSkinCss(id) {
  if (!id || id === 'mesh') return '';
  return `:root:not([data-skin]){${SKIN_VARS[id] || ''}}`;
}

export const SKIN_CSS = `
.skins{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.skins button{
  border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;
  padding:5px 10px;cursor:pointer;border-right:1px solid var(--line);line-height:1.6;
}
.skins button:last-child{border-right:0}
.skins button:hover{color:var(--ink)}
.skins button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.skins button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
`;

// Favicons, one per skin, as data URIs. Same marks, drawn with explicit
// colours because a favicon has no page to inherit from.
const ICON = (accent, bg, inner) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${bg}"/><g stroke="${accent}" fill="none" stroke-linecap="round">${inner}</g></svg>`
  );

export const ICONS = {
  synth: ICON(
    '#d9a441',
    '#07070a',
    `<circle cx="12" cy="12" r="9.4" stroke-width="1.6"/><polygon points="12,7.4 16,9.7 16,14.3 12,16.6 8,14.3 8,9.7" stroke-width="1.4"/><circle cx="12" cy="12" r="1.8" fill="#d9a441" stroke="none"/>`
  ),
  mesh: ICON(
    '#41e08a',
    '#050806',
    `<path d="M9 9.5 L4.2 5.2" stroke-width="1.4"/><path d="M8.6 12 L2.4 11" stroke-width="1.4"/><path d="M9 14.5 L4.2 18.8" stroke-width="1.4"/><path d="M15 9.5 L19.8 5.2" stroke-width="1.4"/><path d="M15.4 12 L21.6 11" stroke-width="1.4"/><path d="M15 14.5 L19.8 18.8" stroke-width="1.4"/><polygon points="12,7.6 15.4,9.6 15.4,13.6 12,15.6 8.6,13.6 8.6,9.6" stroke-width="1.6"/><circle cx="12" cy="11.6" r="1.8" fill="#41e08a" stroke="none"/>`
  ),
};

// The same icon as a standalone file, for /favicon.ico and /favicon.svg. The
// data-URI set above is swapped in by script once a skin is chosen; this is what
// the browser gets from its very first request, before any script has run, and
// what a crawler that never runs one sees. Mesh, because that is the base skin.
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
  `<rect width="24" height="24" rx="5" fill="#050806"/>` +
  `<g stroke="#41e08a" fill="none" stroke-linecap="round">` +
  `<path d="M9 9.5 L4.2 5.2" stroke-width="1.4"/><path d="M8.6 12 L2.4 11" stroke-width="1.4"/>` +
  `<path d="M9 14.5 L4.2 18.8" stroke-width="1.4"/><path d="M15 9.5 L19.8 5.2" stroke-width="1.4"/>` +
  `<path d="M15.4 12 L21.6 11" stroke-width="1.4"/><path d="M15 14.5 L19.8 18.8" stroke-width="1.4"/>` +
  `<polygon points="12,7.6 15.4,9.6 15.4,13.6 12,15.6 8.6,13.6 8.6,9.6" stroke-width="1.6"/>` +
  `<circle cx="12" cy="11.6" r="1.8" fill="#41e08a" stroke="none"/>` +
  `</g></svg>`;

// Diagrams.
//
// Mermaid rather than SVG, and the reason is what reads the wiki. An embedded
// SVG reaches an agent as a few thousand tokens of path coordinates, which is
// strictly worse than no diagram: it costs context and carries no meaning. The
// mermaid SOURCE is what gets stored, so wiki_read hands an agent `A --> B` —
// which it can actually understand — while a browser gets a picture from the
// same bytes. One source, both audiences.
//
// It also avoids reintroducing the class of bug that raw HTML escaping exists to
// prevent. SVG carries <script>, onload= and foreignObject; allowing it on a
// wiki anyone can write to would mean maintaining a sanitiser, where one gap is
// stored XSS. Here the stored content is plain text and the renderer builds the
// SVG itself, under securityLevel 'strict'.
//
// Loaded lazily: the bundle is ~3MB and most pages have no diagram, so nothing
// is fetched unless a .mermaid block is actually on the page.
export const MERMAID_JS = `<script>(function(){
  if(!document.querySelector('pre.mermaid'))return;
  var css=getComputedStyle(document.documentElement);
  var v=function(n,f){return (css.getPropertyValue(n)||f).trim()};
  function draw(){
    if(!window.mermaid)return;
    // Re-read the variables each time: the skin picker can change them after load.
    css=getComputedStyle(document.documentElement);
    window.mermaid.initialize({
      startOnLoad:false,
      securityLevel:'strict',
      theme:'base',
      fontFamily:v('--font-ui','ui-monospace,monospace'),
      themeVariables:{
        background:v('--panel','#0a0f0b'),
        primaryColor:v('--accent-soft','#0c2118'),
        primaryTextColor:v('--ink','#b9f5d3'),
        primaryBorderColor:v('--accent','#41e08a'),
        lineColor:v('--accent','#41e08a'),
        secondaryColor:v('--code','#081008'),
        tertiaryColor:v('--panel','#0a0f0b'),
        textColor:v('--ink','#b9f5d3'),
        mainBkg:v('--accent-soft','#0c2118'),
        nodeBorder:v('--accent','#41e08a'),
        clusterBkg:v('--code','#081008'),
        clusterBorder:v('--line','#17301f'),
        titleColor:v('--ink','#b9f5d3'),
        edgeLabelBackground:v('--panel','#0a0f0b')
      }
    });
    document.querySelectorAll('pre.mermaid').forEach(function(el){
      // The source is kept so a re-render after a skin change starts from the
      // text rather than from the SVG the last render left behind.
      if(!el.dataset.src)el.dataset.src=el.textContent;
      el.removeAttribute('data-processed');
      // Also clear the enhancement marker. Resetting textContent throws away the
      // viewport and toolbar, so leaving this set would make enhance() decline
      // to rebuild them and every diagram would stop moving after a skin change.
      el.removeAttribute('data-dgm');
      el.classList.remove('dgm');
      el.textContent=el.dataset.src;
    });
    try{
      var r=window.mermaid.run({querySelector:'pre.mermaid'});
      if(r&&r.then)r.then(enhanceAll,enhanceAll);else enhanceAll();
    }catch(e){}
  }

  // Turn each drawn diagram into a viewport that pans and zooms.
  //
  // Wheel zoom is deliberately behind ctrl/cmd. A diagram that swallows the
  // wheel traps the page: you scroll toward it, the page stops moving, and the
  // only way out is the keyboard. Ctrl+wheel is what every map and canvas uses
  // for the same reason, and the buttons cover anyone who does not know that.
  // Everything here is additive — an un-enhanced diagram is still a readable
  // SVG, so a failure anywhere below costs the zoom, not the picture.
  function enhance(pre){
    if(pre.dataset.dgm)return;
    var svg=pre.querySelector('svg');
    if(!svg)return;
    pre.dataset.dgm='1';
    pre.classList.add('dgm');
    pre.tabIndex=0;
    pre.setAttribute('role','img');
    pre.setAttribute('aria-label','Diagram. Drag to pan, ctrl and scroll to zoom, or use the arrow keys.');

    var view=document.createElement('div');view.className='dgm-view';
    var pan=document.createElement('div');pan.className='dgm-pan';
    pre.insertBefore(view,pre.firstChild);
    view.appendChild(pan);
    pan.appendChild(svg);

    // The viewBox is the diagram's own coordinate space and is the only stable
    // reference here: mermaid often emits width="100%", which measures as
    // whatever the column happens to be and makes every zoom relative to the
    // browser window instead of to the drawing.
    var vb=svg.viewBox&&svg.viewBox.baseVal;
    var box=svg.getBoundingClientRect();
    var natural=(vb&&vb.width)?{w:vb.width,h:vb.height}:{w:box.width||1,h:box.height||1};
    // Pin the element to that size so the only thing changing scale is our
    // transform. The inline max-width mermaid writes would otherwise win over
    // the stylesheet.
    svg.style.maxWidth='none';
    svg.setAttribute('width',natural.w);
    svg.setAttribute('height',natural.h);
    view.style.height=Math.min(560,Math.max(160,natural.h))+'px';

    var k=1,x=0,y=0,MIN=0.2,MAX=8;
    var readout=document.createElement('span');readout.className='dgm-zoom';
    function apply(){
      pan.style.transform='translate('+x+'px,'+y+'px) scale('+k+')';
      readout.textContent=Math.round(k*100)+'%';
    }
    // Zoom about a point, so the thing under the cursor stays under the cursor.
    // Scaling about the origin instead is the classic version of this that feels
    // broken without anyone being able to say why.
    function zoomAt(nk,cx,cy){
      nk=Math.min(MAX,Math.max(MIN,nk));
      var rect=view.getBoundingClientRect();
      var px=cx-rect.left,py=cy-rect.top;
      x=px-(px-x)*(nk/k);y=py-(py-y)*(nk/k);k=nk;apply();
    }
    function fit(){
      var rect=view.getBoundingClientRect();
      k=Math.min(1,Math.min(rect.width/natural.w,rect.height/natural.h));
      x=(rect.width-natural.w*k)/2;y=(rect.height-natural.h*k)/2;apply();
    }

    var bar=document.createElement('div');bar.className='dgm-bar';
    function btn(label,title,fn){
      var b=document.createElement('button');
      b.type='button';b.textContent=label;b.title=title;b.setAttribute('aria-label',title);
      b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();fn()});
      bar.appendChild(b);return b;
    }
    var center=function(){var r=view.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}};
    btn('\\u2212','Zoom out',function(){var c=center();zoomAt(k/1.3,c.x,c.y)});
    btn('+','Zoom in',function(){var c=center();zoomAt(k*1.3,c.x,c.y)});
    btn('\\u2316','Fit to view',fit);
    if(pre.requestFullscreen){
      btn('\\u26f6','Full screen',function(){
        if(document.fullscreenElement===pre)document.exitFullscreen();
        else pre.requestFullscreen().then(function(){setTimeout(fit,60)},function(){});
      });
    }
    pre.appendChild(bar);pre.appendChild(readout);

    view.addEventListener('wheel',function(e){
      // Without the modifier this is an ordinary page scroll and must stay one.
      if(!(e.ctrlKey||e.metaKey))return;
      e.preventDefault();
      zoomAt(k*(e.deltaY<0?1.12:1/1.12),e.clientX,e.clientY);
    },{passive:false});

    var drag=null;
    view.addEventListener('pointerdown',function(e){
      if(e.button!==0&&e.pointerType==='mouse')return;
      // On touch, a one-finger drag at fit scale is the reader trying to scroll
      // the page. Only claim the gesture once there is something to pan to.
      if(e.pointerType!=='mouse'&&k<=fitScale()+0.01)return;
      drag={x:e.clientX-x,y:e.clientY-y,id:e.pointerId};
      view.classList.add('grabbing');
      try{view.setPointerCapture(e.pointerId)}catch(err){}
    });
    view.addEventListener('pointermove',function(e){
      if(!drag||drag.id!==e.pointerId)return;
      e.preventDefault();
      x=e.clientX-drag.x;y=e.clientY-drag.y;apply();
    });
    function endDrag(e){
      if(!drag||(e&&drag.id!==e.pointerId))return;
      drag=null;view.classList.remove('grabbing');
    }
    view.addEventListener('pointerup',endDrag);
    view.addEventListener('pointercancel',endDrag);
    function fitScale(){
      var rect=view.getBoundingClientRect();
      return Math.min(1,Math.min(rect.width/natural.w,rect.height/natural.h));
    }

    // Pinch, tracked as two live pointers rather than through gesture events,
    // which Safari alone implements.
    var pts={},pinch=null;
    view.addEventListener('pointerdown',function(e){pts[e.pointerId]={x:e.clientX,y:e.clientY}});
    view.addEventListener('pointermove',function(e){
      if(!pts[e.pointerId])return;
      pts[e.pointerId]={x:e.clientX,y:e.clientY};
      var ids=Object.keys(pts);
      if(ids.length!==2){pinch=null;return}
      var a=pts[ids[0]],b=pts[ids[1]];
      var d=Math.hypot(a.x-b.x,a.y-b.y),cx=(a.x+b.x)/2,cy=(a.y+b.y)/2;
      if(pinch){e.preventDefault();zoomAt(k*(d/pinch.d),cx,cy)}
      pinch={d:d};
      drag=null;
    },{passive:false});
    function drop(e){delete pts[e.pointerId];if(Object.keys(pts).length<2)pinch=null}
    view.addEventListener('pointerup',drop);
    view.addEventListener('pointercancel',drop);

    view.addEventListener('dblclick',function(e){e.preventDefault();zoomAt(k*1.6,e.clientX,e.clientY)});

    pre.addEventListener('keydown',function(e){
      var step=e.shiftKey?60:20,c=center(),used=true;
      if(e.key==='ArrowLeft')x+=step;
      else if(e.key==='ArrowRight')x-=step;
      else if(e.key==='ArrowUp')y+=step;
      else if(e.key==='ArrowDown')y-=step;
      else if(e.key==='+'||e.key==='=')zoomAt(k*1.3,c.x,c.y);
      else if(e.key==='-'||e.key==='_')zoomAt(k/1.3,c.x,c.y);
      else if(e.key==='0')fit();
      else used=false;
      if(used){e.preventDefault();apply()}
    });

    // The fit depends on the viewport width, so it has to be recomputed when
    // that changes — a rotated phone otherwise keeps the portrait framing.
    if(window.ResizeObserver){
      var ro=new ResizeObserver(function(){if(k<=fitScale()+0.01)fit()});
      ro.observe(view);
    }
    fit();
  }
  function enhanceAll(){
    document.querySelectorAll('pre.mermaid[data-processed]').forEach(function(el){
      try{enhance(el)}catch(e){}
    });
  }
  var s=document.createElement('script');
  s.src='/vendor/mermaid.min.js';
  s.onload=draw;
  // No handler on failure: the block stays a readable code fence, which is what
  // it already was. A diagram that will not draw should not blank the content.
  document.head.appendChild(s);
  window.addEventListener('skinchange',function(){setTimeout(draw,0)});
})();</script>`;

export const SKIN_JS = `<script>(function(){
  var el=document.documentElement,btns=[].slice.call(document.querySelectorAll('.skins button'));
  var ICONS=${JSON.stringify(ICONS)};
  function icon(){
    var l=document.querySelector('link[rel="icon"]');
    if(!l){l=document.createElement('link');l.rel='icon';document.head.appendChild(l)}
    l.href=ICONS[el.dataset.skin]||ICONS.mesh;
  }
  function mark(){var c=el.dataset.skin||'mesh';btns.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.skin===c))})}
  btns.forEach(function(b){b.addEventListener('click',function(){
    var v=b.dataset.skin;
    el.dataset.skin=v;
    try{localStorage.setItem('botwiki-skin',v)}catch(e){}
    mark();icon();
    // The graph paints to canvas and cannot see a variable change on its own.
    window.dispatchEvent(new CustomEvent('skinchange',{detail:v||''}));
  })});
  mark();icon();
})();</script>`;

// --- mascots ---------------------------------------------------------------
//
// The full creatures, for the places with room for one: an empty search, a
// missing page. Same swap mechanism as the marks — all three emitted, CSS shows
// the live one. Drawn to the panel's rules: one closed silhouette, dark features
// on a light body, two eyes, nothing countable.

export const MASCOTS = `
<svg class="ms ms-synth" viewBox="0 0 140 120" aria-hidden="true">
  <g class="ms-limbs" stroke="currentColor" fill="none" stroke-linecap="round" opacity=".85">
    <path d="M52 78 C44 90 42 102 46 114" stroke-width="3.6"/>
    <path d="M62 82 C58 96 60 106 56 118" stroke-width="2.6"/>
    <path d="M78 82 C82 96 80 106 84 118" stroke-width="3"/>
    <path d="M88 78 C96 90 98 100 94 112" stroke-width="1.8"/>
  </g>
  <g fill="currentColor">
    <rect x="42" y="110" width="8" height="6" rx="1"/><rect x="52" y="114" width="8" height="6" rx="1"/>
    <rect x="80" y="114" width="8" height="6" rx="1"/><rect x="90" y="107" width="8" height="6" rx="1"/>
  </g>
  <path d="M70 18 C92 18 102 36 102 54 C102 72 88 82 70 82 C52 82 38 72 38 54 C38 36 48 18 70 18 Z"
        fill="currentColor" opacity=".15"/>
  <path d="M70 18 C92 18 102 36 102 54 C102 72 88 82 70 82 C52 82 38 72 38 54 C38 36 48 18 70 18 Z"
        fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="70" cy="50" r="16" fill="none" stroke="currentColor" stroke-width="2"/>
  <polygon class="ms-iris" points="70,41 77.8,45.5 77.8,54.5 70,59 62.2,54.5 62.2,45.5"
           fill="none" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="70" cy="50" r="3.4" fill="currentColor"/>
</svg>
<svg class="ms ms-mesh" viewBox="0 0 140 120" aria-hidden="true">
  <g class="ms-limbs" stroke="currentColor" fill="none" stroke-linecap="round">
    <path d="M54 50 C40 42 32 30 30 18" stroke-width="2.8"/>
    <path d="M52 60 C36 58 26 52 20 44" stroke-width="2.2"/>
    <path d="M54 70 C40 76 32 86 30 98" stroke-width="2.4"/>
    <path d="M86 50 C100 42 108 30 110 18" stroke-width="2.8"/>
    <path d="M88 60 C104 58 114 52 120 44" stroke-width="2"/>
    <path d="M86 70 C100 76 108 86 110 98" stroke-width="2.2"/>
    <path d="M62 76 C56 90 54 102 56 112" stroke-width="1.8"/>
  </g>
  <path d="M78 76 C84 90 86 100 84 110" stroke="currentColor" stroke-width="1.8"
        fill="none" stroke-linecap="round" stroke-dasharray="5 4" opacity=".5"/>
  <g fill="currentColor">
    <rect x="26" y="12" width="8" height="6" rx="1"/><rect x="16" y="39" width="8" height="6" rx="1"/>
    <rect x="26" y="95" width="8" height="6" rx="1"/><rect x="52" y="108" width="8" height="6" rx="1"/>
    <rect x="106" y="12" width="8" height="6" rx="1"/><rect x="116" y="39" width="8" height="6" rx="1"/>
    <rect x="106" y="95" width="8" height="6" rx="1"/>
  </g>
  <polygon points="70,36 88,47 88,69 70,80 52,69 52,47" fill="currentColor" opacity=".16"/>
  <polygon points="70,36 88,47 88,69 70,80 52,69 52,47" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="70" cy="58" r="4.6" fill="currentColor"/>
</svg>`;

export const MASCOT_CSS = `
.ms{display:none;width:150px;height:128px;color:var(--accent);opacity:.9}
:root:not([data-skin]) .ms-mesh{display:block}
:root[data-skin="synth"] .ms-synth{display:block}
:root[data-skin="mesh"] .ms-mesh{display:block}
.emptystate{display:flex;flex-direction:column;align-items:center;gap:12px;padding:44px 0 30px;text-align:center}
.emptystate p{margin:0;color:var(--muted)}

/* The creature carries the page's own freshness. This is the whole reason these
   designs were picked over an owl: the iris stops down, the limbs go dashed, and
   the colour crosses to the warning tone — so a stale page looks stale before
   anyone reads a date. */
.msbox{display:inline-flex;flex:none;line-height:0}
.msbox .ms{width:var(--ms,64px);height:auto;opacity:1}
.ms-iris,.ms-limbs{transform-box:fill-box;transform-origin:center;transition:transform .35s ease,opacity .35s ease}
.msbox[data-state="aging"] .ms{color:var(--muted)}
.msbox[data-state="aging"] .ms-iris{transform:scale(.66)}
.msbox[data-state="aging"] .ms-limbs{opacity:.75}
.msbox[data-state="stale"] .ms{color:var(--warn)}
.msbox[data-state="stale"] .ms-iris{transform:scale(.34)}
.msbox[data-state="stale"] .ms-limbs{opacity:.5;stroke-dasharray:5 4}
.msbox[data-state="untracked"] .ms,.msbox[data-state="unknown"] .ms{color:var(--muted);opacity:.6}
.msbox[data-state="untracked"] .ms-iris{transform:scale(.8)}

/* A page's own portrait, beside its title. */
.pagemascot{float:right;margin:-6px 0 10px 18px}

/* The listing pip: the same idea reduced to one glyph, because emitting three
   full creatures per row would be a hundred kilobytes of SVG on the index. */
.pip{width:15px;height:15px;flex:none;color:var(--muted)}
.pip .o{fill:none;stroke:currentColor;stroke-width:2}
.pip .i{fill:currentColor}
li[data-state="fresh"] .pip,li[data-state="verified"] .pip{color:var(--accent)}
li[data-state="stale"] .pip{color:var(--warn)}
li[data-state="stale"] .pip .i{r:1.6}
li[data-state="aging"] .pip .i{r:2.8}
li[data-state="untracked"] .pip{opacity:.45}
li[data-state="untracked"] .pip .i{r:1.2}
`;

// One glyph, sized for a table row. The aperture logic survives the reduction:
// a full centre is verified, a shrinking one is a page going out of date.
export const PIP = `<svg class="pip" viewBox="0 0 16 16" aria-hidden="true"><circle class="o" cx="8" cy="8" r="6"/><circle class="i" cx="8" cy="8" r="4"/></svg>`;

// Canvas cannot read CSS variables, so the graph reads these through
// getComputedStyle at paint time. Keep the keys in step with the tokens above.
export const GROUP_VARS = [
  'root',
  'hosts',
  'services',
  'runbooks',
  'meta',
  'decisions',
  'scratch',
];
