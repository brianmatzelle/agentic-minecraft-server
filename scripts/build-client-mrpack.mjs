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
//
// IMPORTANT: regenerate this in the SAME PR that changes apps/agent/modlist.txt.
// Both the server and this pack track "latest 1.21.1", so generating the pack
// right after a modlist change keeps client and server byte-identical. Run:
//   node scripts/build-client-mrpack.mjs
//
// No global installs, no network writes, never touches server-data/.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  { slug: 'cobblemon',                           client: 'required', server: 'required' },
  { slug: 'kotlin-for-forge',                    client: 'required', server: 'required' }, // Cobblemon runtime
  { slug: 'rctmod',                              client: 'required', server: 'required' },
  { slug: 'rctapi',                              client: 'required', server: 'required' }, // rctmod dep
  // cobblemon-mega-showdown DISABLED 2026-06-24: mega_showdown 1.8.4 fatally NPEs on
  // server datapack load (HeldItems.reload → receiveHeldItemDataFn null) vs Cobblemon
  // 1.7.3. Removed from the server modlist + client pack in lockstep. Re-add (both
  // here and in modlist.txt) once a compatible/pinned Cobblemon↔mega-showdown pair exists.
  { slug: 'simpletms-tms-and-trs-for-cobblemon', client: 'required', server: 'required' },
  { slug: 'cobbledollars',                       client: 'required', server: 'required' },
  { slug: 'cobblepedia',                         client: 'required', server: 'required' },
  { slug: 'waystones',                           client: 'required', server: 'required' },
  { slug: 'balm',                                client: 'required', server: 'required' }, // waystones dep
  { slug: 'sophisticated-backpacks',             client: 'required', server: 'required' },
  { slug: 'sophisticated-core',                  client: 'required', server: 'required' }, // backpacks dep
  { slug: 'farmers-delight',                     client: 'required', server: 'required' },
  { slug: 'architectury-api',                    client: 'required', server: 'required' },
  { slug: 'accessories',                         client: 'required', server: 'required' },
  { slug: 'owo-lib',                             client: 'required', server: 'required' },
  { slug: 'patchouli',                           client: 'required', server: 'required' },
  // ── Create + addons (content mods — required client-side once on the server) ─
  { slug: 'create',                              client: 'required', server: 'required' }, // now required: Create: Aeronautics depends on it
  { slug: 'create-aeronautics',                  client: 'required', server: 'required' },
  { slug: 'sable',                               client: 'required', server: 'required' }, // create-aeronautics dep
  // ── Industrial Upgrade tech suite (mutually required; all client+server) ──
  { slug: 'industrialupgrade',                   client: 'required', server: 'required' },
  { slug: 'power-utilities',                     client: 'required', server: 'required' }, // IU addon
  { slug: 'simply-quarries',                     client: 'required', server: 'required' }, // IU addon
  { slug: 'quantum-generators',                  client: 'required', server: 'required' }, // IU addon
  // ── Quality-of-life — optional on the client (deselectable on import) ─────
  { slug: 'jei',                                 client: 'optional', server: 'optional' },
  { slug: 'jade',                                client: 'optional', server: 'optional' },
];

// Server-only mods that must NEVER ship to a client: perf/diagnostic tools plus
// server-side-only content (e.g. worldgen whose structures use vanilla blocks, so
// the client needs nothing extra to see them).
const SERVER_ONLY = ['lithium', 'ferrite-core', 'modernfix', 'spark', 'chunky', 'noisium', 'when-dungeons-arise'];

function modlistSlugs() {
  return readFileSync(MODLIST, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0]);
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

const notOnServer = [...clientSet].filter((s) => !server.has(s));
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
const files = [];
for (const mod of CLIENT_MODS) {
  const q =
    `https://api.modrinth.com/v2/project/${mod.slug}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify([LOADER]))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([MC_VERSION]))}`;
  const versions = await getJSON(q);
  if (!versions.length) throw new Error(`No ${LOADER} ${MC_VERSION} build for ${mod.slug}`);
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  const v = versions[0];
  const file = pickFile(v);
  if (!file?.hashes?.sha1 || !file?.hashes?.sha512) {
    throw new Error(`Missing hashes for ${mod.slug} ${v.version_number}`);
  }
  files.push({
    path: `mods/${file.filename}`,
    hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
    env: { client: mod.client, server: mod.server },
    downloads: [file.url],
    fileSize: file.size,
  });
  console.error(`  ${mod.slug.padEnd(38)} ${String(v.version_number).padEnd(28)} (client:${mod.client})`);
}

const neoforge = await latestNeoforge();
console.error(`NeoForge loader: ${neoforge}`);

// Stable ordering for clean diffs.
files.sort((a, b) => a.path.localeCompare(b.path));

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
