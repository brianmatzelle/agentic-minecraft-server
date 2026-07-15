// Durable thread -> claude-session mapping for @Garvis, via Node's built-in
// node:sqlite (no native deps). Survives bot restarts so debug threads can
// resume their conversation. Prepared statements => no SQL injection.
// All accessors are guarded: a DB error logs and degrades, never crashes the
// Discord event loop. session_id is a resume capability, so the store is 0600.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GARVIS_DB_PATH || resolve(__dirname, '..', 'garvis.sqlite');

let db;
try {
  mkdirSync(dirname(DB_PATH), { recursive: true });   // node:sqlite will NOT create the dir
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');               // durable + safe concurrent reads
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS thread_sessions (
    thread_id        TEXT PRIMARY KEY,
    session_id       TEXT,            -- legacy (pre-mode); unused now, kept so old rows still load
    owner_id         TEXT NOT NULL,
    help_session_id  TEXT,            -- claude session for the read-only Q&A path (runs in the repo)
    maint_session_id TEXT,            -- claude session for the maintenance path (runs in the agent clone)
    updated_at       INTEGER NOT NULL
  );`);
  // Migrate DBs created before the per-mode columns existed. Claude sessions are
  // scoped to the dir they were created in, so the help (repo) and maintenance
  // (agent clone) sessions MUST be tracked separately — resuming one from the
  // other's cwd fails with "No conversation found". ALTER throws if the column is
  // already present (fresh DB created with the schema above); that's expected.
  for (const c of ['help_session_id', 'maint_session_id']) {
    try { db.exec(`ALTER TABLE thread_sessions ADD COLUMN ${c} TEXT`); } catch { /* column already present */ }
  }
  for (const s of ['', '-wal', '-shm']) { try { chmodSync(DB_PATH + s, 0o600); } catch { /* may not exist yet */ } }
} catch (e) {
  console.error(`Garvis DB init failed at ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

const selStmt = db.prepare('SELECT owner_id, help_session_id, maint_session_id, updated_at FROM thread_sessions WHERE thread_id = ?');
// Upsert ONE mode's session per call: the unused mode is passed as NULL and
// COALESCE preserves whatever was already stored, so a maintenance turn never
// clobbers the thread's help session (or vice-versa). owner_id is left untouched
// on conflict to keep the thread's original starter.
const upStmt = db.prepare(`INSERT INTO thread_sessions
    (thread_id, owner_id, help_session_id, maint_session_id, updated_at)
  VALUES (@thread, @owner, @help, @maint, @updated)
  ON CONFLICT(thread_id) DO UPDATE SET
    help_session_id  = COALESCE(@help,  thread_sessions.help_session_id),
    maint_session_id = COALESCE(@maint, thread_sessions.maint_session_id),
    updated_at       = @updated`);
const delStmt = db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?');

// Returns { ownerId, help, maint, updatedAt } — help/maint are per-mode claude
// session ids, either may be null; updatedAt is the epoch-ms of the last turn so
// callers can expire idle sessions — or null if the thread isn't tracked.
export function getSession(threadId) {
  try {
    const row = selStmt.get(String(threadId));
    if (!row) return null;
    return { ownerId: row.owner_id, help: row.help_session_id ?? null, maint: row.maint_session_id ?? null, updatedAt: row.updated_at ?? null };
  } catch (e) {
    console.error(`getSession failed: ${e.message}`);
    return null;
  }
}

// Persist the session for ONE mode ('help' | 'maint'); the other mode's stored
// session is preserved (see upStmt). ownerId is recorded on first insert only.
export function setSession(threadId, { mode, sessionId, ownerId }) {
  try {
    upStmt.run({
      thread: String(threadId),
      owner: String(ownerId),
      help: mode === 'help' ? (sessionId ?? null) : null,
      maint: mode === 'maint' ? (sessionId ?? null) : null,
      updated: Date.now(),
    });
  } catch (e) {
    console.error(`setSession failed: ${e.message}`);
  }
}

export function deleteSession(threadId) {
  try {
    delStmt.run(String(threadId));
  } catch (e) {
    console.error(`deleteSession failed: ${e.message}`);
  }
}

export function closeDb() {
  try { db.close(); } catch { /* ignore */ }
}
