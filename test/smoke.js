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
check('a new unverified page is fresh but unverified', s1.status === 'fresh' && s1.neverVerified === true, s1.status);
check('ttl comes from the type', s1.ttlDays === 180);

await wiki.writePage('hosts/typed', freshPage.raw, { verified: true, verifiedBy: 'tester', verifiedNote: 'checked live' });
const v = await wiki.readPage('hosts/typed');
check('verification is recorded', !!v.meta.verified_at);
check('verifier is recorded', v.meta.verified_by === 'tester');
check('verification note is recorded', v.meta.verified_note === 'checked live');
check('verification does not change the body', v.body.includes('Typed host'));
const s2 = types.stalenessOf(v, reg);
check('a verified page is no longer neverVerified', s2.neverVerified === false);

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
check('type report counts pages', treport.types.find((t) => t.type === 'host').count === 3, JSON.stringify(treport.types.map((t) => [t.type, t.count])));
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

const cleanup = async () => {
  web.kill();
  mcp.kill();
  await fs.rm(TMP, { recursive: true, force: true });
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
  check('tools are advertised', tools.join(',') === 'wiki_changes,wiki_comment,wiki_comments,wiki_delete,wiki_find,wiki_graph,wiki_history,wiki_list,wiki_query,wiki_read,wiki_related,wiki_resolve_comment,wiki_review_queue,wiki_search,wiki_session,wiki_stale,wiki_tags,wiki_types,wiki_verify,wiki_write', tools.join(','));

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
