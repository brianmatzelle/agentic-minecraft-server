// @Garvis live moderation (Layer 3) — the FIXED verb catalog.
//
// This is the safe-by-construction core of "friends are server moderators, abstracted
// by Garvis". The flow is:
//
//   untrusted Discord text  ->  Garvis (LLM) proposes {action, args}  ->  THIS module
//   validates the action against a hard-coded catalog + per-arg validators  ->  the bot
//   runs a FIXED `docker exec <container> rcon-cli <verb> <validated argv>` (execFile,
//   no shell).
//
// The model NEVER holds a shell and NEVER constructs a command. Even a fully
// prompt-injected Garvis can only ever name a catalog verb with validated args — it has
// no path to `docker run`, the host shell, the live world, or secrets, because those
// code paths do not exist in this module. That is the whole point: this is the same
// boundary whitelist.js already relies on, generalized to the full moderator toolkit.
//
// Prompt-injection of the CLASSIFIER buys an attacker nothing: destructive verbs are
// role-gated in the bot (index.js) independently of anything the LLM says, every arg is
// re-validated here, and the worst an injected OPEN verb can do (set weather, give an
// item, broadcast) is reversible, audited, and already available to any normal user.
//
// Persistence mirrors whitelist.js: actions the compose OVERRIDE_* rewrites would wipe
// on restart (whitelist, ops) are written back to the repo .env source of truth. Bans
// live in server-data/banned-*.json and survive restarts on their own.
import { execFile } from 'node:child_process';
import { validateUsername, upsertEnvListName } from './whitelist.js';

// ── arg validators ──────────────────────────────────────────────────────────
// Each returns { ok: true, value } or { ok: false, error }. Values only ever reach
// argv (execFile), so this is about sane input, not shell-escaping — but we still keep
// every field on a tight allowlist so a verb can't be coerced into surprising behavior.
const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

function vUsername(raw) {
  const u = validateUsername(raw);
  return u ? ok(u) : bad(`\`${String(raw).slice(0, 24)}\` isn't a valid Minecraft Java username (3–16 chars: letters, numbers, _).`);
}

// Free-ish text (kick/ban reason, broadcast). Strip control chars + newlines, collapse
// whitespace, cap length. Stays argv, so this is cosmetic safety, not injection defense.
function vText(max) {
  return (raw) => {
    const t = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    return t ? ok(t) : bad('that text was empty after cleanup.');
  };
}

function vInt(min, max) {
  return (raw) => {
    const n = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isInteger(n)) return bad(`expected a whole number (got \`${String(raw).slice(0, 16)}\`).`);
    if (n < min || n > max) return bad(`number must be between ${min} and ${max}.`);
    return ok(String(n));
  };
}

function vEnum(...values) {
  const set = new Set(values);
  return (raw) => {
    const v = String(raw ?? '').trim().toLowerCase();
    return set.has(v) ? ok(v) : bad(`must be one of: ${values.join(', ')}.`);
  };
}

// Minecraft time: a named tick or a raw 0–24000 tick count.
function vTimeSpec(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['day', 'night', 'noon', 'midnight'].includes(v)) return ok(v);
  return vInt(0, 24000)(v);
}

// A namespaced item/block id, e.g. minecraft:diamond or just diamond.
function vItem(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9_]+(:[a-z0-9_/]+)?$/.test(v) && v.length <= 64 ? ok(v) : bad(`\`${String(raw).slice(0, 24)}\` isn't a valid item id (letters, numbers, _, optional namespace).`);
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
function vIpOrName(raw) {
  const v = String(raw ?? '').trim();
  if (IPV4_RE.test(v)) return ok(v);
  return vUsername(v);
}
function vIp(raw) {
  const v = String(raw ?? '').trim();
  return IPV4_RE.test(v) ? ok(v) : bad(`\`${String(raw).slice(0, 24)}\` isn't a valid IPv4 address.`);
}

// Curated gamerule allowlist (rule -> value type). Keeps gamerule tidy and bounded; add
// more here as needed. `bool` => true/false, `int` => a small non-negative number.
const GAMERULES = {
  keepInventory: 'bool', doDaylightCycle: 'bool', doWeatherCycle: 'bool',
  doMobSpawning: 'bool', mobGriefing: 'bool', doFireTick: 'bool', doInsomnia: 'bool',
  doImmediateRespawn: 'bool', fallDamage: 'bool', naturalRegeneration: 'bool',
  showDeathMessages: 'bool', announceAdvancements: 'bool', doMobLoot: 'bool',
  doTileDrops: 'bool', pvp: 'bool', randomTickSpeed: 'int', playersSleepingPercentage: 'int',
};

// ── the verb catalog ─────────────────────────────────────────────────────────
// Each verb: { summary, gated, params|resolve, build, persist?, confirm, examples }.
//   gated   — true => destructive: requires the mod role (or owner). One-line editable.
//   params  — ordered [{name, required, validate, hint}]; generic loop validates them.
//   resolve — optional; fully validates args itself (used when one arg depends on another,
//             e.g. gamerule value depends on the rule). Returns {ok, values}|{error}.
//   build   — (values) => { kind: 'rcon', argv: [...] }  OR  { kind: 'restart' }.
//   persist — optional async (envPath, values) => {} to write the repo source of truth.
//   confirm — (values, output) => friendly Discord string.
export const VERBS = {
  // ---- OPEN: additive / reversible, available to everyone (like /whitelist today) ----
  whitelist_add: {
    summary: 'whitelist a player so they can join', gated: false,
    params: [{ name: 'player', required: true, validate: vUsername, hint: 'Java username' }],
    build: (v) => ({ kind: 'rcon', argv: ['whitelist', 'add', v.player] }),
    persist: (envPath, v) => upsertEnvListName(envPath, 'MC_WHITELIST', v.player),
    confirm: (v) => `✅ \`${v.player}\` is whitelisted — they can hop on now.`,
    examples: ['whitelist Steve', 'let Alex join', 'add me to the whitelist, my name is Notch'],
  },
  list: {
    summary: 'list who is online', gated: false, params: [],
    build: () => ({ kind: 'rcon', argv: ['list'] }),
    confirm: (_v, out) => `👥 ${out || 'no response from the server.'}`,
    examples: ['who is online?', 'list players'],
  },
  broadcast: {
    summary: 'send a chat message to everyone on the server', gated: false,
    params: [{ name: 'message', required: true, validate: vText(240), hint: 'the message' }],
    build: (v) => ({ kind: 'rcon', argv: ['say', v.message] }),
    confirm: (v) => `📣 Broadcast: _${v.message}_`,
    examples: ['announce that the server is restarting soon', 'say hello everyone'],
  },
  time_set: {
    summary: 'set the world time', gated: false,
    params: [{ name: 'value', required: true, validate: vTimeSpec, hint: 'day/night/noon/midnight or 0–24000' }],
    build: (v) => ({ kind: 'rcon', argv: ['time', 'set', v.value] }),
    confirm: (v) => `🕑 Set time to \`${v.value}\`.`,
    examples: ['set it to day', 'make it night', 'time set noon'],
  },
  weather: {
    summary: 'set the weather', gated: false,
    params: [
      { name: 'type', required: true, validate: vEnum('clear', 'rain', 'thunder'), hint: 'clear/rain/thunder' },
      { name: 'duration', required: false, validate: vInt(1, 1_000_000), hint: 'optional seconds' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['weather', v.type, ...(v.duration ? [v.duration] : [])] }),
    confirm: (v) => `🌦️ Weather set to \`${v.type}\`.`,
    examples: ['make it sunny', 'set weather to thunder', 'stop the rain'],
  },
  tp: {
    summary: 'teleport one player to another', gated: false,
    params: [
      { name: 'who', required: true, validate: vUsername, hint: 'player to move' },
      { name: 'to', required: true, validate: vUsername, hint: 'destination player' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['tp', v.who, v.to] }),
    confirm: (v) => `🌀 Teleported \`${v.who}\` to \`${v.to}\`.`,
    examples: ['tp Steve to Alex', 'teleport me to Notch'],
  },
  give: {
    summary: 'give an item to a player', gated: false,
    params: [
      { name: 'player', required: true, validate: vUsername, hint: 'recipient' },
      { name: 'item', required: true, validate: vItem, hint: 'item id, e.g. minecraft:diamond' },
      { name: 'count', required: false, validate: vInt(1, 6400), hint: 'optional amount' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['give', v.player, v.item, ...(v.count ? [v.count] : [])] }),
    confirm: (v) => `🎁 Gave \`${v.player}\` ${v.count || 1}× \`${v.item}\`.`,
    examples: ['give Steve 64 diamonds', 'give me an elytra'],
  },
  difficulty: {
    summary: 'set the world difficulty', gated: false,
    params: [{ name: 'level', required: true, validate: vEnum('peaceful', 'easy', 'normal', 'hard'), hint: 'peaceful/easy/normal/hard' }],
    build: (v) => ({ kind: 'rcon', argv: ['difficulty', v.level] }),
    confirm: (v) => `⚔️ Difficulty set to \`${v.level}\`.`,
    examples: ['set difficulty to hard', 'make it peaceful'],
  },
  gamerule: {
    summary: `toggle a gamerule (supported: ${Object.keys(GAMERULES).join(', ')})`, gated: false,
    resolve: (args) => {
      const rule = Object.keys(GAMERULES).find((r) => r.toLowerCase() === String(args.rule ?? '').trim().toLowerCase());
      if (!rule) return bad(`unsupported gamerule. Supported: ${Object.keys(GAMERULES).join(', ')}.`);
      const type = GAMERULES[rule];
      if (type === 'bool') {
        const r = vEnum('true', 'false')(args.value);
        return r.ok ? ok({ rule, value: r.value }) : bad(`\`${rule}\` takes true or false.`);
      }
      const r = vInt(0, 100000)(args.value);
      return r.ok ? ok({ rule, value: r.value }) : bad(`\`${rule}\` takes a whole number.`);
    },
    build: (v) => ({ kind: 'rcon', argv: ['gamerule', v.rule, v.value] }),
    confirm: (v) => `🎚️ \`${v.rule}\` = \`${v.value}\`.`,
    examples: ['turn on keepInventory', 'stop the day/night cycle', 'set randomTickSpeed to 6'],
  },

  // ---- GATED: destructive — require the mod role (or owner) ----
  whitelist_remove: {
    summary: 'remove a player from the whitelist (locks them out)', gated: true,
    params: [{ name: 'player', required: true, validate: vUsername, hint: 'Java username' }],
    build: (v) => ({ kind: 'rcon', argv: ['whitelist', 'remove', v.player] }),
    persist: (envPath, v) => upsertEnvListName(envPath, 'MC_WHITELIST', v.player, { remove: true }),
    confirm: (v) => `🚫 Removed \`${v.player}\` from the whitelist.`,
    examples: ['unwhitelist Steve', 'remove Alex from the whitelist'],
  },
  kick: {
    summary: 'kick a player (disconnects them once)', gated: true,
    params: [
      { name: 'player', required: true, validate: vUsername, hint: 'Java username' },
      { name: 'reason', required: false, validate: vText(100), hint: 'optional reason' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['kick', v.player, ...(v.reason ? [v.reason] : [])] }),
    confirm: (v) => `👢 Kicked \`${v.player}\`${v.reason ? ` — _${v.reason}_` : ''}.`,
    examples: ['kick Steve', 'kick Alex for spamming'],
  },
  ban: {
    summary: 'ban a player from the server', gated: true,
    params: [
      { name: 'player', required: true, validate: vUsername, hint: 'Java username' },
      { name: 'reason', required: false, validate: vText(100), hint: 'optional reason' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['ban', v.player, ...(v.reason ? [v.reason] : [])] }),
    confirm: (v) => `🔨 Banned \`${v.player}\`${v.reason ? ` — _${v.reason}_` : ''}.`,
    examples: ['ban Steve for griefing', 'please ban Notch'],
  },
  pardon: {
    summary: 'unban a player', gated: true,
    params: [{ name: 'player', required: true, validate: vUsername, hint: 'Java username' }],
    build: (v) => ({ kind: 'rcon', argv: ['pardon', v.player] }),
    confirm: (v) => `🕊️ Unbanned \`${v.player}\`.`,
    examples: ['unban Steve', 'pardon Alex'],
  },
  ban_ip: {
    summary: 'ban an IP address (or the IP of an online player)', gated: true,
    params: [
      { name: 'target', required: true, validate: vIpOrName, hint: 'IPv4 or online player name' },
      { name: 'reason', required: false, validate: vText(100), hint: 'optional reason' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['ban-ip', v.target, ...(v.reason ? [v.reason] : [])] }),
    confirm: (v) => `🔨 IP-banned \`${v.target}\`.`,
    examples: ['ip ban 1.2.3.4', 'ban the IP of Steve'],
  },
  pardon_ip: {
    summary: 'unban an IP address', gated: true,
    params: [{ name: 'ip', required: true, validate: vIp, hint: 'IPv4 address' }],
    build: (v) => ({ kind: 'rcon', argv: ['pardon-ip', v.ip] }),
    confirm: (v) => `🕊️ Unbanned IP \`${v.ip}\`.`,
    examples: ['unban ip 1.2.3.4'],
  },
  op: {
    summary: 'grant operator (in-game admin) to a player', gated: true,
    params: [{ name: 'player', required: true, validate: vUsername, hint: 'Java username' }],
    build: (v) => ({ kind: 'rcon', argv: ['op', v.player] }),
    persist: (envPath, v) => upsertEnvListName(envPath, 'MC_OPS', v.player),
    confirm: (v) => `⭐ \`${v.player}\` is now an operator.`,
    examples: ['op Steve', 'make Alex an admin'],
  },
  deop: {
    summary: 'revoke operator from a player', gated: true,
    params: [{ name: 'player', required: true, validate: vUsername, hint: 'Java username' }],
    build: (v) => ({ kind: 'rcon', argv: ['deop', v.player] }),
    persist: (envPath, v) => upsertEnvListName(envPath, 'MC_OPS', v.player, { remove: true }),
    confirm: (v) => `🔻 \`${v.player}\` is no longer an operator.`,
    examples: ['deop Steve', 'remove Alex as admin'],
  },
  gamemode: {
    summary: 'set a player\'s game mode', gated: true,
    params: [
      { name: 'mode', required: true, validate: vEnum('survival', 'creative', 'adventure', 'spectator'), hint: 'survival/creative/adventure/spectator' },
      { name: 'player', required: true, validate: vUsername, hint: 'Java username' },
    ],
    build: (v) => ({ kind: 'rcon', argv: ['gamemode', v.mode, v.player] }),
    confirm: (v) => `🎮 Set \`${v.player}\` to \`${v.mode}\`.`,
    examples: ['put Steve in creative', 'set Alex to survival'],
  },
  restart: {
    summary: 'restart the Minecraft server (brief downtime)', gated: true, params: [],
    build: () => ({ kind: 'restart' }),
    confirm: () => `🔄 Restarting the server — it'll be back in a minute or two.`,
    examples: ['restart the server', 'reboot the server'],
  },
};

export function isDestructive(name) {
  return Boolean(VERBS[name]?.gated);
}

// Parse the action classifier's reply. We ask Garvis for a single JSON object, but be
// defensive about stray prose / ```json fences. Returns { action: string|null, args }.
// On anything unparseable we return action:null so the caller safely treats the message
// as a normal question/mod-request (never a phantom action).
export function parseClassification(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return { action: null, args: {} };
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    if (!obj || typeof obj !== 'object') return { action: null, args: {} };
    const action = obj.action == null ? null : String(obj.action).trim();
    const args = obj.args && typeof obj.args === 'object' ? obj.args : {};
    return { action: action || null, args };
  } catch {
    return { action: null, args: {} };
  }
}

// Render the catalog as a compact menu for the classifier prompt.
export function catalogMenu() {
  return Object.entries(VERBS).map(([name, v]) => {
    const argList = v.resolve
      ? '(see summary)'
      : (v.params.length ? v.params.map((p) => p.required ? p.name : `${p.name}?`).join(', ') : '(none)');
    return `- ${name}(${argList})${v.gated ? ' [mod-only]' : ''}: ${v.summary}. e.g. ${(v.examples || [])[0] ?? ''}`;
  }).join('\n');
}

// Validate a proposed {action, args} against the catalog. Returns
// { ok:true, name, gated, build, persist, confirm, values } or { ok:false, error }.
export function resolveAction(action, args = {}) {
  const name = String(action ?? '').trim();
  const verb = VERBS[name];
  if (!verb) return { ok: false, error: `unknown action \`${name.slice(0, 32)}\`.` };
  const a = args && typeof args === 'object' ? args : {};

  let values;
  if (verb.resolve) {
    const r = verb.resolve(a);
    if (!r.ok) return { ok: false, error: r.error };
    values = r.value;
  } else {
    values = {};
    for (const p of verb.params) {
      const raw = a[p.name];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (p.required) return { ok: false, error: `missing \`${p.name}\` (${p.hint}).` };
        continue;
      }
      const r = p.validate(raw);
      if (!r.ok) return { ok: false, error: `\`${p.name}\`: ${r.error}` };
      values[p.name] = r.value;
    }
  }
  return { ok: true, name, gated: verb.gated, build: verb.build, persist: verb.persist || null, confirm: verb.confirm, values };
}

// ── execution (the only place a verb touches the live server) ────────────────
// Generic `docker exec <container> rcon-cli <argv...>`. argv is an ARRAY passed to
// execFile (no shell), so a validated arg can never be reinterpreted as a command.
export function rconExec(container, argv, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, 'rcon-cli', ...argv], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !output) resolve({ ran: false, output: err.message });
      else resolve({ ran: true, output });
    });
  });
}

// `docker restart <container>` for the restart verb (not an rcon command).
export function dockerRestart(container, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', ['restart', container], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !output) resolve({ ran: false, output: err.message });
      else resolve({ ran: true, output });
    });
  });
}

// Run a resolved action against the live server, then persist to the repo .env source of
// truth if the verb requires it. Returns { ran, output }. Caller handles the role gate
// (index.js) BEFORE calling this — execution here assumes authorization already passed.
export async function runAction(resolved, { container, envPath }) {
  const built = resolved.build(resolved.values);
  let res;
  if (built.kind === 'restart') res = await dockerRestart(container);
  else res = await rconExec(container, built.argv);
  if (res.ran && resolved.persist && envPath) {
    try { await resolved.persist(envPath, resolved.values); }
    catch (e) { res.persistError = e.message; }
  }
  return res;
}
