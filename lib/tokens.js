// Self-service access tokens for a public instance.
//
// The point of these is NOT to keep people out. Anyone can mint one, which is
// the only way an open wiki is actually open: a token nobody can obtain is a
// wiki nobody can read over MCP. What the token buys is an *identity* — one
// stable handle per visitor that survives a changing address, so abuse can be
// rate-limited and revoked at the level of the writer instead of the network.
// An IP alone cannot do that: it is shared by innocents and cycled by abusers.
//
// Three properties are load-bearing.
//
//   Issuance is capped per address per day. Without that the identity is free
//   to replace and therefore worth nothing — revoke one, mint another. The cap
//   is what gives a revocation teeth.
//
//   Only the hash is stored, yet the token is still recoverable — because it is
//   derived rather than random (see below), asking again recomputes it instead
//   of reading it back. The file on disk cannot be turned into credentials if it
//   leaks, and a caller that loses its token is not locked out for a day.
//
//   A visitor token is never the operator token. It authenticates, it does not
//   authorise: writes made with one are screened and rate-limited, and it cannot
//   delete or release a pulled page. `WIKI_TOKEN` is what does those.
//
// State lives in a dot-directory under the pages dir, so the page walker skips
// it exactly as it skips .talk and .history.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as wiki from './wiki.js';

const modDir = () => path.join(wiki.PAGES_DIR, '.moderation');
const tokensFile = () => path.join(modDir(), 'tokens.json');

export const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000;

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// --- deriving tokens --------------------------------------------------------
//
// Tokens are computed, not drawn from randomness:
//
//   token = HMAC(secret, issuerKey + ':' + issuedAt)
//
// which makes the same token reproducible for the same issuer and issuance, and
// therefore recoverable. That matters more than it sounds: an agent that loses
// its token is otherwise locked out for a day for no reason, and a first contact
// cannot be handed a credential idempotently — retrying would either mint a
// second identity or be refused.
//
// The file still stores only the hash. Recovery does not read a token back, it
// re-derives one, so a leaked tokens.json is still not a set of credentials.
// The secret is what matters now, and it is the operator token: HMAC is one-way,
// so a visitor token cannot be walked back to it.
let secretCache = null;
const secretFile = () => path.join(modDir(), 'token-secret');

async function secret() {
  if (secretCache) return secretCache;
  const fromEnv = process.env.WIKI_TOKEN_SECRET || process.env.WIKI_TOKEN || '';
  if (fromEnv) {
    secretCache = fromEnv;
    return secretCache;
  }
  // No operator token configured — a private instance, or a test. Persist a
  // random secret so derived tokens survive a restart.
  try {
    secretCache = (await fs.readFile(secretFile(), 'utf8')).trim();
    if (secretCache) return secretCache;
  } catch {
    // Not created yet.
  }
  secretCache = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(modDir(), { recursive: true });
  await fs.writeFile(secretFile(), secretCache, { encoding: 'utf8', mode: 0o600 });
  return secretCache;
}

async function derive(issuer, issuedAt) {
  return crypto.createHmac('sha256', await secret()).update(`${issuer}:${issuedAt}`).digest('hex');
}

/**
 * The unit the daily cap is counted against.
 *
 * For IPv4 that is the address. For IPv6 it is the /64 — a single customer is
 * routinely handed one, and often the whole /64 is theirs to cycle through, so
 * capping on the full 128-bit address would be a cap that costs an abuser
 * nothing to step around while still catching ordinary users behind it.
 */
export function issuerKey(ip) {
  const raw = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw;
  const parts = raw.split('%')[0].split(':');
  // Expand :: only far enough to name the first four groups.
  const gap = parts.indexOf('');
  let groups;
  if (gap === -1) groups = parts;
  else {
    const head = parts.slice(0, gap).filter(Boolean);
    const tail = parts.slice(gap).filter(Boolean);
    const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
    groups = [...head, ...fill, ...tail];
  }
  return `${groups.slice(0, 4).map((g) => (g || '0').toLowerCase()).join(':')}::/64`;
}

async function load() {
  try {
    const raw = await fs.readFile(tokensFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return { tokens: parsed.tokens || {}, issued: parsed.issued || {} };
  } catch {
    return { tokens: {}, issued: {} };
  }
}

// Written to a temporary file and renamed, never in place. A plain writeFile
// truncates first, so a reader arriving mid-write gets a half a JSON document,
// fails to parse it, and falls back to "no tokens at all" — which here means
// every cap forgotten and every token invalid for as long as the write takes.
// Rename is atomic on one filesystem: a reader sees the old file or the new one.
async function save(state) {
  await fs.mkdir(modDir(), { recursive: true });
  const tmp = `${tokensFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, tokensFile());
}

// Issuance is read-modify-write against one file, and the whole value of the
// daily cap is that two simultaneous requests cannot both pass it. Serialising
// in-process is enough here because a single server owns the file.
let chain = Promise.resolve();
const serialise = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

/**
 * Mint a token for an address, unless that address already got one today.
 *
 * Within the window this returns the token that address already has, flagged
 * `reused`, rather than refusing. Asking twice is not a second identity, so the
 * cap is untouched — and an agent that lost its token can simply ask again.
 */
export async function issue({ ip = null, note = '' } = {}) {
  const key = issuerKey(ip);
  return serialise(async () => {
    const state = await load();
    const now = Date.now();
    const last = state.issued[key];

    if (last && now - last < ISSUE_WINDOW_MS) {
      const existing = Object.entries(state.tokens).find(
        ([, r]) => r.issuerKey === key && r.issuedAt === last
      );

      // Revoked is the one case that must not hand anything back. Re-deriving
      // here would undo the revocation completely — the whole point of the daily
      // cap is that a revoked writer waits it out rather than minting again.
      if (existing?.[1]?.revoked) {
        return {
          ok: false,
          reason: 'revoked',
          retryAfter: Math.ceil((last + ISSUE_WINDOW_MS - now) / 1000),
          nextAt: new Date(last + ISSUE_WINDOW_MS).toISOString(),
        };
      }

      if (existing) {
        // Same issuer, same issuance, same token. Asking twice is not a second
        // identity, so the cap is untouched by handing this back.
        const token = await derive(key, last);
        if (hash(token) === existing[0]) {
          return { ok: true, token, issued: existing[1].issued, reused: true };
        }
        // A record from before tokens were derivable, or a changed secret:
        // the old token cannot be reproduced, so it is replaced rather than
        // leaving the caller locked out holding something unrecoverable.
        delete state.tokens[existing[0]];
      }
    }

    const issuedAt = now;
    const token = await derive(key, issuedAt);
    state.tokens[hash(token)] = {
      issued: new Date(issuedAt).toISOString(),
      issuedAt,
      issuerKey: key,
      ip: ip || null,
      note: String(note || '').slice(0, 200),
      revoked: false,
      lastSeen: null,
      uses: 0,
    };
    state.issued[key] = issuedAt;
    await save(state);
    return { ok: true, token, issued: state.tokens[hash(token)].issued, reused: false };
  });
}

/**
 * Is this a live visitor token? Records the sighting, which is what makes an
 * abusive token traceable back to the address that minted it.
 */
export async function verify(token) {
  if (!token) return null;
  const h = hash(token);
  const state = await load();
  const rec = state.tokens[h];
  if (!rec || rec.revoked) return null;
  const answer = { id: h.slice(0, 12), issued: rec.issued, issuerKey: rec.issuerKey };

  // The sighting is recorded through the same queue as every other write, and
  // re-reads inside it. Saving the snapshot this function already loaded would
  // clobber anything issued or revoked in between — a read path silently
  // undoing a write, which is the worst shape a race can take here.
  //
  // Not awaited: bookkeeping must not make a valid token wait, or fail one.
  serialise(async () => {
    const fresh = await load();
    const r = fresh.tokens[h];
    if (!r) return;
    r.lastSeen = new Date().toISOString();
    r.uses = (r.uses || 0) + 1;
    await save(fresh);
  }).catch(() => {});

  return answer;
}

/**
 * Record that this token was throttled.
 *
 * The rate limiter itself lives in memory, per process, keyed on whoever was
 * asking — which makes it invisible to anyone reading the register, invisible to
 * the *other* server process, and gone at the next restart. Writing the fact
 * against the token fixes all three: it is the token that gets rate-limited, so
 * it is the token that should carry the record.
 *
 * `until` is stored rather than derived so "are they still throttled" can be
 * answered by any process from the file alone.
 */
export async function noteThrottle(id, retryAfterSeconds = 60) {
  if (!id || id === 'operator') return null;
  return serialise(async () => {
    const state = await load();
    const h = Object.keys(state.tokens).find((k) => k.startsWith(String(id)));
    if (!h) return null;
    const rec = state.tokens[h];
    rec.throttled = (rec.throttled || 0) + 1;
    rec.throttledAt = new Date().toISOString();
    rec.throttledUntil = new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();
    await save(state);
    return { id, throttled: rec.throttled, until: rec.throttledUntil };
  });
}

/** Revoke by token or by the short id shown in the operator list. */
export async function revoke(idOrToken, { by = 'operator', reason = '' } = {}) {
  return serialise(async () => {
    const state = await load();
    const direct = hash(idOrToken);
    const h = state.tokens[direct]
      ? direct
      : Object.keys(state.tokens).find((k) => k.startsWith(String(idOrToken)));
    if (!h || !state.tokens[h]) return { ok: false, reason: 'not_found' };
    state.tokens[h].revoked = true;
    state.tokens[h].revokedAt = new Date().toISOString();
    state.tokens[h].revokedBy = by;
    state.tokens[h].revokedReason = String(reason || '').slice(0, 200);
    await save(state);
    return { ok: true, id: h.slice(0, 12) };
  });
}

/** Operator view. Never returns anything that could be replayed as a token. */
export async function list({ includeRevoked = true } = {}) {
  const state = await load();
  return Object.entries(state.tokens)
    .map(([h, r]) => ({ id: h.slice(0, 12), ...r }))
    .filter((r) => includeRevoked || !r.revoked)
    .sort((a, b) => String(b.issued).localeCompare(String(a.issued)));
}

export async function count() {
  const state = await load();
  const all = Object.values(state.tokens);
  return { total: all.length, live: all.filter((r) => !r.revoked).length };
}
