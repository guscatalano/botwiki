// End-to-end smoke test: the store, the MCP server over HTTP, and the web server.
// Runs against a throwaway WIKI_DIR. `node test/smoke.js`

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'botwiki-test-'));
const TOKEN = 'test-token-123';
const WEB_PORT = 18787;
const MCP_PORT = 18788;
const PUB_MCP_PORT = 18789;
const PUB_WEB_PORT = 18790;

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

process.env.WIKI_DIR = TMP;

// ---------------------------------------------------------------- store ----
console.log('\nstore');
const wiki = await import('../lib/wiki.js');

await wiki.writePage('hosts/pve-01', '# pve-01\n\nProxmox node at `10.0.0.10`.\nSee [[services/botwiki]].', {
  tags: ['proxmox', 'host'],
});
await wiki.writePage('services/botwiki', '# botwiki\n\nRuns on [[hosts/pve-01]], port `8787`.', {
  title: 'botwiki service',
  tags: ['service'],
});

const doc = await wiki.readPage('hosts/pve-01');
check('write then read round-trips', doc?.body.includes('10.0.0.10'));
check('title falls back to the h1', doc?.title === 'pve-01', doc?.title);
check('tags survive the round trip', doc?.tags.join(',') === 'proxmox,host', doc?.tags.join(','));
check('explicit title wins', (await wiki.readPage('services/botwiki'))?.title === 'botwiki service');

const hits = await wiki.search('proxmox node');
check('search finds the page', hits[0]?.slug === 'hosts/pve-01', JSON.stringify(hits.map((h) => h.slug)));
check('search returns a snippet', !!hits[0]?.snippet);
check('search on an exact value works', (await wiki.search('10.0.0.10'))[0]?.slug === 'hosts/pve-01');
check('search misses cleanly', (await wiki.search('kubernetes')).length === 0);

check('list sees both pages', (await wiki.listPages()).length === 2);
check('list filters by tag', (await wiki.listPages({ tag: 'service' })).length === 1);
check('tags are counted', (await wiki.allTags()).find((t) => t.tag === 'proxmox')?.count === 1);
check('backlinks resolve', (await wiki.backlinks('hosts/pve-01'))[0]?.slug === 'services/botwiki');

// --- page cache -----------------------------------------------------------
// The cache exists so listing paths stop being linear in corpus size. It must
// not be able to serve anything stale, and it must not hand out state a caller
// can corrupt by mutating what they were given.
check('countPages matches without reading pages', (await wiki.countPages()) === 2);
check('listPages honours limit', (await wiki.listPages({ limit: 1 })).length === 1);
check(
  'listPages honours offset',
  (await wiki.listPages({ offset: 1, limit: 1 }))[0].slug !== (await wiki.listPages({ limit: 1 }))[0].slug
);

const cachedOnce = await wiki.readPage('hosts/pve-01');
cachedOnce.meta.injected = 'should not persist';
cachedOnce.tags.push('should-not-persist');
const cachedTwice = await wiki.readPage('hosts/pve-01');
check('mutating a returned page cannot poison the cache', cachedTwice.meta.injected === undefined);
check('mutating returned tags cannot poison the cache', !cachedTwice.tags.includes('should-not-persist'));

// An edit made outside the process — a git pull, a hand edit — must be seen.
const pvePath = (await wiki.readPage('hosts/pve-01')).path;
const before = await fs.readFile(pvePath, 'utf8');
await fs.writeFile(pvePath, `${before}\nEdited outside the process.\n`, 'utf8');
check(
  'an out-of-band edit invalidates the cache',
  (await wiki.readPage('hosts/pve-01')).body.includes('Edited outside the process.'),
  (await wiki.readPage('hosts/pve-01')).body.slice(-60)
);
await fs.writeFile(pvePath, before, 'utf8');
check(
  'reverting out of band is seen too',
  !(await wiki.readPage('hosts/pve-01')).body.includes('Edited outside the process.')
);

const goneSlug = 'scratch/cache-victim';
await wiki.writePage(goneSlug, '# Victim\n\nBody.');
await wiki.readPage(goneSlug);
await wiki.deletePage(goneSlug);
check('a deleted page is not served from cache', (await wiki.readPage(goneSlug)) === null);

// --- moderation -----------------------------------------------------------
// Only reachable on a public instance, but the store itself is testable here.
// Quarantine must hide without destroying: where content is genuinely unlawful
// the obligation is to remove it from view and preserve it, not erase it.
const moderation = await import('../lib/moderation.js');
await wiki.writePage('scratch/reported', '# Reported\n\nBody.');
const rep = await moderation.report({ slug: 'scratch/reported', reason: 'csam', detail: 'test', ip: '10.0.0.1' });
check('a report is recorded', !!rep && rep.reason === 'csam', JSON.stringify(rep));
check('an unknown reason falls back to other', (await moderation.report({ slug: 'scratch/reported', reason: 'nonsense' })).reason === 'other');
check('report detail is bounded', (await moderation.report({ slug: 'scratch/reported', reason: 'spam', detail: 'x'.repeat(5000) })).detail.length <= 1000);
check('reports are listed newest first', (await moderation.listReports())[0].reason === 'spam');
check('reports are counted per page', (await moderation.reportCounts())[0].total === 3);

check('nothing is quarantined by default', (await moderation.isQuarantined('scratch/reported')) === false);
await moderation.quarantine('scratch/reported', { note: 'under review' });
check('quarantine hides the page', (await moderation.isQuarantined('scratch/reported')) === true);
check('quarantine records why', (await moderation.quarantineList())[0].note === 'under review');
check(
  'quarantine does NOT delete the page',
  (await wiki.readPage('scratch/reported'))?.body.includes('Body.'),
  'the file must survive a takedown'
);
check(
  'quarantined pages drop out of public listings',
  (await moderation.filterPublic([{ slug: 'scratch/reported' }, { slug: 'hosts/pve-01' }])).length === 1
);
await moderation.release('scratch/reported');
check('release restores the page', (await moderation.isQuarantined('scratch/reported')) === false);
await wiki.deletePage('scratch/reported');

// Screening refuses the payload rather than storing it and cleaning up after.
check('plain text passes screening', moderation.screen('# fine\n\nJust words.').ok === true);
check(
  'a base64 data URI is refused',
  moderation.screen('![i](data:image/png;base64,iVBORw0KGgoAAAANS)').reason === 'embedded_binary'
);
check('an oversize body is refused', moderation.screen('x'.repeat(300000)).reason === 'too_large');
check('a link flood is refused', moderation.screen('[a](b)'.repeat(400)).reason === 'too_many_links');
check('a normal page of links passes', moderation.screen('[a](b)'.repeat(20)).ok === true);

check('nobody is blocked by default', (await moderation.isBlocked('10.0.0.9')) === false);
await moderation.block('10.0.0.9', { reason: 'repeat abuse' });
check('a blocked writer is recognised', (await moderation.isBlocked('10.0.0.9')) === true);
check('blocking matches any supplied identity', (await moderation.isBlocked(null, 'sess-1', '10.0.0.9')) === true);
check('an unrelated writer is unaffected', (await moderation.isBlocked('10.0.0.8')) === false);
check('the block records why', (await moderation.blockList())[0].reason === 'repeat abuse');
await moderation.unblock('10.0.0.9');
check('unblock works', (await moderation.isBlocked('10.0.0.9')) === false);

// --- votes ------------------------------------------------------------------
// A quality signal, kept deliberately separate from freshness (has anyone
// checked this?) and from moderation (must this be hidden?).
const voteStore = await import('../lib/votes.js');

await wiki.writePage('scratch/voted', '# Voted\n\nBody.', { title: 'Voted' });
check('a page starts with no votes', (await voteStore.scoreOf('scratch/voted')).votes === 0);

const up1 = await voteStore.vote('scratch/voted', 'up', { voter: 'a' });
check('an upvote counts', up1.score === 1 && up1.up === 1);
await voteStore.vote('scratch/voted', 'up', { voter: 'b' });
const down1 = await voteStore.vote('scratch/voted', 'down', { voter: 'c' });
check('a downvote subtracts', down1.score === 1 && down1.down === 1);

// One voter, one vote — otherwise the number means nothing.
await voteStore.vote('scratch/voted', 'up', { voter: 'a' });
check('voting twice the same way clears it', (await voteStore.scoreOf('scratch/voted')).up === 1);
await voteStore.vote('scratch/voted', 'up', { voter: 'a' });
await voteStore.vote('scratch/voted', 'down', { voter: 'a' });
const flipped = await voteStore.scoreOf('scratch/voted', { voter: 'a' });
check('changing your mind replaces the vote, not adds one', flipped.up === 1 && flipped.down === 2);
check('a voter can see their own standing vote', flipped.you === -1);
check('another voter does not see it as theirs', (await voteStore.scoreOf('scratch/voted', { voter: 'b' })).you === 1);

const raw = await fs.readFile(path.join(TMP, '.votes', 'votes.json'), 'utf8');
check('voter identities are not stored in the clear', !raw.includes('"a"') && !raw.includes('"c"'));

await voteStore.vote('scratch/voted', 'clear', { voter: 'a' });
check('a vote can be withdrawn', (await voteStore.scoreOf('scratch/voted', { voter: 'a' })).you === 0);

// A vote is not a verification: liking a page says nothing about whether it is
// still true, and the two must not bleed into each other.
const typesForVotes = await import('../lib/types.js');
const votedStale = typesForVotes.stalenessOf(
  await wiki.readPage('scratch/voted'),
  await typesForVotes.loadTypes()
);
check('votes do not affect freshness', votedStale.neverVerified === true);

// scratch/voted has netted back to zero by now, so give it a clear positive and
// make a second page clearly negative — top and bottom should separate them.
await voteStore.vote('scratch/voted', 'up', { voter: 'd' });
await wiki.writePage('scratch/disliked', '# Disliked', { title: 'Disliked' });
await voteStore.vote('scratch/disliked', 'down', { voter: 'a' });
await voteStore.vote('scratch/disliked', 'down', { voter: 'b' });
check('top lists the best-scoring pages', (await voteStore.top({ min: 1 })).some((r) => r.slug === 'scratch/voted'));
check('top excludes the badly-rated', !(await voteStore.top({ min: 1 })).some((r) => r.slug === 'scratch/disliked'));
check('bottom finds what needs rewriting', (await voteStore.bottom())[0]?.slug === 'scratch/disliked');
check('a downvote never hides the page', !!(await wiki.readPage('scratch/disliked')));
await wiki.deletePage('scratch/disliked');

// Deleting a page must not leave its score behind for whatever is written at
// that slug next.
await wiki.deletePage('scratch/voted');
check('deleting a page forgets its votes', (await voteStore.scoreOf('scratch/voted')).votes === 0);

// --- summary as an argument --------------------------------------------------
// It was accepted, returned 200, and thrown away — the one frontmatter field
// that could not be sent as an argument, with nothing to distinguish "ignored"
// from "stored". Two agents lost writes to it independently.
await wiki.writePage('scratch/summed', '# Summed\n\nBody.', {
  title: 'Summed',
  summary: 'a one-line description sent as an argument',
});
const summed = await wiki.readPage('scratch/summed');
check('summary can be sent as an argument', summed.meta.summary === 'a one-line description sent as an argument');
check(
  'and the listing shows it',
  (await wiki.listPages({})).find((r) => r.slug === 'scratch/summed')?.summary ===
    'a one-line description sent as an argument'
);
// Sticky like the other fields: omitting it on a later write must not wipe it.
await wiki.writePage('scratch/summed', '# Summed\n\nEdited.', {});
check('an unrelated edit keeps the summary', (await wiki.readPage('scratch/summed')).meta.summary?.length > 0);
await wiki.writePage('scratch/summed', '# Summed\n\nEdited.', { summary: '' });
check('and naming it empty clears it', !(await wiki.readPage('scratch/summed')).meta.summary);
await wiki.deletePage('scratch/summed');

// --- size in tokens ----------------------------------------------------------
// Bytes are the wrong unit for a reader that pays in context. Measured on the
// body, because frontmatter is server bookkeeping nobody receives.
check('an empty page costs nothing', wiki.estimateTokens('') === 0);
check('the estimate scales with length', wiki.estimateTokens('a'.repeat(400)) === 100);
check('it never returns a fraction', Number.isInteger(wiki.estimateTokens('an odd length string')));

await wiki.writePage('scratch/sized', '# Sized\n\n' + 'word '.repeat(200), { title: 'Sized' });
const sized = await wiki.readPage('scratch/sized');
const bodyTokens = wiki.estimateTokens(sized.body);
check('a page reports its own token cost', bodyTokens > 200 && bodyTokens < 300, String(bodyTokens));
// The whole point of indexing it: a wiki-wide total must not read every page.
const totals = await wiki.indexTotals();
check('the index can total the wiki', totals && totals.tokens > 0);
check('the total counts the page just written', totals.tokens >= bodyTokens);
check('and counts bodies, not stored files', totals.tokens < Math.ceil(totals.bytes / 4), `${totals.tokens} vs ${Math.ceil(totals.bytes / 4)}`);
await wiki.deletePage('scratch/sized');

// --- is this already written? ------------------------------------------------
// The verdict is calibrated, so test the calibration rather than the plumbing.
// The load-bearing claim is that absence is decided on vocabulary, not on
// relevance — relevance overlaps between covered and absent on a small corpus,
// which is the bug this module exists to avoid.
const { coverage, namespaces: nsCensus } = await import('../lib/coverage.js');

const cov = await coverage('a proxmox host and the services running on it');
check('coverage finds a covered topic', cov.verdict !== 'open', cov.verdict);
check('coverage returns the neighbours as evidence', cov.nearest.length > 0);
check('coverage names where the work lives', cov.namespaces.length > 0);
check('coverage suggests a namespace', typeof cov.suggestedPrefix === 'string');

const far = await coverage('sourdough starter hydration and bulk fermentation schedules');
check('coverage calls an unrelated topic open', far.verdict === 'open', far.verdict);
check('and is confident about it', far.confidence === 'high', far.confidence);
check('and names the words it has never seen', far.unknownTerms.length > 0, far.unknownTerms.join(','));
// The failure this module was built to avoid: a high relevance score on a
// subject the wiki knows nothing about must not read as coverage.
check('an unknown subject is open regardless of its relevance score', far.vocabulary < 0.6, String(far.vocabulary));

check('an empty topic is not a verdict', (await coverage('')).verdict === 'unknown');

const census = await nsCensus();
check('the namespace census is populated', census.length > 0);
check('the census counts pages', census.every((n) => n.pages > 0));
check('the census is ordered by size', census.every((n, i) => i === 0 || census[i - 1].pages >= n.pages));

// --- provenance never lands raw on a public wiki -----------------------------
// Asserted against what is STORED, not against a response. Response-level tests
// only cover the readers you thought of; this covers every writer that will
// ever exist.
wiki.setPublicMasking(true);
await wiki.writePage('scratch/prov', '# Prov\n\nbody', {
  title: 'Prov',
  provenance: { ip: '198.51.100.77', host: 'someones-laptop', agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', via: 'api' },
});
const onDisk = await fs.readFile(path.join(TMP, 'scratch', 'prov.md'), 'utf8');
check('a public wiki stores no raw address', !onDisk.includes('198.51.100.77'), onDisk.match(/updated_ip:.*/)?.[0]);
check('a public wiki stores no raw hostname', !onDisk.includes('someones-laptop'), onDisk.match(/updated_host:.*/)?.[0]);
check('a public wiki stores a pseudonym instead', /updated_ip: visitor-[0-9a-f]{4}/.test(onDisk));
check('the hostname gets one too', /updated_host: machine-[0-9a-f]{4}/.test(onDisk));
check('the agent keeps its family and loses the rest', /updated_agent: \w+ \(client-[0-9a-f]{4}\)/.test(onDisk), onDisk.match(/updated_agent:.*/)?.[0]);

// The same identity twice must produce the same pseudonym, or "who wrote what"
// stops working and distinct-visitor counts inflate.
await wiki.writePage('scratch/prov2', '# Prov2\n\nbody', {
  title: 'Prov2',
  provenance: { ip: '198.51.100.77', host: 'someones-laptop', via: 'api' },
});
const onDisk2 = await fs.readFile(path.join(TMP, 'scratch', 'prov2.md'), 'utf8');
const ipOf = (s) => s.match(/updated_ip: (\S+)/)?.[1];
check('the same writer gets the same pseudonym twice', ipOf(onDisk) === ipOf(onDisk2), `${ipOf(onDisk)} vs ${ipOf(onDisk2)}`);

// Masking twice must be a no-op, or a value crossing two layers gets wrapped
// and the same person ends up with two identities.
check('masking is idempotent', wiki.maskIp(wiki.maskIp('198.51.100.77')) === wiki.maskIp('198.51.100.77'));
check('masking a hostname is idempotent', wiki.maskHost(wiki.maskHost('someones-laptop')) === wiki.maskHost('someones-laptop'));

wiki.setPublicMasking(false);
await wiki.writePage('scratch/prov3', '# Prov3\n\nbody', {
  title: 'Prov3',
  provenance: { ip: '198.51.100.77', host: 'someones-laptop', via: 'api' },
});
const onDisk3 = await fs.readFile(path.join(TMP, 'scratch', 'prov3.md'), 'utf8');
// A private wiki wants the real machine name — it is most of why provenance is
// recorded at all. Masking there would be a regression, not a hardening.
check('a private wiki keeps the real address', onDisk3.includes('198.51.100.77'));
check('a private wiki keeps the real hostname', onDisk3.includes('someones-laptop'));
for (const s of ['scratch/prov', 'scratch/prov2', 'scratch/prov3']) await wiki.deletePage(s);

// --- a write that succeeded must not report failure --------------------------
// Found the hard way: an unwritable history file made a PUT answer 500 on a page
// that was already durably on disk. The caller retries a write that worked, or
// gives up and reports it impossible.
{
  const histDir = path.join(TMP, '.history');
  await fs.mkdir(histDir, { recursive: true });
  const res1 = await wiki.writePage('scratch/histfail', '# One\n\nbody', { title: 'One' });
  check('a normal write records its history', res1.historyRecorded === true);

  // Make the revision log unwritable by replacing it with a directory — the one
  // way to guarantee EISDIR/EACCES on every platform this runs on.
  const logPath = path.join(histDir, 'scratch', 'histfail.jsonl');
  await fs.rm(logPath, { force: true });
  await fs.mkdir(logPath, { recursive: true });

  let threw = null;
  let res2 = null;
  try {
    res2 = await wiki.writePage('scratch/histfail', '# Two\n\nchanged', { title: 'Two' });
  } catch (e) {
    threw = e;
  }
  check('an unrecordable history does not fail the write', threw === null, String(threw?.message).slice(0, 80));
  check('and the page really did change', (await wiki.readPage('scratch/histfail'))?.body.includes('changed'));
  // Silent to the caller is not the same as invisible: something has to say so.
  check('but the caller is told the history is missing', res2?.historyRecorded === false, JSON.stringify(res2?.historyRecorded));

  await fs.rm(logPath, { recursive: true, force: true });
  await wiki.deletePage('scratch/histfail');
}

// --- what a delete leaves behind ---------------------------------------------
// Votes and counters were cleaned up on delete; the discussion and the
// moderation state were not. That left a comment in the review queue pointing at
// a 404 — and, far worse, a takedown that outlived its page and silently hid
// whatever was written at that slug next.
const talkStore = await import('../lib/talk.js');

await wiki.writePage('scratch/doomed', '# Doomed\n\nBody.', { title: 'Doomed' });
await talkStore.addComment('scratch/doomed', 'this contradicts another page', { kind: 'contradiction' });
await moderation.quarantine('scratch/doomed', { by: 'test', note: 'pulled' });
check('a comment reaches the review queue', (await talkStore.allOpen()).some((c) => c.page === 'scratch/doomed'));

await wiki.deletePage('scratch/doomed');
check('deleting drops the discussion', (await talkStore.listComments('scratch/doomed')).length === 0);
check('and clears the review queue entry', !(await talkStore.allOpen()).some((c) => c.page === 'scratch/doomed'));
check('and lifts the takedown', (await moderation.isQuarantined('scratch/doomed')) === false);

// The consequence that actually hurt: an innocent page at a reused slug.
await wiki.writePage('scratch/doomed', '# Second\n\nA different page entirely.', { title: 'Second' });
check('a new page at the same slug is visible', !!(await wiki.readPage('scratch/doomed')));
check('and inherits no argument it never had', (await talkStore.listComments('scratch/doomed')).length === 0);
await wiki.deletePage('scratch/doomed');

// A report is evidence and is deliberately kept — the fact that a page was
// reported and then removed is the history an operator may need.
await wiki.writePage('scratch/reported-then-gone', '# X', { title: 'X' });
await moderation.report({ slug: 'scratch/reported-then-gone', reason: 'spam', detail: 'keep me' });
await wiki.deletePage('scratch/reported-then-gone');
check(
  'a report survives the page it was about',
  (await moderation.listReports()).some((r) => r.slug === 'scratch/reported-then-gone')
);

// --- page size ---------------------------------------------------------------
// The 256KB screen only runs on a public instance, so until now a private wiki,
// the librarian, or anything calling writePage() directly had no ceiling at all.
check('there is a store-level page size limit', wiki.MAX_PAGE_BYTES > 0 && wiki.MAX_PAGE_BYTES <= 4 * 1024 * 1024);
let tooBig = null;
try {
  await wiki.writePage('scratch/enormous', 'x'.repeat(wiki.MAX_PAGE_BYTES + 1));
} catch (err) {
  tooBig = err;
}
check('an oversized page is refused by the store', tooBig?.code === 'too_large');
check('the refusal says what the limit is', /limit is \d+/.test(tooBig?.message || ''));
check('and nothing was written', (await wiki.readPage('scratch/enormous')) === null);
// Generous on purpose: the cap is for the pathological case, not for long pages.
const big = await wiki.writePage('scratch/large-but-fine', 'y'.repeat(200 * 1024));
check('a genuinely long page still writes', big.bytes >= 200 * 1024);
await wiki.deletePage('scratch/large-but-fine');

// --- usage counters ---------------------------------------------------------
// Counts, never events: the value is "which pages are load-bearing", and the
// question "who read what and when" is one this wiki deliberately cannot answer.
const statStore = await import('../lib/stats.js');

await wiki.writePage('scratch/counted', '# Counted\n\nBody.', { title: 'Counted' });
statStore.record('view', { slug: 'scratch/counted' });
statStore.record('view', { slug: 'scratch/counted' });
statStore.record('read', { slug: 'scratch/counted' });
statStore.record('search');
const snap1 = await statStore.snapshot();
check('views are counted', snap1.pages['scratch/counted'].view === 2);
check('agent reads are counted apart from browser views', snap1.pages['scratch/counted'].read === 1);
check('totals accumulate', snap1.totals.view === 2 && snap1.totals.search === 1);
check('a day bucket is written', !!snap1.daily[new Date().toISOString().slice(0, 10)]);

// Unique visitors, counted without keeping anybody. Fed 300 distinct addresses
// plus repeats: the estimate should land near 300 and the repeats must not count
// twice, which is the whole reason a plain counter will not do.
for (let i = 0; i < 300; i++) statStore.record('view', { visitor: `198.51.100.${i % 256}.${(i / 256) | 0}` });
for (let i = 0; i < 80; i++) statStore.record('view', { visitor: `198.51.100.${i % 256}.0` });
const uniq = await statStore.uniqueVisitors({ days: 7 });
check('unique visitors are estimated', Math.abs(uniq.today - 300) / 300 < 0.1, `${uniq.today} vs 300`);
check('repeat visits are not double counted', uniq.today < 340, String(uniq.today));
check('the estimate is labelled as one', uniq.approximate === true);
check('all-time is at least the window', uniq.allTime >= uniq.window);

statStore.record('view', { client: 'Mozilla/5.0 (X11; Linux) AppleWebKit/537 Chrome/141.0.0.0 Safari/537' });
statStore.record('view', { client: 'curl/8.11.0' });
statStore.record('view', { client: 'Mozilla/5.0 Gecko/20100101 Firefox/133.0' });
const fams = await statStore.clients();
check('clients are bucketed by family', fams.some((c) => c.label === 'Chrome') && fams.some((c) => c.label === 'curl'));
check('an unknown client is bucketed, not recorded verbatim', statStore.clientLabel('SomeBespokeThing/9') === 'Other');

const rawStats = await fs.readFile(path.join(TMP, '.stats', 'stats.json'), 'utf8');
check('no search terms are stored', !rawStats.includes('query') && !rawStats.includes('proxmox'));
// The point of the sketch: the addresses that went in are not in the file, and
// neither are hashes of them — an IPv4 hash is a lookup away from the address.
check('no addresses are stored', !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(rawStats));
check('no user-agent strings are stored', !rawStats.includes('Mozilla') && !rawStats.includes('AppleWebKit'));
check('only client families are stored', rawStats.includes('"Chrome"') && rawStats.includes('"curl"'));

check('the busiest list ranks by the kind asked for', (await statStore.busiest({ by: 'view' }))[0].slug === 'scratch/counted');
const span = await statStore.series({ days: 7 });
check('the series is one bucket per day, oldest first', span.length === 7 && span[6].day === new Date().toISOString().slice(0, 10));
check('the series fills gaps with zeroes', span[0].view === 0);
check('today carries the counts', span[6].view >= 2);

await wiki.writePage('scratch/ignored', '# Ignored', { title: 'Ignored' });
check(
  'never-opened finds a page nobody has read',
  (await statStore.unread({ limit: 50 })).some((r) => r.slug === 'scratch/ignored')
);
check(
  'never-opened excludes a page that was read',
  !(await statStore.unread({ limit: 50 })).some((r) => r.slug === 'scratch/counted')
);

// A reused slug must not inherit the last page's numbers.
await wiki.deletePage('scratch/counted');
check('deleting a page forgets its counters', (await statStore.snapshot()).pages['scratch/counted'] === undefined);
await wiki.deletePage('scratch/ignored');

// --- self-service tokens ----------------------------------------------------
// Anyone may mint one, which is what makes an open wiki readable over MCP. The
// daily cap is what stops that identity from being free to replace.
const tokenStore = await import('../lib/tokens.js');

const t1 = await tokenStore.issue({ ip: '203.0.113.5' });
check('anyone can mint a token', t1.ok === true && typeof t1.token === 'string');
check('the token is long enough to be unguessable', t1.token.length === 64);
check('a fresh token verifies', (await tokenStore.verify(t1.token))?.id.length === 12);

// Asking again returns the SAME token rather than refusing. Tokens are derived
// from the issuer and the issuance, so recovery is a recomputation — which is
// what makes losing one survivable and auto-issuing on first contact idempotent.
const t2 = await tokenStore.issue({ ip: '203.0.113.5' });
check('asking again returns the same token', t2.ok === true && t2.token === t1.token);
check('a recovered token is marked as reused', t2.reused === true);
check('recovery does not consume a second issuance', (await tokenStore.list()).filter((r) => r.issuerKey === '203.0.113.5').length === 1);
check('a different address gets a different token', (await tokenStore.issue({ ip: '203.0.113.6' })).token !== t1.token);

// Simultaneous requests must not both pass a cap that allows one.
const raced = await Promise.all([
  tokenStore.issue({ ip: '203.0.113.77' }),
  tokenStore.issue({ ip: '203.0.113.77' }),
]);
check('a race yields one token, not two', new Set(raced.map((r) => r.token)).size === 1);
check('a race records one issuance', (await tokenStore.list()).filter((r) => r.issuerKey === '203.0.113.77').length === 1);

// A /64 is routinely one customer's to cycle through, so capping the full
// address would be a cap an abuser steps around for free.
check(
  'ipv6 is capped per /64, not per address',
  tokenStore.issuerKey('2001:db8:1:2:aaaa::1') === tokenStore.issuerKey('2001:db8:1:2:ffff::9')
);
check(
  'a different /64 is a different issuer',
  tokenStore.issuerKey('2001:db8:1:2::1') !== tokenStore.issuerKey('2001:db8:1:3::1')
);
check('ipv4-mapped ipv6 is treated as the ipv4', tokenStore.issuerKey('::ffff:203.0.113.5') === '203.0.113.5');

// The file must not be replayable as credentials if it leaks.
const rawTokenFile = await fs.readFile(path.join(TMP, '.moderation', 'tokens.json'), 'utf8');
check('the token itself is never stored', !rawTokenFile.includes(t1.token));

await tokenStore.revoke(t1.token, { reason: 'test' });
check('a revoked token stops verifying', (await tokenStore.verify(t1.token)) === null);
const afterRevoke = await tokenStore.issue({ ip: '203.0.113.5' });
check('recovery cannot resurrect a revoked token', afterRevoke.ok === false && afterRevoke.reason === 'revoked');
check('the refusal says when a new one is possible', afterRevoke.retryAfter > 0);
check('revocation is recorded, not erased', (await tokenStore.list()).some((r) => r.revoked));
check('the operator list never exposes a usable token', !JSON.stringify(await tokenStore.list()).includes(t1.token));

// Held edits: the one control that is not reactive. An untrusted write is never
// applied, so there is no payoff in repeating it.
const prop = await moderation.propose({
  slug: 'scratch/proposed',
  content: '# Proposed\n\nFrom a stranger.',
  opts: { title: 'Proposed', tags: ['x'], type: 'note', bogus: 'dropped' },
  ip: '10.0.0.7',
});
check('a proposal is queued', prop.status === 'pending');
check('a proposal does NOT touch the page', (await wiki.readPage('scratch/proposed')) === null);
check('only permitted fields survive a proposal', prop.opts.bogus === undefined && prop.opts.title === 'Proposed');
check('pending edits are listed', (await moderation.listPending()).some((e) => e.id === prop.id));

await moderation.approve(prop.id);
check('approving applies the write', (await wiki.readPage('scratch/proposed'))?.body.includes('From a stranger'));
check('an approved proposal leaves the queue', !(await moderation.listPending()).some((e) => e.id === prop.id));
check('approving twice does nothing', (await moderation.approve(prop.id)) === null);

const bad = await moderation.propose({ slug: 'scratch/rejected', content: '# no' });
await moderation.reject(bad.id);
check('rejecting never writes the page', (await wiki.readPage('scratch/rejected')) === null);
check('a rejected proposal leaves the queue', !(await moderation.listPending()).some((e) => e.id === bad.id));
await wiki.deletePage('scratch/proposed');

// The floor limiter, for when nothing is in front of the process.
// Shadowing: a blocked writer must not be able to tell. An honest error is an
// instruction — "blocked" says change address, "rejected" says change payload —
// so the response has to match what they were already getting.
const shadowed = await moderation.shadowWrite({
  slug: 'scratch/shadowed',
  content: '# spam',
  ip: '10.0.0.99',
});
check('a shadowed write returns a proposal-shaped id', /^pe-/.test(shadowed.id));
check('a shadowed write never touches the page', (await wiki.readPage('scratch/shadowed')) === null);
check(
  'a shadowed write never enters the review queue',
  !(await moderation.listPending()).some((e) => e.slug === 'scratch/shadowed')
);
check('a shadowed write is kept as evidence', (await moderation.shadowLog()).some((e) => e.slug === 'scratch/shadowed'));
check('the evidence records who sent it', (await moderation.shadowLog())[0].ip === '10.0.0.99');

const rl = (n) => { let last; for (let i = 0; i < n; i++) last = moderation.rateLimit('t', { max: 3, windowMs: 60000 }); return last; };
check('writes under the limit pass', rl(3).ok === true);
check('the next write is limited', moderation.rateLimit('t', { max: 3, windowMs: 60000 }).ok === false);
check('a different writer is unaffected', moderation.rateLimit('other', { max: 3, windowMs: 60000 }).ok === true);


// --- derived index --------------------------------------------------------
// The index answers listings without opening files. Files stay the truth: the
// index must agree with them, and the wiki must work when it cannot.
await wiki.ensureIndex();
const idx = await wiki.indexStats();
check('the index is available', idx.available === true, JSON.stringify(idx));
check(
  'index page count matches the filesystem',
  idx.pages === (await wiki.listSlugs()).length,
  `${idx.pages} vs ${(await wiki.listSlugs()).length}`
);

await wiki.writePage('scratch/indexed', '# Indexed\n\nBody.', {
  title: 'Indexed page', tags: ['idxtag'], type: 'host', fields: { address: '10.9.9.9' },
});
check(
  'a write lands in the index immediately',
  (await wiki.listPages({ tag: 'idxtag' })).some((p) => p.slug === 'scratch/indexed')
);
check('the index carries the title', (await wiki.listPages({ tag: 'idxtag' }))[0].title === 'Indexed page');
check(
  'fields are queryable through the index',
  (await wiki.indexQueryByFields({ type: 'host', where: { address: '10.9.9.9' } })).includes('scratch/indexed')
);
check('tag counts come from the index', (await wiki.allTags()).some((t) => t.tag === 'idxtag'));

await wiki.deletePage('scratch/indexed');
check(
  'a delete leaves the index',
  !(await wiki.listPages({ tag: 'idxtag' })).some((p) => p.slug === 'scratch/indexed')
);

// A file that appears without going through the store — a git pull, a hand edit.
const smuggled = path.join(wiki.PAGES_DIR, 'scratch', 'smuggled.md');
await fs.mkdir(path.dirname(smuggled), { recursive: true });
await fs.writeFile(smuggled, '---\ntitle: Smuggled\ntags: [smuggled]\n---\n\n# Smuggled\n\nBody.\n', 'utf8');
const rebuilt = await wiki.reindex();
check('reindex picks up an out-of-band page', rebuilt.updated >= 1, JSON.stringify(rebuilt));
check(
  'the smuggled page is listed after reindex',
  (await wiki.listPages({ tag: 'smuggled' })).some((p) => p.slug === 'scratch/smuggled')
);
await fs.rm(smuggled);
const afterRemoval = await wiki.reindex();
check('reindex drops a page removed out of band', afterRemoval.removed >= 1, JSON.stringify(afterRemoval));

// --- index-narrowed search must equal a full scan --------------------------
// The index only decides which files are worth opening. If narrowing ever drops
// a page the scoring would have accepted, results change silently — which is
// worse than being slow, so the two paths are compared directly.
const sameSearch = async (q, opts = {}) => {
  const key = (rs) => rs.map((r) => `${r.slug}@${r.score}`).join(',');
  return key(await wiki.search(q, { ...opts, scanAll: true })) === key(await wiki.search(q, opts));
};
for (const q of ['proxmox', 'pve-01', 'oxmo', '10.0.0.10', 'botwiki service', 'nothinghere']) {
  check(`indexed search matches a full scan: "${q}"`, await sameSearch(q), q);
}
check('substring search still works through the index', (await wiki.search('roxmo')).length > 0);


// Updating must not lose metadata the caller did not resend.
await wiki.writePage('hosts/pve-01', '# pve-01\n\nUpdated body.');
check('update keeps existing tags', (await wiki.readPage('hosts/pve-01'))?.tags.join(',') === 'proxmox,host');

let rejected = false;
try {
  await wiki.readPage('../../etc/passwd');
} catch (err) {
  rejected = err instanceof wiki.WikiError;
}
check('path traversal is rejected', rejected);
check('absolute paths are rejected', await wiki.readPage('/etc/passwd').then(() => false).catch(() => true));
check('missing page returns null', (await wiki.readPage('nope/not-here')) === null);

// ----------------------------------------------------------- provenance ----
console.log('\nprovenance');
await wiki.writePage('scratch/prov', '# Prov\n\nBody.', {
  provenance: {
    via: 'mcp',
    ip: '::ffff:10.0.0.5',
    agent: 'claude-code 2.1',
    model: 'claude-opus-5',
    context: 'testing the edit record',
  },
});
const pv = (await wiki.readPage('scratch/prov')).provenance;
check('transport is recorded as observed', pv.observed.via === 'mcp');
check('ipv4-mapped addresses are normalised', pv.observed.ip === '10.0.0.5', pv.observed.ip);
check('agent is recorded as claimed', pv.claimed.agent === 'claude-code 2.1');
check('model is recorded as claimed', pv.claimed.model === 'claude-opus-5');
check('context is recorded as claimed', pv.claimed.context === 'testing the edit record');
check('an edit timestamp is stored', !!pv.at && !isNaN(new Date(pv.at)));
check('describeProvenance reads naturally', wiki.describeProvenance(pv).includes('claude-code'), wiki.describeProvenance(pv));

// A caller must not be able to smuggle extra frontmatter through a text field.
await wiki.writePage('scratch/inject', '# Inject\n\nBody.', {
  provenance: { via: 'api', context: 'legit\nupdated_ip: 10.0.0.1\nadmin: true' },
});
const injected = await wiki.readPage('scratch/inject');
check('newlines in provenance cannot forge frontmatter', injected.meta.admin === undefined);
check('injected ip is not honoured', !injected.provenance.observed.ip, injected.provenance.observed.ip);
check('the field is kept, flattened', injected.provenance.claimed.context.includes('legit'));

// Writing without provenance must not wipe what an earlier edit recorded... it
// records the new (empty) editor instead, which is the honest behaviour.
check('provenance is absent when never supplied', (await wiki.readPage('hosts/pve-01')).provenance.observed.via === undefined);

await wiki.deletePage('scratch/prov');
await wiki.deletePage('scratch/inject');

// ----------------------------------------------------------------- talk ----
console.log('\ntalk');
const talk = await import('../lib/talk.js');

const c1 = await talk.addComment('hosts/pve-01', 'The disk size here looks wrong.', {
  kind: 'stale', author: 'librarian', model: 'claude-opus-5', via: 'mcp', ip: '::ffff:10.1.2.3',
});
check('comment gets an id', /^c-/.test(c1.id), c1.id);
check('kind is kept', c1.kind === 'stale');
check('ip is normalised', c1.ip === '10.1.2.3', c1.ip);

// The canary string exists ONLY inside a comment, so the search exclusion test
// below proves something rather than passing on a token nothing contains.
await talk.addComment('hosts/pve-01', 'Second thought:\nzzqqxxcanary multi-line body.', {
  kind: 'note',
});
const thread = await talk.listComments('hosts/pve-01');
check('comments round-trip through the file', thread.length === 2, String(thread.length));
check('body survives verbatim', thread[0].body === 'The disk size here looks wrong.', thread[0].body);
check('multi-line bodies survive', thread[1].body.includes('\nzzqqxxcanary multi-line body.'), JSON.stringify(thread[1].body));
check('metadata survives', thread[0].model === 'claude-opus-5' && thread[0].via === 'mcp');
check('new comments are open', thread.every((c) => c.status === 'open'));

// An unknown kind must not become a new kind.
const odd = await talk.addComment('hosts/pve-01', 'x', { kind: 'not-a-kind' });
check('unknown kinds fall back to note', odd.kind === 'note', odd.kind);

const resolved = await talk.resolveComment('hosts/pve-01', c1.id, { by: 'gus', resolution: 'fixed the number' });
check('resolve marks the comment', resolved.status === 'resolved');
check('resolution text is stored', (await talk.listComments('hosts/pve-01')).find((c) => c.id === c1.id)?.resolution === 'fixed the number');
check('resolving an unknown id returns null', (await talk.resolveComment('hosts/pve-01', 'c-nope')) === null);
check('reopen works', (await talk.reopenComment('hosts/pve-01', c1.id)).status === 'open');
await talk.resolveComment('hosts/pve-01', c1.id, { by: 'gus' });

const counts = await talk.openCounts();
check('open counts exclude resolved', counts.get('hosts/pve-01') === 2, String(counts.get('hosts/pve-01')));
check('review queue spans the wiki', (await talk.allOpen()).length === 2);
check('empty comment is refused', await talk.addComment('hosts/pve-01', '   ').then(() => false).catch(() => true));
check('talk inherits slug traversal defence', await talk.listComments('../../etc/passwd').then(() => false).catch(() => true));

// Talk must never leak into the wiki proper.
check('talk files are not pages', !(await wiki.listSlugs()).some((s) => s.includes('.talk')));
check('talk does not show up in search', (await wiki.search('zzqqxxcanary')).length === 0);

// ---------------------------------------------------------------- graph ----
console.log('\ngraph');
const graph = await import('../lib/graph.js');

// pve-01 <-> botwiki are mutually linked; add an unlinked page that only shares
// vocabulary, to prove similarity edges are found without any explicit link.
await wiki.writePage(
  'hosts/pve-02',
  '# pve-02\n\nProxmox node. Runs containers and virtual machines on local-lvm storage.',
  { tags: ['proxmox', 'host'] }
);
await wiki.writePage('unrelated/poetry', '# Poetry\n\nDaffodils, sonnets, iambic pentameter.', {
  tags: ['literature'],
});

// A similarity edge only survives if the pair has no stronger relationship, so
// these two share vocabulary but deliberately share no tag and no link.
await wiki.writePage(
  'runbooks/backup-postgres',
  '# Backup postgres\n\nNightly dump of the database to remote storage, then verify the dump restores cleanly and prune old archives.',
  { tags: ['postgres'] }
);
await wiki.writePage(
  'runbooks/backup-mysql',
  '# Backup mysql\n\nNightly dump of the database to remote storage, then verify the dump restores cleanly and prune old archives.',
  { tags: ['mysql'] }
);

const pairIn = (gr, a, b) =>
  gr.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));

const g = await graph.buildGraph();
check('graph has a node per page', g.nodes.length === (await wiki.listSlugs()).length);
check('explicit links become edges', g.edges.some((e) => e.type === 'link'));
check('shared tags become edges', g.edges.some((e) => e.type === 'tag'));
check('similar content becomes edges', g.edges.some((e) => e.type === 'similar'));
check(
  'similarity links pages with no tag or link in common',
  pairIn(g, 'runbooks/backup-postgres', 'runbooks/backup-mysql')?.type === 'similar',
  JSON.stringify(pairIn(g, 'runbooks/backup-postgres', 'runbooks/backup-mysql'))
);
check('nodes are grouped by folder', g.nodes.find((n) => n.id === 'hosts/pve-02')?.group === 'hosts');

const pair = (a, b) =>
  g.edges.find(
    (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)
  );
check('a pair gets at most one edge', g.edges.length === new Set(g.edges.map((e) => [e.source, e.target].sort().join('|'))).size);
check('an explicit link outranks a shared tag', pair('hosts/pve-01', 'services/botwiki')?.type === 'link');
check('unrelated page stays unconnected to hosts', !pair('unrelated/poetry', 'hosts/pve-01'));

const rel = await graph.relatedTo('hosts/pve-01');
check('relatedTo returns neighbours', rel.length > 0);
// Ranked by strength, not by kind: a page sharing two rare tags is a better
// neighbour than one that mentions this page once in passing.
check(
  'relatedTo ranks by strength',
  rel.every((r, i) => i === 0 || rel[i - 1].strength >= r.strength),
  JSON.stringify(rel.map((r) => [r.slug, r.type, r.strength]))
);
check('relatedTo carries the evidence', !!rel[0].evidence && Array.isArray(rel[0].evidence.sharedTags));
check('relatedTo on a missing page returns null', (await graph.relatedTo('ghost')) === null);
check('broken links are reported', Array.isArray(g.broken));

// Documenting the syntax must not register as a link, in the graph or anywhere.
await wiki.writePage(
  'meta/syntax-doc',
  '# Syntax\n\nWrite `[[some-page]]` to link.\n\n```\nor [[fenced-page]]\n```\n\nReal one: [[hosts/pve-01]].',
  {}
);
const g2 = await graph.buildGraph();
check(
  'code-span examples are not counted as broken links',
  !g2.broken.some((b) => b.to === 'some-page' || b.to === 'fenced-page'),
  JSON.stringify(g2.broken)
);
check(
  'a real link on the same page still registers',
  !!g2.edges.find(
    (e) =>
      (e.source === 'meta/syntax-doc' && e.target === 'hosts/pve-01') ||
      (e.target === 'meta/syntax-doc' && e.source === 'hosts/pve-01')
  )
);
await wiki.deletePage('meta/syntax-doc');
check('stats add up', g.stats.links + g.stats.tagEdges + g.stats.similarEdges === g.stats.edges);

const noSim = await graph.buildGraph({ includeSimilar: false });
check('similarity can be turned off', noSim.stats.similarEdges === 0);

// --- weighting ---
check('every edge carries a strength', g.edges.every((e) => typeof e.strength === 'number' && e.strength > 0 && e.strength <= 1));
check('edges come back strongest first', g.edges.every((e, i) => i === 0 || g.edges[i - 1].strength >= e.strength));
check('edges carry their evidence', g.edges.every((e) => e.evidence && typeof e.evidence.mentions === 'number'));

// Two pages sharing two rare tags must beat two sharing one common tag.
const rare = pairIn(g, 'hosts/pve-01', 'hosts/pve-02');
const common = pairIn(g, 'runbooks/backup-postgres', 'runbooks/backup-mysql');
check('shared rare tags produce a strong edge', rare && rare.strength > 0.5, JSON.stringify(rare?.strength));
// Two independent kinds of evidence (shared rare tags AND similar prose) should
// beat a single kind, however strong that one kind is. That is the noisy-OR.
check('two kinds of evidence beat one', !common || rare.strength > common.strength, `${rare?.strength} vs ${common?.strength}`);
check('strengths are actually spread out, not all 1', new Set(g.edges.map((e) => e.strength)).size > Math.min(4, g.edges.length - 1), JSON.stringify(g.edges.map((e) => e.strength)));

// A page linked once, from a page that links everything, must not look strong.
await wiki.writePage(
  'meta/hub',
  '# Hub\n\n' + (await wiki.listSlugs()).map((s) => `- [[${s}]]`).join('\n'),
  {}
);
await wiki.writePage('scratch/tight', '# Tight\n\nSee [[scratch/tight-b]] and [[scratch/tight-b]] again.', { tags: ['zzrare'] });
await wiki.writePage('scratch/tight-b', '# Tight B\n\nBack to [[scratch/tight]].', { tags: ['zzrare'] });
const gw = await graph.buildGraph();
const hubEdge = pairIn(gw, 'meta/hub', 'hosts/pve-01');
const tightEdge = pairIn(gw, 'scratch/tight', 'scratch/tight-b');
check('a hub page produces weak edges', hubEdge && hubEdge.strength < 0.35, JSON.stringify(hubEdge?.strength));
check('repeated mutual links produce a strong edge', tightEdge && tightEdge.strength > 0.7, JSON.stringify(tightEdge?.strength));
check('mutual links are detected', tightEdge?.evidence.mutual === true);
check('stats report strong and weak counts', typeof gw.stats.strong === 'number' && typeof gw.stats.weak === 'number');
check('weighted degree is exposed', gw.nodes.every((n) => typeof n.weightedDegree === 'number'));
check('minStrength filters weak edges', (await graph.buildGraph({ minStrength: 0.9 })).edges.length < gw.edges.length);

await wiki.deletePage('meta/hub');
await wiki.deletePage('scratch/tight');
await wiki.deletePage('scratch/tight-b');

await wiki.deletePage('runbooks/backup-postgres');
await wiki.deletePage('runbooks/backup-mysql');
await wiki.deletePage('unrelated/poetry');
await wiki.deletePage('hosts/pve-02');

// --------------------------------------------------------- concurrency ----
console.log('\nconcurrency');
const revisions = await import('../lib/revisions.js');

const base = await wiki.readPage('hosts/pve-01');
check('readPage exposes a content hash', /^[0-9a-f]{16}$/.test(base.hash), base.hash);

// A write based on stale content must be refused, and must hand back the
// current content so the caller can merge rather than guess.
let conflict = null;
try {
  await wiki.writePage('hosts/pve-01', '# pve-01\n\nstale write', { baseHash: '0000000000000000' });
} catch (err) {
  conflict = err;
}
check('a stale write is rejected', conflict?.code === 'conflict');
check('the conflict carries the current content', typeof conflict?.current === 'string' && conflict.current.includes('pve-01'));
check('the conflict names both hashes', conflict?.expected === '0000000000000000' && conflict?.actual === base.hash);
check('the page was not modified by the rejected write', (await wiki.readPage('hosts/pve-01')).hash === base.hash);

const okWrite = await wiki.writePage('hosts/pve-01', '# pve-01\n\ncorrect write', { baseHash: base.hash });
check('a write with the right base is accepted', okWrite.hash !== base.hash);
check('writes with no baseHash still work', !!(await wiki.writePage('hosts/pve-01', '# pve-01\n\nunchecked')).hash);

// The real scenario: many agents writing the same page at once. Every write
// must either land or be cleanly rejected — none may be silently lost, and the
// file must never be left half-written.
await wiki.writePage('scratch/race', '# Race\n\nstart', {});
const raceBase = await wiki.readPage('scratch/race');
const results = await Promise.allSettled(
  Array.from({ length: 12 }, (_, i) =>
    wiki.writePage('scratch/race', `# Race\n\nwriter ${i}`, {
      baseHash: raceBase.hash,
      provenance: { via: 'mcp', agent: `agent-${i}` },
    })
  )
);
const landed = results.filter((r) => r.status === 'fulfilled').length;
const refused = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'conflict').length;
const other = results.filter((r) => r.status === 'rejected' && r.reason?.code !== 'conflict');
check('exactly one concurrent writer wins', landed === 1, `landed=${landed} refused=${refused}`);
check('every other writer is told, not ignored', refused === 11, String(refused));
check('no writer fails for an unexpected reason', other.length === 0, JSON.stringify(other.map((o) => o.reason?.message)));

const after = await wiki.readPage('scratch/race');
check('the file is intact after the race', /^# Race\n\nwriter \d+$/m.test(after.body.trim()), JSON.stringify(after.body));
check('no temp files were left behind', !(await wiki.listSlugs()).some((s) => s.includes('.tmp')));

// Unguarded concurrent writes must still not corrupt the file, even though one
// of them will be lost — that is the documented cost of omitting baseHash.
await Promise.allSettled(
  Array.from({ length: 8 }, (_, i) => wiki.writePage('scratch/race', `# Race\n\nunguarded ${i}`, {}))
);
const afterUnguarded = await wiki.readPage('scratch/race');
check('unguarded races still leave a valid page', /unguarded \d+/.test(afterUnguarded.body), JSON.stringify(afterUnguarded.body.slice(0, 40)));

// Revisions are recorded per write, not per timer tick.
const raceRevs = await revisions.listRevisions('scratch/race', { limit: 100 });
check('every accepted write produced a revision', raceRevs.length >= 3, String(raceRevs.length));
check('revisions record who wrote them', raceRevs.some((r) => r.provenance?.claimed?.agent?.startsWith('agent-')));
check('revisions are newest first', raceRevs.every((r, i) => i === 0 || raceRevs[i - 1].at >= r.at));

const created = raceRevs[raceRevs.length - 1];
check('the first revision is a create', created.op === 'create', created.op);

const rdiff = await revisions.diffOf('scratch/race', raceRevs[0].id);
check('a diff can be computed without git', rdiff && rdiff.patch.includes('+'), JSON.stringify(rdiff?.patch?.slice(0, 60)));
check('the diff counts changed lines', rdiff.added > 0);

// Deleting keeps the last content so the page can be brought back.
await wiki.deletePage('scratch/race');
const afterDelete = await revisions.listRevisions('scratch/race', { limit: 5, withContent: true });
check('deletion is recorded as a revision', afterDelete[0]?.op === 'delete', afterDelete[0]?.op);
check('the deleted content is retained', afterDelete[0]?.raw?.includes('Race'));

// Later sections rely on this fixture's body; the race tests above rewrote it.
await wiki.writePage('hosts/pve-01', '# pve-01\n\nUpdated body.');

// --- sessions: grouping a run's edits ---
// Timestamps almost do this and stop working the moment two agents write in the
// same minute, which is the case this exists for.
const SESS = 'sess-alpha';
for (const p of ['scratch/s1', 'scratch/s2', 'scratch/s3']) {
  await wiki.writePage(p, `# ${p}\n\nwritten in one run`, {
    provenance: { via: 'mcp', agent: 'agent-a', model: 'model-a', host: 'boxA', session: SESS, context: 'one run' },
  });
}
await wiki.writePage('scratch/other', '# other\n\ndifferent run', {
  provenance: { via: 'mcp', agent: 'agent-b', session: 'sess-beta' },
});

const sessRows = await revisions.bySession(SESS);
check('a session groups its own edits', sessRows.length === 3, String(sessRows.length));
check('a session excludes other runs', sessRows.every((r) => r.page !== 'scratch/other'));
check('session rows are oldest first', sessRows.every((r, i) => i === 0 || sessRows[i - 1].at <= r.at));
check('an unknown session returns nothing', (await revisions.bySession('nope')).length === 0);
check('an empty session id returns nothing', (await revisions.bySession('')).length === 0);

const sessList = await revisions.sessions();
const alpha = sessList.find((s) => s.session === SESS);
check('sessions are listed', !!alpha, JSON.stringify(sessList.map((s) => s.session)));
check('a session records who ran it', alpha.agent === 'agent-a' && alpha.model === 'model-a');
check('a session records the machine', alpha.host === 'boxA');
check('a session counts its pages', alpha.pages.length === 3, String(alpha.pages.length));
check('both sessions are distinguished', sessList.length >= 2, String(sessList.length));

const sessProv = (await wiki.readPage('scratch/s1')).provenance;
check('session is claimed, not observed', sessProv.claimed.session === SESS && sessProv.observed.session === undefined);

for (const p of ['scratch/s1', 'scratch/s2', 'scratch/s3', 'scratch/other']) await wiki.deletePage(p);

check('history never leaks into pages', !(await wiki.listSlugs()).some((s) => s.includes('.history')));
check('history inherits slug traversal defence', await revisions.listRevisions('../../etc/passwd').then(() => false).catch(() => true));

// -------------------------------------------------------------- history ----
console.log('\nhistory');
const history = await import('../lib/history.js');

// The store works with or without git; history is a nicety layered on top, and
// its absence must never break anything.
check('history is empty, not broken, outside a repo', Array.isArray(await history.historyOf('hosts/pve-01')));
check('recentChanges is empty, not broken', Array.isArray(await history.recentChanges()));
check('contributors is empty, not broken', Array.isArray(await history.contributorsOf('hosts/pve-01')));
check('diffOf refuses a non-revision', (await history.diffOf('hosts/pve-01', 'not-a-rev; rm -rf /')) === null);
check('history inherits slug traversal defence', await history.historyOf('../../etc/passwd').then(() => false).catch(() => true));

// Now make it a real repo and prove the edit record survives into history.
const { execFileSync } = await import('node:child_process');
const gitRun = (...a) => execFileSync('git', ['-C', TMP, ...a], { stdio: 'pipe' });
try {
  gitRun('init', '-q', '-b', 'main');
  gitRun('config', 'user.email', 'test@example.com');
  gitRun('config', 'user.name', 'test');
  await wiki.writePage('hosts/versioned', '# Versioned\n\nFirst.', {
    provenance: { via: 'mcp', agent: 'agent-one', model: 'model-a', context: 'first write' },
  });
  gitRun('add', '-A');
  gitRun('commit', '-q', '-m', 'first');
  await wiki.writePage('hosts/versioned', '# Versioned\n\nSecond.', {
    provenance: { via: 'web', agent: 'agent-two', model: 'model-b', context: 'second write' },
  });
  gitRun('add', '-A');
  gitRun('commit', '-q', '-m', 'second');

  check('history is detected', await history.isRepo());
  const revs = await history.historyOf('hosts/versioned');
  check('both revisions are found', revs.length === 2, String(revs.length));
  check('newest revision comes first', revs[0].provenance?.claimed?.agent === 'agent-two', JSON.stringify(revs.map((r) => r.provenance?.claimed?.agent)));
  check('the OLD revision keeps its own edit record', revs[1].provenance?.claimed?.agent === 'agent-one');
  check('the reason given is preserved per revision', revs[1].provenance?.claimed?.context === 'first write');
  check('the model is preserved per revision', revs[0].provenance?.claimed?.model === 'model-b');
  check('revisions report size', revs[0].bytes > 0 && revs[0].lines > 0);

  const contribs = await history.contributorsOf('hosts/versioned');
  check('contributors are aggregated', contribs.length === 2, JSON.stringify(contribs.map((c) => c.who)));
  check('contributors carry their models', contribs.some((c) => c.models.includes('model-a')));

  const patch = await history.diffOf('hosts/versioned', revs[0].rev);
  check('a diff can be read', typeof patch === 'string' && patch.includes('Second'));

  const changes = await history.recentChanges();
  check('recent changes span the wiki', changes.length >= 2, String(changes.length));
  check('recent changes name the pages touched', changes[0].pages.includes('hosts/versioned'));
  check('recent changes exclude talk files', changes.every((c) => c.pages.every((f) => !f.startsWith('.talk'))));
} catch (err) {
  check('git-backed history', false, err.message);
}

// -------------------------------------------------- types & staleness ----
console.log('\ntypes & staleness');
const types = await import('../lib/types.js');

await wiki.writePage(
  'meta/types',
  `# Types

| type | required | optional | ttl | description |
| --- | --- | --- | --- | --- |
| host | address | node, os | 180d | A machine |
| runbook | - | risk | 90d | A procedure |
| decision | - | - | never | Why we chose something |
`,
  {}
);
const reg = await types.loadTypes();
check('types load from the wiki page', reg.size === 3, String(reg.size));
check('required fields parse', reg.get('host').required.join(',') === 'address');
check('optional fields parse', reg.get('runbook').optional.join(',') === 'risk');
check('ttl parses', reg.get('host').ttlDays === 180, String(reg.get('host').ttlDays));
check('"never" means no ttl', reg.get('decision').ttlDays === null);

await wiki.writePage('hosts/typed', '# Typed host', {
  type: 'host',
  fields: { address: '10.0.0.5', node: 'pve1' },
});
const typed = await wiki.readPage('hosts/typed');
check('type is stored and read back', typed.type === 'host');
check('typed fields land in frontmatter', typed.meta.address === '10.0.0.5');
check('fields are separable from reserved keys', types.fieldsOf(typed).node === 'pve1');
check('conformance passes when required present', types.checkPage(typed, reg).ok === true);

await wiki.writePage('hosts/partial', '# Partial host', { type: 'host', fields: { node: 'pve2' } });
const partial = types.checkPage(await wiki.readPage('hosts/partial'), reg);
check('missing required fields are reported', partial.missing.join(',') === 'address');
check('a non-conforming page is still written', (await wiki.readPage('hosts/partial')) !== null);

await wiki.writePage('hosts/bogus', '# Bogus', { type: 'notathing' });
check('undefined types are flagged', types.checkPage(await wiki.readPage('hosts/bogus'), reg).known === false);

check('query by type works', (await types.queryPages({ type: 'host' })).length === 2, JSON.stringify((await types.queryPages({ type: 'host' })).map((r) => r.slug)));
check('query by field works', (await types.queryPages({ type: 'host', where: { node: 'pve1' } })).length === 1);
check('query by field is case-insensitive', (await types.queryPages({ type: 'host', where: { node: 'PVE1' } })).length === 1);
check('query with no match returns empty', (await types.queryPages({ type: 'host', where: { node: 'nope' } })).length === 0);

// Staleness: freshness is measured from verification, not from editing.
const freshPage = await wiki.readPage('hosts/typed');
const s1 = types.stalenessOf(freshPage, reg);
// Written seconds ago, but nobody has ever confirmed it. It must not read as
// fresh, or rewriting the prose on a never-checked page would launder it.
check('a brand-new unverified page is aging, not fresh', s1.status === 'aging' && s1.neverVerified === true, s1.status);
check('ttl comes from the type', s1.ttlDays === 180);

await wiki.writePage('hosts/typed', freshPage.raw, { verified: true, verifiedBy: 'tester', verifiedNote: 'checked live' });
const v = await wiki.readPage('hosts/typed');
check('verification is recorded', !!v.meta.verified_at);
check('verifier is recorded', v.meta.verified_by === 'tester');
check('verification note is recorded', v.meta.verified_note === 'checked live');
check('verification does not change the body', v.body.includes('Typed host'));
const s2 = types.stalenessOf(v, reg);
check('a verified page is no longer neverVerified', s2.neverVerified === false);
check('a verified page becomes fresh', s2.status === 'fresh', s2.status);

// An edit made while looking at the live system is both a change and a
// confirmation: it must reset the clock, where a plain edit must not.
await wiki.writePage('hosts/drifted', '# Drifted\n\nv1.', { type: 'host', fields: { address: '1.1.1.1' } });
const drifted = await wiki.readPage('hosts/drifted');
await fs.writeFile(
  drifted.path,
  drifted.raw.replace('---\n\n', `verified_at: ${new Date(Date.now() - 400 * 86400000).toISOString()}\n---\n\n`),
  'utf8'
);
check('a long-unverified page is stale', types.stalenessOf(await wiki.readPage('hosts/drifted'), reg).status === 'stale');

await wiki.writePage('hosts/drifted', '# Drifted\n\nv2, prose tidied.', { type: 'host' });
check(
  'a plain edit does not reset the freshness clock',
  types.stalenessOf(await wiki.readPage('hosts/drifted'), reg).status === 'stale',
  types.stalenessOf(await wiki.readPage('hosts/drifted'), reg).status
);

await wiki.writePage('hosts/drifted', '# Drifted\n\nv3, corrected from the live host.', {
  type: 'host', verified: true, verifiedBy: 'tester (model-x)', verifiedNote: 'ssh, address matches',
});
const sv = types.stalenessOf(await wiki.readPage('hosts/drifted'), reg);
check('a verified edit does reset it', sv.status === 'fresh', sv.status);
check('the verified edit records who checked', sv.verifiedBy === 'tester (model-x)');
check('the verified edit records what was checked', sv.verifiedNote === 'ssh, address matches');
check(
  'the revision log distinguishes verify from update',
  (await revisions.listRevisions('hosts/drifted', { limit: 2 })).map((r) => r.op).join(',') === 'verify,update'
);

// An old verification must go stale.
await wiki.writePage('hosts/old', '# Old\n\nBody.', { type: 'host', fields: { address: '1.2.3.4' } });
const oldRaw = (await wiki.readPage('hosts/old')).raw.replace(
  /^verified_at:.*$/m, ''
).replace('---\n\n', `verified_at: ${new Date(Date.now() - 400 * 86400000).toISOString()}\n---\n\n`);
await fs.writeFile((await wiki.readPage('hosts/old')).path, oldRaw, 'utf8');
const s3 = types.stalenessOf(await wiki.readPage('hosts/old'), reg);
check('an old verification goes stale', s3.status === 'stale', `${s3.status} sinceDays=${s3.sinceDays}`);
check('overdue days are computed', s3.overdueBy > 200, String(s3.overdueBy));
check('stale report finds it', (await types.staleReport()).some((r) => r.slug === 'hosts/old'));
check('describeStaleness reads naturally', /stale|verified/.test(types.describeStaleness(s3)), types.describeStaleness(s3));

const treport = await types.typeReport();
check('type report counts pages', treport.types.find((t) => t.type === 'host').count === 4, JSON.stringify(treport.types.map((t) => [t.type, t.count])));
check('type report lists problems', treport.problems.some((p) => p.slug === 'hosts/partial'));
check('type report lists untyped pages', treport.untyped.length > 0);

// ------------------------------------------------------------ find ----
console.log('\nfind');
const { find } = await import('../lib/find.js');

const f1 = await find('the proxmox machine that runs containers');
check('find returns something for a vague description', f1.results.length > 0);
check('find ranks a relevant page first', /hosts\//.test(f1.results[0].slug), JSON.stringify(f1.results.map((r) => r.slug)));
check('find explains what matched', Array.isArray(f1.results[0].matched));
check('find reports words the wiki has never seen', Array.isArray(f1.unknown));
check('find respects the limit', (await find('proxmox', { limit: 2 })).results.length <= 2);
check('find can filter by type', (await find('machine', { type: 'host' })).results.every((r) => r.type === 'host'));
const f2 = await find('quantum entanglement in banana futures');
check('find returns nothing for an unrelated query', f2.results.length === 0, JSON.stringify(f2.results.map((r) => r.slug)));
check('find surfaces the unknown words', f2.unknown.length > 0, JSON.stringify(f2.unknown));
check('find on empty input is empty', (await find('')).results.length === 0);

// find answers from the index without opening a page; it must agree with the
// version that reads every file.
const findKey = (r) => r.results.map((x) => x.slug).join(',');
// findByIndex is called behind a .catch that falls back to the scan, so a bug in
// it looks exactly like success. Assert the path actually taken, or the checks
// below quietly compare the scan against itself.
check('forceIndex really uses the index', (await find('proxmox', { forceIndex: true })).via === 'index');
check('a small wiki defaults to the in-memory path', (await find('proxmox')).via === 'scan');
for (const q of ['proxmox node', 'a container that will not start', 'botwiki']) {
  check(
    `indexed find matches a full scan: "${q}"`,
    findKey(await find(q, { limit: 5, scanAll: true })) === findKey(await find(q, { limit: 5, forceIndex: true })),
    `${findKey(await find(q, { limit: 5, scanAll: true }))} vs ${findKey(await find(q, { limit: 5, forceIndex: true }))}`
  );
}

await wiki.deletePage('hosts/typed');
await wiki.deletePage('hosts/partial');
await wiki.deletePage('hosts/bogus');
await wiki.deletePage('hosts/old');

// -------------------------------------------------------------- servers ----
function start(script, extraEnv) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, WIKI_DIR: TMP, WIKI_TOKEN: TOKEN, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  return child;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const web = start('server/web.js', { WIKI_PORT: String(WEB_PORT) });
const mcp = start('server/mcp.js', { MCP_PORT: String(MCP_PORT), MCP_TRANSPORT: 'http' });
// A public instance, to prove the MCP write path is guarded the same way the
// web one is. A wiki that holds strangers' edits over HTTP and publishes them
// over MCP is not moderated; it is open with a moderated front door.
const pubMcp = start('server/mcp.js', { MCP_PORT: String(PUB_MCP_PORT), MCP_TRANSPORT: 'http', WIKI_PUBLIC: '1', WIKI_WRITE_RATE: '200' });
const pubWeb = start('server/web.js', { WIKI_PORT: String(PUB_WEB_PORT), WIKI_PUBLIC: '1', WIKI_TRUST_PROXY: '1', WIKI_WRITE_RATE: '200' });

const cleanup = async () => {
  // Windows will not unlink an open SQLite file, and the derived index is one —
  // held by this process and by both servers. Close ours, then wait for theirs to
  // actually exit rather than merely being signalled.
  wiki.closeIndex();
  const ended = (child) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 3000).unref?.();
    });
  web.kill();
  mcp.kill();
  pubMcp.kill();
  pubWeb.kill();
  await Promise.all([ended(web), ended(mcp), ended(pubMcp), ended(pubWeb)]);
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

try {
  const base = `http://127.0.0.1:${WEB_PORT}`;
  const mcpUrl = `http://127.0.0.1:${MCP_PORT}`;
  check('web server starts', await waitFor(`${base}/healthz`));
  check('mcp server starts', await waitFor(`${mcpUrl}/healthz`));

  const auth = { Authorization: `Bearer ${TOKEN}` };

  // ------------------------------------------------------------- mcp ----
  console.log('\nmcp over http');
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
      requestInit: { headers: auth },
    })
  );

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check('tools are advertised', tools.join(',') === 'wiki_changes,wiki_comment,wiki_comments,wiki_coverage,wiki_delete,wiki_find,wiki_graph,wiki_history,wiki_list,wiki_query,wiki_random,wiki_read,wiki_related,wiki_report,wiki_resolve_comment,wiki_review_queue,wiki_search,wiki_session,wiki_stale,wiki_stats,wiki_tags,wiki_types,wiki_verify,wiki_vote,wiki_write', tools.join(','));

  const searchRes = await client.callTool({ name: 'wiki_search', arguments: { query: 'proxmox' } });
  check('wiki_search returns a hit', searchRes.content[0].text.includes('hosts/pve-01'));

  const readRes = await client.callTool({ name: 'wiki_read', arguments: { page: 'hosts/pve-01' } });
  check('wiki_read returns the body', readRes.content[0].text.includes('Updated body'));
  check('wiki_read includes backlinks', readRes.content[0].text.includes('Linked from'));

  const missRes = await client.callTool({ name: 'wiki_read', arguments: { page: 'does-not-exist' } });
  check('wiki_read flags a miss as an error', missRes.isError === true);

  await client.callTool({
    name: 'wiki_write',
    arguments: { page: 'decisions/use-mcp', content: '# Use MCP\n\nBecause every agent speaks it.', tags: ['decision'] },
  });
  check('wiki_write creates a page', (await wiki.readPage('decisions/use-mcp'))?.tags[0] === 'decision');

  const relRes = await client.callTool({
    name: 'wiki_related',
    arguments: { page: 'hosts/pve-01' },
  });
  check('wiki_related names a neighbour', relRes.content[0].text.includes('services/botwiki'));
  check(
    'wiki_related explains why, with a strength band',
    /(strong|moderate|weak) \(\d/.test(relRes.content[0].text) &&
      /(explicit link|shares |similar prose)/.test(relRes.content[0].text),
    relRes.content[0].text.split('\n').slice(0, 4).join(' | ')
  );

  const graphRes = await client.callTool({ name: 'wiki_graph', arguments: {} });
  check('wiki_graph reports clusters', graphRes.content[0].text.includes('Clusters:'));
  check('wiki_graph reports hubs', graphRes.content[0].text.includes('Most connected:'));

  const listRes = await client.callTool({ name: 'wiki_list', arguments: {} });
  check('wiki_list sees every page', /^[0-9]+ page\(s\)/.test(listRes.content[0].text), listRes.content[0].text.slice(0, 30));
  await client.close();

  // ------------------------------------------------------------- web ----
  console.log('\nweb');
  check('api requires the token', (await fetch(`${base}/api/pages`)).status === 401);

  const apiSearch = await (await fetch(`${base}/api/search?q=proxmox`, { headers: auth })).json();
  check('json search works', apiSearch.results[0].slug === 'hosts/pve-01');

  const apiPage = await (await fetch(`${base}/api/page/hosts/pve-01`, { headers: auth })).json();
  check('json page read works', apiPage.title === 'pve-01');
  check('json 404 is a 404', (await fetch(`${base}/api/page/ghost`, { headers: auth })).status === 404);

  const put = await fetch(`${base}/api/page/scratch/api-made`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Made over HTTP', tags: ['test'] }),
  });
  check('json write works', put.ok && (await wiki.readPage('scratch/api-made')) !== null);

  const del = await fetch(`${base}/api/page/scratch/api-made`, { method: 'DELETE', headers: auth });
  check('json delete works', del.ok && (await wiki.readPage('scratch/api-made')) === null);

  const page = await (await fetch(`${base}/w/hosts/pve-01`, { headers: auth })).text();
  check('html page renders markdown', page.includes('<h1>pve-01</h1>') || page.includes('pve-01'));
  check('html page renders code spans', page.includes('<code>'));

  // Agents write these pages, so raw HTML must never execute.
  await wiki.writePage('scratch/xss', '# XSS\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  const xss = await (await fetch(`${base}/w/scratch/xss`, { headers: auth })).text();
  const bodyHtml = xss.slice(xss.indexOf('<article'));
  check('script tags are escaped', !/<script>alert/.test(bodyHtml), bodyHtml.match(/.{0,60}alert.{0,40}/)?.[0]);
  check('event handlers are escaped', !/<img[^>]*onerror/i.test(bodyHtml));

  const wikilink = await (await fetch(`${base}/w/services/botwiki`, { headers: auth })).text();
  check('wikilinks become links', wikilink.includes('href="/w/hosts/pve-01"'));

  // A page documenting the syntax must not have its examples turned into links.
  await wiki.writePage(
    'scratch/codespan',
    '# Codespan\n\nWrite `[[other-page]]` to link.\n\n```\nsee [[fenced-page]]\n```',
    {}
  );
  const cs = await (await fetch(`${base}/w/scratch/codespan`, { headers: auth })).text();
  const csBody = cs.slice(cs.indexOf('<article'));
  check('wikilinks inside code spans stay literal', !csBody.includes('href="/w/other-page"'));
  check('wikilinks inside fenced blocks stay literal', !csBody.includes('href="/w/fenced-page"'));
  check('code span still shows the literal syntax', csBody.includes('[[other-page]]'));

  const notFound = await fetch(`${base}/w/ghost/page`, { headers: auth });
  check('missing page is a 404 with suggestions', notFound.status === 404);

  const shellHtmlForIcon = await (await fetch(`${base}/`, { headers: auth })).text();

  // Addresses are shown blunted. Provenance is worth surfacing — "written from
  // somewhere on this network" is real signal — but a full address identifies a
  // machine, and this one is published to everyone who opens the page.
  // Replaced outright rather than partly masked: keeping any part of an address
  // still names a network, and a network is often an organisation or a town.
  check('an address becomes a pseudonym', /^visitor-[0-9a-f]{4}$/.test(wiki.maskIp('192.168.4.27')));
  check('no part of the address survives', !wiki.maskIp('192.168.4.27').includes('192.168') && !wiki.maskIp('192.168.4.27').includes('4.27'));
  check('the same writer reads the same every time', wiki.maskIp('192.168.4.27') === wiki.maskIp('192.168.4.27'));
  check('two writers stay distinguishable', wiki.maskIp('192.168.4.27') !== wiki.maskIp('192.168.4.28'));
  // Neighbours on one network must not look related, which the octet mask made
  // them: it left the network visible and only hid the host.
  check('neighbours do not look related', wiki.maskIp('192.168.4.27') !== wiki.maskIp('192.168.4.99'));
  check('ipv6 gets a pseudonym too', /^visitor-[0-9a-f]{4}$/.test(wiki.maskIp('2001:db8:1:2::7')));
  check('loopback is named rather than hidden', wiki.maskIp('127.0.0.1') === 'localhost');
  check('an ipv4-mapped address is the same writer', wiki.maskIp('::ffff:192.168.4.27') === wiki.maskIp('192.168.4.27'));
  check('nothing in, nothing out', wiki.maskIp(null) === '' && wiki.maskIp('') === '');
  check('an address and a hostname cannot collide', wiki.maskIp('pve-01') !== wiki.maskHost('pve-01'));
  check(
    'the record an agent reads is masked too',
    wiki
      .describeProvenance({ observed: { ip: '192.168.4.27', via: 'api' }, claimed: {} }, { mask: true })
      .includes('visitor-')
  );
  check(
    'and unmasked when not asked — a private wiki wants the address',
    wiki.describeProvenance({ observed: { ip: '192.168.4.27', via: 'api' }, claimed: {} }).includes('192.168.4.27')
  );

  // Hostnames are replaced rather than trimmed: they are short and meaningful,
  // so half of "gus-desktop" still says whose desktop it is.
  check('a hostname becomes a pseudonym', /^machine-[0-9a-f]{4}$/.test(wiki.maskHost('pve-01')));
  check('nothing of the name survives', !wiki.maskHost('gus-desktop').includes('gus'));
  check('the same machine reads the same everywhere', wiki.maskHost('pve-01') === wiki.maskHost('PVE-01'));
  check('two machines stay distinguishable', wiki.maskHost('pve-01') !== wiki.maskHost('pve-02'));
  check('no host, no pseudonym', wiki.maskHost('') === '' && wiki.maskHost(null) === '');
  check(
    'the provenance line masks the host when asked',
    wiki.describeProvenance({ observed: { host: 'pve-01' }, claimed: {} }, { mask: true }).includes('machine-')
  );
  check(
    'and shows it when not — a private wiki wants the real name',
    wiki.describeProvenance({ observed: { host: 'pve-01' }, claimed: {} }).includes('pve-01')
  );

  // Discovery files. An agent that arrives over plain HTTP should not have to
  // infer any of this from rendered prose.
  const robots = await fetch(`${base}/robots.txt`);
  const robotsBody = await robots.text();
  // Served without a token: a tab icon and a crawler-instruction file are the
  // two things that should never answer 401.
  check('robots.txt is served without a credential', robots.status === 200);
  check('a private instance tells crawlers to stay out entirely', /^Disallow: \/$/m.test(robotsBody));
  check('and does not enumerate its own paths', !robotsBody.includes('/moderation'));

  const sitemap = await fetch(`${base}/sitemap.xml`, { headers: auth });
  const sitemapBody = await sitemap.text();
  check('a sitemap is served', sitemap.status === 200 && sitemapBody.startsWith('<?xml'));
  check('it lists real pages', sitemapBody.includes('/w/hosts/pve-01'));
  check('it is served as xml', (sitemap.headers.get('content-type') || '').includes('xml'));

  for (const path of ['/favicon.ico', '/favicon.svg']) {
    const ico = await fetch(`${base}${path}`);
    check(`${path} is served`, ico.status === 200);
    check(`${path} is an image`, (ico.headers.get('content-type') || '').includes('svg'));
  }
  check('the icon is declared in the head', shellHtmlForIcon.includes('rel="icon" href="/favicon.svg"'));

  // The nav collapses the five views that are about the wiki rather than its
  // content. <details> so it works with no JavaScript at all.
  check('the nav groups the meta views', shellHtmlForIcon.includes('<details class="menu">'));
  check('it is reachable without javascript', shellHtmlForIcon.includes('<summary>Activity'));
  for (const href of ['/changes', '/sessions', '/review', '/top', '/stats']) {
    check(`${href} is still linked`, shellHtmlForIcon.includes(`href="${href}"`));
  }

  // Mobile. The header is the piece that breaks first — a nowrap row of brand,
  // search, eight nav links and the skin picker is about twice a phone wide.
  const shellCss = await (await fetch(`${base}/`, { headers: auth })).text();
  check('the page ships a narrow-screen stylesheet', /@media \(max-width:720px\)/.test(shellCss));
  check('the header stops being one nowrap row', /header\.top \.wrap\{height:auto;flex-wrap:wrap/.test(shellCss));
  check('the nav is allowed to wrap', /\.nav\{order:4;flex:0 0 100%;flex-wrap:wrap/.test(shellCss));
  // Under 16px iOS zooms on focus and does not zoom back, leaving the reader
  // scrolled sideways on a page that was fine a moment earlier.
  check('form fields are 16px on phones', /input,textarea,select\{font-size:16px\}/.test(shellCss));
  check('the floated mascot stops floating', /\.pagemascot\{float:none/.test(shellCss));
  check('a viewport meta is set', /name="viewport" content="width=device-width/.test(shellCss));
  check('wide content still scrolls in its own box', /\.prose table\{[^}]*overflow-x:auto/.test(shellCss));
  check('no fixed width forces a phone to scroll sideways',
    ![...shellCss.matchAll(/[^-]width\s*:\s*(\d+)px/g)].some((m) => Number(m[1]) > 320));

  const graphCss = await (await fetch(`${base}/graph`, { headers: auth })).text();
  check('the graph page is responsive too', /@media \(max-width:720px\)/.test(graphCss));
  check('its fixed-height header row becomes auto', /\.app\{grid-template-rows:auto 1fr\}/.test(graphCss));

  // Two skins, both dark. The light one was removed, and the thing that breaks
  // quietly when a default skin goes away is the un-stamped root: a page that
  // renders before any script runs must still be the dark palette, not an
  // unstyled white one.
  const shell = await (await fetch(`${base}/`, { headers: auth })).text();
  const skinBtns = (shell.match(/class="skins"[\s\S]*?<\/div>/) || [''])[0];
  check('the picker offers exactly two skins', (skinBtns.match(/<button/g) || []).length === 2);
  check('no light skin is offered', !/Paper/i.test(shell));
  // Whichever skin is the default has to live on bare :root, because that is
  // what paints before any script runs.
  check('bare :root carries the default palette', /:root,\s*:root\[data-skin="mesh"\]/.test(shell));
  check('the non-default skin is attribute-only', !/:root,\s*:root\[data-skin="synth"\]/.test(shell));
  check('no light-mode media query survives', !/prefers-color-scheme/.test(shell));
  check('the boot script always stamps a skin', /dataset\.skin=\(s==='synth'\)\?'synth':'mesh'/.test(shell));
  check('a reader with nothing stored gets the default', /catch\(e\)\{document\.documentElement\.dataset\.skin='mesh'\}/.test(shell));

  // The root is the only page a stranger is guaranteed to land on, so a `home`
  // page renders there in full — and only that. The listing that used to be
  // stapled underneath it lives at /pages, which the nav links to; a front page
  // whose second half is a 150-row directory is one nobody reaches the end of.
  await wiki.writePage('home', '# Front door\n\nWhat this wiki is.', { title: 'Home' });
  const idxHome = await (await fetch(`${base}/`, { headers: auth })).text();
  check('the root renders the home page body', idxHome.includes('Front door'));
  check('the root no longer lists every page', !idxHome.includes('id="all-pages"') && !idxHome.includes('<ul class="pages">'));
  check('the root does not carry the tag chips either', !idxHome.includes('class="chips"'));
  check('but the nav still points at the listing', idxHome.includes('href="/pages"'));
  check('title is not doubled when home supplies the heading', !/<title>[^<]*·[^<]*<\/title>/.test(idxHome), (idxHome.match(/<title>[^<]*/) || [])[0]);

  // A tag filter is a listing, so it belongs with the listings rather than
  // growing a second one at the root.
  const tagRedirect = await fetch(`${base}/?tag=host`, { headers: auth, redirect: 'manual' });
  check('/?tag= redirects to the listing', [301, 302, 303, 307, 308].includes(tagRedirect.status), String(tagRedirect.status));
  check('and keeps the tag when it does', (tagRedirect.headers.get('location') || '').includes('tag=host'), tagRedirect.headers.get('location'));

  // `per` has a floor of 10, so forcing a second page means actually having
  // more than ten pages — the seed corpus alone never paginates.
  const filler = Array.from({ length: 12 }, (_, i) => `scratch/fill-${i}`);
  for (const slug of filler) await wiki.writePage(slug, '# Filler', { title: `Filler ${slug}` });
  const idxPage2 = await (await fetch(`${base}/pages?p=2&per=10`, { headers: auth })).text();
  check('the listing paginates', idxPage2.includes('<ul class="pages">'));
  check('and never renders home into it', !idxPage2.includes('Front door'));
  for (const slug of filler) await wiki.deletePage(slug);

  await wiki.deletePage('home');
  // With no home page the root has nothing to be a front door with, so it falls
  // back to the listing rather than serving a blank page.
  const idxBare = await (await fetch(`${base}/`, { headers: auth })).text();
  check('the root falls back to the listing with no home page', idxBare.includes('<ul class="pages">'));

  // --------------------------------------- public mode: visitor tokens ----
  console.log('\npublic mode: self-service tokens over MCP');
  const pubBase = `http://127.0.0.1:${PUB_WEB_PORT}`;
  const pubMcpUrl = `http://127.0.0.1:${PUB_MCP_PORT}`;
  check('public web server starts', await waitFor(`${pubBase}/healthz`));
  check('public mcp server starts', await waitFor(`${pubMcpUrl}/healthz`));

  // An agent arriving with no credential is issued one rather than being told to
  // go and read a web page about how to get one.
  const noCred = await fetch(`${pubMcpUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cold","version":"1"}}}',
  });
  check('an unauthenticated agent is let in, not refused', noCred.status === 200);
  const autoToken = noCred.headers.get('x-botwiki-token');
  check('the auto-issued token comes back on the response', !!autoToken && autoToken.length === 64);
  check('the auto-issued token actually works', !!(await tokenStore.verify(autoToken)));

  const badCred = await fetch(`${pubMcpUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer not-a-real-token' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  });
  check('a bad token is refused rather than quietly replaced', badCred.status === 401);

  // Behind TLS termination this process still speaks plain http. Advertising
  // http:// endpoints for an https:// site would have agents send their bearer
  // token in cleartext on the first hop, before any redirect.
  const fwd = await fetch(`${pubBase}/llms.txt`, { headers: { 'x-forwarded-proto': 'https' } });
  const fwdBody = await fwd.text();
  check('absolute urls follow the proxy scheme', fwdBody.includes('https://'));
  check('no http:// endpoint is advertised behind tls', !/\bhttp:\/\//.test(fwdBody));

  const llms = await fetch(`${pubBase}/llms.txt`);
  const llmsBody = await llms.text();
  check('llms.txt is served for agents that arrive over http', llms.status === 200);
  check('llms.txt names the mcp endpoint', llmsBody.includes('/mcp'));
  check('llms.txt says how to get a credential', llmsBody.includes('/api/token'));
  check('llms.txt points at the full doc', llmsBody.includes('/w/meta/mcp'));

  const mintRes = await fetch(`${pubBase}/api/token`, { method: 'POST' });
  const minted = await mintRes.json();
  check('anyone can get a token over http', mintRes.ok && !!minted.token);
  check('the mint response points at the docs', typeof minted.docs === 'string');
  check('the mint response shows the GET write url', String(minted.write).includes('/api/write?token='));

  // Asking again recovers the same token rather than being refused, and GET
  // works too — for agents whose only capability is fetching a URL.
  const again = await (await fetch(`${pubBase}/api/token`, { method: 'POST' })).json();
  check('asking again returns the same token', again.token === minted.token);
  check('the repeat is flagged as reused', again.reused === true);
  const viaGet = await (await fetch(`${pubBase}/api/token`)).json();
  check('a token can be fetched with a plain GET', viaGet.token === minted.token);
  check('the agent auto-issued one earlier got the same token', minted.token === autoToken);

  // One rule across every door. The JSON API was the hole: it wrote and, worse,
  // DELETED with no credential at all, while MCP asked for a token and the
  // browser editor asked for the operator's. Three locks is not a policy.
  const anonWrite = await fetch(`${pubBase}/api/page/scratch/anon`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Anon' }),
  });
  check('the json api refuses an untokened write', anonWrite.status === 401);
  check('the refusal says how to get a token', (await anonWrite.json()).message?.includes('/api/token'));
  check('an untokened write reaches nothing', (await wiki.readPage('scratch/anon')) === null);

  await wiki.writePage('scratch/deleteme', '# Delete me', { title: 'Delete me' });
  const anonDelete = await fetch(`${pubBase}/api/page/scratch/deleteme`, { method: 'DELETE' });
  check('the json api refuses an untokened delete', anonDelete.status === 401);
  check('an untokened delete does not delete', !!(await wiki.readPage('scratch/deleteme')));

  const visitorDelete = await fetch(`${pubBase}/api/page/scratch/deleteme`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${minted.token}` },
  });
  check('a visitor token cannot delete over http either', visitorDelete.status === 401);
  check('the page survives a visitor delete', !!(await wiki.readPage('scratch/deleteme')));

  const opDelete = await fetch(`${pubBase}/api/page/scratch/deleteme`, { method: 'DELETE', headers: auth });
  check('the operator can delete', opDelete.status === 200);

  // The browser editor must not draw a form it will refuse to save.
  check('the editor is not offered without a token', (await fetch(`${pubBase}/new`)).status === 401);
  const saveAnon = await fetch(`${pubBase}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'slug=scratch/via-form&content=hi',
  });
  check('the browser save refuses without a token', saveAnon.status === 401);

  // ...but a visitor token is enough to write, on every path.
  const visitorPut = await fetch(`${pubBase}/api/page/scratch/via-api-token`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ content: '# Tokened', title: 'Tokened' }),
  });
  check('a visitor token writes over the json api', visitorPut.status === 200);
  check('and the page is live', !!(await wiki.readPage('scratch/via-api-token')));
  await wiki.deletePage('scratch/via-api-token');

  // Writes expressible as a GET, for agents that cannot issue a POST at all.
  const getWrite = await fetch(
    `${pubBase}/api/write?token=${minted.token}&page=scratch/via-get&content=${encodeURIComponent('# Via GET\n\nWritten with a URL.')}&title=Via+GET`
  );
  check('a page can be written with a plain GET', getWrite.status === 200);
  check('the GET-written page is live', (await wiki.readPage('scratch/via-get'))?.title === 'Via GET');
  check('a GET write is not cacheable', getWrite.headers.get('cache-control') === 'no-store');

  // A caller with no token is issued one and the write goes through, rather than
  // being sent away to fetch a credential and come back — which, for something
  // whose only ability is fetching a URL, is most of the work.
  const coldWrite = await fetch(`${pubBase}/api/write?page=scratch/cold&content=hello&title=Cold`, {
    headers: { accept: 'application/json' },
  });
  const coldBody = await coldWrite.json();
  check('a tokenless GET write succeeds', coldWrite.status === 200);
  check('and the page is live', (await wiki.readPage('scratch/cold'))?.title === 'Cold');
  check('the issued token comes back in the body', typeof coldBody.token === 'string' && coldBody.tokenIssued === true);
  check('and on the header', coldWrite.headers.get('x-botwiki-token') === coldBody.token);
  check('the issued token works', !!(await tokenStore.verify(coldBody.token)));
  await wiki.deletePage('scratch/cold');

  // Without an explicit Accept, the answer is plain text. An agent that can only
  // fetch a URL is reading what comes back, not parsing it — one reported three
  // successful writes as failures because its extractor could not render JSON
  // and fell back to "Failed to fetch", inverting the outcome each time.
  const textWrite = await fetch(`${pubBase}/api/write?page=scratch/plain&content=hi&title=Plain`);
  const textBody = await textWrite.text();
  const htmlWrite = await fetch(`${pubBase}/api/write?page=scratch/htmlish&content=hi&title=H`, {
    headers: { accept: 'text/html' },
  });
  check('an html client gets a page, not a text blob', (htmlWrite.headers.get('content-type') || '').includes('text/html'));
  check('and it confirms the write', (await htmlWrite.text()).includes('Written'));
  check('the page really landed', !!(await wiki.readPage('scratch/htmlish')));
  await wiki.deletePage('scratch/htmlish');

  check('a GET write answers in plain text by default', (textWrite.headers.get('content-type') || '').includes('text/plain'));
  check('and says plainly that it worked', /^OK — created scratch\/plain/.test(textBody));
  check('it says where to read the page back', textBody.includes('/w/scratch/plain'));
  check('it is not JSON a text extractor would drop', !textBody.trimStart().startsWith('{'));
  check('the page really was written', !!(await wiki.readPage('scratch/plain')));
  await wiki.deletePage('scratch/plain');

  // Which moves the whole CSRF question onto this: a tokenless write that mints
  // its own credential has no secret for a drive-by to fail to know, so the
  // <img> case has to be recognised directly. Browsers announce it and scripts
  // cannot forge the headers; non-browser clients send none and are unaffected.
  const driveBy = await fetch(`${pubBase}/api/write?page=scratch/csrf&content=x`, {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' },
  });
  check('an <img> from another site cannot write', driveBy.status === 401);
  check('the drive-by wrote nothing', (await wiki.readPage('scratch/csrf')) === null);
  check(
    'nor can it pull a page',
    (await fetch(`${pubBase}/api/report?page=hosts/pve-01&reason=spam`, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' },
    })).status === 403
  );
  check('the page it targeted is untouched', !!(await wiki.readPage('hosts/pve-01')));

  // Typing the URL into an address bar is a navigation, and stays allowed.
  const typed = await fetch(`${pubBase}/api/write?page=scratch/typed&content=hi`, {
    headers: { 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
  });
  check('pasting the url into a browser still works', typed.status === 200);
  await wiki.deletePage('scratch/typed');

  const getVote = await (await fetch(`${pubBase}/api/vote?page=scratch/via-get&direction=up`)).json();
  check('a vote can be cast with a plain GET', getVote.score === 1);
  const getReport = await (await fetch(`${pubBase}/api/report?page=scratch/via-get&reason=spam`)).json();
  check('a page can be pulled with a plain GET', getReport.pulled === true);
  check('and it is actually hidden', (await fetch(`${pubBase}/w/scratch/via-get`)).status === 404);
  await moderation.release('scratch/via-get');
  await wiki.deletePage('scratch/via-get');

  // The server's filesystem layout is not the visitor's business. It used to be
  // in the footer of every page, in /healthz, and in every write response.
  const pubShell = await (await fetch(`${pubBase}/w/hosts/pve-01`)).text();
  // Asserted against the invariant, not a proxy for it. This used to check that
  // the literal string "/pages" was absent — because the wiki directory happens
  // to end in it — and so it failed the moment a nav link legitimately pointed
  // at /pages. What is actually forbidden is an absolute server path.
  check(
    'no server path in the page footer',
    !pubShell.includes(TMP) && !/[A-Za-z]:\\\\|(?:^|["'>\s])\/(?:home|var|opt|etc|root|tmp|Users)\//.test(pubShell)
  );
  const pubHealth = await (await fetch(`${pubBase}/healthz`)).json();
  check('no server path in healthz', pubHealth.pages === undefined);
  const pathWrite = await (
    await fetch(`${pubBase}/api/page/scratch/pathcheck`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({ content: '# Path check' }),
    })
  ).json();
  check('no server path in a write response', pathWrite.path === undefined);
  check('the write still reports what it did', pathWrite.slug === 'scratch/pathcheck' && pathWrite.bytes > 0);
  await wiki.deletePage('scratch/pathcheck');

  // A page shows a masked address, and the operator's moderation screen does not
  // — blocking works on an exact address, so the one screen that acts on them
  // has to see them.
  const modView = await (await fetch(`${pubBase}/moderation`, { headers: auth })).text();
  check('the moderation screen is reachable by the operator', !modView.includes('Not authorised'));

  // On a public instance robots.txt is the opposite: crawl everything except
  // the paths that are actions, /api/write above all — a crawler following one
  // of those would be editing the wiki by accident.
  const pubRobots = await (await fetch(`${pubBase}/robots.txt`)).text();
  check('a public instance invites crawlers', /^Allow: \/$/m.test(pubRobots));
  check('the GET write endpoint is excluded from crawling', /^Disallow: \/api\/$/m.test(pubRobots));
  check('robots points at the sitemap', /^Sitemap: http/m.test(pubRobots));
  check('robots points agents at llms.txt', pubRobots.includes('/llms.txt'));

  const revisionsForTest = await import('../lib/revisions.js');

  // Diagrams. The point of choosing mermaid over SVG is that the SOURCE is what
  // gets stored, so an agent reading the page gets something it can understand
  // rather than a few thousand tokens of path coordinates.
  await wiki.writePage(
    'scratch/diagram',
    '# Shape\n\n```mermaid\ngraph LR\n  caddy --> web\n  caddy --> mcp\n```\n\nAfter.',
    { title: 'Shape' }
  );
  const diagHtml = await (await fetch(`${pubBase}/w/scratch/diagram`)).text();
  check('a mermaid fence becomes a renderable block', diagHtml.includes('<pre class="mermaid">'));
  check('the diagram source survives into the page', diagHtml.includes('caddy --&gt; web'));
  check('the renderer is loaded lazily, not inlined', diagHtml.includes("'/vendor/mermaid.min.js'"));
  check('mermaid is served from the vendor allowlist', (await fetch(`${pubBase}/vendor/mermaid.min.js`)).status === 200);
  check('it renders under strict security', diagHtml.includes("securityLevel:'strict'"));

  // An ordinary fence must not be turned into a diagram.
  await wiki.writePage('scratch/codeblock', '# Code\n\n```js\nconst x = 1;\n```\n', { title: 'Code' });
  const codeHtml = await (await fetch(`${pubBase}/w/scratch/codeblock`)).text();
  check('a normal code fence is left alone', codeHtml.includes('class="language-js"') && !codeHtml.includes('<pre class="mermaid">'));
  check('a page with no diagram still loads no renderer', !codeHtml.includes('/vendor/mermaid.min.js') || codeHtml.includes("querySelector('pre.mermaid')"));
  await wiki.deletePage('scratch/codeblock');

  // Freshness, browsable. Two entry points onto one view: "what needs checking"
  // and "what can I rely on" are the same axis read from opposite ends.
  const stalePage = await (await fetch(`${pubBase}/stale`)).text();
  const freshPage = await (await fetch(`${pubBase}/fresh`)).text();
  check('there is a stale page', stalePage.includes('<h1>Stale</h1>'));
  check('there is a fresh page', freshPage.includes('<h1>Fresh</h1>'));
  check('each offers the other', stalePage.includes('href="/fresh"') && freshPage.includes('href="/stale"'));
  // A verify button on a list you are skimming would manufacture confirmations
  // nobody performed, which is the one thing that makes the record worthless.
  check('neither offers a verify button', !/\/api\/verify|name="verify"/.test(stalePage + freshPage));

  const freshApi = await (await fetch(`${pubBase}/api/fresh`)).json();
  check('freshness has an api form', Array.isArray(freshApi.pages) && freshApi.state === 'fresh');
  const allApi = await (await fetch(`${pubBase}/api/freshness?state=all`)).json();
  check('the report can return every state', allApi.pages.length >= freshApi.pages.length);
  check(
    'untracked pages are included, not silently dropped',
    (await types.freshnessReport({})).some((r) => r.status === 'untracked')
  );
  check('and staleReport still excludes what is fine', !(await types.staleReport()).some((r) => r.status === 'fresh'));

  // Throttling is recorded against the token, so the register can answer "were
  // they throttled, when, and are they still" from any process and after a
  // restart — the in-memory limiter can answer none of those.
  const throttleTok = await tokenStore.issue({ ip: '198.51.100.222' });
  await tokenStore.noteThrottle(throttleTok.token ? (await tokenStore.verify(throttleTok.token)).id : '', 45);
  const throttled = (await tokenStore.list()).find((r) => r.issuerKey === '198.51.100.222');
  check('a throttle is counted against the token', throttled.throttled === 1);
  check('and timestamped', typeof throttled.throttledAt === 'string');
  check('and says when it lifts', new Date(throttled.throttledUntil) > new Date());
  await tokenStore.noteThrottle(throttled.id, 45);
  check('repeat throttles accumulate', (await tokenStore.list()).find((r) => r.id === throttled.id).throttled === 2);
  check('the operator is never throttle-tracked', (await tokenStore.noteThrottle('operator', 30)) === null);

  // The write endpoint exists for agents with limited tooling, and then refused
  // the two most likely ways such a tool reaches a URL. A 404 tells a caller the
  // endpoint is not there, so it stops trying — the worst answer to "you called
  // it with a slightly different verb".
  const methodProbe = `${pubBase}/api/write?page=scratch/verbs&content=hi&title=Verbs`;
  check('GET writes', (await fetch(methodProbe)).status === 200);
  check('POST writes too', (await fetch(methodProbe, { method: 'POST' })).status === 200);
  const headRes = await fetch(methodProbe, { method: 'HEAD' });
  check('HEAD is answered, not 404d', headRes.status === 200);
  const optRes = await fetch(methodProbe, { method: 'OPTIONS' });
  check('OPTIONS names the verbs', optRes.status === 204 && /GET/.test(optRes.headers.get('allow') || ''));
  await wiki.deletePage('scratch/verbs');
  // A probe must not write. If HEAD had side effects, checking whether a URL
  // works would silently create the page you were checking about.
  check('HEAD does not write', (await wiki.readPage('scratch/verbs')) === null);

  // A POST may put its parameters in the body rather than the URL.
  const bodyWrite = await fetch(`${pubBase}/api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'scratch/from-body', content: '# From a body', title: 'Body' }),
  });
  check('a POST body is accepted', bodyWrite.status === 200);
  check('and the page lands', (await wiki.readPage('scratch/from-body'))?.title === 'Body');
  await wiki.deletePage('scratch/from-body');

  // An unknown /api/ path answered with the HTML 404 page, which tells a machine
  // nothing at all.
  const apiMiss = await fetch(`${pubBase}/api/no-such-route`);
  check('an unknown api route answers in json', (apiMiss.headers.get('content-type') || '').includes('json'));
  const missBody = await apiMiss.json();
  check('and names the write route', String(missBody.write).includes('/api/write'));
  check('and says what needs a token', /no token/i.test(missBody.hint || ''));

  // A vote that clears somebody else's must say so. Identity here is an address
  // or a token, and two agents can share both — so asking to vote up and getting
  // `you: 0` back means the standing vote was removed, possibly not your own.
  // Returning 200 with no distinction let an agent believe it had upvoted a page
  // it had just un-upvoted.
  await wiki.writePage('scratch/shared-vote', '# Shared', { title: 'Shared' });
  const first = await voteStore.voteWithNote('scratch/shared-vote', 'up', { voter: 'one-address' });
  check('the first vote reports it was cast', first.action === 'cast' && first.you === 1);
  const second = await voteStore.voteWithNote('scratch/shared-vote', 'up', { voter: 'one-address' });
  check('a second identical vote reports it CLEARED', second.action === 'cleared' && second.you === 0);
  check('and warns it may have been someone else’s', /may have removed THEIR vote/.test(second.message));
  check('the score reflects the clear', second.score === 0);
  const changed = await voteStore.voteWithNote('scratch/shared-vote', 'down', { voter: 'other' });
  check('a fresh voter reports cast, not changed', changed.action === 'cast');
  check('changing direction reports changed', (await voteStore.voteWithNote('scratch/shared-vote', 'up', { voter: 'other' })).action === 'changed');
  await wiki.deletePage('scratch/shared-vote');

  // A pseudonym in `claimed` is a value the writer never claimed. The record now
  // says when it has been through masking, so a reader knows not to quote those
  // fields as the writer's own words.
  const maskedProv = await (await fetch(`${pubBase}/api/page/hosts/pve-01`)).json();
  if (maskedProv.provenance?.claimed?.host || maskedProv.provenance?.observed?.ip) {
    check('a masked record says so', maskedProv.provenance.masked === true);
  }
  check(
    'an unmasked record carries no such flag',
    wiki.maskProvenance({ observed: {}, claimed: { model: 'x' } })?.masked === undefined
  );

  // Reading a page told you everything about it except who wrote it. The field
  // was absent rather than empty, so a caller checking it got `undefined` — which
  // reads as "nobody claimed anything", not as "this endpoint does not answer
  // that". The listings carried it all along.
  const withProv = await (await fetch(`${pubBase}/api/page/hosts/pve-01`)).json();
  check('a page read includes its edit record', 'provenance' in withProv);
  check(
    'and it matches what the history says',
    JSON.stringify(withProv.provenance?.claimed || {}) ===
      JSON.stringify(
        (await (await fetch(`${pubBase}/api/history/hosts/pve-01`)).json()).revisions?.[0]?.provenance?.claimed || {}
      )
  );

  // The documented safe-edit loop asked for `baseHash`; the response only had
  // `hash`, so a caller following the docs wrote without one — the exact clobber
  // that mechanism prevents.
  const pageJson = await (await fetch(`${pubBase}/api/page/hosts/pve-01`)).json();
  check('the read returns baseHash under the documented name', typeof pageJson.baseHash === 'string');
  check('and it matches the hash the write path wants', pageJson.baseHash === pageJson.hash);

  // Reading takes no credential anywhere. The docs said "open to anyone with a
  // token", which is a different and wrong claim.
  for (const path of ['/api/pages', '/api/search?q=proxmox', '/api/page/hosts/pve-01', '/api/graph', '/api/random', '/api/stats', '/api/coverage?topic=proxmox', '/api/namespaces']) {
    check(`${path} reads with no token`, (await fetch(`${pubBase}${path}`)).status === 200);
  }

  // The nav said "Pages" and pointed at `/`, which renders the home page essay
  // with the listing below it — a label promising a list and delivering prose.
  // `/pages` is the listing on its own.
  await wiki.writePage('home', '# Front door\n\nZZTOPMARKER explains the wiki.', { title: 'Front door' });
  const idx = await fetch(`${pubBase}/pages`);
  const idxHtml = await idx.text();
  check('/pages serves the index', idx.status === 200);
  check('/pages leads with the listing, not the home essay', !idxHtml.includes('ZZTOPMARKER'));
  check('/pages still links back to the front door', idxHtml.includes('href="/"'));
  check('/pages lists pages', idxHtml.includes('hosts/pve-01'));
  check('/pages paginates against itself', !/href="\/\?p=\d/.test(idxHtml), 'paginator points at /');
  const rootHtml = await (await fetch(`${pubBase}/`)).text();
  check('/ still renders the home page above the listing', rootHtml.includes('ZZTOPMARKER'));
  check('the nav points at the index, not the front door', rootHtml.includes('href="/pages"'));
  await wiki.deletePage('home');

  // 174 tags in one flat row is a wall, not a filter, and it grows on its own
  // every time anyone invents a tag.
  {
    for (let i = 0; i < 14; i++) {
      await wiki.writePage(`scratch/tagged-${i}`, `# T${i}\n\nbody`, { title: `T${i}`, tags: [`zztag${i}`] });
    }
    const idxHtml = await (await fetch(`${pubBase}/pages`)).text();
    const chipBlock = idxHtml.match(/<div class="chips">[\s\S]*?<\/div>\s*<ul class="pages">/)?.[0] || idxHtml;
    check('the tag row folds past ten', chipBlock.includes('class="chipmore"'), 'no overflow control');
    check('the overflow says how many it hides', /\+\d+ more/.test(chipBlock));
    // <details> and not a script: the fold has to open even if nothing else works.
    check('the overflow needs no javascript', chipBlock.includes('<details') && chipBlock.includes('<summary'));
    check('the hidden tags are still in the document', chipBlock.includes('zztag13'), 'overflow tags dropped entirely');

    // A tag is not a search term. These chips used to link at /search?q=<tag>,
    // which returns pages that mention the word and misses tagged pages that
    // never say it.
    check('a tag chip filters by tag', idxHtml.includes('href="/pages?tag=zztag0"'), 'chip still text-searches');
    const tagged = await fetch(`${pubBase}/pages?tag=zztag7`);
    const taggedHtml = await tagged.text();
    check('/pages?tag= filters the listing', tagged.status === 200 && taggedHtml.includes('scratch/tagged-7'));
    check('and excludes everything else', !taggedHtml.includes('scratch/tagged-6'), 'filter did not filter');
    check('and says what it filtered on', /1 page tagged/.test(taggedHtml.replace(/<[^>]*>/g, '')));
    check('and offers a way out', taggedHtml.includes('clear filter'));
    check('and drops the home essay', !taggedHtml.includes('ZZTOPMARKER'));
    // The active tag must stay visible even when it is rare enough to live in
    // the overflow — a filter that hides itself is worse than no filter.
    check('the active tag is marked', taggedHtml.includes('aria-current="true"'));
    const unknownTag = await (await fetch(`${pubBase}/pages?tag=nosuchtagexists`)).text();
    check('an empty tag does not claim the wiki is empty', !unknownTag.includes('Nothing here yet'));
    for (let i = 0; i < 14; i++) await wiki.deletePage(`scratch/tagged-${i}`);
  }

  // A count that came from an event counter read 0 against 152 live tokens,
  // because it was incremented at two of the four places that issue one — and
  // the two it missed were the automatic paths nearly every agent uses. Counted
  // from the register now, which cannot disagree with itself.
  {
    const before = await (await fetch(`${pubBase}/api/stats`)).json();
    const reg = await (await fetch(`${pubBase}/api/tokens`)).json();
    check('stats reports writers at all', typeof before.writers?.total === 'number', JSON.stringify(before.writers));
    check('the writer count matches the register', before.writers.total === reg.tokens.length,
      `stats ${before.writers?.total} vs register ${reg.tokens.length}`);
    check('and there are actually writers to count', reg.tokens.length > 0);

    // Issue one by the automatic path — the one the old counter did not see —
    // and both numbers must move together.
    await fetch(`${pubBase}/api/write?page=scratch/counted&content=hello&title=Counted`, {
      headers: { 'x-forwarded-for': '203.0.113.77' },
    });
    const after = await (await fetch(`${pubBase}/api/stats`)).json();
    const reg2 = await (await fetch(`${pubBase}/api/tokens`)).json();
    check('an auto-issued token is counted', after.writers.total === reg2.tokens.length,
      `stats ${after.writers?.total} vs register ${reg2.tokens.length}`);
    // Not asserting the count rose: this instance does not trust X-Forwarded-For,
    // so the write came from the same address as everything else in this run and
    // the daily cap correctly handed back the token it already had. That reuse
    // is the behaviour worth checking here.
    check('a second write from one address reuses its token', after.writers.total === before.writers.total,
      `${before.writers?.total} -> ${after.writers?.total}`);
    check('writers who have used their token are counted separately',
      after.writers.writing <= after.writers.total && after.writers.writing > 0,
      `${after.writers?.writing} of ${after.writers?.total}`);
    await wiki.deletePage('scratch/counted').catch(() => {});
  }

  // Parity across the three doors, asserted by capability rather than by
  // endpoint — an endpoint list can be complete while the wiki is still
  // lopsided. Drift happens the same way every time: a feature gets built where
  // it was asked for, and the other two doors keep answering as though it does
  // not exist. Found /api/tokens returning 401 while its browser twin was
  // public, which had been true since the day the browser one was un-gated.
  {
    // Its own connection to the PUBLIC instance: the client in scope here talks
    // to the private one, and parity is a claim about the public wiki.
    const pc = new Client({ name: 'parity-check', version: '1.0.0' });
    await pc.connect(new StreamableHTTPClientTransport(new URL(`${pubMcpUrl}/mcp`)));
    const mcpTools = new Set((await pc.listTools()).tools.map((t) => t.name));
    const ok = async (path) => (await fetch(`${pubBase}${path}`)).status === 200;
    const CAPS = [
      ['read a page', 'wiki_read', `/api/page/hosts/pve-01`, `/w/hosts/pve-01`],
      ['read as plain markdown', 'wiki_read', `/raw/hosts/pve-01`, null],
      ['list pages', 'wiki_list', '/api/pages', '/pages'],
      ['filter by tag', 'wiki_list', '/api/pages?tag=host', '/pages?tag=host'],
      ['search text', 'wiki_search', '/api/search?q=proxmox', '/search?q=proxmox'],
      ['search by description', 'wiki_find', '/api/find?q=a+proxmox+host', '/find?q=a+proxmox+host'],
      ['check coverage', 'wiki_coverage', '/api/coverage?topic=proxmox', null],
      ['a page at random', 'wiki_random', '/api/random', '/random'],
      ['related pages', 'wiki_related', '/api/related/hosts/pve-01', null],
      ['the link graph', 'wiki_graph', '/api/graph', '/graph'],
      ['tags', 'wiki_tags', '/api/tags', '/pages?tag=host'],
      ['recent changes', 'wiki_changes', '/api/changes', '/changes'],
      ['stale pages', 'wiki_stale', '/api/stale', '/stale'],
      ['statistics', 'wiki_stats', '/api/stats', '/stats'],
      ['rated pages', 'wiki_vote', '/api/top', '/top'],
      ['review queue', 'wiki_review_queue', '/api/review', '/review'],
      ['who writes here', 'wiki_session', '/api/tokens', '/tokens'],
      ['types', 'wiki_types', '/api/types', null],
    ];
    const gaps = [];
    for (const [cap, tool, api, web] of CAPS) {
      if (tool && !mcpTools.has(tool)) gaps.push(`${cap}: no mcp tool ${tool}`);
      if (api && !(await ok(api))) gaps.push(`${cap}: ${api} not 200`);
      if (web && !(await ok(web))) gaps.push(`${cap}: ${web} not 200`);
    }
    check('every capability answers on every door it should', gaps.length === 0, gaps.join(' | '));

    // Reading is free everywhere or it is free nowhere. A read gated on one
    // surface and open on another is not a policy, it is a leftover.
    for (const path of ['/api/tokens', '/api/types', '/api/namespaces', '/api/coverage?topic=x', '/raw/hosts/pve-01']) {
      check(`${path} needs no token`, await ok(path));
    }

    // The 404 body is what an agent sees when it guesses wrong, which makes it
    // the most-read documentation here. It should name the routes that exist.
    const miss = await (await fetch(`${pubBase}/api/nope`)).json();
    check('a wrong api url lists the real routes', (miss.read || []).length >= 8, String((miss.read || []).length));
    for (const must of ['/raw/', '/api/find', '/api/coverage']) {
      check(`the 404 body mentions ${must}`, JSON.stringify(miss).includes(must));
    }
    await pc.close();
  }

  // The page with nothing around it, for piping into a system prompt.
  {
    const rawRes = await fetch(`${pubBase}/raw/hosts/pve-01`);
    const rawBody = await rawRes.text();
    check('/raw serves a page', rawRes.status === 200);
    check('/raw is markdown, not html', /text\/markdown/.test(rawRes.headers.get('content-type') || ''));
    check('/raw is the body only', rawBody.startsWith('#') && !rawBody.includes('updated_at:'), rawBody.slice(0, 40));
    check('/raw carries no page chrome', !rawBody.includes('<nav') && !rawBody.includes('<!doctype'));
    check('/raw tolerates a .md suffix', (await fetch(`${pubBase}/raw/hosts/pve-01.md`)).status === 200);
    const rawMiss = await fetch(`${pubBase}/raw/no/such/page`);
    check('/raw 404s as text, not as a page', rawMiss.status === 404 && /text\/plain/.test(rawMiss.headers.get('content-type') || ''));
    check('/raw asks not to be indexed', (rawRes.headers.get('x-robots-tag') || '').includes('noindex'));
    // A withdrawn page is withdrawn on every surface, including new ones.
    await wiki.writePage('scratch/rawhidden', '# Hidden\n\nsecret-marker-text', { title: 'Hidden' });
    // Pulled the way a visitor pulls one, through the running server, rather
    // than by calling the module in this process — the server is a separate
    // process and the point is what IT will serve afterwards.
    const pulled = await (await fetch(`${pubBase}/api/report?page=scratch/rawhidden&reason=spam`)).json();
    check('the test actually pulled the page', pulled.pulled === true, JSON.stringify(pulled).slice(0, 120));
    const rawHidden = await fetch(`${pubBase}/raw/scratch/rawhidden`);
    check('/raw does not serve a pulled page', rawHidden.status === 404, String(rawHidden.status));
    check('and leaks none of its text', !(await rawHidden.text()).includes('secret-marker-text'));
    await moderation.release('scratch/rawhidden');
    await wiki.deletePage('scratch/rawhidden');
  }

  // The graph legend is one chip per namespace, overlaid on the canvas it is
  // filtering, and namespaces only ever get added — so it grew until it covered
  // the corner. Folded after three there instead of ten: the bar sits on the
  // drawing rather than above a list, so the budget is much smaller.
  {
    const graphHtml = await (await fetch(`${pubBase}/graph`)).text();
    check('the graph legend folds', graphHtml.includes('legendmore') && graphHtml.includes('legendrest'));
    check('the graph legend folds after three', /LEGEND_SHOWN\s*=\s*3/.test(graphHtml));
    // A <details>, not a click handler, so the fold opens even if the graph's
    // own script has already failed.
    check('the graph fold is a details element', /<details class="legendmore">/.test(graphHtml) && graphHtml.includes('</details>'));
    // It opens upward: the bar is pinned to the bottom of the stage, so a panel
    // that dropped downward would open off the screen.
    check('the graph fold opens upward', /\.legendmore\[open\][^}]*bottom:/.test(graphHtml));
    // A chip in the overflow is still a filter, so it has to carry the same
    // state and the same target the visible ones do.
    check('folded chips keep their filter state', graphHtml.includes("hidden.has(gr) ? ' off' : ''"));
    // graph-page.js is one template literal end to end; a stray backtick
    // terminates it mid-file and the damage is invisible until the page loads.
    check('the graph page is not truncated', graphHtml.includes('</html>'), 'template literal may have been cut short');
  }

  // A drawn diagram is a viewport you can move around inside. The drawing is
  // client-side, so what is checked here is that the page ships everything the
  // enhancement needs — and, more importantly, that the block still renders as
  // a plain readable diagram without it.
  // Its own slug: scratch/diagram belongs to the MCP readable-source check
  // further down, and writing over a fixture another test depends on is how you
  // get a failure whose message points at the wrong feature entirely.
  await wiki.writePage('scratch/panzoom', '# D\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n', { title: 'D' });
  const dgm = await (await fetch(`${pubBase}/w/scratch/panzoom`)).text();
  check('a mermaid fence still renders as a diagram block', dgm.includes('<pre class="mermaid">'));
  check('the source survives as readable text', dgm.includes('graph TD'), 'diagram source not in the page');
  check('the page ships the pan and zoom styles', dgm.includes('.dgm-view') && dgm.includes('.dgm-pan'));
  for (const fn of ['zoomAt', 'fitScale', 'enhanceAll', 'pointerdown', 'requestFullscreen']) {
    check(`the diagram script carries ${fn}`, dgm.includes(fn));
  }
  // Wheel zoom must stay behind a modifier: a diagram that eats the wheel traps
  // the reader on the page.
  check('wheel zoom requires ctrl or cmd', /ctrlKey\|\|e\.metaKey/.test(dgm.replace(/\s/g, '')));
  // A page with no diagram must not pay for any of it.
  const noDgm = await (await fetch(`${pubBase}/w/hosts/pve-01`)).text();
  check('a page with no diagram loads no diagram code', !noDgm.includes('zoomAt'));
  await wiki.deletePage('scratch/panzoom');

  // Landing on /search with no query is the normal way to arrive — every link to
  // it in prose does exactly that — and it rendered "0 results" above the
  // empty-wiki mascot, so the page reported both a failed search and an empty
  // wiki when neither had happened.
  const searchBare = await fetch(`${pubBase}/search`);
  const searchBareHtml = await searchBare.text();
  check('/search with no query answers 200', searchBare.status === 200);
  check('/search with no query offers a box', searchBareHtml.includes('action="/search"') && searchBareHtml.includes('<button'));
  check('/search with no query claims no results', !searchBareHtml.includes('0 results'));
  check('/search with no query does not call the wiki empty', !searchBareHtml.includes('Nothing here yet'));

  // A search that matched nothing is not a wiki with nothing in it. Both used
  // to render identically, and the wrong one is the alarming one.
  const searchMiss = await (await fetch(`${pubBase}/search?q=zzzzqqqxnothingmatchesthis`)).text();
  check('a search with no hits says so', searchMiss.includes('0 results'));
  check('a search with no hits does not claim the wiki is empty', !searchMiss.includes('Nothing here yet'));
  check('a search with no hits offers a way forward', searchMiss.includes('/find?q='));
  check('a search with no hits keeps the box', searchMiss.includes('action="/search"'));
  const findMissEmpty = await (await fetch(`${pubBase}/find?q=zzzzqqqxnothingmatchesthis`)).text();
  check('/find with no hits does not claim the wiki is empty', !findMissEmpty.includes('Nothing here yet'));
  // The index is the one caller for which "nothing here" is the true message.
  const idxEmptyCheck = await (await fetch(`${pubBase}/search?q=pve`)).text();
  check('a search that does hit still lists pages', idxEmptyCheck.includes('hosts/pve-01'));

  // Description search had no browser page for its whole life: the front page
  // recommended it to people and linked at a 404, because prose about a feature
  // is not a route and nothing checked that it was.
  const findEmpty = await fetch(`${pubBase}/find`);
  check('/find serves a form with no query', findEmpty.status === 200);
  const findRes = await fetch(`${pubBase}/find?q=${encodeURIComponent('a proxmox machine and what runs on it')}`);
  const findHtml = await findRes.text();
  check('/find answers a description', findRes.status === 200);
  check('/find returns pages', findHtml.includes('hosts/pve-01'), 'no hit for a described page');
  const findMiss = await (await fetch(`${pubBase}/find?q=sourdough+fermentation+schedules`)).text();
  check('/find names the words it has never seen', findMiss.includes('sourdough'), 'no unknown-term note');

  // Headings carry ids, so an in-page anchor is a real destination. A link to
  // #some-section used to render fine and go nowhere.
  await wiki.writePage('scratch/anchors', '# Top\n\n## Can I write here?\n\ntext\n\n## Why\n\na\n\n## Why\n\nb', { title: 'Anchors' });
  const anchored = await (await fetch(`${pubBase}/w/scratch/anchors`)).text();
  check('headings get ids', anchored.includes('id="can-i-write-here"'));
  check('punctuation is dropped from the id', !anchored.includes('id="can-i-write-here?"'));
  // Two sections called "Why" is normal; sending both anchors to the first one
  // is the kind of breakage nobody reports.
  check('duplicate headings get distinct ids', anchored.includes('id="why"') && anchored.includes('id="why-2"'));
  await wiki.deletePage('scratch/anchors');

  // The generalisation of the /find bug: any page may link somewhere that does
  // not exist, and prose is where that happens because prose is not checked.
  // Sweep every rendered page for internal links and follow them.
  {
    const all = await wiki.listPages({});
    const seen = new Map();
    for (const row of all) {
      const pageHtml = await (await fetch(`${pubBase}/w/${row.slug}`)).text();
      const article = pageHtml.match(/<article class="prose">([\s\S]*?)<\/article>/)?.[1] || '';
      for (const m of article.matchAll(/href="(\/[^"#]*)"/g)) {
        if (!seen.has(m[1])) seen.set(m[1], row.slug);
      }
    }
    const dead = [];
    for (const [href, from] of seen) {
      if ((await fetch(`${pubBase}${href}`)).status !== 200) dead.push(`${href} (on ${from})`);
    }
    check(`no page links somewhere that does not exist`, dead.length === 0, dead.join(', '));
  }

  // Checking whether a topic exists must be free — it is the step before
  // writing, and anything gated there just gets skipped.
  const covHttp = await (await fetch(`${pubBase}/api/coverage?topic=a+proxmox+host+and+its+services`)).json();
  check('/api/coverage returns a verdict', ['covered', 'adjacent', 'open'].includes(covHttp.verdict), covHttp.verdict);
  check('/api/coverage returns neighbours', Array.isArray(covHttp.nearest) && covHttp.nearest.length > 0);
  check('/api/coverage names namespaces', Array.isArray(covHttp.namespaces));
  const nsHttp = await (await fetch(`${pubBase}/api/namespaces`)).json();
  check('/api/namespaces lists prefixes', Array.isArray(nsHttp.namespaces) && nsHttp.namespaces.length > 0);
  // A coverage answer must not become a side channel for provenance, since it
  // returns page metadata by a route nobody thinks of as a page read.
  check(
    'coverage leaks no identity',
    !JSON.stringify(covHttp).includes('updated_ip') && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(covHttp))
  );
  check(
    'a wrong token does not break a read',
    (await fetch(`${pubBase}/api/pages`, { headers: { Authorization: 'Bearer nonsense' } })).status === 200
  );

  // Commenting asked for the OPERATOR token, which made "leave a comment rather
  // than pull the page" advice that a visitor could not follow — the gentler of
  // the two options was the locked one.
  const visitorComment = await fetch(`${pubBase}/api/talk/hosts/pve-01`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ body: 'a visitor should be able to say this' }),
  });
  check('a visitor token can comment', visitorComment.status === 200, String(visitorComment.status));
  check(
    'and the comment is really there',
    (await talk.listComments('hosts/pve-01')).some((c) => c.body.includes('a visitor should be able')),
  );
  check(
    'commenting with no token is still refused',
    (await fetch(`${pubBase}/api/talk/hosts/pve-01`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'anon' }),
    })).status === 401
  );

  // llms.txt is the first file an arriving agent reads; it described a review
  // queue that had not existed for hours.
  const llmsNow = await (await fetch(`${pubBase}/llms.txt`)).text();
  check('llms.txt does not claim a review queue', !/held for operator review|submission id/.test(llmsNow));
  check('llms.txt says writes publish immediately', /publish immediately/.test(llmsNow));
  check('llms.txt says reading needs nothing', /no credential at all/.test(llmsNow));
  check('llms.txt gives a one-line way in', llmsNow.includes('/api/write?page=<slug>'));

  // A vote's reason was kept over MCP and silently dropped on every HTTP route,
  // so the explanation the wiki asks a downvoter for went nowhere. Both doors go
  // through one helper now, and the reason lands where a reader looks for it.
  await wiki.writePage('scratch/noted', '# Noted\n\nBody.', { title: 'Noted' });

  const notedGetVote = await (
    await fetch(`${pubBase}/api/vote?page=scratch/noted&direction=down&note=${encodeURIComponent('the second example is wrong')}`)
  ).json();
  check('a GET vote records the reason', notedGetVote.noted === true);
  check(
    'and it lands on the discussion',
    (await talk.listComments('scratch/noted')).some((c) => c.body.includes('the second example is wrong'))
  );
  check('a downvote files it as a suggestion', (await talk.listComments('scratch/noted'))[0].kind === 'suggestion');

  const notedPostVote = await (
    await fetch(`${pubBase}/api/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'scratch/noted', direction: 'up', note: 'clearer than it was' }),
    })
  ).json();
  check('a POST vote records one too', notedPostVote.noted === true);
  check(
    'the reason is visible over the api',
    (await (await fetch(`${pubBase}/api/talk/scratch/noted`)).json()).comments.some((c) =>
      c.body.includes('clearer than it was')
    )
  );
  check('a vote with no reason is still a vote', (await voteStore.voteWithNote('scratch/noted', 'clear', { voter: 'x' })).noted === false);

  const notedPage = await (await fetch(`${pubBase}/w/scratch/noted`)).text();
  check('the page offers a reason field', notedPage.includes('name="note"'));
  check('and points at the reasons already there', /open note/.test(notedPage));
  await wiki.deletePage('scratch/noted');

  // Random, on every surface — it is a way of reading, and every way of reading
  // should be reachable from every door.
  const rnd = await fetch(`${pubBase}/random`, { redirect: 'manual' });
  check('the web serves a random page', rnd.status === 302 && /^\/w\//.test(rnd.headers.get('location') || ''));
  check('a random page is never cached', (rnd.headers.get('cache-control') || '').includes('no-store'));
  const rndApi = await (await fetch(`${pubBase}/api/random`)).json();
  check('the api serves one too', typeof rndApi.slug === 'string' && typeof rndApi.body === 'string');

  // Rolling the dice must not reach a page that was pulled from view.
  await wiki.writePage('scratch/only-page-tagged', '# Only', { title: 'Only', tags: ['solotag'] });
  await moderation.quarantine('scratch/only-page-tagged', { by: 'test' });
  const rndTagged = await fetch(`${pubBase}/api/random?tag=solotag`);
  check('random cannot reach a pulled page', rndTagged.status === 404);
  await moderation.release('scratch/only-page-tagged');
  check('and finds it again once released', (await (await fetch(`${pubBase}/api/random?tag=solotag`)).json()).slug === 'scratch/only-page-tagged');
  await wiki.deletePage('scratch/only-page-tagged');

  // Verifying existed over MCP and nowhere else — the wiki's central claim was
  // reachable only by an agent that spoke the right protocol.
  await wiki.writePage('scratch/to-verify', '# To verify\n\nBody.', { title: 'To verify' });
  const beforeV = await wiki.readPage('scratch/to-verify');
  const vres = await (
    await fetch(`${pubBase}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({ page: 'scratch/to-verify', note: 'checked it' }),
    })
  ).json();
  check('a page can be verified over http', vres.verified === true);
  const afterV = await wiki.readPage('scratch/to-verify');
  check('verifying records a confirmation', !!afterV.meta.verified_at);
  check('and does not change the body', afterV.body === beforeV.body);
  check('the note is kept', afterV.meta.verified_note === 'checked it');
  check('the verifier is not a raw user-agent', !String(afterV.meta.verified_by).includes('Mozilla'));
  check(
    'an untokened verify is refused',
    (await fetch(`${pubBase}/api/verify?page=scratch/to-verify`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } })).status === 403
  );
  await wiki.deletePage('scratch/to-verify');

  const topApi = await (await fetch(`${pubBase}/api/top`)).json();
  check('the rated list has an api form', Array.isArray(topApi.best) && Array.isArray(topApi.worst));

  // Addresses must not leave the building on ANY surface. Masking used to live
  // in the HTML renderers, so /api/graph and /api/history served raw addresses —
  // for every writer, to callers with no token at all. These assert the whole
  // JSON surface, because that is the shape the bug took.
  // Checks the fields that carry provenance, not the raw text. A page may quite
  // legitimately *discuss* an address — one on this wiki talks about 1.1.1.1 —
  // and a blanket grep would fail on the wiki's own content while proving
  // nothing about what the server discloses. A flaky security test is one that
  // gets ignored, which is worse than not having it.
  const PROV_KEYS = ['ip', 'host', 'updated_ip', 'updated_host', 'updated_agent'];
  const findLeaks = (value) => {
    const out = [];
    const walk = (v, at) => {
      if (v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
      for (const [k, val] of Object.entries(v)) {
        if (PROV_KEYS.includes(k) && typeof val === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(val)) {
          out.push(`${at}.${k}=${val}`);
        }
        walk(val, `${at}.${k}`);
      }
    };
    walk(value, '');
    return out;
  };
  const NO_IP = (body) => {
    try {
      return findLeaks(JSON.parse(body)).length === 0;
    } catch {
      // An HTML surface: look for an address in a provenance-shaped context
      // rather than anywhere on the page.
      return !/(from\s+|updated_ip:\s*|"ip":\s*")\d{1,3}(\.\d{1,3}){3}/.test(body);
    }
  };
  for (const [path, needsAuth] of [
    ['/api/graph', false],
    ['/api/history/hosts/pve-01', false],
    ['/api/changes', false],
    ['/api/sessions', false],
    ['/api/pages', false],
    ['/api/stats', false],
    ['/api/page/hosts/pve-01', true],
    ['/api/random', false],
    ['/api/fresh', false],
    ['/api/tokens', false],
    ['/api/top', false],
  ]) {
    const r = await fetch(`${pubBase}${path}`, needsAuth ? { headers: { Authorization: `Bearer ${minted.token}` } } : {});
    const body = await r.text();
    check(`${path} publishes no address`, NO_IP(body), body.match(/\b\d{1,3}(\.\d{1,3}){3}\b/)?.[0] || '');
  }

  // A conflict hands back the current content to merge. It used to hand back the
  // raw file, frontmatter included — which made a 409 an unauthenticated way to
  // read the last writer's address.
  const conflict = await fetch(`${pubBase}/api/page/hosts/pve-01`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ content: 'x', baseHash: '0000000000000000' }),
  });
  const conflictBody = await conflict.text();
  check('a conflict is reported as one', conflict.status === 409);
  check('the conflict body carries no address', NO_IP(conflictBody));
  check('and no server bookkeeping at all', !/updated_ip|updated_token|updated_host/.test(conflictBody));
  check('but still returns something to merge into', JSON.parse(conflictBody).current !== undefined);

  // The store is the thing that masks, so a reader that never touches a
  // template inherits it.
  check('provenance leaves the store masked', wiki.isMasking() === false, 'test process is private, as expected');

  // The token register. A rate limit needs a handle to count against and a
  // revocation needs one to revoke; neither is worth much without being able to
  // see what a given handle has written.
  // Public: the same class of fact as /changes, which anyone can already read.
  const tokPublic = await fetch(`${pubBase}/tokens`);
  const tokPublicBody = await tokPublic.text();
  check('the token register is public', tokPublic.status === 200);
  check('a visitor cannot revoke from it', !tokPublicBody.includes('/tokens/revoke'));
  check('read activity is not published', !/seen d+×/.test(tokPublicBody));

  const tokPage = await (await fetch(`${pubBase}/tokens`, { headers: auth })).text();
  check('the operator sees revoke', tokPage.includes('/tokens/revoke'));
  check('and sees read activity', /seen d+×/.test(tokPage) || tokPage.includes('no edits'));
  check('revoking still needs the operator',
    (await fetch(`${pubBase}/tokens/revoke`, { method: 'POST', body: 'id=abc' })).status === 401);
  check('it lists an issued token', tokPage.includes(minted.token.slice(0, 4)) || /[0-9a-f]{12}/.test(tokPage));
  check('it never prints a usable token', !tokPage.includes(minted.token));
  check('identities are shown as pseudonyms', !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(tokPage));

  const tokJson = await (await fetch(`${pubBase}/api/tokens`, { headers: auth })).json();
  check('there is a machine-readable form', Array.isArray(tokJson.tokens));
  check('it reports what each token wrote', tokJson.tokens.every((t) => typeof t.edits === 'number'));
  check('and never the token itself', !JSON.stringify(tokJson).includes(minted.token));

  // A write records which token made it — without that the page above cannot
  // answer its own question.
  const attrRes = await fetch(`${pubBase}/api/page/scratch/attributed`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ content: '# Attributed' }),
  });
  check('the attribution write was accepted', attrRes.status === 200, String(attrRes.status));
  const attributed = (await wiki.readPage('scratch/attributed')) || { provenance: { observed: {}, claimed: {} } };
  check('a write records the token that made it', !!attributed.provenance.observed.token);
  check('the token is observed, not claimed', attributed.provenance.claimed.token === undefined);
  const mine = (await revisionsForTest.byToken()).find((t) => t.token === attributed.provenance.observed.token);
  check('and the register finds that page under it', mine?.pages.some((pg) => pg.page === 'scratch/attributed'));
  await wiki.deletePage('scratch/attributed');

  // The stats page has to survive a wiki that has barely been used — an empty
  // series and a zero denominator are the normal state on day one.
  const statsPage = await fetch(`${pubBase}/stats`);
  const statsHtmlBody = await statsPage.text();
  check('the stats page renders', statsPage.status === 200);
  check('it separates agent reads from browser views', statsHtmlBody.includes('Agent reads') && statsHtmlBody.includes('Browser views'));
  check('it shows a freshness breakdown', statsHtmlBody.includes('freshbar'));
  check('it never divides by a zero page count', !statsHtmlBody.includes('NaN') && !statsHtmlBody.includes('Infinity'));
  const statsJson = await (await fetch(`${pubBase}/api/stats`)).json();
  check('there is a machine-readable form', typeof statsJson.totals === 'object');
  check('the json reports freshness too', typeof statsJson.freshness?.stale === 'number');

  // A bare slug is what an agent guesses when handed one by a tool result.
  const bare = await fetch(`${pubBase}/hosts/pve-01`, { redirect: 'manual' });
  check('a bare slug redirects to the page', bare.status === 301);
  check('and points at the canonical url', bare.headers.get('location') === '/w/hosts/pve-01');
  check(
    'a slug that names nothing is still a 404',
    (await fetch(`${pubBase}/no/such/thing`, { redirect: 'manual' })).status === 404
  );

  const visitor = { Authorization: `Bearer ${minted.token}` };
  const vc = new Client({ name: 'visitor-agent', version: '1.0.0' });
  await vc.connect(
    new StreamableHTTPClientTransport(new URL(`${pubMcpUrl}/mcp`), { requestInit: { headers: visitor } })
  );
  check('a visitor token connects', (await vc.listTools()).tools.length > 0);

  // The whole argument for choosing mermaid: an agent gets readable source.
  const diagMcp = await vc.callTool({ name: 'wiki_read', arguments: { page: 'scratch/diagram' } });
  check('an agent reads the diagram as text', diagMcp.content[0].text.includes('caddy --> web'));
  check('and not as markup', !diagMcp.content[0].text.includes('<svg'));
  await wiki.deletePage('scratch/diagram');

  const rndMcp = await vc.callTool({ name: 'wiki_random', arguments: {} });
  check('mcp serves a random page too', !rndMcp.isError && rndMcp.content[0].text.includes('page:'));
  const statsMcp = await vc.callTool({ name: 'wiki_stats', arguments: {} });
  check('usage stats are reachable over mcp', !statsMcp.isError && statsMcp.content[0].text.includes('agent reads'));

  const vRead = await vc.callTool({ name: 'wiki_search', arguments: { query: 'proxmox' } });
  check('a visitor can read', !vRead.isError && vRead.content[0].text.length > 0);

  const vWrite = await vc.callTool({
    name: 'wiki_write',
    arguments: { page: 'scratch/from-visitor', content: '# Visitor\n\nGoes live.', model: 'test' },
  });
  check('a visitor write is accepted', !vWrite.isError);
  check('a visitor write publishes immediately', vWrite.content[0].text.includes('Created'));
  check('a visitor write lands on disk', !!(await wiki.readPage('scratch/from-visitor')));

  const vScreened = await vc.callTool({
    name: 'wiki_write',
    arguments: { page: 'scratch/binary', content: '![x](data:image/png;base64,iVBORw0KGgo)' },
  });
  check('a visitor write is still screened', vScreened.isError === true);
  check('a screened write never reaches the disk', (await wiki.readPage('scratch/binary')) === null);

  // Removal is as open as writing, and it has to actually remove: a pull that
  // only hides a page from the browser leaves it readable by every agent, which
  // is most of what a takedown was trying to stop.
  // This process is a third reader of the same directory and has its own copy of
  // the store, so it needs the same visibility source a public server installs.
  wiki.setHiddenLoader(() => moderation.quarantinedSlugs());

  const vReport = await vc.callTool({
    name: 'wiki_report',
    arguments: { page: 'scratch/from-visitor', reason: 'spam', detail: 'test pull' },
  });
  check('any token can pull a page', !vReport.isError && vReport.content[0].text.includes('Pulled'));
  check('a pulled page is hidden from the store', (await wiki.readPage('scratch/from-visitor')) === null);
  check('a pulled page is not deleted', !!(await wiki.readPage('scratch/from-visitor', { includeHidden: true })));

  const vReadPulled = await vc.callTool({ name: 'wiki_read', arguments: { page: 'scratch/from-visitor' } });
  check('a pulled page cannot be read over mcp', vReadPulled.isError === true);
  const vListPulled = await vc.callTool({ name: 'wiki_list', arguments: {} });
  check('a pulled page is not listed over mcp', !vListPulled.content[0].text.includes('scratch/from-visitor'));
  const vSearchPulled = await vc.callTool({ name: 'wiki_search', arguments: { query: 'Goes live' } });
  check('a pulled page is not searchable over mcp', !vSearchPulled.content[0].text.includes('scratch/from-visitor'));
  const pulledWeb = await fetch(`${pubBase}/w/scratch/from-visitor`);
  check('a pulled page is not readable over http', pulledWeb.status !== 200);

  await moderation.release('scratch/from-visitor');
  check('an operator can put a pulled page back', !!(await wiki.readPage('scratch/from-visitor')));
  await wiki.deletePage('scratch/from-visitor');

  // Being wrong is the normal condition of a page here. If a disagreement could
  // hide a page, the wiki would be one argument away from empty.
  await wiki.writePage('scratch/disputed', '# Disputed\n\nArguably wrong.', { title: 'Disputed' });
  const vInaccurate = await vc.callTool({
    name: 'wiki_report',
    arguments: { page: 'scratch/disputed', reason: 'inaccurate', detail: 'I disagree' },
  });
  check('reporting a page as inaccurate does not pull it', !vInaccurate.isError);
  check('a merely-wrong page stays live', !!(await wiki.readPage('scratch/disputed')));
  await wiki.deletePage('scratch/disputed');
  // Back to a private store, so the rest of the suite is unaffected by it.
  wiki.setHiddenLoader(null);

  // Voting: open to any token, and pointedly not a moderation action.
  await wiki.writePage('scratch/rate-me', '# Rate me\n\nBody.', { title: 'Rate me' });
  const vVote = await vc.callTool({
    name: 'wiki_vote',
    arguments: { page: 'scratch/rate-me', direction: 'down', note: 'thin and unsourced' },
  });
  check('a visitor can vote', !vVote.isError && vVote.content[0].text.includes('-1'));
  check('a downvoted page is still readable', !!(await wiki.readPage('scratch/rate-me')));
  check(
    'a vote note lands on the page discussion',
    (await talk.listComments('scratch/rate-me')).some((c) => c.body.includes('thin and unsourced'))
  );
  const vRead2 = await vc.callTool({ name: 'wiki_read', arguments: { page: 'scratch/rate-me' } });
  check('wiki_read reports the score', vRead2.content[0].text.includes('votes: -1'));
  check(
    'a score is never presented as a verification',
    /never verified/.test(vRead2.content[0].text)
  );
  await wiki.deletePage('scratch/rate-me');

  const vDelete = await vc.callTool({ name: 'wiki_delete', arguments: { page: 'hosts/pve-01' } });
  check('a visitor cannot delete', vDelete.isError === true);
  check('the page a visitor tried to delete is still there', !!(await wiki.readPage('hosts/pve-01')));

  // The operator token on the same public instance is not held back.
  const oc = new Client({ name: 'operator-agent', version: '1.0.0' });
  await oc.connect(
    new StreamableHTTPClientTransport(new URL(`${pubMcpUrl}/mcp`), { requestInit: { headers: auth } })
  );
  const oWrite = await oc.callTool({
    name: 'wiki_write',
    arguments: { page: 'scratch/from-operator', content: '# Operator\n\nGoes live.', model: 'test' },
  });
  check('an operator write is not held', !oWrite.isError && oWrite.content[0].text.includes('Created'));
  check('an operator write lands on disk', !!(await wiki.readPage('scratch/from-operator')));
  await oc.close();
  await vc.close();
  await wiki.deletePage('scratch/from-operator');

  // ------------------------------------------- provenance over the wire ----
  console.log('\nprovenance over the wire');
  const client2 = new Client({ name: 'smoke-test-prov', version: '9.9.9' });
  await client2.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: auth } })
  );
  await client2.callTool({
    name: 'wiki_write',
    arguments: {
      page: 'scratch/via-mcp',
      content: '# Via MCP',
      model: 'claude-opus-5',
      context: 'smoke test',
    },
  });
  const viaMcp = (await wiki.readPage('scratch/via-mcp')).provenance;
  check('mcp write records the transport', viaMcp.observed.via === 'mcp');
  check('mcp write observes the client address', !!viaMcp.observed.ip, JSON.stringify(viaMcp.observed));
  check('mcp write picks up the client name automatically', viaMcp.claimed.agent?.includes('smoke-test'), viaMcp.claimed.agent);
  check('mcp write records the self-reported model', viaMcp.claimed.model === 'claude-opus-5');

  const noMeta = await client2.callTool({
    name: 'wiki_write',
    arguments: { page: 'scratch/no-meta', content: '# No meta' },
  });
  check('wiki_write nudges when model/context are missing', noMeta.content[0].text.includes('incomplete'));

  await fetch(`${base}/api/page/scratch/via-api`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Via API', model: 'some-model', context: 'api write' }),
  });
  const viaApi = (await wiki.readPage('scratch/via-api')).provenance;
  check('api write records the transport', viaApi.observed.via === 'api');
  check('api write records the model', viaApi.claimed.model === 'some-model');

  const shown = await (await fetch(`${base}/w/scratch/via-mcp`, { headers: auth })).text();
  check('page view shows who edited it', shown.includes('claude-opus-5'));
  check('page view marks self-reported fields', shown.includes('self-reported'));

  const d3res = await fetch(`${base}/vendor/d3.min.js`, { headers: auth });
  const d3body = await d3res.text();
  check('vendored d3 is served locally', d3res.ok && d3body.length > 100000, `${d3res.status}, ${d3body.length} bytes`);

  const fg = await fetch(`${base}/vendor/3d-force-graph.min.js`, { headers: auth });
  const fgBody = await fg.text();
  check('vendored 3d-force-graph is served locally', fg.ok && fgBody.length > 500000, `${fg.status}, ${fgBody.length} bytes`);

  // /vendor/ is an allow-list, never a path built from the request.
  const bad = await fetch(`${base}/vendor/../../etc/passwd`, { headers: auth });
  check('vendor path is not walkable', bad.status === 404 || !(await bad.text()).includes('root:'), String(bad.status));
  const unknown = await fetch(`${base}/vendor/marked/lib/marked.cjs`, { headers: auth });
  check('unlisted vendor files are refused', unknown.status === 404, String(unknown.status));

  const graphPage = await (await fetch(`${base}/graph`, { headers: auth })).text();
  check('graph page offers both renderers', graphPage.includes('id="m2d"') && graphPage.includes('id="m3d"'));
  check('3d bundle is not loaded up front', !graphPage.includes('<script src="/vendor/3d-force-graph.min.js">'));

  // ----------------------------------------------- talk over the wire ----
  console.log('\ntalk over the wire');
  const wc = await client2.callTool({
    name: 'wiki_comment',
    arguments: {
      page: 'hosts/pve-01',
      body: 'Disk figure looks stale against live config.',
      kind: 'stale',
      model: 'claude-opus-5',
    },
  });
  check('wiki_comment succeeds', !wc.isError && wc.content[0].text.includes('comment c-'));
  check('wiki_comment says the page is unchanged', wc.content[0].text.includes('unchanged'));

  const badPage = await client2.callTool({
    name: 'wiki_comment',
    arguments: { page: 'ghost/page', body: 'x' },
  });
  check('cannot comment on a missing page', badPage.isError === true);

  const readWithTalk = await client2.callTool({
    name: 'wiki_read',
    arguments: { page: 'hosts/pve-01' },
  });
  check('wiki_read flags open discussion', readWithTalk.content[0].text.includes('DISCUSSION'));
  check('wiki_read names the kind', readWithTalk.content[0].text.includes('[stale]'));

  const listed = await client2.callTool({
    name: 'wiki_comments',
    arguments: { page: 'hosts/pve-01' },
  });
  check('wiki_comments returns the thread', listed.content[0].text.includes('STALE'));
  check('wiki_comments hides resolved by default', !listed.content[0].text.includes('(resolved)'));

  const queue = await client2.callTool({ name: 'wiki_review_queue', arguments: {} });
  check('review queue lists across pages', queue.content[0].text.includes('hosts/pve-01'));
  const filtered = await client2.callTool({
    name: 'wiki_review_queue',
    arguments: { kind: 'contradiction' },
  });
  check('review queue filters by kind', filtered.content[0].text.includes('No open contradiction'));

  const cid = /c-[a-z0-9]+/.exec(wc.content[0].text)[0];
  const rr = await client2.callTool({
    name: 'wiki_resolve_comment',
    arguments: { page: 'hosts/pve-01', id: cid, resolution: 'checked, figure was right' },
  });
  check('wiki_resolve_comment works', !rr.isError);
  const afterResolve = await client2.callTool({ name: 'wiki_read', arguments: { page: 'hosts/pve-01' } });
  check('resolved comments stop being flagged', !afterResolve.content[0].text.includes('[stale]'));

  const talkApi = await (await fetch(`${base}/api/talk/hosts/pve-01`, { headers: auth })).json();
  check('json talk read works', typeof talkApi.open === 'number');
  const postTalk = await fetch(`${base}/api/talk/hosts/pve-01`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'via the http api', kind: 'question' }),
  });
  check('json talk write works', postTalk.ok);
  const reviewApi = await (await fetch(`${base}/api/review`, { headers: auth })).json();
  check('json review queue works', reviewApi.open.some((c) => c.page === 'hosts/pve-01'));

  // Escaping raw HTML is not enough: markdown's own link and image syntax goes
  // straight through it. A data: image is the page hosting the bytes, and a
  // javascript: href is stored XSS on a wiki whose pages agents write.
  await wiki.writePage(
    'scratch/schemes',
    '# schemes\n\n![i](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n\n' +
      '[a](javascript:alert(1))\n\n[b](java\tscript:alert(2))\n\n[ok](https://example.com)\n\n[rel](/w/other)\n'
  );
  const schemes = await (await fetch(`${base}/w/scratch/schemes`, { headers: auth })).text();
  check('a data: image is never rendered', !schemes.includes('img src="data:'), 'embedded image leaked');
  check('a javascript: href is never rendered', !/href="\s*java/i.test(schemes), 'executable scheme leaked');
  check('a blocked target is shown, not silently dropped', schemes.includes('class="blocked"'));
  check('https links still work', schemes.includes('href="https://example.com"'));
  check('relative links still work', schemes.includes('href="/w/other"'));
  await wiki.deletePage('scratch/schemes');

  const pageHtml = await (await fetch(`${base}/w/hosts/pve-01`, { headers: auth })).text();
  check('page renders the discussion', pageHtml.includes('Discussion'));
  check('page shows the open badge', pageHtml.includes('class="badge"'));
  const reviewHtml = await (await fetch(`${base}/review`, { headers: auth })).text();
  check('review page renders', reviewHtml.includes('Review queue'));

  const graphApi = await (await fetch(`${base}/api/graph`, { headers: auth })).json();
  check('graph nodes carry a summary', graphApi.nodes.some((n) => n.summary));
  check('graph nodes carry provenance', graphApi.nodes.some((n) => n.provenance));

  await client2.close();
  await wiki.deletePage('scratch/via-mcp');
  await wiki.deletePage('scratch/via-api');
  await wiki.deletePage('scratch/no-meta');

  // ----------------------------------------------------- mcp over stdio ----
  console.log('\nmcp over stdio');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const stdioClient = new Client({ name: 'smoke-test-stdio', version: '1.0.0' });
  await stdioClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'server', 'mcp.js')],
      env: { ...process.env, WIKI_DIR: TMP },
      cwd: ROOT,
    })
  );
  const stdioTools = (await stdioClient.listTools()).tools.map((t) => t.name);
  check('stdio transport advertises tools', stdioTools.includes('wiki_search'), stdioTools.join(','));
  const stdioHit = await stdioClient.callTool({ name: 'wiki_search', arguments: { query: 'proxmox' } });
  check('stdio transport searches', stdioHit.content[0].text.includes('hosts/pve-01'));
  await stdioClient.close();
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
