// Ledger schema for the tollbooth — KEEP IN SYNC with the consumer's copy in
// apps/garvis-bot/src/streamchat.js (both sides CREATE IF NOT EXISTS at boot,
// so neither cares which comes up first). Three tables, one flow:
//   stream_codes    — a paid /buy mints one redeem code worth N credits
//   stream_viewers  — !redeem binds a code to an Owncast chat identity
//   stream_commands — !g <text> from a credited viewer queues here; the
//                     garvis-bot worker (host) claims, executes, replies.
export const SCHEMA = `
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

// Ensure the schema exists, retrying until Postgres is up (compose start order
// isn't guaranteed and depends_on doesn't wait for readiness).
export async function initDb(pool, log) {
  for (;;) {
    try {
      await pool.query(SCHEMA);
      log('schema ready');
      return;
    } catch (e) {
      log(`pg not ready (${e.message}) — retrying in 5s`);
      await sleep(5_000);
    }
  }
}
