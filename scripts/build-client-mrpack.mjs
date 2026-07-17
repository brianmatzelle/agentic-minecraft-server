#!/usr/bin/env node
// ── Client modpack builder ───────────────────────────────────────────────────
// Generates the CLIENT-side Modrinth modpack (.mrpack) that friends import into
// Prism Launcher / the Modrinth App to join mc.starting.cc without a mod
// mismatch. One file, one click: Prism installs NeoForge 1.21.1, the right Java,
// and every mod pinned to the exact version + hash the server runs.
//
//   apps/agent/modlist.txt   = source of truth for the SERVER mods.
//   CLIENT_MODS (below)       = source of truth for what ships to CLIENTS.
//   This script reconciles the two: it errors if a client mod isn't on the
//   server, and warns if a server mod is neither classified client nor
//   server-only — so the bundle can't silently drift from the modlist.
//
// What it does:
//   1. For each CLIENT_MODS slug, query the Modrinth API for the newest
//      NeoForge 1.21.1 build (same "latest compatible" policy itzg uses on the
//      server, alpha/beta channels included) and grab its primary file's
//      url + size + sha1/sha512.
//   2. Resolve the newest NeoForge 21.1.x loader build.
//   3. Write apps/client/modrinth.index.json (human-readable, committed for PR
//      review) and zip it to apps/client/starting-cc-client.mrpack.
//   4. Emit apps/client/pack/ in packwiz format (pack.toml + index.toml +
//      mods/*.pw.toml) — the same mods, served over the raw GitHub URL so
//      packwiz-installer can auto-update clients on launch (no re-import).
//      The .mrpack stays the first-time installer (it carries the loader).
//
// IMPORTANT: regenerate this in the SAME PR that changes apps/agent/modlist.txt.
// Both the server and this pack track "latest 1.21.1", so generating the pack
// right after a modlist change keeps client and server byte-identical. Run:
//   node scripts/build-client-mrpack.mjs
//
// No global installs, no network writes, never touches server-data/.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const OUT_DIR = join(REPO, 'apps', 'client');
const MODLIST = join(REPO, 'apps', 'agent', 'modlist.txt');

const MC_VERSION = '1.21.1';
const LOADER = 'neoforge';
const PACK_NAME = 'starting-cc-client.mrpack';
const UA = 'starting-cc/mrpack-builder (mc.starting.cc; +https://github.com/brianmatzelle/agentic-minecraft-server)';
const VERSION_ID = process.env.PACK_VERSION_ID || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// env.client/server: "required" | "optional" | "unsupported". Prism installs
// "optional" files by default on import but lets the user deselect them.
const CLIENT_MODS = [
  // ── Required to connect (content/registry mods + the libs they need) ──────
  { slug: 'cc-tweaked',                          client: 'required', server: 'required' },
  { slug: 'advancedperipherals',                 client: 'required', server: 'required' }, // CC: Tweaked add-on (extra peripherals); dep cc-tweaked already above
  // PINNED to 1.7.1: SimpleTMs 2.3.3 declares a *required* Modrinth dependency on
  // Cobblemon 1.7.1 exactly, so itzg resolves the SERVER down to 1.7.1 (not the
  // newer 1.7.3). The pack MUST match or clients fail the handshake ("Incompatible
  // client! Please use NeoForge ..."). Drop the pin when SimpleTMs supports a newer
  // Cobblemon and the server re-resolves upward. See apps/agent/modlist.txt.
  { slug: 'cobblemon',                           client: 'required', server: 'required', pin: '1.7.1' },
  // PINNED to 5.11.0: 5.12.0 has shipped, so leaving this unpinned lets the server
  // (and a regen of this pack) drift onto it independently → client/server mismatch.
  // Pin both sides to the build the server runs. Matches modlist.txt kotlin-for-forge:NrSebcsG.
  { slug: 'kotlin-for-forge',                    client: 'required', server: 'required', pin: '5.11.0' }, // Cobblemon runtime
  // rctmod (Radical Cobblemon Trainers) + rctapi removed 2026-06-25 by request.
  // RE-ENABLED 2026-07-15, PINNED to the last build made FOR Cobblemon 1.7.1 (the
  // 2026-06-24 disable was mega_showdown 1.8.4, a Cobblemon-1.7.3 build, NPEing
  // against a mismatched Cobblemon). DO NOT unpin: newer MSD targets Cobblemon
  // 1.7.3+. Matches modlist.txt cobblemon-mega-showdown:qDIlaSjM.
  { slug: 'cobblemon-mega-showdown',             client: 'required', server: 'required', pin: '1.6.1+1.7.1+1.21.1' },
  // PINNED to 8.0.3: requires cobblemon [1.7.0,) — fine for our pinned 1.7.1 — but a
  // future build may target newer Cobblemon/MSD. Pin both sides so neither drifts off
  // the pinned server. Matches modlist.txt legendary-monuments:l6PiCdpy. (Discord req 2026-07-15)
  { slug: 'legendary-monuments',                 client: 'required', server: 'required', pin: '8.0.3' },
  { slug: 'chipped',                             client: 'required', server: 'required' }, // legendary-monuments dep (structures use Chipped blocks)
  { slug: 'resourceful-lib',                     client: 'required', server: 'required' }, // chipped dep
  // Athena — Chipped's connected-textures dep, declared side=CLIENT in Chipped's
  // neoforge.mods.toml: clients need it, the server never runs it (Modrinth tags
  // server 'unsupported'), so it stays out of modlist.txt like the FPS mods.
  { slug: 'athena-ctm',                          client: 'required', server: 'unsupported' },
  // Lithostitched — legendary-monuments' worldgen lib. Modrinth tags client
  // 'unsupported', but LM declares the dep side=BOTH, so LM clients must have the
  // jar or NeoForge refuses to launch. It's on the server too (modlist.txt).
  { slug: 'lithostitched',                       client: 'required', server: 'required' },
  { slug: 'simpletms-tms-and-trs-for-cobblemon', client: 'required', server: 'required' },
  { slug: 'cobbledollars',                       client: 'required', server: 'required' },
  { slug: 'cobblepedia',                         client: 'required', server: 'required' },
  // PINNED to 2.3.3: its neoforge.mods.toml requires Cobblemon [1.7.0,) — fine for our
  // pinned 1.7.1 — but a future Cobblenav may target Cobblemon 1.8. Pin both sides so
  // neither drifts off the pinned server. Matches modlist.txt cobblemon-pokenav:yCSofpNb.
  { slug: 'cobblemon-pokenav',                   client: 'required', server: 'required', pin: '2.3.3' }, // PokéNav UI for Cobblemon (Discord req 2026-06-28, re-requested 2026-07-02)
  // PINNED to 2.2.1: it targets Cobblemon 1.7 (our server is pinned to 1.7.1). Pin
  // both sides so a future "latest" Cobbreeding can't drift onto a Cobblemon 1.8
  // build and mismatch the pinned server. Matches modlist.txt cobbreeding:xt8IiPEN.
  { slug: 'cobbreeding',                         client: 'required', server: 'required', pin: '2.2.1' },
  { slug: 'waystones',                           client: 'required', server: 'required' },
  { slug: 'balm',                                client: 'required', server: 'required' }, // waystones dep
  { slug: 'sophisticated-backpacks',             client: 'required', server: 'required', pin: '1.21.1-3.25.65.1955' }, // PINNED — was unpinned & drifted ahead of the client on 2026-06-30; pin both sides. Matches modlist.txt sophisticated-backpacks:y2W0V4fw
  // PINNED to 1.4.60.2057: 1.4.61.x has shipped; pin both sides so the pack can't
  // drift off the server. Matches modlist.txt sophisticated-core:IAisFkLf.
  { slug: 'sophisticated-core',                  client: 'required', server: 'required', pin: '1.21.1-1.4.60.2057' }, // backpacks dep
  { slug: 'farmers-delight',                     client: 'required', server: 'required' },
  { slug: 'gravestone-mod',                      client: 'required', server: 'required' }, // GraveStone Mod — recover items from a grave on death (Modrinth client_side: required)
  { slug: 'architectury-api',                    client: 'required', server: 'required' },
  { slug: 'accessories',                         client: 'required', server: 'required' },
  { slug: 'owo-lib',                             client: 'required', server: 'required' },
  { slug: 'patchouli',                           client: 'required', server: 'required' },
  { slug: 'cloth-config',                        client: 'required', server: 'required' }, // cobbreeding dep (config screens)
  // ── Create + addons (content mods — required client-side once on the server) ─
  { slug: 'create',                              client: 'required', server: 'required' }, // now required: Create: Aeronautics depends on it
  { slug: 'create-aeronautics',                  client: 'required', server: 'required' },
  { slug: 'sable',                               client: 'required', server: 'required' }, // create-aeronautics dep
  // ── Tech, storage & villager QoL (Discord req 2026-06-28) — content mods, required client-side ─
  { slug: 'mekanism',                            client: 'required', server: 'required' },
  { slug: 'mekanism-generators',                 client: 'required', server: 'required' }, // mekanism addon
  { slug: 'mekanism-tools',                      client: 'required', server: 'required' }, // mekanism addon
  { slug: 'mekanism-additions',                  client: 'required', server: 'required' }, // mekanism addon
  { slug: 'refined-storage',                     client: 'required', server: 'required' },
  { slug: 'extra-disks',                         client: 'required', server: 'required' }, // refined-storage addon
  { slug: 'pylons',                              client: 'required', server: 'required' },
  { slug: 'easy-villagers',                      client: 'required', server: 'required' },
  { slug: 'easy-piglins',                        client: 'required', server: 'required' },
  { slug: 'trade-cycling',                       client: 'required', server: 'required' },
  // Industrial Upgrade tech suite (industrialupgrade + power-utilities +
  // simply-quarries + quantum-generators) REMOVED 2026-06-26 by request — taken
  // out of modlist.txt and this pack together; see modlist.txt for the note.
  // ── Quality-of-life — optional on the client (deselectable on import) ─────
  { slug: 'jei',                                 client: 'optional', server: 'optional' },
  { slug: 'refined-storage-jei-integration',     client: 'optional', server: 'required' }, // JEI recipe transfer for RS grids — hard-requires JEI: deselect together with JEI or the game won't launch
  { slug: 'jade',                                client: 'optional', server: 'optional' },
  // Cobblemon: Extra Structures — server generates the structures; client mod is
  // optional (Modrinth client_side: optional) but shipped so players see custom
  // structure content. Discord req 2026-06-28.
  { slug: 'cobblemonextrastructures',            client: 'optional', server: 'required' },
  // Simple Voice Chat — proximity voice. Not needed to CONNECT (clients without it
  // just have no voice), so client: 'optional' (installed by default, deselectable —
  // no-mic players can skip it). PINNED to the server's exact build: SVC runs its own
  // client<->server voice-compat handshake, so a drifted server build can silently
  // kill voice for everyone. Matches modlist.txt simple-voice-chat:8xOu3Um5.
  // Server side needs UDP 24454 published (apps/server/docker-compose.yml).
  // Discord req 2026-07-16.
  { slug: 'simple-voice-chat',                   client: 'optional', server: 'required', pin: 'neoforge-1.21.1-2.6.20' },
  // ── Chat image embeds (client-only; server never runs it → server: 'unsupported') ─
  // ChatImage (kitUIN) renders an inline image in chat wherever a message carries a
  // [[CICode,url=…]] tag — including tellraw JSON, which is how in-game Garvis speaks
  // (apps/garvis-bot/src/ingame.js). Modrinth lists server_side: optional, but the
  // server half only relays LOCAL-file sharing between clients; web-URL rendering is
  // pure client-side, so like distanthorizons it stays out of modlist.txt (no server
  // boot risk, no deploy coupling). client: 'required' so every player sees Garvis's
  // images instead of the raw CICode text. PINNED to the tested build (drift-lock,
  // same policy as the other pins). No deps.
  { slug: 'chatimage',                           client: 'required', server: 'unsupported', pin: '1.4.7+1.21.0+neoforge' },
  // ── Client-side FPS mods (server never runs them → server: 'unsupported') ──
  // Pure rendering/culling optimizations: the server's view-distance=16 forces
  // each client to render ~1k chunks of heavy modded terrain, and the pack ships
  // the vanilla renderer. These restore framerate without touching the server.
  // Renderer = Sodium, NOT Embeddium: Sable jar-in-jars Veil (4.1.4), which hard-
  // refuses to load with Embeddium ("incompatible: embeddium any") but supports
  // Sodium 0.6.9+. Sodium's NeoForge build is beta-tagged but is the only renderer
  // compatible with this pack. (Was embeddium 1.0.15 — crashed clients on launch.)
  // PINNED to 0.8.12-beta.2: Iris (below) is sodium-version-sensitive — Iris 1.8.14
  // targets "Sodium 0.8" and older Iris builds crashed on mismatched Sodium betas
  // (IrisShaders/Iris#3136). Pin Sodium to the exact build the shader stack is tested
  // against so a future "latest" Sodium can't drift in and break Iris on clients. The
  // pinned value is today's newest, so this changes no bytes now — it's a drift-lock.
  // Drop the pin (and the iris/iris-veil-compat block) together if shaders are removed.
  { slug: 'sodium',                              client: 'required', server: 'unsupported', pin: 'mc1.21.1-0.8.12-beta.2-neoforge' }, // Veil-compatible renderer: the big FPS win + Iris's required dep
  { slug: 'entityculling',                       client: 'required', server: 'unsupported' }, // skips rendering hidden mobs/Cobblemon
  // PINNED to 1.6.10: this is the build the live pack ships and every player has. A
  // newer stable 1.6.11 released 2026-06-30, and unpinned this mod re-resolves to
  // "latest" on every regen — a naive regen silently swaps it in, dirtying the /add
  // version-gate and pushing an unneeded client update for a client-only perf mod.
  // Freeze it to the shipped build (drift-lock, changes no bytes now). Bump both this
  // pin and re-ship the pack together if you ever want 1.6.11+.
  { slug: 'immediatelyfast',                     client: 'required', server: 'unsupported', pin: '1.6.10+1.21.1-neoforge' }, // faster text/UI/JEI batching
  // ── Shaders (client-only; server never renders → server: 'unsupported') ────────
  // Iris is the shader engine (loads Complementary/BSL/etc. shaderpacks). It does NOT
  // bundle Sodium on NeoForge — it REQUIRES the standalone Sodium above (verified by
  // inspecting iris-neoforge-1.8.14-beta.1's jarjar: fabric shims + glsl-transformer
  // only, no sodium). Installing Iris alone here is the shader engine; the shaderpack
  // .zip is a separate artifact (NOT a mod) the player picks in Video Settings — see
  // the follow-up to auto-ship a default pack. No stable 1.21.1 Iris build exists yet,
  // so PINNED to the tested beta (don't let a regen pull a newer untested beta to
  // friends). Shaders stay OFF until selected, so merely shipping these doesn't force
  // an FPS hit — it just unlocks the capability.
  { slug: 'iris',                                client: 'required', server: 'unsupported', pin: '1.8.14-beta.1+1.21.1-neoforge' },
  // Without this, Create: Aeronautics / anything drawn through Veil (jar-in-jar'd by
  // Sable) renders BROKEN once a shaderpack is active — Veil's draws bypass the
  // shaderpack's gbuffer pipeline. Iris Veil Compat merges Veil's shader code into the
  // active shaderpack at runtime so those visuals render correctly under shaders.
  // Depends on Iris (project YL57xq9U). PINNED to the tested beta for the same reason.
  { slug: 'iris-veil-compat',                    client: 'required', server: 'unsupported', pin: '1.21.1+0.3.0-beta' },
  // ── Render distance (client-only; server never renders → server: 'unsupported') ─
  // Distant Horizons — LOD terrain renderer: "see farther without turning your game
  // into a slideshow." Pure client-side rendering. Modrinth lists server_side: optional
  // (a 3.x feature to share LODs in multiplayer), but we DON'T run it server-side — it's
  // a visual enhancement, not server logic, so it stays out of modlist.txt like the FPS
  // mods. client: 'optional' so weaker PCs can deselect it on import — it's GPU/CPU heavy
  // and not needed to connect. NeoForge 1.21.1, latest 3.1.2-b-1.21.1 (beta). No deps.
  // Requested via Discord 2026-06-30.
  { slug: 'distanthorizons',                     client: 'optional', server: 'unsupported' },
];

// Server-only mods that must NEVER ship to a client: perf/diagnostic tools plus
// server-side-only content (e.g. worldgen whose structures use vanilla blocks, so
// the client needs nothing extra to see them).
const SERVER_ONLY = ['lithium', 'ferrite-core', 'modernfix', 'spark', 'chunky', 'noisium', 'when-dungeons-arise', 'warputils', 'cobblemon-challenge'];

function modlistSlugs() {
  return readFileSync(MODLIST, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter(Boolean)
    // A modlist entry may pin a version as `slug:versionId` (itzg syntax, e.g.
    // `cobblemon:Uz1QF4Md`). Strip the `:versionId` so the reconcile compares
    // bare slugs against CLIENT_MODS (which carries its own `pin` field).
    .map((l) => l.split(/\s+/)[0].split(':')[0]);
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

async function latestNeoforge() {
  const r = await fetch(
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    { headers: { 'User-Agent': UA } },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching NeoForge metadata`);
  const xml = await r.text();
  const builds = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith('21.1.'))
    .map((v) => ({ v, patch: Number(v.split('.')[2]) }))
    .filter((x) => Number.isFinite(x.patch))
    .sort((a, b) => a.patch - b.patch);
  if (!builds.length) throw new Error('No NeoForge 21.1.x builds found');
  return builds[builds.length - 1].v;
}

function pickFile(version) {
  const f = version.files;
  return (
    f.find((x) => x.primary) ||
    f.find((x) => /\.jar$/.test(x.filename) && !/sources|javadoc/i.test(x.filename)) ||
    f[0]
  );
}

// ── Reconcile CLIENT_MODS against the server modlist ─────────────────────────
const server = new Set(modlistSlugs());
const clientSet = new Set(CLIENT_MODS.map((m) => m.slug));
const serverOnly = new Set(SERVER_ONLY);

// Client mods must be on the server too — EXCEPT pure client-side mods declared
// server:'unsupported' (e.g. FPS/render mods), which the server never runs.
const notOnServer = CLIENT_MODS
  .filter((m) => m.server !== 'unsupported')
  .map((m) => m.slug)
  .filter((s) => !server.has(s));
if (notOnServer.length) {
  console.error(`ERROR: client mods not in modlist.txt (server doesn't run them): ${notOnServer.join(', ')}`);
  process.exit(1);
}
const unclassified = [...server].filter((s) => !clientSet.has(s) && !serverOnly.has(s));
if (unclassified.length) {
  console.error(`WARNING: server mods not classified client/server-only: ${unclassified.join(', ')}`);
  console.error('         → add each to CLIENT_MODS or SERVER_ONLY in this script.');
}

// ── Resolve each client mod's file from Modrinth ─────────────────────────────
console.error(`Resolving ${CLIENT_MODS.length} client mods for ${LOADER} ${MC_VERSION}…`);
const resolved = [];
for (const mod of CLIENT_MODS) {
  const q =
    `https://api.modrinth.com/v2/project/${mod.slug}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify([LOADER]))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([MC_VERSION]))}`;
  const versions = await getJSON(q);
  if (!versions.length) throw new Error(`No ${LOADER} ${MC_VERSION} build for ${mod.slug}`);
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  // Default: newest compatible build (the same "latest" policy itzg uses). `pin`
  // overrides it for mods whose server version is forced by a dependency (e.g.
  // SimpleTMs pins Cobblemon), so the pack can't drift off what the server runs.
  const v = mod.pin ? versions.find((x) => x.version_number === mod.pin) : versions[0];
  if (!v) throw new Error(`Pinned ${mod.slug} ${mod.pin} not found among ${LOADER} ${MC_VERSION} builds`);
  const file = pickFile(v);
  if (!file?.hashes?.sha1 || !file?.hashes?.sha512) {
    throw new Error(`Missing hashes for ${mod.slug} ${v.version_number}`);
  }
  resolved.push({
    slug: mod.slug,
    client: mod.client,
    server: mod.server,
    filename: file.filename,
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    url: file.url,
    fileSize: file.size,
    projectId: v.project_id, // Modrinth IDs let `packwiz update` re-resolve later
    versionId: v.id,
  });
  console.error(`  ${mod.slug.padEnd(38)} ${String(v.version_number).padEnd(28)} (client:${mod.client})`);
}

const neoforge = await latestNeoforge();
console.error(`NeoForge loader: ${neoforge}`);

// mrpack file list — Modrinth-schema fields only. Stable ordering for clean diffs.
const files = resolved
  .map((r) => ({
    path: `mods/${r.filename}`,
    hashes: { sha1: r.sha1, sha512: r.sha512 },
    env: { client: r.client, server: r.server },
    downloads: [r.url],
    fileSize: r.fileSize,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

const index = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: VERSION_ID,
  name: 'mc.starting.cc — Cobblemon + Create (NeoForge 1.21.1)',
  summary: 'Client mods for the mc.starting.cc server. Import into Prism Launcher or the Modrinth App.',
  files,
  dependencies: { minecraft: MC_VERSION, neoforge },
};

// ── Emit modrinth.index.json + zip to .mrpack ────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const indexPath = join(OUT_DIR, 'modrinth.index.json');
const packPath = join(OUT_DIR, PACK_NAME);
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
if (existsSync(packPath)) rmSync(packPath); // rebuild fresh, no stale entries
execFileSync('zip', ['-j', '-X', '-q', packPath, indexPath]);

console.error(`\nWrote ${indexPath}`);
console.error(`Wrote ${packPath}  (versionId ${VERSION_ID}, ${files.length} mods)`);

// ── Emit a packwiz pack/ for auto-updating clients ───────────────────────────
// Same mods as the .mrpack, in packwiz's git-friendly format. Players point
// packwiz-installer-bootstrap at pack/pack.toml (raw GitHub URL) as a Prism
// pre-launch command; it re-syncs mods from this folder on every launch, so a
// modlist change lands on clients automatically — no re-import. See
// apps/client/README.md. The .mrpack above is still the first-time installer
// (it carries the NeoForge loader, which packwiz does not install).
const PACKWIZ_DIR = join(OUT_DIR, 'pack');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// TOML basic-string: quote + escape backslash/quote/newline. Modrinth names can
// carry em-dashes etc. (fine as UTF-8); URLs/hashes/ids are ASCII-safe.
const toml = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';

rmSync(PACKWIZ_DIR, { recursive: true, force: true }); // rebuild fresh — drop stale .pw.toml for removed mods
mkdirSync(join(PACKWIZ_DIR, 'mods'), { recursive: true });

const indexEntries = [];
for (const r of [...resolved].sort((a, b) => a.slug.localeCompare(b.slug))) {
  // packwiz `side`: unsupported on one side narrows it; everything else is "both".
  const side = r.client === 'unsupported' ? 'server' : r.server === 'unsupported' ? 'client' : 'both';
  let body =
    `name = ${toml(r.slug)}\n` +
    `filename = ${toml(r.filename)}\n` +
    `side = ${toml(side)}\n\n` +
    `[download]\n` +
    `url = ${toml(r.url)}\n` +
    `hash-format = "sha512"\n` +
    `hash = ${toml(r.sha512)}\n`;
  if (r.client === 'optional') {
    // Mirrors the .mrpack's "optional" — installed by default, deselectable in
    // packwiz-installer's GUI.
    body += `\n[option]\noptional = true\ndefault = true\ndescription = ${toml('Quality-of-life — deselect to skip.')}\n`;
  }
  body += `\n[update]\n[update.modrinth]\nmod-id = ${toml(r.projectId)}\nversion = ${toml(r.versionId)}\n`;

  const rel = `mods/${r.slug}.pw.toml`;
  writeFileSync(join(PACKWIZ_DIR, rel), body);
  indexEntries.push({ file: rel, hash: sha256(body) });
}

let indexToml = `hash-format = "sha256"\n`;
for (const e of indexEntries) {
  indexToml += `\n[[files]]\nfile = ${toml(e.file)}\nhash = ${toml(e.hash)}\nmetafile = true\n`;
}
writeFileSync(join(PACKWIZ_DIR, 'index.toml'), indexToml);

const packToml =
  `name = ${toml(index.name)}\n` +
  `author = "mc.starting.cc"\n` +
  `version = ${toml(VERSION_ID)}\n` +
  `pack-format = "packwiz:1.1.0"\n\n` +
  `[index]\nfile = "index.toml"\nhash-format = "sha256"\nhash = ${toml(sha256(indexToml))}\n\n` +
  `[versions]\nminecraft = ${toml(MC_VERSION)}\nneoforge = ${toml(neoforge)}\n`;
writeFileSync(join(PACKWIZ_DIR, 'pack.toml'), packToml);

console.error(`Wrote ${PACKWIZ_DIR}/  (pack.toml + index.toml + ${indexEntries.length} mods)`);
