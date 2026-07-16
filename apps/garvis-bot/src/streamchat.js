// Stream-command worker (Layer 3, Garvis TV side) — PAID viewer commands from
// the Owncast stream chat at tv.starting.cc.
//
// The selling half lives in apps/server/tollbooth/ (compose sidecar): it sells
// command credits over x402 (USDC over HTTP 402 — see the sidecar's README),
// watches the stream chat via an Owncast CHAT webhook, and for a viewer with
// credits INSERTs one row into stream_commands (status 'queued'). This module
// is the host-side consumer of that queue:
//
//   poll stream_commands (pg, FOR UPDATE SKIP LOCKED, ONE at a time)
//     -> classify with the SAME in-game intent classifier (injected)
//     -> execute ONLY body / tv intents — the powers the owner put on sale;
//        qa/give/modreq are refused and the credit is NOT burned
//     -> burn 1 credit on success, write reply+status back to the row,
//        push the reply into the stream chat (Owncast integrations API),
//        and tellraw the in-game world so players see WHY the body moved.
//
// Trust model: a stream viewer is ANONYMOUS (an Owncast chat identity — no
// whitelist, no ops.json). They get exactly the body-verb + TV surface in-game
// players already have (re-validated + denylisted in body.js / tv.js, executed
// with asker:null so "come here"-style verbs refuse cleanly), bought with
// credits. They NEVER reach qa (the free-form agent), give, modreq, or the
// rcon-empowered `!g` agent — refused intents cost nothing and run nothing.
// The single-claim loop also serializes viewers, so two paying strangers can't
// interleave Baritone commands.
//
// Like convlog.js this module degrades, never dies: a down Postgres or Owncast
// just idles the worker (logged), and every loop turn is fully try/caught.
import pg from 'pg';
import { logTurn } from './convlog.js';

// Shared schema contract with the tollbooth sidecar — KEEP IN SYNC with
// apps/server/tollbooth/src/schema.js. Both sides CREATE IF NOT EXISTS at
// boot so neither cares which comes up first.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS stream_viewers (
  owncast_id   TEXT PRIMARY KEY,                 -- Owncast chat user id (webhook user.id)
  display_name TEXT,
  credits      INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stream_codes (
  code        TEXT PRIMARY KEY,                  -- redeem code minted by a paid /buy
  credits     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_ref TEXT,                              -- settlement breadcrumb (tx hash/header), when known
  redeemed_by TEXT,                              -- owncast_id that claimed it
  redeemed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS stream_commands (
  id           BIGSERIAL PRIMARY KEY,
  owncast_id   TEXT NOT NULL,
  display_name TEXT,
  request      TEXT NOT NULL,                    -- what they typed after "!g"
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed|refused
  intent       TEXT,
  reply        TEXT,
  credit_spent BOOLEAN,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS stream_commands_status_idx ON stream_commands (status, id);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Push one line into the Owncast stream chat via the integrations API (shows
// as the token's bot identity). Best-effort; the queue row keeps the reply
// either way.
async function sendStreamChat(owncastUrl, token, text, log) {
  try {
    const r = await fetch(`${owncastUrl}/api/integrations/chat/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: String(text).slice(0, 500) }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    log(`stream-chat send failed: ${e.message}`);
  }
}

// One public in-game line so players see why the body just walked off / the TV
// changed: "[Garvis] 📺 name (stream): ...". Fixed argv via the injected
// rconExec (execFile, no shell); viewer text never lands raw — only our own
// reply text does, JSON-escaped.
async function tellrawStream(rconExec, mcContainer, name, text, log) {
  const component = ['',
    { text: '[Garvis] ', color: 'aqua', bold: true },
    { text: `📺 ${name} (stream): `, color: 'gold' },
    { text: String(text), color: 'white' },
  ];
  const res = await rconExec(mcContainer, ['tellraw', '@a', JSON.stringify(component)]);
  if (!res.ran) log(`tellraw failed: ${(res.output || '').slice(0, 120)}`);
}

// Claim the oldest queued command, marking it running. SKIP LOCKED keeps this
// safe even if a second bot instance ever runs.
async function claimNext(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `SELECT * FROM stream_commands WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!r.rows.length) { await c.query('COMMIT'); return null; }
    const cmd = r.rows[0];
    await c.query(`UPDATE stream_commands SET status = 'running', started_at = now() WHERE id = $1`, [cmd.id]);
    await c.query('COMMIT');
    return cmd;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Start the worker. All capabilities are injected from index.js wiring:
//   classify(text) -> { intent, body, ... }   (the in-game classifier, fails safe to qa)
//   runBody(body)  -> { ok, text }            (runBodyAction pre-bound with asker:null)
//   runTv({player, request}) -> { ok, text }  (showOnTv)
// Returns { stop }.
export function startStreamWorker({
  pgUrl,
  owncastUrl,
  owncastToken,
  classify,
  runBody,
  runTv,
  rconExec,
  mcContainer,
  pollMs = 2500,
  log = (m) => console.log(`[stream] ${m}`),
}) {
  let stopped = false;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  pool.on('error', (e) => log(`idle pool error: ${e.message}`));

  const processOne = async (cmd) => {
    const name = cmd.display_name || 'viewer';
    const t0 = Date.now();
    let intent = { intent: 'qa' };
    let out;
    let refused = false;
    try {
      intent = await classify(cmd.request);
      if (intent.intent === 'body') {
        out = await runBody(intent.body);
      } else if (intent.intent === 'tv') {
        out = await runTv({ player: name, request: cmd.request });
      } else {
        refused = true;
        out = {
          ok: false,
          text: 'that reads like chat, not a command — from the stream I do body work (mine <block> / farm / follow <player> / go to <x y z> / spectate <player>) and TV spots ("put a creeper on the TV").',
        };
      }
    } catch (e) {
      out = { ok: false, text: 'I hit a snag on that one — no credit spent, give it another go in a moment.' };
      log(`command ${cmd.id} (${name}) failed: ${e.message}`);
    }

    // Burn exactly one credit, only for a command that actually ran and worked.
    let left = null;
    if (out.ok) {
      try {
        const r = await pool.query(
          `UPDATE stream_viewers SET credits = GREATEST(credits - 1, 0), updated_at = now() WHERE owncast_id = $1 RETURNING credits`,
          [cmd.owncast_id],
        );
        left = r.rows[0]?.credits ?? null;
      } catch (e) { log(`credit burn failed for ${cmd.owncast_id}: ${e.message}`); }
    }

    const status = out.ok ? 'done' : refused ? 'refused' : 'failed';
    await pool.query(
      `UPDATE stream_commands SET status = $2, intent = $3, reply = $4, credit_spent = $5, finished_at = now() WHERE id = $1`,
      [cmd.id, status, intent.intent ?? null, out.text ?? null, Boolean(out.ok)],
    ).catch((e) => log(`finish update failed for ${cmd.id}: ${e.message}`));

    const suffix = out.ok ? ` · −1 credit${left == null ? '' : `, ${left} left`}` : ' · no credit spent';
    await sendStreamChat(owncastUrl, owncastToken, `@${name} ${out.text}${suffix}`, log);
    if (out.ok) await tellrawStream(rconExec, mcContainer, name, out.text, log);

    logTurn({
      source: 'stream', server: mcContainer, trigger: '!g', player: name,
      playerId: cmd.owncast_id, intent: intent.intent ?? 'qa', request: cmd.request,
      response: out.text, success: out.ok, latencyMs: Date.now() - t0,
      metadata: { commandId: Number(cmd.id), creditSpent: Boolean(out.ok), refused },
    });
    log(`#${cmd.id} ${name} [${intent.intent}] ${status}: ${String(cmd.request).slice(0, 80)}`);
  };

  (async () => {
    // Boot: ensure the shared schema, then re-queue commands orphaned mid-run
    // by a previous bot restart (single logical worker, so this is safe).
    for (;;) {
      if (stopped) return;
      try {
        await pool.query(SCHEMA);
        await pool.query(`UPDATE stream_commands SET status = 'queued', started_at = NULL WHERE status = 'running'`);
        break;
      } catch (e) {
        log(`pg not ready (${e.message}) — retrying in 10s`);
        await sleep(10_000);
      }
    }
    log(`worker up — polling every ${pollMs}ms, owncast=${owncastUrl}`);
    while (!stopped) {
      let worked = false;
      try {
        const cmd = await claimNext(pool);
        if (cmd) { worked = true; await processOne(cmd); }
      } catch (e) {
        log(`tick failed: ${e.message}`);
        await sleep(pollMs * 4);
      }
      if (!worked) await sleep(pollMs);
    }
  })();

  return {
    stop() { stopped = true; pool.end().catch(() => {}); },
  };
}

// ── Free chat bridge (web → game) ────────────────────────────────────────────
// Mirrors every message typed in the Owncast stream chat at tv.starting.cc into
// Minecraft chat as "📺 <name>: <text>", so in-game players can hear the web
// audience. One-way on purpose — game chat never leaves the world.
//
// Transport: no token and no tollbooth involved. The bridge registers itself an
// ANONYMOUS chat user (the same POST /api/chat/register the web page uses) and
// polls the visible-message backlog (GET /api/chat?accessToken=…) every couple
// of seconds. Owncast invalidating the token (401/403, e.g. a wiped chat db)
// just triggers a re-register; a down Owncast idles the loop.
//
// Trust model: viewer text is untrusted. It arrives as Owncast-rendered HTML —
// we reduce it to plain text (emotes → their :alt: text), strip control chars,
// and cap the length; tellraw carries it as a JSON string component, so it is
// always chat DATA, never a command. The 📺-gold rendering is deliberately
// distinct from a real "<player>" line, so a viewer who names themselves after
// a player can't forge player chat. Bot/integration-token messages (the paid
// worker's own replies) are skipped, so nothing echoes. A token bucket bounds
// a web flood's reach into game chat. Kill switch: GARVIS_STREAM_CHAT=off.

// Owncast message bodies are rendered HTML ("<p>hey</p>", emote <img> tags,
// <a> links). Flatten to chat-safe plain text: emotes become their alt text,
// tags drop, entities decode (AFTER tag-stripping, so "&lt;b&gt;" stays
// literal), control chars go, whitespace collapses.
function htmlToChatText(html) {
  const cp = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
  return String(html ?? '')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function startChatBridge({
  owncastUrl,
  rconExec,
  mcContainer,
  pollMs = 2000,
  maxLen = 256,
  log = (m) => console.log(`[bridge] ${m}`),
}) {
  let stopped = false;
  let token = null;
  let baselined = false;   // first fetch after (re-)register marks history seen, bridges nothing
  const seen = new Set();  // message ids already handled (insertion-ordered, pruned below)

  // Sustained ~1 line per 2s into game chat, bursting to 8 — beyond that,
  // messages are dropped (and logged), not queued: stale chat isn't worth relaying.
  const bucket = { cap: 8, tokens: 8, perMs: 2000, last: Date.now() };
  const takeToken = () => {
    const now = Date.now();
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + (now - bucket.last) / bucket.perMs);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const register = async () => {
    const r = await fetch(`${owncastUrl}/api/chat/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'garvis-bridge' }),
    });
    if (!r.ok) throw new Error(`register HTTP ${r.status}`);
    const j = await r.json();
    if (!j?.accessToken) throw new Error('register returned no accessToken');
    return j.accessToken;
  };

  const fetchBacklog = async () => {
    const r = await fetch(`${owncastUrl}/api/chat?accessToken=${encodeURIComponent(token)}`);
    if (r.status === 401 || r.status === 403) { token = null; throw new Error(`auth ${r.status} — re-registering`); }
    if (!r.ok) throw new Error(`chat HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  };

  const bridgeOne = async (m) => {
    const name = String(m.user?.displayName ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'viewer';
    const text = htmlToChatText(m.body).slice(0, maxLen);
    if (!text) return;
    if (!takeToken()) { log(`rate-limited, dropped ${name}: ${text.slice(0, 40)}`); return; }
    const component = ['',
      { text: '📺 ', color: 'aqua' },
      { text: name, color: 'gold', hoverEvent: { action: 'show_text', contents: 'watching the stream at tv.starting.cc' } },
      { text: ': ', color: 'gray' },
      { text, color: 'white' },
    ];
    const res = await rconExec(mcContainer, ['tellraw', '@a', JSON.stringify(component)]);
    if (!res.ran) log(`tellraw failed: ${(res.output || '').slice(0, 120)}`);
    else log(`${name}: ${text.slice(0, 80)}`);
  };

  (async () => {
    while (!stopped) {
      try {
        if (!token) { token = await register(); baselined = false; }
        const msgs = await fetchBacklog();
        if (!baselined) {
          for (const m of msgs) if (m?.id) seen.add(m.id);
          baselined = true;
          log(`up — polling every ${pollMs}ms (${msgs.length} backlog messages skipped)`);
        } else {
          for (const m of msgs) {
            if (stopped) return;
            if (!m?.id || seen.has(m.id)) continue;
            seen.add(m.id);
            // Real viewers only: skip non-chat events and any token-backed
            // identity (isBot, or a non-empty scope — anonymous users carry
            // [""]), so the paid worker's own replies never echo back in.
            if (m.type !== 'CHAT' || m.user?.isBot || (m.user?.scopes || []).some(Boolean)) continue;
            await bridgeOne(m);
          }
        }
        // The backlog is a bounded window (~300 messages), so pruning to a
        // floor above that can never resurrect an id that's still fetchable.
        for (const id of seen) { if (seen.size <= 1000) break; seen.delete(id); }
        await sleep(pollMs);
      } catch (e) {
        log(`tick failed: ${e.message}`);
        await sleep(Math.max(pollMs * 5, 10_000));
      }
    }
  })();

  return { stop() { stopped = true; } };
}
