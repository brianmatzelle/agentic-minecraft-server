// Sleep watcher — the body's second reflex (hunger.js is the first). Phantoms
// were farming Garvis every night: Baritone has no concept of sleep, so his
// time_since_rest hit 2.16M ticks (~30 real hours of insomnia) and the night
// sky was permanently out for him. Same brainstem pattern as eating: poll game
// state over rcon each minute, and when it's night, place a carried bed where
// he stands and right-click it — no fixed "home bed", it works wherever the
// day's adventure left him. Mornings he reclaims the bed so the world doesn't
// accumulate one per night.
//
// How a headless client sleeps (all fixed-argv execFile, like hunger/body):
//   1. rcon `time query daytime` says it's night; `SleepTimer` NBT says he
//      isn't already asleep; `playerGameType`/`OnGround` say he's standing in
//      survival.
//   2. Ensure a bed in the hotbar (restock slot 8 — the "bedroll", one left of
//      the lunchbox — via rcon `item replace`, exactly like the beef).
//   3. `#stop` Baritone, then AIM: an in-place tp with computed yaw/pitch puts
//      the crosshair on the top face of the ground block one ahead (Baritone
//      can't aim on command; a tp-in-place is the only deterministic way to
//      point a headless client at something).
//   4. eat.sh with the bed slot: select + hold right-click. The press places
//      the bed against that face; the hold's repeat-use then fires on the
//      just-placed bed and he climbs in. One hold, both clicks.
//   5. Verify via SleepTimer. Failures (slope, water, "monsters nearby")
//      just rotate the facing 90° and retry next tick, all night if needed.
// Phantoms already on him would block the sleep with "monsters nearby" — the
// exact mob this exists to stop — so each attempt is preceded by a targeted
// rcon kill of phantoms within 16 blocks (phantoms only; other mobs blocking
// the bed are his problem to walk off, like any player).
//
// Sleeping ~once a night keeps time_since_rest under the 72k-tick insomnia
// threshold, so in steady state phantoms never spawn for him at all. Kill
// switch: GARVIS_BODY_AUTOSLEEP=off. Pending-bed state is in-memory: a bot
// restart at the wrong moment can orphan one placed bed (restock covers the
// loss; the orphan is a find for whoever spots it).
import { execFile } from 'node:child_process';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const PERIOD_MS = 60_000;
// Beds are usable from 12542 (clear-weather dusk); stop trying by 23000 so a
// last-second attempt can't straddle sunrise, and treat everything else as
// morning (reclaim time). Rain technically opens beds earlier — not worth it.
const NIGHT_START = 12542;
const NIGHT_END = 23000;
const BEDROLL_SLOT = 7; // hotbar.7 = key 8, one left of the hunger lunchbox (8/9)
const BED_RE = /^minecraft:[a-z_]+_bed$/;
// Facing rotation for retries: north, east, south, west. yaw is Minecraft's
// (0=south, 90=west, 180=north, -90=east); dx/dz point at the bed-foot block.
const CARDINALS = [
  { dx: 0, dz: -1, yaw: 180 },
  { dx: 1, dz: 0, yaw: -90 },
  { dx: 0, dz: 1, yaw: 0 },
  { dx: -1, dz: 0, yaw: 90 },
];

function rcon(rconExec, container, argv) {
  return rconExec(container, argv).then((res) => ({
    ran: res.ran,
    output: String(res.output ?? '').replace(ANSI_RE, '').trim(),
  }));
}

// eat.sh is really "select hotbar slot N and hold right-click" — food was just
// its first customer. Same flock as chat.sh, so a bed click can't interleave
// with a typist or an eat.
function useSlot(bodyContainer, slot, { timeoutMs = 15_000 } = {}) {
  return new Promise((res) => {
    execFile('docker', ['exec', bodyContainer, '/opt/garviscam/eat.sh', String(slot)], { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ ran: !err, output: `${stdout ?? ''}${stderr ?? ''}`.replace(ANSI_RE, '').trim() });
    });
  });
}

// Public chat / Baritone lines typed into the live client (see body.js).
function typeInClient(bodyContainer, line, { timeoutMs = 15_000 } = {}) {
  return new Promise((res) => {
    execFile('docker', ['exec', bodyContainer, '/opt/garviscam/chat.sh', line], { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ ran: !err, output: `${stdout ?? ''}${stderr ?? ''}`.replace(ANSI_RE, '').trim() });
    });
  });
}

// "... has the following entity data: 14" / "100s" / "1b" → number; null when
// offline/unparsable (same shape as hunger.js).
async function getInt(rconExec, container, account, path) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', account, path]);
  const m = res.output.match(/:\s*(-?\d+)\s*[a-z]?\s*$/);
  return res.ran && m ? Number(m[1]) : null;
}

async function getPos(rconExec, container, account) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', account, 'Pos']);
  const m = res.output.match(/\[\s*(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\s*\]/);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

async function slotItem(rconExec, container, account, slot) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', account, `Inventory[{Slot:${slot}b}].id`]);
  const m = res.output.match(/"(minecraft:[a-z_0-9]+)"/);
  return m ? m[1] : null;
}

// "The time is 19999" → 19999 (day-cycle tick, 0..23999); null when the query fails.
async function getDaytime(rconExec, container) {
  const res = await rcon(rconExec, container, ['time', 'query', 'daytime']);
  const m = res.output.match(/(\d+)/);
  return res.ran && m ? Number(m[1]) : null;
}

async function bedAt(rconExec, container, { x, y, z }) {
  const res = await rcon(rconExec, container, ['execute', 'if', 'block', String(x), String(y), String(z), '#minecraft:beds']);
  return /passed/i.test(res.output);
}

// Morning chore: pop each bed we placed overnight back into the world as a
// drop (setblock destroy = drops as if mined; he's usually standing right
// there and hoovers it up — and if not, the nightly restock covers the loss).
// The `execute if block` guard means we can never destroy anything that isn't
// still a bed. Skipped while he's actually asleep, so a reclaim can't yank
// the bed out from under him in the final seconds before sunrise.
async function reclaimBeds(ctx, state) {
  if (!state.beds.length) return;
  const asleep = await getInt(ctx.rconExec, ctx.mcContainer, ctx.account, 'SleepTimer');
  if (asleep !== null && asleep > 0) return; // still in it — next tick
  for (const b of state.beds) {
    const p = [String(b.x), String(b.y), String(b.z)];
    const r = await rcon(ctx.rconExec, ctx.mcContainer, ['execute', 'if', 'block', ...p, '#minecraft:beds', 'run', 'setblock', ...p, 'minecraft:air', 'destroy']);
    console.log(`[sleep] reclaimed bed at ${b.x} ${b.y} ${b.z}: ${r.output || '(gone already)'}`);
  }
  state.beds = [];
}

async function tick(ctx, state) {
  const { rconExec, mcContainer, bodyContainer, account } = ctx;
  const t = await getDaytime(rconExec, mcContainer);
  if (t === null) return; // server unreachable
  if (t < NIGHT_START || t > NIGHT_END) {
    state.announced = false;
    await reclaimBeds(ctx, state);
    return;
  }

  const mode = await getInt(rconExec, mcContainer, account, 'playerGameType');
  if (mode !== 0) return; // offline or on camera duty — only the survival body sleeps
  const sleepTimer = await getInt(rconExec, mcContainer, account, 'SleepTimer');
  if (sleepTimer === null || sleepTimer > 0) return; // already tucked in
  const onGround = await getInt(rconExec, mcContainer, account, 'OnGround');
  if (onGround !== 1) return; // falling/swimming — try again next tick

  // Bedroll check: any bed already in the hotbar wins; else restock slot 8.
  let slot = null;
  for (const s of [BEDROLL_SLOT, 0, 1, 2, 3, 4, 5, 6, 8]) {
    const id = await slotItem(rconExec, mcContainer, account, s);
    if (id && BED_RE.test(id)) { slot = s; break; }
  }
  if (slot === null) {
    const displaced = await slotItem(rconExec, mcContainer, account, BEDROLL_SLOT);
    if (displaced) console.log(`[sleep] bedroll slot held ${displaced} — displacing it for a bed`);
    const r = await rcon(rconExec, mcContainer, ['item', 'replace', 'entity', account, `hotbar.${BEDROLL_SLOT}`, 'with', 'minecraft:red_bed', '1']);
    if (!r.ran) { console.log('[sleep] bed restock failed:', r.output); return; }
    slot = BEDROLL_SLOT;
  }

  if (!state.announced) { await typeInClient(bodyContainer, 'gn'); state.announced = true; }
  await typeInClient(bodyContainer, '#stop'); // cancel any follow/mine and hold still for the aim

  // Phantoms within sleep-blocking range would veto the bed with "monsters
  // nearby" — the very mob this reflex exists to beat. Clear just them.
  await rcon(rconExec, mcContainer, ['execute', 'at', account, 'run', 'kill', '@e[type=minecraft:phantom,distance=..16]']);

  const p = await getPos(rconExec, mcContainer, account);
  if (!p) return;
  const dir = CARDINALS[state.attempt % CARDINALS.length];
  state.attempt += 1; // rotate the facing whether or not this attempt lands
  const fy = Math.floor(p.y);
  const cx = Math.floor(p.x) + 0.5, cz = Math.floor(p.z) + 0.5;
  const bed = { x: Math.floor(p.x) + dir.dx, y: fy, z: Math.floor(p.z) + dir.dz };
  // Aim at the top face of the ground one block ahead (horizontal distance is
  // exactly 1.0 once he's centered): eye = feet + 1.62, so pitch is just the
  // downward angle onto that face. Clicking it places the bed's foot in the
  // air block above — i.e. at his feet level, right in front of him.
  const pitch = (Math.atan2((p.y - fy) + 1.62, 1.0) * 180 / Math.PI).toFixed(1);
  const tp = await rcon(rconExec, mcContainer, ['tp', account, String(cx), String(p.y), String(cz), String(dir.yaw), pitch]);
  if (!tp.ran) { console.log('[sleep] aim tp failed:', tp.output); return; }
  await new Promise((r) => setTimeout(r, 700)); // let the client take the new look angle

  const u = await useSlot(bodyContainer, slot + 1); // eat.sh takes the 1-based hotbar key
  if (!u.ran) { console.log('[sleep] use click failed:', u.output); return; }
  await new Promise((r) => setTimeout(r, 4_000)); // place + climb in + server sync

  // The bed may have landed even if the sleep itself was vetoed — remember it
  // either way so the morning reclaim never leaves one behind.
  if (await bedAt(rconExec, mcContainer, bed) && !state.beds.some((b) => b.x === bed.x && b.y === bed.y && b.z === bed.z)) {
    state.beds.push(bed);
  }
  const after = await getInt(rconExec, mcContainer, account, 'SleepTimer');
  if (after > 0) {
    console.log(`[sleep] asleep in bed at ${bed.x} ${bed.y} ${bed.z} (t=${t})`);
    state.attempt = 0;
  } else {
    console.log(`[sleep] attempt facing yaw=${dir.yaw} didn't take (t=${t}, bed placed=${state.beds.length > 0}) — rotating and retrying next tick`);
  }
}

// Fire-and-forget minute loop; overlapping ticks are skipped, errors only log.
export function startSleepWatcher(ctx) {
  const state = { announced: false, attempt: 0, beds: [] };
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(ctx, state); } catch (e) { console.error('[sleep]', e?.stack ?? e); } finally { busy = false; }
  }, PERIOD_MS);
  t.unref?.();
  console.log(`[sleep] watcher on: ${ctx.account} sleeps through ticks ${NIGHT_START}-${NIGHT_END} (checked every ${PERIOD_MS / 1000}s)`);
  return t;
}
