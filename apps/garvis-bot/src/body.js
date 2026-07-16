// In-game BODY (Layer 3) — "!g come here / follow me / stay / go to <coords> /
// mine some iron / harvest the wheat / spectate <player>": players command
// Garvis's physical in-game body (the camera account — a real modded client in
// the garviscam container with Baritone aboard).
//
// Two control planes, both fixed-argv execFile (no shell), both fed ONLY from
// validated parts — raw player text NEVER reaches either:
//   • rcon (moderation.js rconExec, passed in): presence checks, positions, the
//     spectator→survival flip, the far-hop teleport, and the ghost-cam
//     attach/release (vanilla /spectate).
//   • chat.sh (docker exec into the body container): xdotool-types a Baritone
//     command ("#follow player <name>", "#goto x y z", "#stop") into the live
//     client. Baritone intercepts '#' lines client-side, so they never reach
//     public chat.
//
// Safety posture: every action is visible and reversible ("!g stop"), and
// names/coords are RE-validated here even though the classifier already
// extracted them (same belt-and-braces as moderation.js resolveAction). Since
// 2026-07-15 Baritone allowBreak/allowPlace/allowInventory are ON (owner's
// call — the body really plays survival now); this module still never toggles
// settings itself.
import { execFile } from 'node:child_process';

// Same shape ingame.js trusts for chat senders; a followee name from the
// classifier must ALSO resolve (case-insensitively) to an online player below.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// rcon-cli output arrives with terminal escapes (itzg TTY) — strip all CSI.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Block ids the classifier hands us for "#mine" — shape-checked here before
// they're ever typed into the client.
const BLOCK_ID_RE = /^[a-z0-9_]{1,48}$/;
// Baritone's #mine hunts PLACED blocks too — keep "!g mine diamond blocks"
// from turning into sanctioned theft of somebody's beacon base or storage.
const MINE_DENY = new Set([
  'diamond_block', 'emerald_block', 'gold_block', 'iron_block', 'netherite_block',
  'beacon', 'chest', 'trapped_chest', 'ender_chest', 'barrel',
  'spawner', 'conduit', 'dragon_egg',
]);

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
// Falls back to a UNIQUE prefix match — players say "spectate ruben", not
// "spectate rubenwarrior38" — and an ambiguous prefix resolves to nobody.
async function onlinePlayer(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['list']);
  if (!res.ran) return null;
  const names = (res.output.split(':').pop() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const q = name.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === q);
  if (exact) return exact;
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(q));
  return prefixed.length === 1 ? prefixed[0] : null;
}

// Any online player who isn't the body itself — the ground anchor for askerless
// (stream-viewer) commands when the body is hovering in spectator: players are
// guaranteed to be standing somewhere survivable, raw coords are not.
async function anyOnlinePlayer(rconExec, container, body) {
  const res = await rcon(rconExec, container, ['list']);
  if (!res.ran) return null;
  const names = (res.output.split(':').pop() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return names.find((n) => n.toLowerCase() !== body.toLowerCase()) ?? null;
}

// "<name> has the following entity data: [-918.4d, 81.0d, -152.8d]" → {x,y,z}
async function getPos(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', name, 'Pos']);
  const m = res.output.match(/\[\s*(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\s*\]/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

// playerGameType: 0 survival, 1 creative, 2 adventure, 3 spectator. Vanilla
// quirk (host-verified 2026-07-16): while POV-attached via /spectate, a player
// drops out of `data get entity` lookup ENTIRELY ("No entity was found") even
// though `list` shows them online and tp/execute still target them fine. An
// online body we can't find is therefore attached — report spectator so every
// verb anchors (tp) before flipping gamemode, instead of dropping him into
// survival mid-air wherever the spectated player happens to be flying.
async function isSpectator(rconExec, container, name) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', name, 'playerGameType']);
  if (/no entity was found/i.test(res.output)) return true;
  const m = res.output.match(/:\s*(\d+)\s*$/);
  return m ? Number(m[1]) === 3 : false;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Run one validated body action. `asker` is the server-stamped chat sender
// (trusted); `player`/coords come from the classifier (untrusted, re-checked).
// `asker` may be NULL: a stream-viewer command (Garvis TV tollbooth) has no
// avatar in the world — asker-anchored verbs then anchor on any online player
// (or refuse, for the verbs that only make sense in-world: "come here",
// "follow me", "spectate me"). Returns { ok, text } — text is a short chat
// line. Never throws.
export async function runBodyAction({ action, player, x, y, z, blocks = [] }, { rconExec, mcContainer, bodyContainer, account, asker }) {
  const body = await onlinePlayer(rconExec, mcContainer, account);
  if (!body) return { ok: false, text: `My body (${account}) isn't in the game right now — ask an admin to check on it.` };

  // mine / farm — real survival play (Baritone #mine / #farm). Anchor on the
  // ASKER exactly like follow/come (grounded, working near whoever asked),
  // then hand Baritone the task; "!g stop" cancels either. Askerless (stream)
  // commands work from wherever he stands; off the camera perch they anchor
  // on any online player instead.
  if (action === 'mine' || action === 'farm') {
    const spectating = await isSpectator(rconExec, mcContainer, body);
    if (asker) {
      const [bodyPos, askerPos] = await Promise.all([
        getPos(rconExec, mcContainer, body),
        getPos(rconExec, mcContainer, asker),
      ]);
      const far = !bodyPos || !askerPos || dist(bodyPos, askerPos) > MAX_WALK;
      if (spectating || far) await rcon(rconExec, mcContainer, ['tp', body, asker]);
    } else if (spectating) {
      const anchor = await anyOnlinePlayer(rconExec, mcContainer, body);
      if (!anchor) return { ok: false, text: "I'm up on camera duty and nobody's in the world to drop in next to — try again when someone's online." };
      await rcon(rconExec, mcContainer, ['tp', body, anchor]);
    }
    await rcon(rconExec, mcContainer, ['gamemode', 'survival', body]);
    if (action === 'farm') {
      const t = await typeInClient(bodyContainer, '#farm');
      return t.ran
        ? { ok: true, text: `🌾 Farming what's around me — "!g stop" when the harvest's done.` }
        : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
    }
    const ids = [...new Set(blocks)].filter((id) => BLOCK_ID_RE.test(id)).slice(0, 4);
    if (!ids.length) return { ok: false, text: 'Tell me which block to mine — e.g. "!g mine iron ore".' };
    const banned = ids.find((id) => MINE_DENY.has(id) || id.endsWith('shulker_box'));
    if (banned) return { ok: false, text: `I don't mine ${banned.replaceAll('_', ' ')} — that's somebody's stuff, not ore.` };
    const t = await typeInClient(bodyContainer, `#mine ${ids.join(' ')}`);
    return t.ran
      ? { ok: true, text: `⛏️ Mining ${ids.join(', ').replaceAll('_', ' ')} — "!g stop" when you've got enough.` }
      : { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
  }

  if (action === 'stop') {
    // Release a ghost-cam POV attach BEFORE touching the keyboard: while
    // attached, 't' doesn't open chat, so typed lines leak into the game as
    // raw keypresses — and '#'/'!' press Shift, which is sneak, the vanilla
    // detach key (host-verified 2026-07-16). The in-place tp detaches cleanly
    // over rcon and is a harmless no-op when he's just hovering on jumbotron
    // camera duty (position and rotation both kept).
    const ghosting = await isSpectator(rconExec, mcContainer, body);
    if (ghosting) await rcon(rconExec, mcContainer, ['execute', 'at', body, 'run', 'tp', body, '~', '~', '~']);
    const t = await typeInClient(bodyContainer, '#stop');
    if (!t.ran) return { ok: false, text: "I couldn't reach my body's controls — try again in a moment." };
    return ghosting
      ? { ok: true, text: `👻 Ghost-cam off — I'm hovering where I stopped; "!g come here" puts my feet back on the ground.` }
      : { ok: true, text: '🦿 Staying put.' };
  }

  // spectate — ghost-cam: POV-attach the body to a player with vanilla
  // /spectate, so the stream (jumbotron faces + Garvis TV) renders THEIR
  // first-person view. Baritone can't path without collision, so no #follow
  // here — the server glues the camera to the target and the client just
  // renders it (smooth, cross-dimension, zero tick cost). Released by
  // "!g stop", or naturally by any body verb (they all tp + flip to survival).
  if (action === 'spectate') {
    const rawWatch = !player || player.toLowerCase() === 'me' ? asker : player;
    if (!rawWatch) return { ok: false, text: 'Tell me WHO to spectate — e.g. "spectate Steve".' };
    if (!USERNAME_RE.test(rawWatch)) return { ok: false, text: `"${rawWatch}" doesn't look like a player name.` };
    const target = await onlinePlayer(rconExec, mcContainer, rawWatch);
    if (!target) return { ok: false, text: `${rawWatch} isn't online right now.` };
    if (target === body) return { ok: false, text: "That's me — I can't spectate myself." };
    // tp FIRST: it detaches any previous attach (typing is dead while
    // attached — see the stop handler) and anchors same-dimension for the new
    // one; only then is the keyboard safe for Baritone's #stop.
    await rcon(rconExec, mcContainer, ['tp', body, target]);
    await typeInClient(bodyContainer, '#stop');                    // drop any walk/mine before ghosting out
    await rcon(rconExec, mcContainer, ['gamemode', 'spectator', body]);
    const s = await rcon(rconExec, mcContainer, ['spectate', target, body]);
    return s.ran && /now spectating/i.test(s.output)
      ? { ok: true, text: `👻 Spectating ${target} — their POV is live on Garvis TV. "!g stop" releases me.` }
      : { ok: false, text: `I couldn't lock onto ${target} — try again in a moment.` };
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
      // asker (guaranteed on ground) before walking off; an askerless (stream)
      // command anchors on any online player instead.
      const anchor = asker ?? await anyOnlinePlayer(rconExec, mcContainer, body);
      if (!anchor) return { ok: false, text: "I'm up on camera duty and nobody's in the world to drop in next to — try again when someone's online." };
      await rcon(rconExec, mcContainer, ['tp', body, anchor]);
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
  if (!rawTarget) return { ok: false, text: 'You\'re watching from outside the world — name a player ("follow Steve") or send me somewhere ("go to -948 85 -147").' };
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
