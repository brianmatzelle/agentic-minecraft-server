// In-game Garvis bridge (Layer 3, in-game side) — the `!g` / `!gw` chat triggers.
//
// This is the no-custom-mod path to "talk to Garvis in Minecraft": instead of a
// NeoForge mod registering a real `/g` slash command (a documented Phase 2 — see
// docs/in-game-garvis.md), we reuse the SAME trust boundary the bot already owns.
//
//   player types in chat:  !g how do waystones work?
//     -> server logs the line:  <Steve> !g how do waystones work?
//     -> we tail `docker logs -f <container>`, parse the chat line
//     -> hand the message to Garvis's existing Q&A brain (index.js wiring)
//     -> push the reply back in-game via `rcon-cli tellraw` (moderation.js rconExec)
//
// The bridge can watch several trigger tokens on one log stream (`!g` public, `!gw`
// whisper); the matched token is passed to onMessage so the wiring can route. NOTE
// the transport asymmetry: the TYPED line is public chat either way (we only read
// the log — chat can't be intercepted); only the REPLY target differs. True private
// input is the Phase 2 mod's job.
//
// SECURITY: this module never builds a shell command and never executes anything the
// player says. The only live-server write it performs is a FIXED `tellraw` whose
// argv is an array (execFile, no shell) — same property as the moderation catalog.
// The player's message is passed UP to the wiring as data; the wiring fences it
// before it ever reaches the model. The chat line's FIRST `<name>` is always the
// server-stamped real sender, so a player can't spoof another's name (a faked
// "<Bob> !g …" inside their own message lands AFTER the real "<Steve> " prefix and
// fails the trigger check). See docs/in-game-garvis.md + docs/security.md.

import { spawn } from 'node:child_process';

// Minecraft Java usernames: 3–16 chars, letters/digits/underscore.
const CHAT_RE = /^<([A-Za-z0-9_]{3,16})>\s+(.*)$/;
// itzg runs the server on a TTY, so `docker logs` carries terminal control codes —
// not just SGR colors (…m) but cursor/erase sequences (…K) too. Strip all CSI escapes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Parse one raw server-log line into { player, message } IFF it's a chat message
// that starts with the trigger token. Returns null for everything else. Pure +
// testable: no I/O, no state.
//
//   "[12:34:56] [Server thread/INFO]: <Steve> !g hi there"  -> { player:'Steve', message:'hi there' }
//   "[12:34:56] [Server thread/INFO]: <Steve> just chatting" -> null (no trigger)
//   "[12:34:56] [Server thread/INFO]: Steve joined the game"  -> null (not chat)
export function parseChatLine(raw, trigger) {
  const clean = String(raw ?? '').replace(ANSI_RE, '');
  // Drop the log prefix up to the FIRST "]: " (timestamp + thread/level bracket).
  const afterPrefix = clean.includes(']: ') ? clean.slice(clean.indexOf(']: ') + 3) : clean;
  // Unsigned-chat servers can stamp a leading "[Not Secure] " marker before <name>.
  const body = afterPrefix.replace(/^\[Not Secure\]\s*/, '');
  const m = body.match(CHAT_RE);
  if (!m) return null;
  const player = m[1];
  const said = m[2];
  // The trigger must be a whole leading token: exactly "!g" or "!g <text>".
  if (said !== trigger && !said.startsWith(trigger + ' ')) return null;
  const message = said.slice(trigger.length).trim();
  return { player, message };
}

// Parse the in-game classifier's reply (a single JSON object). Defensive about stray
// prose / ```json fences, mirroring moderation.js's parseClassification. Returns one of
// three intents plus, for a give, the raw extracted args (the item id / count / recipient
// are RE-VALIDATED later by moderation.js resolveAction — this is pure extraction, no
// validation):
//
//   {"intent":"give","give":{"item":"minecraft:stone","count":64,"player":"me"}}
//     -> { intent:'give', give:{ player:'me', item:'minecraft:stone', count:'64' } }
//   {"intent":"modreq"}  -> { intent:'modreq', give:null }
//   anything else / unparseable / a give with no item  -> { intent:'qa', give:null }
//
// 'qa' is the safe default: a classifier hiccup can never silently spawn the maint agent
// OR perform a give. Pure + testable: no I/O, no state.
export function parseIngameClassification(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return { intent: 'qa', give: null };
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); }
  catch { return { intent: 'qa', give: null }; }
  if (!obj || typeof obj !== 'object') return { intent: 'qa', give: null };
  const intent = String(obj.intent ?? '').trim().toLowerCase();
  if (intent === 'modreq') return { intent: 'modreq', give: null };
  if (intent === 'give') {
    // Tolerate either a nested {"give":{…}} or the fields placed flat on the object.
    const g = obj.give && typeof obj.give === 'object' ? obj.give : obj;
    const item = g.item == null ? '' : String(g.item).trim();
    const player = g.player == null ? '' : String(g.player).trim();
    const count = g.count == null || String(g.count).trim() === '' ? null : String(g.count).trim();
    if (!item) return { intent: 'qa', give: null };   // a give with no item is meaningless → safe qa
    return { intent: 'give', give: { player, item, count } };
  }
  return { intent: 'qa', give: null };
}

// Back-compat thin wrapper: the original API returned just the intent string for the
// modreq-vs-qa split. Anything that isn't an explicit mod request reads as 'qa'.
export function parseIngameIntent(text) {
  return parseIngameClassification(text).intent === 'modreq' ? 'modreq' : 'qa';
}

// Split a reply into in-game chat lines. Each becomes ONE tellraw (one chat line),
// so we honor Garvis's own newlines, then hard-wrap long lines and cap the total so
// a runaway answer can't flood chat. The prompt already asks Garvis to be terse.
// Pure + testable: no I/O, no state.
export function toChatLines(text, { maxLineLen = 230, maxLines = 8 } = {}) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    // ChatImage renders a line as an inline image only if the URL (or a legacy
    // [[CICode,url=…]] tag) reaches the client intact — its checkImageUri
    // auto-detection (default-on) scans every chat-HUD line, tellraw included.
    // Hard-wrapping would sever the URL and players would see broken fragments
    // instead of the image. A line carrying either skips the wrap (RCON takes
    // the length fine; it renders as an image, not text, so "width" is moot).
    if (line.includes('[[CICode') || /https?:\/\//.test(line)) { out.push(line); continue; }
    for (let i = 0; i < line.length; i += maxLineLen) out.push(line.slice(i, i + maxLineLen));
  }
  if (!out.length) return ['(no answer)'];
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] += ' …'; }
  return out;
}

// Build the argv for one `tellraw <target> <json>`. First line carries the bold
// aqua [Garvis] tag; continuation lines are plain. JSON.stringify does all the
// escaping, so the player-facing text can contain any characters safely.
// style 'whisper' renders gray italic (vanilla /msg styling) so a private reply
// is visually distinct from the public voice.
function tellrawArgv(target, line, withTag, style) {
  const whisper = style === 'whisper';
  const body = whisper ? { text: line, color: 'gray', italic: true } : { text: line, color: 'white' };
  const tag = whisper
    ? { text: '[Garvis whispers] ', color: 'aqua', bold: true, italic: true }
    : { text: '[Garvis] ', color: 'aqua', bold: true };
  const component = withTag ? ['', tag, body] : body;
  return ['tellraw', target, JSON.stringify(component)];
}

// Send a (possibly multi-line) reply in-game via rcon tellraw. Best-effort: a
// failed line is logged and skipped, never thrown.
async function sendReply({ rconExec, container, target, text, style, log }) {
  const lines = toChatLines(text);
  for (let i = 0; i < lines.length; i++) {
    const res = await rconExec(container, tellrawArgv(target, lines[i], i === 0, style));
    if (!res.ran) { log(`tellraw failed: ${(res.output || '').slice(0, 120)}`); break; }
  }
}

// Read a child stream line-by-line, invoking onLine(cleanLine) per newline.
function readLines(stream, onLine) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      try { onLine(line); } catch (e) { /* a bad line must never kill the stream */ }
    }
  });
}

// Start the in-game bridge: follow the server log, and for each trigger chat message
// call onMessage({ player, message, trigger, reply }) — `trigger` is the token that
// matched. `reply(text, { target, style })` pushes a tellraw back in-game (default
// target = replyTarget, e.g. "@a"; style 'whisper' = gray italic).
//
// Pass `triggers: ['!g', '!gw']` to watch several tokens on the one log stream;
// the single `trigger` option remains for back-compat.
//
// The docker-logs follower is reattached if the stream ends (a server restart must
// not blind the bridge — same pattern as ops-tripwire.sh). Returns { stop }.
export function startInGameBridge({
  container,
  trigger = '!g',
  triggers = null,
  replyTarget = '@a',
  rconExec,
  onMessage,
  log = (m) => console.log(`[ingame] ${m}`),
  reattachMs = 3000,
}) {
  let stopped = false;
  let child = null;

  // Longest token first, so a prefix trigger ("!g") can never shadow a longer
  // sibling ("!gw") whatever order they were configured in. (With the defaults the
  // whole-token rule in parseChatLine already disambiguates; this covers exotic
  // configs like a trigger that IS another trigger plus a space.)
  const trigList = [...new Set(triggers?.length ? triggers : [trigger])]
    .sort((a, b) => b.length - a.length);

  const makeReply = (player) => (text, opts = {}) =>
    sendReply({
      rconExec,
      container,
      target: opts.target ?? replyTarget,
      text,
      style: opts.style,
      log,
    });

  const handleLine = (line) => {
    for (const t of trigList) {
      const hit = parseChatLine(line, t);
      if (!hit) continue;
      // Fire-and-forget so the slow model call never blocks log reading; the wiring
      // applies its own per-player cooldown to bound spam + concurrent spawns.
      Promise.resolve(onMessage({ player: hit.player, message: hit.message, trigger: t, reply: makeReply(hit.player) }))
        .catch((e) => log(`onMessage failed for ${hit.player}: ${e.message}`));
      return;
    }
  };

  const attach = () => {
    if (stopped) return;
    // `--since 1s` => only NEW lines (never replay history on (re)attach).
    child = spawn('docker', ['logs', '-f', '--since', '1s', container]);
    readLines(child.stdout, handleLine);
    readLines(child.stderr, handleLine);           // itzg writes some lines to stderr
    child.on('error', (e) => log(`docker logs spawn error: ${e.message}`));
    child.on('close', () => {
      if (stopped) return;
      log(`log stream ended (container restart?) — reattaching in ${reattachMs}ms`);
      setTimeout(attach, reattachMs);
    });
  };

  attach();
  log(`watching container=${container} triggers=${trigList.map((t) => `"${t}"`).join(',')} replyTarget="${replyTarget}"`);
  return {
    stop() { stopped = true; try { child?.kill('SIGTERM'); } catch { /* ignore */ } },
  };
}
