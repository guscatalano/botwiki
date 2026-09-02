#!/usr/bin/env node
// botwiki MCP server.
//
//   node server/mcp.js            -> stdio   (agent running on this same machine)
//   node server/mcp.js --http     -> HTTP    (agents elsewhere on the network / LXC)
//
// Env: MCP_HOST, MCP_PORT, MCP_TRANSPORT=stdio|http, WIKI_TOKEN, WIKI_READONLY, WIKI_DIR

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWikiServer } from '../lib/mcp-server.js';
import { PAGES_DIR } from '../lib/wiki.js';

const args = process.argv.slice(2);
const transportKind =
  args.includes('--http') || process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio';
const readOnly = /^(1|true|yes)$/i.test(process.env.WIKI_READONLY || '');
const TOKEN = process.env.WIKI_TOKEN || '';
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

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer === TOKEN || req.headers['x-api-key'] === TOKEN;
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
        ok: true, transport: 'http', pages: PAGES_DIR, readOnly, sessions: sessions.size,
      });
    }
    if (url.pathname !== '/mcp') {
      return sendJson(res, 404, { error: 'not found', hint: 'MCP endpoint is POST /mcp' });
    }
    if (!authorized(req)) {
      res.setHeader('www-authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    const clientIp =
      (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      req.socket.remoteAddress;

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
      const mcp = createWikiServer({ readOnly, via: 'mcp', clientIp });
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
        `  auth:    ${TOKEN ? 'bearer token required' : 'NONE (set WIKI_TOKEN to require one)'}\n` +
        `  mode:    ${readOnly ? 'read-only' : 'read-write'}`
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

await (transportKind === 'http' ? runHttp() : runStdio());
