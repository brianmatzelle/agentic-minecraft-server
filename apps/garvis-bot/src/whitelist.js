// @Garvis whitelist plumbing (Layer 3).
//
// This is the ONLY place the bot touches the LIVE game server, and it does so
// DIRECTLY (node child_process), NOT through a spawned `claude` agent. That split is
// deliberate: the sandboxed maintenance agent is denied docker/rcon (AGENT_DENY_TOOLS
// in index.js, see docs/security.md) because it acts on untrusted chat text; the bot
// process itself is trusted (it holds the token, runs on the host) and only reaches
// here behind a username-validation + cooldown gate (no allowlist — /whitelist is
// open to everyone). Keep this file small and easy to audit.
//
// Mechanism is "live + persist":
//   1. `docker exec <container> rcon-cli whitelist add <name>` — instant, no restart,
//      nobody gets kicked. The server resolves the Mojang account and writes
//      whitelist.json itself.
//   2. Append <name> to MC_WHITELIST in apps/server/.env so it SURVIVES a restart —
//      compose sets OVERRIDE_WHITELIST=TRUE, which rewrites whitelist.json from
//      MC_WHITELIST on every start, so a live-only add would be silently wiped.
// Both steps are idempotent. Usernames are validated to Minecraft's Java charset and
// only ever passed as argv (execFile, no shell), so a username can never be a command.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Minecraft Java Edition usernames: 3–16 chars, [A-Za-z0-9_]. Reject everything else
// BEFORE it reaches argv or the .env file. Returns the cleaned name, or null if invalid.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export function validateUsername(raw) {
  const name = String(raw ?? '').trim();
  return USERNAME_RE.test(name) ? name : null;
}

// Serialize .env read-modify-writes so two concurrent /whitelist calls can't clobber
// each other's addition (last-writer-wins would drop a name). One bot process, so an
// in-process chain is enough.
let envChain = Promise.resolve();
function serializeEnv(fn) {
  const run = envChain.then(fn, fn);
  envChain = run.then(() => {}, () => {});
  return run;
}

// Idempotently add (or, with {remove:true}, drop) `name` in a comma-separated env LIST
// — MC_WHITELIST, MC_OPS, … — preserving every other line, the key's spacing, and any
// inline `# comment`. Dedupe/match is case-insensitive (Minecraft matches names that
// way) but the caller's casing is kept on add. Atomic write (temp + rename) so a crash
// can't truncate the live .env, and the file's original mode (likely 0600) is preserved.
// `key` is an internal constant (never user input), so building a RegExp from it is safe.
// Returns {alreadyPresent, removed, list}.
export function upsertEnvListName(envPath, key, name, { remove = false } = {}) {
  return serializeEnv(async () => {
    const content = await readFile(envPath, 'utf8');
    const lines = content.split('\n');
    const keyRe = new RegExp(`^\\s*${key}\\s*=`);
    const idx = lines.findIndex((l) => keyRe.test(l));
    if (idx === -1) throw new Error(`${key} not found in ${envPath}`);

    const m = lines[idx].match(new RegExp(`^(\\s*${key}\\s*=)(.*)$`));
    const prefix = m[1];
    let rest = m[2];
    let comment = '';
    const cm = rest.match(/\s+#.*$/);          // a dotenv inline comment needs leading whitespace
    if (cm) { comment = rest.slice(cm.index); rest = rest.slice(0, cm.index); }

    const current = rest.trim() ? rest.trim().split(',').map((s) => s.trim()).filter(Boolean) : [];
    const alreadyPresent = current.some((u) => u.toLowerCase() === name.toLowerCase());
    let list = current;
    if (remove) list = current.filter((u) => u.toLowerCase() !== name.toLowerCase());
    else if (!alreadyPresent) list = [...current, name];

    lines[idx] = `${prefix}${list.join(',')}${comment}`;
    const next = lines.join('\n');

    if (next !== content) {
      const mode = await stat(envPath).then((s) => s.mode & 0o777).catch(() => 0o600);
      const tmp = join(dirname(envPath), `.env.garvis.${process.pid}.tmp`);
      await writeFile(tmp, next, { mode });
      await chmod(tmp, mode).catch(() => {});
      await rename(tmp, envPath);              // atomic on the same filesystem
    }
    return { alreadyPresent, removed: remove && alreadyPresent, list };
  });
}

// Back-compat thin wrapper: /whitelist still calls this. Adds to MC_WHITELIST.
export function addUsernameToWhitelistEnv(envPath, username) {
  return upsertEnvListName(envPath, 'MC_WHITELIST', username);
}

// `docker exec <container> rcon-cli whitelist add <username>`. execFile => no shell =>
// the username is argv, never interpretable as a command. Returns {ran, output}:
// ran=false means we couldn't even reach the server/docker (it may be down/restarting).
export function rconWhitelistAdd(container, username, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, 'rcon-cli', 'whitelist', 'add', username], { timeout: timeoutMs },
      (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        // A nonzero exit from the rcon command still gives usable stdout (e.g. "That
        // player does not exist"); only a spawn/exec failure with NO output means we
        // genuinely couldn't talk to the server.
        if (err && !output) resolve({ ran: false, output: err.message });
        else resolve({ ran: true, output });
      });
  });
}

// Map rcon-cli's human text to an outcome. The exact wording varies across server
// versions, so match loosely and fall back to 'unknown' (treated as success — the add
// almost certainly took; we don't want to swallow a real success on a wording change).
export function classifyWhitelistOutput(output) {
  const o = String(output ?? '').toLowerCase();
  if (o.includes('does not exist') || o.includes('could not resolve') ||
      o.includes('no player was found') || o.includes('unknown player')) return 'nonexistent';
  if (o.includes('already whitelisted')) return 'already';
  if (o.includes('added') && o.includes('whitelist')) return 'added';
  return 'unknown';
}
