// Conversation log → Postgres. A durable, queryable transcript of every Garvis
// turn — starting with the in-game `!g` bridge (player message, intent, Garvis's
// reply, claude session id, success, latency, cost). Discord turns can be added
// later (Discord already retains its own chat history), so the schema is source-
// tagged from day one.
//
// DESIGN CONTRACT — this module is PURELY ADDITIVE and NEVER load-bearing:
//   1. If GARVIS_PG_URL (or DATABASE_URL) is unset, logging is a silent no-op and
//      the bot runs exactly as it did before this file existed.
//   2. Every accessor swallows its own errors (logs once) and NEVER throws, so a
//      down/slow Postgres can't block a reply or crash the Discord event loop —
//      the same degrade-don't-die discipline as db.js (the SQLite session store).
//   3. It does NOT touch db.js. That SQLite file remains the source of truth for
//      claude-session RESUME (load-bearing); this is a separate write-mostly table
//      that no live code path ever reads back. Losing it loses history, nothing more.
//
// pg is pure-JS (no native build), so it adds no toolchain weight on this nvm node.
import pg from 'pg';

const PG_URL = process.env.GARVIS_PG_URL || process.env.DATABASE_URL || '';

let pool = null;
let ready = false;

// One row per turn. `source`/`server`/`player_id` are forward-compatible columns so a
// Discord backfill (source='discord', player_id=<numeric id>) drops into the SAME table.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS garvis_messages (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            TEXT        NOT NULL,            -- 'minecraft' (later: 'discord')
  server            TEXT,                            -- container / tenant key, e.g. 'mc-neoforge'
  trigger           TEXT,                            -- '!g'
  player            TEXT        NOT NULL,            -- minecraft username (later: discord tag)
  player_id         TEXT,                            -- minecraft uuid / discord numeric id, when known
  intent            TEXT        NOT NULL,            -- 'qa' | 'give' | 'modreq'
  request_text      TEXT        NOT NULL,            -- what the player said, after the trigger token
  response_text     TEXT,                            -- Garvis's reply (null on a hard failure)
  claude_session_id TEXT,                            -- resume id, when a claude turn actually ran
  success           BOOLEAN,
  timed_out         BOOLEAN,
  error             TEXT,
  latency_ms        INTEGER,
  cost_usd          NUMERIC(10,4),
  num_turns         INTEGER,
  metadata          JSONB
);
CREATE INDEX IF NOT EXISTS garvis_messages_created_at_idx ON garvis_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS garvis_messages_player_idx     ON garvis_messages (player);
CREATE INDEX IF NOT EXISTS garvis_messages_source_idx     ON garvis_messages (source);
`;

const INSERT = `INSERT INTO garvis_messages
    (source, server, trigger, player, player_id, intent, request_text, response_text,
     claude_session_id, success, timed_out, error, latency_ms, cost_usd, num_turns, metadata)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;

// Connect + ensure the schema once at startup. Best-effort: on ANY failure we log once
// and leave logging disabled (ready stays false), so the bot keeps serving without a
// conversation log instead of crash-looping on a DB that isn't up yet.
export async function initConvLog() {
  if (!PG_URL) {
    console.log('[convlog] GARVIS_PG_URL unset — conversation logging disabled');
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: PG_URL,
      max: Number(process.env.GARVIS_PG_POOL_MAX ?? 4),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // A network blip on an IDLE pooled client emits 'error'; with no listener pg lets it
    // become an uncaught exception that kills the process. Swallow it — logTurn already
    // tolerates a dead pool, and the pool reconnects on the next query.
    pool.on('error', (e) => console.error(`[convlog] idle pool error: ${e.message}`));
    await pool.query(SCHEMA);
    ready = true;
    console.log('[convlog] connected — conversation logging ON');
  } catch (e) {
    console.error(`[convlog] init failed (logging disabled, bot continues): ${e.message}`);
    ready = false;
  }
}

// Insert one turn. Returns a promise the caller MAY await but never NEEDS to — it never
// rejects (all errors are swallowed here), so callers fire-and-forget AFTER replying so
// the player's reply is never delayed by the DB. Unknown numeric/boolean fields store NULL.
export function logTurn(turn = {}) {
  if (!ready || !pool) return Promise.resolve();
  const vals = [
    turn.source ?? 'minecraft',
    turn.server ?? null,
    turn.trigger ?? null,
    String(turn.player ?? 'unknown'),
    turn.playerId ?? null,
    turn.intent ?? 'qa',
    String(turn.request ?? ''),
    turn.response == null ? null : String(turn.response),
    turn.sessionId ?? null,
    typeof turn.success === 'boolean' ? turn.success : null,
    typeof turn.timedOut === 'boolean' ? turn.timedOut : null,
    turn.error == null ? null : String(turn.error).slice(0, 2000),
    Number.isFinite(turn.latencyMs) ? Math.round(turn.latencyMs) : null,
    Number.isFinite(turn.costUsd) ? turn.costUsd : null,
    Number.isFinite(turn.numTurns) ? Math.round(turn.numTurns) : null,
    // pg JSON-encodes a plain object/array for a jsonb param; pass null to store SQL NULL.
    turn.metadata == null ? null : turn.metadata,
  ];
  return pool.query(INSERT, vals).then(
    () => {},
    (e) => { console.error(`[convlog] insert failed (turn dropped): ${e.message}`); },
  );
}

export async function closeConvLog() {
  try { await pool?.end(); } catch { /* ignore */ }
}
