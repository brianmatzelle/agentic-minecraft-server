// In-game "TV" renderer — put text or a web image on a CraftOS monitor.
//
// The player asks Garvis (`!g put a creeper on the TV`); index.js routes the "tv"
// intent to a web-capable director call that returns a render spec, then hands it
// here. All the heavy lifting (fetch, decode, downscale, colour-quantise) happens
// HOST-SIDE in Node — the in-game computer can't decode a PNG. We push it only a
// finished `blit` payload (a custom 16-colour palette + one hex string per row),
// which it paints to the monitor. That fits the garvtunnel model perfectly: one
// synchronous, self-contained chunk, no long-running listener (so no wedge risk).
//
// Transport: the bot POSTs Lua to the garvtunnel control plane (127.0.0.1:8175,
// host-only, token-gated) — the same plane the `cc` helper uses. The monitor is on
// a specific computer (GARVIS_TV_COMPUTER, default 9); we target it by id.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Jimp from 'jimp';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ -> apps/garvis-bot -> apps -> apps/server/.env (holds TUNNEL_TOKEN).
const SERVER_ENV = resolve(__dirname, '../../server/.env');

const CTL_BASE = `http://127.0.0.1:${process.env.TUNNEL_CTL_PORT || '8175'}`;

// Monitor geometry at text scale 0.5 (probe-confirmed on computer 9). Each CraftOS
// character cell is a 6x9 font-pixel box; letterboxing into (W*6)x(H*9) then
// downscaling to WxH keeps real-world proportions (square font pixels) so images
// aren't stretched. One colour per cell (space char + background colour).
const MON_W = 164, MON_H = 81;
const CELL_W = 6, CELL_H = 9;
const HEX = '0123456789abcdef';

// CraftOS default palette (24-bit RGB per slot 0..15), used to restore normal
// colours for text mode after an image may have left a custom palette behind.
const DEFAULT_PALETTE = [
  0xf0f0f0, 0xf2b233, 0xe57fd8, 0x99b2f2, 0xdede6c, 0x7fcc19, 0xf2b2cc, 0x4c4c4c,
  0x999999, 0x4c99b2, 0xb266e5, 0x3366cc, 0x7f664c, 0x57a64e, 0xcc4c4c, 0x111111,
];

// ── tunnel token + push ──────────────────────────────────────────────────────
async function tunnelToken() {
  if (process.env.TUNNEL_TOKEN) return process.env.TUNNEL_TOKEN.trim();
  try {
    const env = await readFile(SERVER_ENV, 'utf8');
    const m = env.match(/^TUNNEL_TOKEN=(.*)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// POST one Lua chunk to the control plane, targeting a specific computer by id.
// Returns { ok, result } or { ok:false, error }. Never throws.
export async function pushToTunnel(code, { computerId, timeoutMs = 15_000 } = {}) {
  const token = await tunnelToken();
  if (!token) return { ok: false, error: 'no TUNNEL_TOKEN (env or apps/server/.env)' };
  let resp;
  try {
    resp = await fetch(`${CTL_BASE}/exec`, {
      method: 'POST',
      headers: { 'X-Tunnel-Token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ code, id: computerId == null ? undefined : String(computerId) }),
      signal: AbortSignal.timeout(timeoutMs + 2_000),
    });
  } catch (e) { return { ok: false, error: `tunnel unreachable: ${e.message}` }; }
  if (!resp.ok) return { ok: false, error: `tunnel HTTP ${resp.status}` };
  const j = await resp.json().catch(() => null);
  if (!j) return { ok: false, error: 'bad tunnel response' };
  if (j.ok === false || j.error) return { ok: false, error: String(j.error || 'exec error') };
  const ret = Array.isArray(j.returns) ? String(j.returns[0] ?? '') : '';
  if (ret === 'NOMON') return { ok: false, error: 'no monitor attached to the TV computer' };
  return { ok: true, result: ret, raw: j };
}

// ── image → blit payload ───────────────────────────────────────────────────────
// Fetch a direct image URL into a Buffer, with http(s)-only, size, and time guards.
export async function fetchImageBuffer(url, { maxBytes = 8 * 1024 * 1024, timeoutMs = 12_000 } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('url must be http(s)');
  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('empty image');
  if (buf.length > maxBytes) throw new Error('image too large');
  return buf;
}

// Median-cut colour quantisation → up to 16 representative RGB colours. Splits the
// bucket with the largest volume along its widest channel until 16 buckets (or none
// can split further). Cheap: ~13k pixels, 16 colours.
function quantize16(pixels) {
  let buckets = [pixels.slice()];
  const rangeOf = (b) => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
    return { mn, mx };
  };
  while (buckets.length < 16) {
    let bi = -1, best = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.length < 2) continue;
      const { mn, mx } = rangeOf(b);
      const vol = (mx[0] - mn[0] + 1) * (mx[1] - mn[1] + 1) * (mx[2] - mn[2] + 1);
      if (vol > best) { best = vol; bi = i; }
    }
    if (bi < 0) break;                                   // nothing left to split
    const b = buckets[bi];
    const { mn, mx } = rangeOf(b);
    const rng = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = rng[0] >= rng[1] && rng[0] >= rng[2] ? 0 : (rng[1] >= rng[2] ? 1 : 2);
    b.sort((p, q) => p[ch] - q[ch]);
    const mid = b.length >> 1;
    buckets[bi] = b.slice(0, mid);
    buckets.push(b.slice(mid));
  }
  return buckets.map((b) => {
    if (!b.length) return [0, 0, 0];
    const s = [0, 0, 0];
    for (const p of b) for (let c = 0; c < 3; c++) s[c] += p[c];
    return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length)];
  });
}

function nearest(palette, p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const q = palette[i];
    const dr = p[0] - q[0], dg = p[1] - q[1], db = p[2] - q[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// Decode + downscale a buffer to the monitor grid and quantise → { palette, rows }.
// palette: up to 16 [r,g,b] (0..255); rows: MON_H strings of MON_W hex chars.
export async function imageToSpec(buf) {
  const img = await Jimp.read(buf);
  img.contain(MON_W * CELL_W, MON_H * CELL_H);          // letterbox, preserve aspect
  img.resize(MON_W, MON_H);                             // area-average to the cell grid
  const { data, width, height } = img.bitmap;
  const pixels = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    pixels[i] = a < 128
      ? [17, 17, 17]                                     // transparent/letterbox -> near-black
      : [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  }
  const palette = quantize16(pixels);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += HEX[nearest(palette, pixels[y * width + x])];
    rows.push(row);
  }
  return { palette, rows, width, height };
}

// Build the self-contained Lua chunk that paints the image on the monitor. rows are
// pure [0-9a-f], so they need no Lua escaping.
export function buildImageLua({ palette, rows }) {
  const pal = palette
    .map((c) => `{${(c[0] / 255).toFixed(4)},${(c[1] / 255).toFixed(4)},${(c[2] / 255).toFixed(4)}}`)
    .join(',');
  const rowsLua = rows.map((r) => `"${r}"`).join(',');
  return [
    'local m=peripheral.find("monitor")',
    'if not m then return "NOMON" end',
    'm.setTextScale(0.5)',
    `local pal={${pal}}`,
    'for i=1,#pal do m.setPaletteColour(2^(i-1),pal[i][1],pal[i][2],pal[i][3]) end',
    `local rows={${rowsLua}}`,
    'local W=#rows[1]',
    'm.setBackgroundColour(1) m.clear()',
    'local blank=(" "):rep(W)',
    'for y=1,#rows do m.setCursorPos(1,y) m.blit(blank,rows[y],rows[y]) end',
    'return "OK"',
  ].join('\n');
}

// ── text → Lua ─────────────────────────────────────────────────────────────────
// Safe Lua double-quoted string literal (UTF-8 bytes; non-printables as \ddd).
function luaStr(s) {
  const bytes = Buffer.from(String(s ?? ''), 'utf8');
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b >= 32 && b < 127) out += String.fromCharCode(b);
    else out += '\\' + String(b).padStart(3, '0');
  }
  return out + '"';
}

// Pick a text scale so the message reads big but still fits. Larger scale = bigger
// glyphs = fewer columns; short messages get the biggest treatment.
function textScaleFor(body) {
  const n = String(body ?? '').length;
  if (n <= 24) return 3;
  if (n <= 64) return 2;
  if (n <= 140) return 1.5;
  return 1;
}

// Build the Lua chunk that shows a centred, word-wrapped announcement. The wrap +
// centring happens IN Lua against the monitor's real getSize() at the chosen scale,
// so it stays correct regardless of exact monitor dimensions.
export function buildTextLua({ title = '', body = '' } = {}) {
  const scale = textScaleFor(body);
  return [
    'local m=peripheral.find("monitor")',
    'if not m then return "NOMON" end',
    `local DEF={${DEFAULT_PALETTE.map((h) => '0x' + h.toString(16)).join(',')}}`,
    'for i=1,16 do m.setPaletteColour(2^(i-1),DEF[i]) end',
    `m.setTextScale(${scale})`,
    'local W,H=m.getSize()',
    'm.setBackgroundColour(colours.black) m.setTextColour(colours.white) m.clear()',
    `local title=${luaStr(title)}`,
    `local body=${luaStr(body)}`,
    // greedy word-wrap body to width W
    'local lines={}',
    'local cur=""',
    'for word in tostring(body):gmatch("%S+") do',
    '  if #cur==0 then cur=word',
    '  elseif #cur+1+#word<=W then cur=cur.." "..word',
    '  else lines[#lines+1]=cur cur=word end',
    '  while #cur>W do lines[#lines+1]=cur:sub(1,W) cur=cur:sub(W+1) end',
    'end',
    'if #cur>0 then lines[#lines+1]=cur end',
    'local block=#lines+(title~="" and 2 or 0)',
    'local y=math.max(1,math.floor((H-block)/2)+1)',
    'if title~="" then',
    '  local t=title:sub(1,W)',
    '  m.setCursorPos(math.max(1,math.floor((W-#t)/2)+1),y)',
    '  m.setTextColour(colours.yellow) m.write(t)',
    '  m.setTextColour(colours.white) y=y+2',
    'end',
    'for _,l in ipairs(lines) do',
    '  m.setCursorPos(math.max(1,math.floor((W-#l)/2)+1),y) m.write(l) y=y+1',
    'end',
    'return "OK"',
  ].join('\n');
}

// ── top-level: render a director spec to the TV ─────────────────────────────────
// spec: {mode:'image', url, label} | {mode:'text', title, body}. Returns
// { ok, text } — text is a short in-game chat confirmation (or a private apology).
export async function renderSpecToTv(spec, { computerId = '9', player = '' } = {}) {
  if (!spec || !spec.mode) return { ok: false, text: "I couldn't work out what to put up there — try rephrasing?" };

  if (spec.mode === 'image') {
    let lua;
    try {
      const buf = await fetchImageBuffer(spec.url);
      lua = buildImageLua(await imageToSpec(buf));
    } catch (e) {
      return { ok: false, text: `That image wouldn't load (${e.message}) — try another?` };
    }
    const push = await pushToTunnel(lua, { computerId });
    if (!push.ok) return { ok: false, text: `I got the image but couldn't reach the TV (${push.error}).` };
    const cap = spec.label ? `: ${spec.label}` : '';
    return { ok: true, text: `📺 Now showing on the TV${cap}${player ? ` — for ${player}` : ''}.` };
  }

  // text
  const push = await pushToTunnel(buildTextLua({ title: spec.title, body: spec.body }), { computerId });
  if (!push.ok) return { ok: false, text: `Couldn't reach the TV (${push.error}).` };
  return { ok: true, text: `📺 Put it on the TV${player ? ` for ${player}` : ''}.` };
}

// Defensive parse of the TV director's JSON output → a render spec, or null on any
// miss (mirrors ingame.js parseIngameClassification). Pure + testable.
export function parseTvSpec(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const mode = String(o.mode ?? '').trim().toLowerCase();
  if (mode === 'image') {
    const url = String(o.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    return { mode: 'image', url, label: String(o.label ?? '').trim().slice(0, 60) };
  }
  if (mode === 'text') {
    const title = String(o.title ?? '').trim().slice(0, 60);
    const body = String(o.body ?? '').trim().slice(0, 220);
    if (!title && !body) return null;
    return { mode: 'text', title, body };
  }
  return null;
}
