#!/usr/bin/env node
// botwiki MCP server.
//
//   node server/mcp.js            -> stdio   (agent running on this same machine)
//   node server/mcp.js --http     -> HTTP    (agents elsewhere on the network / LXC)
//
// Env: MCP_HOST, MCP_PORT, MCP_TRANSPORT=stdio|http, WIKI_TOKEN, WIKI_READONLY, WIKI_DIR

import http from 'node:http';
import crypto, { randomUUID } from 'node:crypto';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWikiServer } from '../lib/mcp-server.js';
import { PAGES_DIR, setHiddenLoader, setPublicMasking } from '../lib/wiki.js';
import * as tokens from '../lib/tokens.js';
import * as moderation from '../lib/moderation.js';

const args = process.argv.slice(2);
const transportKind =
  args.includes('--http') || process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio';
const readOnly = /^(1|true|yes)$/i.test(process.env.WIKI_READONLY || '');
const TOKEN = process.env.WIKI_TOKEN || '';
const PUBLIC = /^(1|true|yes)$/i.test(process.env.WIKI_PUBLIC || '');

const WRITE_RATE = Math.max(1, Number(process.env.WIKI_WRITE_RATE) || 6);

// Teach the store which pages have been pulled from view. Enforcing it there
// rather than per-tool is what keeps a hide honest: twenty tools read through
// this store, and a check any one of them can forget is not a check.
if (PUBLIC) setHiddenLoader(() => moderation.quarantinedSlugs());
if (PUBLIC) setPublicMasking(true);
// Only believe X-Forwarded-For when something in front is actually setting it.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WIKI_TRUST_PROXY || '');

async function runStdio() {
  // stdio means the caller is on this machine; there is no remote address.
  // Over stdio the agent runs on this machine, so the hostname is observed
  // fact rather than something the client has to be trusted about.
  const server = createWikiServer({
    readOnly, via: 'stdio', clientIp: null, serverHost: os.hostname(),
  });
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel — every human-facing byte goes to stderr.
  console.error(`botwiki MCP (stdio) ready. pages: ${PAGES_DIR}${readOnly ? ' [read-only]' : ''}`);
}

// Compared through a digest rather than the raw bytes: timingSafeEqual throws
// on a length mismatch, so feeding it attacker-controlled input directly turns
// a wrong-length credential into an exception instead of a "no". Hashing first
// makes both sides 32 bytes whatever arrives, and keeps the compare constant.
const sameSecret = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );

/**
 * Who is calling, and how much are they allowed to do.
 *
 * Two kinds of credential authenticate here and they are not the same thing:
 *
 *   the operator token   — WIKI_TOKEN. Also releases pulled pages and deletes.
 *   a visitor token      — minted by anyone at POST /api/token, one per address
 *                          per day. Reads, writes and pulls pages; cannot delete
 *                          or release.
 *
 * Both publish immediately. The token is an identity to rate-limit and revoke
 * against, not a gate.
 *
 * Visitor tokens only exist in public mode. A private instance keeps exactly the
 * behaviour it had: no token configured means wide open, a configured token
 * means that token and nothing else.
 */
async function principal(req, clientIp) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const presented = bearer || String(req.headers['x-api-key'] || '').trim();

  if (TOKEN && presented && sameSecret(presented, TOKEN)) return { ok: true, trusted: true };
  if (!TOKEN && !PUBLIC) return { ok: true, trusted: true };

  if (PUBLIC && presented) {
    const visitor = await tokens.verify(presented);
    if (visitor) return { ok: true, trusted: false, tokenId: visitor.id };
    // A credential that was presented and is not valid stays a refusal. Minting
    // one here would silently promote a revoked token back into a working one.
    return { ok: false, reason: 'invalid' };
  }

  // Nothing presented. Rather than refuse and expect an agent to go and read a
  // web page about how to get a credential, mint one for it and say so. The
  // token is derived, so a client that reconnects without keeping it gets the
  // same one back — first contact is idempotent rather than a new identity per
  // attempt, and the daily cap still holds.
  if (PUBLIC) {
    const minted = await tokens.issue({ ip: clientIp, note: 'auto-issued on first contact' });
    if (minted.ok) {
      // Resolve the id straight away. An auto-issued connection writes under the
      // same identity as one that brought its own token — otherwise every page
      // written on first contact would be attributed to nobody.
      const self = await tokens.verify(minted.token);
      return { ok: true, trusted: false, minted: minted.token, tokenId: self?.id || null };
    }
    // Only reachable when this address's token was revoked. It waits out the cap.
    return { ok: false, reason: minted.reason };
  }
  return { ok: false };
}

function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Live MCP sessions, keyed by the id the transport hands the client.
const sessions = new Map();
const SESSION_IDLE_MS = 30 * 60 * 1000;

const isInitialize = (body) =>
  Array.isArray(body)
    ? body.some((m) => m?.method === 'initialize')
    : body?.method === 'initialize';

// A client that vanishes without a DELETE would otherwise pin its session for
// the life of the process.
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(id);
      s.transport.close().catch(() => {});
      s.mcp.close().catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

async function runHttp() {
  const host = process.env.MCP_HOST || '0.0.0.0';
  const port = Number(process.env.MCP_PORT || 8788);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        // The pages directory is the server's filesystem layout; a public
        // instance answers healthz to anyone, so it does not go in the reply.
        ok: true, transport: 'http', readOnly, sessions: sessions.size,
        ...(PUBLIC ? {} : { pages: PAGES_DIR }),
      });
    }
    if (url.pathname !== '/mcp') {
      return sendJson(res, 404, { error: 'not found', hint: 'MCP endpoint is POST /mcp' });
    }
    const clientIp =
      (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      req.socket.remoteAddress;

    const who = await principal(req, clientIp);
    if (!who.ok) {
      res.setHeader('www-authenticate', 'Bearer');
      return sendJson(res, 401, {
        error: 'unauthorized',
        ...(PUBLIC
          ? {
              hint:
                who.reason === 'revoked'
                  ? 'This address had its token revoked. A new one can be issued once the daily window passes.'
                  : 'That token is not valid. Connect with no Authorization header and one will be issued automatically.',
            }
          : {}),
      });
    }

    // Handed back on the response so a client that reads headers can adopt it
    // without parsing prose. The instructions carry it too, for those that cannot.
    if (who.minted) res.setHeader('x-botwiki-token', who.minted);

    try {
      let body;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : undefined;
      }

      const sid = req.headers['mcp-session-id'];
      const existing = sid ? sessions.get(sid) : null;

      if (existing) {
        existing.lastSeen = Date.now();
        return await existing.transport.handleRequest(req, res, body);
      }

      // A session keeps the server that handled `initialize` alive for the rest
      // of the conversation — which is the only way tool calls can know which
      // client is calling them, for the page edit record.
      if (isInitialize(body)) {
        // The transport does not have an id until initialize completes, so the
        // server reads it through a closure rather than being handed a value.
        const holder = {};
        const mcp = createWikiServer({
          readOnly, via: 'mcp', clientIp,
          publicMode: PUBLIC, trusted: who.trusted, writeRate: WRITE_RATE,
          voterId: who.tokenId || clientIp,
          tokenId: who.tokenId || (who.trusted ? 'operator' : null),
          mintedToken: who.minted || null,
          getConnectionId: () => holder.transport?.sessionId || null,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, { mcp, transport, lastSeen: Date.now() }),
        });
        holder.transport = transport;
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          mcp.close().catch(() => {});
        };
        await mcp.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      // No session and not an initialize: serve it statelessly so simple clients
      // that never negotiate a session still work, just without client identity.
      const mcp = createWikiServer({ readOnly, via: 'mcp', clientIp, publicMode: PUBLIC, trusted: who.trusted, writeRate: WRITE_RATE, voterId: who.tokenId || clientIp,
          tokenId: who.tokenId || (who.trusted ? 'operator' : null), mintedToken: who.minted || null });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
    }
  });

  server.listen(port, host, () => {
    console.error(
      `botwiki MCP (http) listening on http://${host}:${port}/mcp\n` +
        `  pages:   ${PAGES_DIR}\n` +
        `  auth:    ${
        PUBLIC
          ? `operator token + self-service visitor tokens (writes held for review)`
          : TOKEN
            ? 'bearer token required'
            : 'NONE (set WIKI_TOKEN to require one)'
      }\n` +
        `  mode:    ${readOnly ? 'read-only' : 'read-write'}`
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

await (transportKind === 'http' ? runHttp() : runStdio());
