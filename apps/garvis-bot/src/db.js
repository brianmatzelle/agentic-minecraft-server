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
    thread_id  TEXT PRIMARY KEY,
    session_id TEXT,
    owner_id   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  for (const s of ['', '-wal', '-shm']) { try { chmodSync(DB_PATH + s, 0o600); } catch { /* may not exist yet */ } }
} catch (e) {
  console.error(`Garvis DB init failed at ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

const selStmt = db.prepare('SELECT session_id, owner_id FROM thread_sessions WHERE thread_id = ?');
const upStmt = db.prepare(`INSERT INTO thread_sessions (thread_id, session_id, owner_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(thread_id) DO UPDATE SET
    session_id = excluded.session_id,
    owner_id   = excluded.owner_id,
    updated_at = excluded.updated_at`);
const delStmt = db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?');

export function getSession(threadId) {
  try {
    const row = selStmt.get(String(threadId));
    return row ? { sessionId: row.session_id ?? null, ownerId: row.owner_id } : null;
  } catch (e) {
    console.error(`getSession failed: ${e.message}`);
    return null;
  }
}

export function setSession(threadId, sessionId, ownerId) {
  try {
    upStmt.run(String(threadId), sessionId ?? null, String(ownerId), Date.now());
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
