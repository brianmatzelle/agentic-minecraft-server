// garvtunnel — a small bridge that lets an external agent run Lua inside an
// in-game CraftOS 1.9 (CC: Tweaked) computer, SSH-style but over a WebSocket.
//
// Two planes, one process:
//   * WS plane  (TUNNEL_WS_PORT,  internal only): the in-game computer connects
//     OUT to ws://garvtunnel:<port>/agent, registers, then runs a receive loop.
//     The same listener serves GET /client.lua so the computer can bootstrap with
//     `wget run`. Never published to the host.
//   * Control plane (TUNNEL_CTL_PORT, published to host 127.0.0.1 ONLY): the agent
//     POSTs {code} to /exec, the bridge forwards it to the computer, waits for the
//     result, and returns it as JSON. GET /status lists connected computers.
//
// Both planes require the shared secret in TUNNEL_TOKEN (constant-time compared).
// The computer never exposes an inbound port; it dials out. This mirrors the
// localhost-only sidecar pattern already used for Grafana/Postgres in this compose.

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const TOKEN = process.env.TUNNEL_TOKEN || '';
const WS_PORT = parseInt(process.env.TUNNEL_WS_PORT || '8176', 10);   // in-game computer dials this (internal)
const CTL_PORT = parseInt(process.env.TUNNEL_CTL_PORT || '8175', 10); // agent control plane (host 127.0.0.1 only)
const EXEC_TIMEOUT_MS = parseInt(process.env.TUNNEL_EXEC_TIMEOUT_MS || '15000', 10);

if (!TOKEN) {
  console.error('garvtunnel: TUNNEL_TOKEN is required (set it in apps/server/.env)');
  process.exit(1);
}

// Constant-time token comparison — avoids leaking length/match timing.
function tokenOk(t) {
  if (typeof t !== 'string' || t.length === 0) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function headerToken(req) {
  return (req.headers['x-tunnel-token'] || '').toString();
}

// --- state ---------------------------------------------------------------
const computers = new Map(); // id -> { ws, label }
const pending = new Map();    // jobId -> { resolve, timer }
let jobSeq = 0;

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* socket gone; close handler cleans up */ }
}

// --- WS plane: in-game computer connects here, also serves the bootstrap script ---
// The token is injected into client.lua at serve time (replacing the placeholder)
// so the in-game `wget run http://garvtunnel:8176/` needs no token typed by hand.
// This listener is internal-only (never host-published), so the baked token never
// leaves the compose network; the WS handshake re-checks the token regardless.
const clientLuaTemplate = fs.readFileSync(__dirname + '/client.lua', 'utf8');
const clientLua = clientLuaTemplate.split('TUNNEL_TOKEN_PLACEHOLDER').join(TOKEN);

const wsHttp = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/client.lua'))) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(clientLua);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server: wsHttp, path: '/agent' });

wss.on('connection', (ws, req) => {
  if (!tokenOk(headerToken(req))) {
    ws.close(4001, 'bad token');
    return;
  }
  let id = null;
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'hello') {
      id = (msg.id || `cc-${computers.size}`).toString();
      computers.set(id, { ws, label: msg.label || id });
      console.log(`[ws] computer connected: ${id} (${msg.label || ''})`);
      send(ws, { type: 'welcome', id });
    } else if (msg.type === 'result') {
      const p = pending.get(msg.jobId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.jobId);
        p.resolve(msg);
      }
    }
  });
  ws.on('close', () => {
    if (id && computers.get(id)?.ws === ws) {
      computers.delete(id);
      console.log(`[ws] computer disconnected: ${id}`);
    }
  });
  ws.on('error', () => { /* close handler does cleanup */ });
});

wsHttp.listen(WS_PORT, '0.0.0.0', () => console.log(`[ws]  listening on :${WS_PORT} (internal)`));

// --- Control plane: the agent submits Lua here ---------------------------
function pickComputer(targetId) {
  if (targetId) return computers.get(targetId);
  // default: the only (or first) connected computer
  return [...computers.values()][0];
}

const ctl = http.createServer((req, res) => {
  if (!tokenOk(headerToken(req))) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    const list = [...computers.entries()].map(([id, c]) => ({ id, label: c.label }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ computers: list }));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/exec')) {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy(); // 1MB hard cap on submitted code
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
      if (typeof parsed.code !== 'string') { res.writeHead(400); res.end('{"error":"missing code"}'); return; }

      const entry = pickComputer(parsed.id);
      if (!entry) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no computer connected' }));
        return;
      }

      const jobId = `job-${++jobSeq}`;
      const timer = setTimeout(() => {
        pending.delete(jobId);
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'timeout', jobId }));
      }, EXEC_TIMEOUT_MS);

      pending.set(jobId, {
        timer,
        resolve: (msg) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(msg));
        },
      });

      send(entry.ws, { type: 'exec', jobId, code: parsed.code });
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

ctl.listen(CTL_PORT, '0.0.0.0', () => console.log(`[ctl] listening on :${CTL_PORT} (publish to 127.0.0.1 only)`));
