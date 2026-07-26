#!/usr/bin/env node
'use strict';
// castaudio.js — TV audio for the jumbotron, as a DFPWM websocket on :8179.
//
// ComputerCraft really can play arbitrary audio: speaker.playAudio() takes 48kHz
// mono signed-8-bit PCM, and cc.audio.dfpwm decodes DFPWM1a (1 bit/sample, so a
// whole second of audio is 6000 bytes). ffmpeg has had a native dfpwm encoder
// since 5.1, so the entire chain is: channel's AAC -> ffmpeg -> 6KB/s -> ws ->
// jumboaudio.lua -> speakers. Measured on computer 10: decoding costs ~250ms per
// 5s of audio, i.e. ~5% of one computer.
//
// WHY THIS IS A SEPARATE ffmpeg FROM THE VIDEO LEG, AND NOT sanjuuni'S OWN AUDIO:
// sanjuuni does carry audio (-w "sends the image/video with audio", -d for dfpwm,
// ws command `a<offset>`), but in -T streamed mode the encoder only advances one
// video frame per client message (sanjuuni.cpp:1225) and audio is appended to its
// ring only as the encoder walks the input. The `a` handler always returns a
// fixed 1s chunk and ZERO-PADS when the ring is short (sanjuuni.cpp:281-289), so
// at the faces' 3-4fps draw ceiling against a 10fps input most chunks would come
// back as silence padding. Audio has to be paced by wall-clock, not by the blit
// rate, which means its own process. Same reason we don't just add a second
// output to the video ffmpeg: that one blocks on the CAST_FIFO by design (it IS
// the backpressure that paces the faces), and a shared process would drag audio
// down with it.
//
// The URL still has to be the one the VIDEO leg picked, though — channels.js
// ranks several variants per channel and they are not always the same programme
// (a channel's asia/eu manifests differ). So entrypoint.sh, which owns source
// resolution, publishes its choice to /media/audio-source and we follow it.
//
// Protocol (client -> server, text; mirrors sanjuuni's so jumboaudio.lua reads
// like jumboplay.lua):
//   a      -> one binary chunk: 6000 bytes of DFPWM = exactly 1s @ 48kHz mono.
//             Text "!" instead when nothing is buffered yet (parked/starting).
//   d<n>   -> set the target buffer depth to n seconds; replies "ok <n>".
//             This is the A/V sync knob: the faces run seconds behind live, so
//             audio has to be held back to match. Tunable in-game, no rebuild.
//   s      -> status JSON (same shape as GET /health).
// Serving trims the queue to the target first, so a client that falls behind gets
// a forward SKIP (a click) instead of unbounded drift.
//
// Logs go to stdout only — entrypoint.sh redirects us into /media/audio.log.
// (channels.js learned this the hard way: writing to both a file and stderr while
// the caller redirects stderr into that same file double-logs everything.)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = Number(process.env.CAST_AUDIO_PORT || 8179);
const SRC_FILE = process.env.CAST_AUDIO_SRC || '/media/audio-source';
// 48000 samples/s at 1 bit/sample = 6000 bytes = 1.000s. Keep it exact: the
// client's speaker consumption is the clock, so a chunk that isn't a round
// second makes the delay knob lie.
const CHUNK = 6000;
// Seconds of audio buffered before playback starts. This is BOTH the A/V offset
// knob and the underrun guard, and the second job sets the floor: HLS hands over
// a whole segment at a time, so production is a sawtooth, not a trickle. Measured
// on a live iptv-org feed: bursts of 6 chunks every 6s (6s segments), averaging
// exactly real time. A prebuffer shallower than the segment period drains to
// empty between bursts and stutters forever — 8 gives ~2s of trough headroom.
// Tune live with `d<n>` from jumboaudio.lua, then persist via CAST_AUDIO_DELAY.
const DEFAULT_TARGET = Number(process.env.CAST_AUDIO_DELAY || 8);
// How far above the target we tolerate before treating it as drift and skipping
// forward. Must clear one full burst (6) or ordinary sawtooth peaks would read as
// drift and we'd throw away good audio.
const SLACK = Number(process.env.CAST_AUDIO_SLACK || 10);
// Hard cap on the ring so a client that never reads can't grow us without bound.
// 40 chunks = 240KB. (The 2026-07-24 sanjuuni outage was exactly this bug at
// video scale: an unread buffer with no ceiling ate 94GB.)
const RING_MAX = Number(process.env.CAST_AUDIO_RING || 40);
// TV loudness is all over the place and 1-bit audio punishes quiet sources
// (quantisation noise doesn't scale down with the signal), so normalise on the
// way in. Single-pass, realtime-safe. Set empty to disable.
const FILTER = process.env.CAST_AUDIO_FILTER === undefined
  ? 'dynaudnorm=f=250:g=15'
  : process.env.CAST_AUDIO_FILTER;

let target = DEFAULT_TARGET;
let ring = [];
let pending = null;
let primed = false;
// Live vs VOD need OPPOSITE overflow policies, so the source line says which.
// Live (channel/bloomberg): drop the oldest and skip forward — falling behind the
// live edge is worse than a click. VOD (youtube): never drop, backpressure ffmpeg
// instead, because a file has no live edge to chase and dropping is pure damage.
// This is not hypothetical: `-re -stream_loop -1` on a short clip produces ~5x
// real time (measured on a 19s video), so a dropping policy skipped constantly.
let isVod = false;
let produced = 0, skipped = 0, served = 0, underruns = 0;
let srcLine = '';
let proc = null;
let quickFails = 0;
let restartTimer = null;

const log = (...a) => console.log('[audio]', ...a);

// --- ffmpeg leg -------------------------------------------------------------

function stopFfmpeg() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (proc) { const p = proc; proc = null; try { p.kill('SIGKILL'); } catch {} }
  pending = null;
}

function startFfmpeg() {
  if (!srcLine) return;
  // url \t user-agent \t referer \t extra-input-flags (space separated).
  // Split on tabs, not spaces: user agents have spaces, and the referer is kept
  // as a bare value so WE build the CRLF header — a literal "Referer: x\r\n" in
  // the file would break its own line.
  const [url, ua, ref, flags, kind] = srcLine.split('\t');
  if (!url) return;
  isVod = kind === 'vod';

  const args = ['-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  if (ua) args.push('-user_agent', ua);
  if (ref) args.push('-headers', `Referer: ${ref}\r\n`);
  // youtube mode passes "-re -stream_loop -1": -re paces a VOD at 1x so it stays
  // roughly aligned with the video leg (which is also -re paced), and the loop
  // keeps a short clip going without a pipeline teardown.
  if (flags) for (const f of flags.split(' ')) if (f) args.push(f);
  args.push('-i', url, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000');
  if (FILTER) args.push('-af', FILTER);
  args.push('-f', 'dfpwm', 'pipe:1');

  const started = Date.now();
  log('ffmpeg ->', url.slice(0, 100));
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc = p;

  p.stdout.on('data', (buf) => {
    pending = pending ? Buffer.concat([pending, buf]) : buf;
    while (pending.length >= CHUNK) {
      // Copy out: subarray would keep the whole concatenated buffer alive.
      ring.push(Buffer.from(pending.subarray(0, CHUNK)));
      pending = pending.subarray(CHUNK);
      produced++;
      if (ring.length > RING_MAX) {
        if (isVod) p.stdout.pause();          // let ffmpeg block; serveChunk resumes
        else { ring.shift(); skipped++; }     // live: stay near the edge
      }
    }
  });
  p.stderr.on('data', (b) => {
    const s = b.toString().trim();
    if (s) log('ffmpeg:', s.split('\n').slice(-3).join(' | '));
  });
  p.on('exit', (code, sig) => {
    if (proc !== p) return;            // superseded by a source change
    proc = null;
    pending = null;
    const ran = (Date.now() - started) / 1000;
    quickFails = ran < 5 ? quickFails + 1 : 0;
    // A source with no audio stream at all fails instantly and forever — don't
    // spin on it. The next source change clears the counter.
    if (quickFails >= 4) {
      log(`giving up on this source: ffmpeg exited in ${ran.toFixed(1)}s, ${quickFails}x in a row (no audio stream?)`);
      return;
    }
    log(`ffmpeg exited (code=${code} sig=${sig}) after ${ran.toFixed(1)}s — retrying in 3s`);
    restartTimer = setTimeout(() => { restartTimer = null; startFfmpeg(); }, 3000);
  });
}

// entrypoint.sh truncates the file when the pipeline is torn down (including the
// leak guard's park cycle), so an empty file means "no audio right now".
function pollSource() {
  let line = '';
  try { line = (fs.readFileSync(SRC_FILE, 'utf8').split('\n')[0] || '').trim(); } catch {}
  if (line === srcLine) return;
  srcLine = line;
  quickFails = 0;
  stopFfmpeg();
  ring = [];
  primed = false;      // new source: refill the prebuffer before playing again
  if (srcLine) startFfmpeg();
  else log('source cleared — audio idle');
}

// --- minimal websocket ------------------------------------------------------
// Node stdlib only (same rule as channels.js: nodejs is in the image for yt-dlp,
// there is nothing to npm-install). We only ever receive tiny text commands and
// only ever send <=6000 byte payloads, but lengths/opcodes are handled properly.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

const sendText = (sock, s) => sock.write(frame(0x1, Buffer.from(s, 'utf8')));
const sendBin = (sock, b) => sock.write(frame(0x2, b));

function status() {
  return {
    up: !!proc,
    kind: isVod ? 'vod' : 'live',
    queued: ring.length,
    target,
    primed,
    produced,
    served,
    skipped,
    underruns,
    clients,
    src: srcLine ? srcLine.split('\t')[0] : null,
  };
}

function serveChunk(sock) {
  // Re-anchor to the live edge when we're well past the target. Two cases, one
  // rule: ffmpeg gulps the whole HLS playlist window at startup (a live source
  // has no -re to pace it, and that gulp is what keeps it near the live edge),
  // and a client that stalls leaves a backlog behind. Both mean "the front of
  // the ring is stale" — drop to the NEWEST target chunks. Do NOT trim on every
  // serve just for being above target: production is a 6-chunk sawtooth, so
  // being temporarily over is normal, and trimming it discarded whole bursts
  // (first cut of this served 8 chunks and 4 silences out of 12 requests).
  if (!isVod && ring.length > target + SLACK) {
    skipped += ring.length - target;
    ring = ring.slice(ring.length - target);
  }
  if (!primed) {
    if (ring.length < target) return sendText(sock, '!');   // still filling
    primed = true;
  }
  if (!ring.length) {
    // Drained despite the prebuffer. Re-prime rather than dribble out one chunk
    // per burst forever: one clean gap beats permanent chop.
    primed = false;
    underruns++;
    return sendText(sock, '!');
  }
  sendBin(sock, ring.shift());
  served++;
  // A VOD's producer is parked on a full ring until we make room here.
  if (isVod && proc && ring.length <= RING_MAX) proc.stdout.resume();
}

function onCommand(sock, text) {
  const c = text[0];
  if (c === 'a') return serveChunk(sock);
  if (c === 'd') {
    const n = parseInt(text.slice(1), 10);
    if (Number.isFinite(n) && n >= 0 && n <= RING_MAX) {
      target = n;
      log('target depth ->', n);
      return sendText(sock, `ok ${n}`);
    }
    return sendText(sock, `bad ${text.slice(1)}`);
  }
  if (c === 's') return sendText(sock, JSON.stringify(status()));
  sendText(sock, '?');
}

let clients = 0;

function handleUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  clients++;
  log(`client connected (${clients} total)`);

  let buf = Buffer.alloc(0);
  // 'close' alone is not enough: an upgraded socket can sit half-open after the
  // peer's FIN, so the count drifted up forever (observed: two finished clients
  // still reported as connected, with nothing in /proc/net/tcp). Take whichever
  // event arrives first, destroy for real, and guard against the double fire.
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    clients--;
    log(`client gone (${clients} left)`);
    try { sock.destroy(); } catch { /* already down */ }
  };
  sock.on('close', done);
  sock.on('end', done);
  sock.on('error', done);

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off)); off += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { sock.end(frame(0x8, Buffer.alloc(0))); return; }
      else if (opcode === 0x9) sock.write(frame(0xa, payload));
      else if (opcode === 0x1) onCommand(sock, payload.toString('utf8').trim());
      // 0x2 (binary) and 0xa (pong) from a client are not part of the protocol.
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status(), null, 2) + '\n');
  } else {
    res.writeHead(404).end('not found\n');
  }
});
server.on('upgrade', handleUpgrade);
server.listen(PORT, () => log(`listening on :${PORT} (target depth ${target}s, filter ${FILTER || 'none'})`));

pollSource();
setInterval(pollSource, 1000);
process.on('SIGTERM', () => { stopFfmpeg(); process.exit(0); });
process.on('SIGINT', () => { stopFfmpeg(); process.exit(0); });
