// Hunger watcher — keeps the body fed now that it really plays survival
// (Baritone allowBreak/allowPlace unlocked at the owner's request, 2026-07-15).
// Baritone never eats, and both Modrinth auto-eat mods hard-fail on NeoForge
// 21.1 (see garviscam/scripts/sync-pack.py), so feeding is driven from out
// here: poll hunger over rcon, and when it dips, have the client hold
// right-click on a food hotbar slot (eat.sh — same flock as chat.sh so an eat
// can't interleave with a typist).
//
// Same control planes and trust posture as body.js: fixed-argv execFile only;
// nothing player-controlled ever reaches a command line. Hotbar slot 9 is the
// "lunchbox": we eat from whichever hotbar slot already holds food, else we
// restock slot 9 with cooked beef and eat that — displacing whatever Baritone
// stashed there (logged; bot food security beats a stray stack of cobble).
import { execFile } from 'node:child_process';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const EAT_BELOW = 15; // foodLevel is 0-20; beef restores 8, so eating at <=14 never wastes
const PERIOD_MS = 60_000;
// Foods we'll eat if already in the hotbar, in preference order. Deliberately
// no golden apples / suspicious stew — nothing with side effects.
const FOODS = new Set([
  'minecraft:cooked_beef', 'minecraft:cooked_porkchop', 'minecraft:cooked_chicken',
  'minecraft:cooked_mutton', 'minecraft:bread', 'minecraft:baked_potato',
  'minecraft:golden_carrot', 'minecraft:carrot', 'minecraft:apple', 'minecraft:cooked_cod',
]);

function rcon(rconExec, container, argv) {
  return rconExec(container, argv).then((res) => ({
    ran: res.ran,
    output: String(res.output ?? '').replace(ANSI_RE, '').trim(),
  }));
}

function eatSlot(bodyContainer, slot, { timeoutMs = 15_000 } = {}) {
  return new Promise((res) => {
    execFile('docker', ['exec', bodyContainer, '/opt/garviscam/eat.sh', String(slot)], { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ ran: !err, output: `${stdout ?? ''}${stderr ?? ''}`.replace(ANSI_RE, '').trim() });
    });
  });
}

// "... has the following entity data: 14" → 14; null when offline/unparsable.
async function getInt(rconExec, container, account, path) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', account, path]);
  const m = res.output.match(/:\s*(-?\d+)\s*[a-z]?\s*$/);
  return res.ran && m ? Number(m[1]) : null;
}

// Item id in a hotbar slot (0-8), or null when the slot is empty.
async function slotItem(rconExec, container, account, slot) {
  const res = await rcon(rconExec, container, ['data', 'get', 'entity', account, `Inventory[{Slot:${slot}b}].id`]);
  const m = res.output.match(/"(minecraft:[a-z_0-9]+)"/);
  return m ? m[1] : null;
}

async function tick({ rconExec, mcContainer, bodyContainer, account }) {
  const food = await getInt(rconExec, mcContainer, account, 'foodLevel');
  if (food === null || food >= EAT_BELOW) return; // offline or not hungry
  const mode = await getInt(rconExec, mcContainer, account, 'playerGameType');
  if (mode !== 0) return; // hunger only matters in survival

  // Prefer a hotbar slot that already holds food (lunchbox slot 9 last-checked
  // first via ordering below), else restock the lunchbox.
  let slot = null;
  for (const s of [8, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const id = await slotItem(rconExec, mcContainer, account, s);
    if (id && FOODS.has(id)) { slot = s; break; }
  }
  if (slot === null) {
    const displaced = await slotItem(rconExec, mcContainer, account, 8);
    if (displaced) console.log(`[hunger] lunchbox slot held ${displaced} — displacing it for food`);
    const r = await rcon(rconExec, mcContainer, ['item', 'replace', 'entity', account, 'hotbar.8', 'with', 'minecraft:cooked_beef', '16']);
    if (!r.ran) { console.log('[hunger] restock failed:', r.output); return; }
    slot = 8;
  }

  const e = await eatSlot(bodyContainer, slot + 1); // eat.sh takes the 1-based hotbar key
  if (!e.ran) { console.log('[hunger] eat.sh failed:', e.output); return; }
  await new Promise((r) => setTimeout(r, 12_000)); // eat anim + server sync
  const after = await getInt(rconExec, mcContainer, account, 'foodLevel');
  console.log(`[hunger] ate from slot ${slot + 1}: foodLevel ${food} -> ${after ?? '?'}`);
}

// Fire-and-forget minute loop; overlapping ticks are skipped, errors only log.
export function startHungerWatcher(ctx) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(ctx); } catch (e) { console.error('[hunger]', e?.stack ?? e); } finally { busy = false; }
  }, PERIOD_MS);
  t.unref?.();
  console.log(`[hunger] watcher on: feeding ${ctx.account} when foodLevel < ${EAT_BELOW} (every ${PERIOD_MS / 1000}s)`);
  return t;
}
