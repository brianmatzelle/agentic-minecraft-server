# Conversation logging (Postgres)

Garvis writes a durable, queryable transcript of every conversation turn to Postgres.
**Phase 1 (live): the in-game `!g` bridge.** Discord turns are not logged yet — Discord
already retains its own chat history — but the schema is source-tagged so they can be
backfilled into the same table later.

## What's stored

One row per `!g` turn in `garvis_messages`, across all three branches of the bridge:

| intent   | when                                   | notable fields |
|----------|----------------------------------------|----------------|
| `qa`     | a question → the read-only Q&A brain   | `claude_session_id`, `latency_ms`, `cost_usd`, `num_turns`, `metadata.resumed` |
| `modreq` | "add/remove a mod" → the maint agent   | same claude metadata; response is the chat reply (incl. PR URL) |
| `give`   | an op's `!g give …` (or a denied one)  | `metadata.give` (item/count/recipient); denials store `success=false, error='not_op'` |

Columns: `created_at`, `source` (`'minecraft'`), `server` (the container, e.g.
`mc-neoforge` — the future tenant key), `trigger` (`!g`), `player`, `player_id` (null
in-game for now — the chat transport carries no UUID), `intent`, `request_text`,
`response_text`, `claude_session_id`, `success`, `timed_out`, `error`, `latency_ms`,
`cost_usd`, `num_turns`, `metadata` (JSONB).

## How it's wired

- **Postgres**: a `postgres:17` service in `apps/server/docker-compose.yml`, named volume
  `postgres-data`, bound to **`127.0.0.1:5432` only** (never off-box). Credentials come from
  `POSTGRES_*` in `apps/server/.env`.
- **Bot**: `apps/garvis-bot/src/convlog.js` — a `pg` pool that creates the schema
  idempotently on startup and exposes a best-effort `logTurn()`. The `!g` handler
  (`onInGameMessage` in `index.js`) calls it once per turn, **after** sending the reply.
  Connection string: `GARVIS_PG_URL` in `apps/garvis-bot/.env` (must match the
  `POSTGRES_*` above).

### Design contract — purely additive, never load-bearing

`convlog.js` is held to the same degrade-don't-die discipline as the SQLite session store
(`db.js`), but stricter, because it talks to a network service:

1. If `GARVIS_PG_URL` is unset, logging is a silent no-op — the bot runs exactly as before.
2. Every accessor swallows its own errors and **never throws**, so a down/slow Postgres
   can't block a `!g` reply or crash the event loop. Logging happens after the reply is
   sent, so it never adds latency the player feels.
3. It does **not** touch `db.js`. That SQLite file stays the source of truth for
   claude-session *resume* (load-bearing). `garvis_messages` is write-mostly history that
   no live code path reads back — losing it loses history, nothing else.

## Operating

```bash
# bring the DB up (additive — does not touch the MC server)
cd apps/server && docker compose up -d postgres

# the bot picks it up on (re)start:
systemctl --user restart garvis-bot
#   → log line "[convlog] connected — conversation logging ON" confirms it

# query the log
docker exec -it mc-postgres psql -U garvis -d garvis
#   SELECT created_at, player, intent, request_text, response_text FROM garvis_messages ORDER BY id DESC LIMIT 20;
```

Turn logging off without removing anything: blank `GARVIS_PG_URL` and restart the bot.

## Later

- **Discord backfill**: same table, `source='discord'`, `player_id=<numeric id>`. The
  @mention / slash paths already flow through the same `runClaude`, so a `logTurn()` at the
  `answerInThread` call sites is the whole change.
- **Offsite/backups**: `postgres-data` is local-only, like the world backups — see the
  offsite-backups TODO. A `pg_dump` sidecar or logical replication is the eventual plan.
