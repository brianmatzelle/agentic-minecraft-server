// In-game JUMBOTRON — put a YouTube video on the 5-face stadium screen.
//
// The stadium jumbotron is a different display from the small in-game TV (tv.js):
// it's a live sanjuuni video pipeline, not a one-shot blit, so it's the only screen
// that can actually PLAY something. A player just pastes a link — "!g put
// https://youtu.be/… on the jumbotron" — and the video comes up on all five faces.
//
// Control plane: fixed-argv `docker exec mc-stadiumcast /opt/source.sh …` (no shell),
// exactly like body.js drives chat.sh. The sidecar owns yt-dlp/ffmpeg; the bot only
// hands it a URL it has already normalised. Player text NEVER reaches the container
// raw: extractYouTubeUrl() rebuilds a canonical watch URL from a validated 11-char
// video id, so query junk, tracking params, and injection shapes are dropped by
// construction. source.sh resolves the link BEFORE flipping, so a dead link leaves
// whatever was playing alone and comes back as an error we can tell the player.
//
// Ops runbook (channels, health, the blank-screen ladder): .claude/skills/stream.
import { execFile } from 'node:child_process';

const CAST_CONTAINER = process.env.GARVIS_CAST_CONTAINER || 'mc-stadiumcast';
// yt-dlp resolution is a live network round trip (~3s typical) and it self-updates
// on a first failure, which is slow but worth waiting through.
const CAST_TIMEOUT_MS = Number(process.env.GARVIS_CAST_TIMEOUT_MS || 180_000);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Pull a YouTube video id out of chat text and rebuild the canonical watch URL, or
// null. Covers the shapes people actually paste: watch?v=, youtu.be/, /live/,
// /shorts/, /embed/ — with or without scheme/www/m/music, and with any trailing
// punctuation or &list=… junk chat glues on.
export function extractYouTubeUrl(text) {
  const s = String(text ?? '');
  const m = s.match(
    /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[\w=&%.-]*&)?v=|live\/|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  );
  if (!m) return null;
  const id = m[1];
  if (!VIDEO_ID_RE.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

// "put bloomberg back on the jumbotron" / "jumbotron back to the camera" → a channel
// name, else null. Deliberately narrow: it only fires when the message names the big
// screen, so "show me a creeper" still goes to the normal TV/Q&A paths.
export function parseChannelAsk(text) {
  const s = String(text ?? '').toLowerCase();
  if (!/\b(jumbotron|jumbo|big screen|stadium screen|stadium tv|the big tv)\b/.test(s)) return null;
  if (/\b(bloomberg|business news|stock|market|finance)\b/.test(s)) return 'bloomberg';
  if (/\b(camera|cam|live view|the world|back to normal|normal|nothing|off)\b/.test(s)) return 'live';
  return null;
}

// docker exec the source switcher. Returns { ok, stdout, error } — never throws.
function runSource(args) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', CAST_CONTAINER, '/opt/source.sh', ...args], { timeout: CAST_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        if (!err) return resolve({ ok: true, stdout: out });
        // source.sh prints yt-dlp's own complaint on failure; the last line is the
        // useful bit ("Video unavailable", "Private video", "Sign in to confirm…").
        const lines = String(stderr ?? '').trim().split('\n').filter(Boolean);
        const why = lines.length ? lines[lines.length - 1].replace(/^ERROR:\s*/i, '') : (err.message || 'unknown error');
        resolve({ ok: false, error: why.slice(0, 180) });
      });
  });
}

// source.sh echoes "source -> youtube ▶ <title> (pipeline restarting)".
function titleFrom(stdout) {
  const m = String(stdout ?? '').match(/▶\s*(.+?)\s*\(pipeline restarting\)\s*$/);
  return m ? m[1] : '';
}

// Play a (already-normalised) YouTube URL on the jumbotron. Returns { ok, text }.
export async function playOnJumbotron({ url, player = '' } = {}) {
  const res = await runSource(['youtube', url]);
  if (!res.ok) return { ok: false, text: `That link won't play on the jumbotron — ${res.error}` };
  const title = titleFrom(res.stdout);
  const who = player ? ` — ${player}'s pick` : '';
  return {
    ok: true,
    text: `📺 Jumbotron: ${title || 'your video'}${who}. Give it ~10s, then look up at the stadium screen.`,
  };
}

// Flip the jumbotron to a non-video channel ('bloomberg' | 'live').
export async function setJumbotronChannel(channel, { player = '' } = {}) {
  if (channel !== 'bloomberg' && channel !== 'live') return { ok: false, text: "I only know 'bloomberg' and the live camera for the jumbotron." };
  const res = await runSource([channel]);
  if (!res.ok) return { ok: false, text: `Couldn't switch the jumbotron — ${res.error}` };
  const who = player ? ` (${player})` : '';
  return {
    ok: true,
    text: channel === 'bloomberg'
      ? `📺 Jumbotron back on Bloomberg TV${who}.`
      : `📺 Jumbotron back on the live world camera${who}.`,
  };
}
