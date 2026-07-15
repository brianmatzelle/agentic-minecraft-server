// In-game BODY (Layer 3) — "!g come here / follow me / stay / go to <coords>":
// players command Garvis's physical in-game body (the camera account — a real
// modded client in the garviscam container with Baritone aboard).
//
// Two control planes, both fixed-argv execFile (no shell), both fed ONLY from
// validated parts — raw player text NEVER reaches either:
//   • rcon (moderation.js rconExec, passed in): presence checks, positions, the
//     spectator→survival flip, and the far-hop teleport.
//   • chat.sh (docker exec into the body container): xdotool-types a Baritone
//     command ("#follow player <name>", "#goto x y z", "#stop") into the live
//     client. Baritone intercepts '#' lines client-side, so they never reach
//     public chat.
//
// Safety posture: no world edits (Baritone allowBreak/allowPlace are false and
// this module never toggles settings), every action is visible and reversible
// ("!g stop"), and names/coords are RE-validated here even though the classifier
// already extracted them (same belt-and-braces as moderation.js resolveAction).
import { execFile } from 'node:child_process';

// Same shape ingame.js trusts for chat senders; a followee name from the
// classifier must ALSO resolve (case-insensitively) to an online player below.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// rcon-cli output arrives with terminal escapes (itzg TTY) — strip all CSI.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Beyond this, "follow"/"come" teleport the body to the target first. Two
// reasons: Baritone's "#follow player" only binds entities the CLIENT has
// loaded (server entity tracking ~48–64 blocks — a farther target yields "No
// valid entities in range!"), and nobody wants their companion to arrive
// tomorrow. Anchoring the hop to a PLAYER also makes the spectator→survival
// flip safe (players stand on ground; raw coords might not).
const MAX_WALK = 60;

// Type one line into the body client's chat. The line is ALWAYS built by us
// from validated parts — it lands in a live client as keystrokes.
function typeInClient(bodyContainer, line, { timeoutMs = 15_000 } = {}) {
  return new Promise((res) => {
    execFile('docker', ['exec', bodyContainer, '/opt/garviscam/chat.sh', line], { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ ran: !err, output: `${stdout ?? ''}${stderr ?? ''}`.replace(ANSI_RE, '').trim() });
    });
  });
}

async function rcon(rconExec, container, argv) {
  const res = await rconExec(container, argv);
  return { ran: res.ran, output: String(res.output ?? '').replace(ANSI_RE, '').trim() };
}

// Resolve a name against the live player list, case-insensitively, returning
// the server's canonical casing (the classifier may lowercase what was typed).
async function onlinePlayer(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['list']);
  if (!res.ran) return null;
  const names = (res.output.split(':').pop() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? null;
}

// "<name> has the following entity data: [-918.4d, 81.0d, -152.8d]" → {x,y,z}
async function getPos(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', name, 'Pos']);
  const m = res.output.match(/\[\s*(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\s*\]/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

// playerGameType: 0 survival, 1 creative, 2 adventure, 3 spectator.
async function isSpectator(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', name, 'playerGameType']);
  const m = res.output.match(/:\s*(\d+)\s*$/);
  return m ? Number(m[1]) === 3 : false;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Run one validated body action. `asker` is the server-stamped chat sender
// (trusted); `player`/coords come from the classifier (untrusted, re-checked).
// Returns { ok, text } — text is a short in-game chat line. Never throws.
export async function runBodyAction({ action, player, x, y, z }, { rconExec, mcContainer, bodyContainer, account, asker }) {
  const body = await onlinePlayer(rconExec, mcContainer, account);
  if (!body) return { ok: false, text: `My body (${account}) isn't in the game right now — ask an admin to check on it.` };

  if (action === 'stop') {
    const t = await typeInClient(bodyContainer, '#stop');
    return t.ran ? { ok: true, text: '🦿 Staying put.' } : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
  }

  if (action === 'goto') {
    // Coords were already number-checked in parseIngameClassification; clamp to
    // sane world bounds. y is optional — Baritone takes "#goto x z" fine.
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 30_000 || Math.abs(z) > 30_000) {
      return { ok: false, text: 'Those coordinates look off — give me x y z inside the world border.' };
    }
    const hasY = Number.isFinite(y) && y >= -64 && y <= 320;
    if (await isSpectator(rconExec, mcContainer, body)) {
      // Can't flip to survival mid-hover at the camera perch — anchor to the
      // asker (guaranteed on ground) before walking off.
      await rcon(rconExec, mcContainer, ['tp', body, asker]);
    }
    await rcon(rconExec, mcContainer, ['gamemode', 'survival', body]);
    const target = hasY ? `${Math.round(x)} ${Math.round(y)} ${Math.round(z)}` : `${Math.round(x)} ${Math.round(z)}`;
    const t = await typeInClient(bodyContainer, `#goto ${target}`);
    return t.ran
      ? { ok: true, text: `🦿 Heading to ${target} — long treks take a while ("!g stop" to cancel).` }
      : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
  }

  // follow / come — both anchor on a player: the named followee, or the asker.
  const rawTarget = action === 'come' || !player || player.toLowerCase() === 'me' ? asker : player;
  if (!USERNAME_RE.test(rawTarget)) return { ok: false, text: `"${rawTarget}" doesn't look like a player name.` };
  const target = await onlinePlayer(rconExec, mcContainer, rawTarget);
  if (!target) return { ok: false, text: `${rawTarget} isn't online right now.` };
  if (target === body) return { ok: false, text: "That's me — I can't follow myself." };

  const [bodyPos, targetPos, spectating] = await Promise.all([
    getPos(rconExec, mcContainer, body),
    getPos(rconExec, mcContainer, target),
    isSpectator(rconExec, mcContainer, body),
  ]);
  const far = !bodyPos || !targetPos || dist(bodyPos, targetPos) > MAX_WALK;
  if (spectating || far) await rcon(rconExec, mcContainer, ['tp', body, target]);
  await rcon(rconExec, mcContainer, ['gamemode', 'survival', body]);

  if (action === 'follow') {
    const t = await typeInClient(bodyContainer, `#follow player ${target}`);
    return t.ran
      ? { ok: true, text: `🦿 Following ${target}${spectating || far ? ' (hopped over to you first)' : ''} — "!g stop" when you want me to stay.` }
      : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
  }

  // come — walk to where they are NOW (or arrive instantly if we just hopped).
  if (spectating || far) {
    await typeInClient(bodyContainer, '#stop');
    return { ok: true, text: `🦿 Here, ${target}!` };
  }
  const t = await typeInClient(bodyContainer, `#goto ${Math.round(targetPos.x)} ${Math.round(targetPos.y)} ${Math.round(targetPos.z)}`);
  return t.ran
    ? { ok: true, text: `🦿 On my way, ${target}.` }
    : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
}
