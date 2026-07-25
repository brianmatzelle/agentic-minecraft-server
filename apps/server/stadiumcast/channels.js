#!/usr/bin/env node
'use strict';
// channels.js — the jumbotron's TV catalog: iptv-org channel index + the HTTP
// control API that jumboplay.lua (and garvis-bot) tune through.
//
// This is the one part of ~/projects/active/tv (termtv) worth having here. That
// app's render layer is sanjuuni's job and its player layer is ffmpeg's, but its
// DATA layer — fetch iptv-org's channels.json + streams.json, merge, cache, and
// resolve a small hand-vetted grid out of the ~8.5k-channel long tail — is
// exactly what "bloomberg mode" was a one-channel hardcode of. CURATED below is
// a faithful port of termtv's curated.py table and its match/score rules, so a
// tile that reads cleanly there reads cleanly here.
//
// Two extras termtv doesn't do, both because the faces are a harsher target than
// a terminal: streams carry per-entry user_agent/referrer (some CDNs 403 without
// them, and we hand them to ffmpeg), and stream choice prefers the variant
// nearest the 542x414 face resolution instead of blindly taking the first.
//
// Subcommands:
//   build [--force]   fetch + merge + write the compact index (heavy, transient)
//   resolve <query>   query -> "id<TAB>label" on stdout, exit 1 if no match
//   url <id>          id -> "url<TAB>user_agent<TAB>referrer" (entrypoint.sh reads this)
//   serve             the control API on :$CAST_CTL_PORT (internal network only)
//
// Memory note: channels.json is ~11MB and streams.json ~4MB upstream, so `build`
// peaks around a few hundred MB parsing them. It runs as a SHORT-LIVED process
// (serve re-spawns it rather than building in-process) because this container is
// capped at 2g and shares it with sanjuuni's frame store — see the leak-guard
// comment in entrypoint.sh.

const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const MEDIA     = process.env.CAST_MEDIA || '/media';
const INDEX     = `${MEDIA}/channels.json`;
const BUILDING  = `${MEDIA}/.channels-building`;
const SOURCE    = `${MEDIA}/source`;
const NOW       = `${MEDIA}/now-playing`;
const LOG       = `${MEDIA}/channels.log`;
const SOURCE_SH = '/opt/source.sh';

const API      = process.env.CAST_IPTV_API || 'https://iptv-org.github.io/api';
const TTL_MS   = Number(process.env.CAST_INDEX_TTL_H || 6) * 3600_000;
const CTL_PORT = Number(process.env.CAST_CTL_PORT || 8178);
const SEARCH_CAP = Number(process.env.CAST_SEARCH_CAP || 60);
// Variant selection: how many of a channel's ranked streams to probe, and how
// long to give each. Probed concurrently, so this bounds wall-clock too — the
// in-game picker blocks on it.
const PROBE_CANDIDATES = Number(process.env.CAST_PROBE_CANDIDATES || 3);
const PROBE_MS = Number(process.env.CAST_PROBE_MS || 12_000);

// File only, not stderr: the entrypoint already redirects this process's stderr
// into the same file, so writing both put every line in twice.
const log = (...m) => {
  try { fs.appendFileSync(LOG, `[chan] ${m.join(' ')}\n`); } catch { /* best effort */ }
};

// --- curated grid (ported from termtv's curated.py) --------------------------
// label, keywords (ALL must appear in the channel name), country tiebreaker,
// avoid (ANY match rejects — this is what keeps "BBC News Persian" out when we
// asked for English). Order here is the order tiles appear in the picker.
const CURATED = [
  { label: 'Bloomberg',           keywords: ['bloomberg'],            country: 'us', avoid: ['quicktake', 'originals', 'español', 'tv+', 'ht', 'mongolia', 'bnn'] },
  { label: 'Bloomberg Originals', keywords: ['bloomberg', 'originals'], country: 'us' },
  { label: 'ABC News',            keywords: ['abc', 'news'],          country: 'us', avoid: ['sabc'] },
  { label: 'CBS News',            keywords: ['cbs', 'news'],          country: 'us' },
  { label: 'NBC News Now',        keywords: ['nbc', 'news'],          country: 'us' },
  { label: 'Cheddar News',        keywords: ['cheddar', 'news'],      country: 'us' },
  { label: 'Fox News',            keywords: ['fox', 'news', 'channel'], country: 'us' },
  { label: 'Al Jazeera 2',        keywords: ['al jazeera', '2'],                     avoid: ['mubasher', 'documentary'] },
  { label: 'Sky News',            keywords: ['sky news'],             country: 'gb', avoid: ['arabia', 'weather'] },
  { label: 'CNBC Asia',           keywords: ['cnbc', 'asia'] },
  { label: 'Euronews',            keywords: ['euronews', 'english'] },
  { label: 'DW',                  keywords: ['dw'],                   country: 'de' },
  { label: 'PBS NewsHour',        keywords: ['pbs'],                  country: 'us', avoid: ['kids'] },
  { label: 'CGTN',                keywords: ['cgtn'],                                avoid: ['español', 'русский', 'français', 'العربية', 'documentary'] },
  { label: 'TRT World',           keywords: ['trt', 'world'] },
  { label: 'C-SPAN 2',            keywords: ['c-span', '2'],          country: 'us' },
  { label: 'i24 News',            keywords: ['i24', 'usa'] },
  { label: 'Fox Weather',         keywords: ['fox', 'weather'],       country: 'us' },
  { label: 'Christian Youth',     keywords: ['christian', 'youth'],   country: 'us' },
];

// --- index ------------------------------------------------------------------
// Compact on-disk shape (short keys — this file is read on every control
// request and the full catalog would otherwise be ~6MB of JSON):
//   { built, channels: [ { i:id, n:name, c:country, g:[categories],
//                          s:[ [url, user_agent, referrer], ... ] } ],
//     curated: [ { id, label } ] }

function qualityLines(q) {
  const m = /^(\d+)/.exec(String(q || ''));
  return m ? Number(m[1]) : null;
}

// Best stream first. LANDMINE (cost us a Pluto TV bumper slate on the faces
// 2026-07-25): an unlabelled stream must NOT score as "neutral". BloombergTV.us
// carries 25 streams; three have no quality tag, two of those are Pluto
// (jmp2.uk/plu-…) URLs that serve an ad slate instead of the channel, and
// treating unknown as ~540 promoted them over every real 720p feed — including
// the broadcaster's own bloomberg.com manifest, which fell to position 16.
//
// So: labelled beats unlabelled outright, then nearest 720p (plentiful, encodes
// cleanly, downsamples to 542x414 without the softness of a 270p upscale or the
// wasted decode of 2160p), then UPSTREAM ORDER as a stable tiebreak — iptv-org
// roughly lists a channel's own CDN first, which is what termtv's naive
// streams[0] was implicitly getting right.
const IDEAL_LINES = 720;
// Per-event / overflow feeds (bloomberg's own asia-event.m3u8, eu-event.m3u8, …)
// carry nothing but a holding slate when no event is running, and they PROBE FINE
// because a slate is valid video. Same trap as the Pluto bumper, so keep them as
// fallbacks instead of first picks.
const EVENT_FEED_RE = /\bevent\b|[-_]event/i;
function rankStreams(streams) {
  return streams
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const qa = qualityLines(a.s[3]);
      const qb = qualityLines(b.s[3]);
      if ((qa === null) !== (qb === null)) return qa === null ? 1 : -1;
      const ea = EVENT_FEED_RE.test(a.s[0]) ? 1 : 0;
      const eb = EVENT_FEED_RE.test(b.s[0]) ? 1 : 0;
      if (ea !== eb) return ea - eb;
      if (qa !== null && qb !== null) {
        const d = Math.abs(qa - IDEAL_LINES) - Math.abs(qb - IDEAL_LINES);
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

// Is there actually decodable video here right now? The long tail is full of
// entries that resolve but are dead, geo-blocked, or audio-only. Can't detect a
// bumper slate this way — that's what the ranking above is for.
function probeOne(url, ua, ref) {
  return new Promise((done) => {
    const args = ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'];
    if (ua) args.push('-user_agent', ua);
    if (ref) args.push('-headers', `Referer: ${ref}\r\n`);
    args.push('-i', url);
    execFile('ffprobe', args, { timeout: PROBE_MS },
      (err, stdout) => done(!err && String(stdout || '').trim().length > 0));
  });
}

// Pick a playable variant: probe the top candidates CONCURRENTLY and take the
// best-ranked one that answers. Concurrent because serial probes would stack to
// a minute on a dead channel and the in-game picker is waiting on this; the
// extra cost is two throwaway HTTP HEADs worth of traffic. Re-run on every
// pipeline loop, so a variant dying mid-play heals into the next-best one.
async function playableStream(ch) {
  const cands = ch.s.slice(0, PROBE_CANDIDATES);
  if (!cands.length) return null;
  const oks = await Promise.all(cands.map((s) => probeOne(s[0], s[1], s[2])));
  const win = oks.indexOf(true);
  return win === -1 ? null : cands[win];
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function matches(entry, ch) {
  const name = ch.n.toLowerCase();
  if (!entry.keywords.every((k) => name.includes(k.toLowerCase()))) return false;
  if ((entry.avoid || []).some((a) => name.includes(a.toLowerCase()))) return false;
  return true;
}

// Lower is better: exact country first, then the shorter name (a long name is
// usually a regional spinoff), then id for stability. Same rule as termtv.
function curatedScore(entry, ch) {
  const country = entry.country && ch.c.toLowerCase() === entry.country ? 0 : 1;
  return [country, ch.n.length, ch.i];
}

function cmpTuple(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function resolveCurated(channels) {
  const out = [];
  const seen = new Set();
  for (const entry of CURATED) {
    const cands = channels.filter((c) => !seen.has(c.i) && matches(entry, c));
    if (!cands.length) continue;
    cands.sort((x, y) => cmpTuple(curatedScore(entry, x), curatedScore(entry, y)));
    out.push({ id: cands[0].i, label: entry.label });
    seen.add(cands[0].i);
  }
  return out;
}

async function build({ force = false } = {}) {
  if (!force && indexAge() !== null && indexAge() < TTL_MS) {
    log('index still fresh, nothing to do');
    return readIndex();
  }
  log('fetching iptv-org catalog');
  const [chRaw, stRaw] = await Promise.all([
    getJSON(`${API}/channels.json`),
    getJSON(`${API}/streams.json`),
  ]);

  // channel id -> [[url, user_agent, referrer, quality], ...]
  const streamMap = new Map();
  for (const s of stRaw) {
    if (!s.channel || !s.url) continue;
    if (!/^https?:\/\//i.test(s.url)) continue;
    let list = streamMap.get(s.channel);
    if (!list) streamMap.set(s.channel, (list = []));
    list.push([s.url, s.user_agent || '', s.referrer || '', s.quality || '']);
  }

  const channels = [];
  for (const c of chRaw) {
    const streams = streamMap.get(c.id);
    if (!streams || c.is_nsfw || c.closed) continue;
    channels.push({
      i: c.id,
      n: c.name,
      c: c.country || '',
      g: c.categories || [],
      s: rankStreams(streams).map((s) => s.slice(0, 3)),
    });
  }
  channels.sort((a, b) => a.n.toLowerCase().localeCompare(b.n.toLowerCase()));

  const index = { built: Date.now(), channels, curated: resolveCurated(channels) };
  // Atomic swap: `serve` reads this file on demand and a torn read would look
  // like a corrupt catalog rather than a slow one.
  fs.writeFileSync(`${INDEX}.tmp`, JSON.stringify(index));
  fs.renameSync(`${INDEX}.tmp`, INDEX);
  log(`index built: ${channels.length} channels, ${index.curated.length}/${CURATED.length} curated resolved`);
  return index;
}

function indexAge() {
  try { return Date.now() - fs.statSync(INDEX).mtimeMs; } catch { return null; }
}

let _cache = null;
let _cacheMtime = 0;
function readIndex() {
  let mtime;
  try { mtime = fs.statSync(INDEX).mtimeMs; } catch { return null; }
  if (_cache && mtime === _cacheMtime) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    _cacheMtime = mtime;
    return _cache;
  } catch (e) {
    log(`index unreadable: ${e.message}`);
    return null;
  }
}

// --- lookup -----------------------------------------------------------------

function byId(index, id) {
  const want = String(id).toLowerCase();
  return index.channels.find((c) => c.i.toLowerCase() === want) || null;
}

function labelFor(index, ch) {
  const cur = index.curated.find((c) => c.id === ch.i);
  return cur ? cur.label : ch.n;
}

// Resolve free text to a channel. Tried in order of how much the caller
// probably meant it: exact id, exact curated label, curated label words, exact
// name, name prefix, name substring. Player chat ("sky news") lands in the
// curated tiers; the picker and garvis-bot pass ids, which short-circuit.
function resolve(index, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;

  const exactId = byId(index, q);
  if (exactId) return exactId;

  const curLabel = index.curated.find((c) => c.label.toLowerCase() === q);
  if (curLabel) return byId(index, curLabel.id);

  const words = q.split(/\s+/).filter(Boolean);
  const curWords = index.curated.filter((c) => {
    const l = c.label.toLowerCase();
    return words.every((w) => l.includes(w));
  });
  if (curWords.length) {
    curWords.sort((a, b) => a.label.length - b.label.length);
    return byId(index, curWords[0].id);
  }

  const scored = [];
  for (const c of index.channels) {
    const n = c.n.toLowerCase();
    let tier;
    if (n === q) tier = 0;
    else if (n.startsWith(q)) tier = 1;
    else if (n.includes(q)) tier = 2;
    else if (words.length > 1 && words.every((w) => n.includes(w))) tier = 3;
    else continue;
    scored.push([tier, c.n.length, c.i, c]);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => cmpTuple(a.slice(0, 3), b.slice(0, 3)));
  return scored[0][3];
}

function search(index, query, cap = SEARCH_CAP) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of index.channels) {
    const n = c.n.toLowerCase();
    let tier;
    if (n === q) tier = 0;
    else if (n.startsWith(q)) tier = 1;
    else if (n.includes(q)) tier = 2;
    else if (words.length > 1 && words.every((w) => n.includes(w))) tier = 3;
    else continue;
    hits.push([tier, c.n.length, c.i, c]);
  }
  hits.sort((a, b) => cmpTuple(a.slice(0, 3), b.slice(0, 3)));
  return hits.slice(0, cap).map(([, , , c]) => ({
    id: c.i, name: c.n, country: c.c, categories: c.g,
  }));
}

// --- current state ----------------------------------------------------------

function nowPlaying() {
  let line = 'live';
  try { line = (fs.readFileSync(SOURCE, 'utf8').split('\n')[0] || 'live').trim() || 'live'; } catch { /* default */ }
  const sp = line.indexOf(' ');
  const mode = sp === -1 ? line : line.slice(0, sp);
  const arg = sp === -1 ? '' : line.slice(sp + 1).trim();
  let label = '';
  try { label = (fs.readFileSync(NOW, 'utf8').split('\n')[0] || '').trim(); } catch { /* none */ }
  if (!label) {
    if (mode === 'live') label = 'Live world camera';
    else if (mode === 'bloomberg') label = 'Bloomberg';
    else label = arg || mode;
  }
  return { mode, arg, label };
}

// --- control API ------------------------------------------------------------

function ensureIndex() {
  const age = indexAge();
  if (age !== null && age < TTL_MS) return readIndex();
  startBuild();
  return readIndex(); // stale-but-usable while the rebuild runs, or null if absent
}

let _building = null;
function startBuild(force = false) {
  if (_building) return;
  _building = execFile(process.execPath, [__filename, 'build', ...(force ? ['--force'] : [])],
    { timeout: 300_000 }, (err) => {
      _building = null;
      try { fs.unlinkSync(BUILDING); } catch { /* fine */ }
      if (err) log(`background build failed: ${err.message}`);
    });
  try { fs.writeFileSync(BUILDING, String(Date.now())); } catch { /* fine */ }
  log('background index build started');
}

// Tune by handing source.sh a channel id (or a bare mode) as fixed argv — no
// shell, same control-plane discipline garvis-bot uses. source.sh ffprobe-vets
// the stream and refuses to flip a working screen to a dead one, so its exit
// status is the honest answer to "did that work".
function tune(args) {
  return new Promise((resolve_) => {
    execFile(SOURCE_SH, args, { timeout: 90_000 }, (err, stdout, stderr) => {
      if (!err) return resolve_({ ok: true, stdout: String(stdout || '').trim() });
      const lines = String(stderr || '').trim().split('\n').filter(Boolean);
      resolve_({ ok: false, error: (lines[lines.length - 1] || err.message || 'tune failed').slice(0, 200) });
    });
  });
}

function serve() {
  ensureIndex();
  const send = (res, code, body) => {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      // CC:T reuses connections poorly across program restarts; don't keep them.
      connection: 'close',
    });
    res.end(json);
  };

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://stadiumcast'); } catch { return send(res, 400, { ok: false, error: 'bad url' }); }
    const path = u.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      const age = indexAge();
      return send(res, 200, {
        ok: true, index: age === null ? 'absent' : `${Math.round(age / 60000)}m old`,
        building: _building !== null, now: nowPlaying(),
      });
    }

    if (path === '/now') return send(res, 200, { ok: true, now: nowPlaying() });

    if (path === '/channels') {
      const index = ensureIndex();
      if (!index) return send(res, 503, { ok: false, building: true, error: 'catalog still building' });
      const curated = index.curated.map((c) => {
        const ch = byId(index, c.id);
        return { id: c.id, label: c.label, country: ch ? ch.c : '' };
      });
      return send(res, 200, {
        ok: true, now: nowPlaying(), curated,
        total: index.channels.length, built: index.built,
      });
    }

    if (path === '/search') {
      const index = ensureIndex();
      if (!index) return send(res, 503, { ok: false, building: true, error: 'catalog still building' });
      return send(res, 200, { ok: true, results: search(index, u.searchParams.get('q') || '') });
    }

    if (path === '/tune') {
      const mode = (u.searchParams.get('mode') || '').trim().toLowerCase();
      const id = (u.searchParams.get('id') || u.searchParams.get('q') || '').trim();
      if (mode === 'live' || mode === 'bloomberg') {
        const r = await tune([mode]);
        return send(res, r.ok ? 200 : 502, r.ok
          ? { ok: true, now: nowPlaying() }
          : { ok: false, error: r.error });
      }
      if (!id) return send(res, 400, { ok: false, error: 'need ?id=<channel-id> or ?mode=live|bloomberg' });
      const index = ensureIndex();
      if (!index) return send(res, 503, { ok: false, building: true, error: 'catalog still building' });
      // Only ids the catalog actually knows reach source.sh.
      const ch = resolve(index, id);
      if (!ch) return send(res, 404, { ok: false, error: `no channel matching "${id}"` });
      const r = await tune(['channel', ch.i]);
      return send(res, r.ok ? 200 : 502, r.ok
        ? { ok: true, id: ch.i, label: labelFor(index, ch), now: nowPlaying() }
        : { ok: false, id: ch.i, label: labelFor(index, ch), error: r.error });
    }

    if (path === '/refresh') { startBuild(true); return send(res, 202, { ok: true, building: true }); }

    return send(res, 404, { ok: false, error: 'try /channels /search?q= /tune?id= /now /health' });
  });

  server.listen(CTL_PORT, '0.0.0.0', () => log(`control API on :${CTL_PORT}`));
}

// --- cli --------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'build':
      await build({ force: rest.includes('--force') });
      return;
    case 'serve':
      serve();
      return;
    case 'resolve': {
      const index = readIndex() || await build({});
      const ch = index && resolve(index, rest.join(' '));
      if (!ch) { process.stderr.write(`no channel matching "${rest.join(' ')}"\n`); process.exit(1); }
      process.stdout.write(`${ch.i}\t${labelFor(index, ch)}\n`);
      return;
    }
    case 'url': {
      // `url <id>` = best-ranked variant, no network. `--probe` = best variant
      // that actually plays right now; both source.sh (as its pre-flip vet) and
      // the pipeline loop use --probe, so they can never disagree about which
      // variant is in use.
      const index = readIndex() || await build({});
      const ch = index && byId(index, rest[0] || '');
      if (!ch || !ch.s.length) { process.stderr.write(`no stream for "${rest[0]}"\n`); process.exit(1); }
      let pick = ch.s[0];
      if (rest.includes('--probe')) {
        pick = await playableStream(ch);
        if (!pick) {
          process.stderr.write(`no playable stream for "${ch.i}" (tried ${Math.min(PROBE_CANDIDATES, ch.s.length)} variants — dead or geo-blocked)\n`);
          process.exit(1);
        }
      }
      // TAB-separated so entrypoint.sh can read it without eval.
      const [url, ua, ref] = pick;
      process.stdout.write(`${url}\t${ua || ''}\t${ref || ''}\n`);
      return;
    }
    case 'search': {
      const index = readIndex() || await build({});
      for (const r of search(index, rest.join(' '))) process.stdout.write(`${r.id}\t${r.name}\t${r.country}\n`);
      return;
    }
    default:
      process.stderr.write('usage: channels.js build [--force] | serve | resolve <q> | url <id> | search <q>\n');
      process.exit(2);
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
