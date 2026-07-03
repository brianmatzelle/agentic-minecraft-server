# Talking to Garvis in-game

Goal: let players have a conversation with Garvis **without leaving Minecraft**.
Today this is the **`!g` chat trigger** (Phase 1, shipped). A real **`/g` slash
command** backed by a small NeoForge mod is the planned **Phase 2** (jotted down
below so we can build it when there's time).

Both phases reuse the **same Garvis brain** that already answers Discord
@mentions — the bot process (`apps/garvis-bot`) that spawns `claude -p`. The only
difference is the transport that carries the player's message in and Garvis's
reply back out.

---

## Phase 1 — `!g` chat trigger (SHIPPED)

### What it does

A player types in normal chat:

```
<Steve> !g how do waystones work?
[Garvis] Right-click a waystone to activate it, then open any waystone to
         teleport to the ones you've found. ...
```

- **Q&A / conversation.** Garvis answers questions, explains mods, gives advice,
  and remembers the conversation per player.
- **Mod requests.** A player can also ask Garvis to **add a mod** from in-game
  (`!g add cobblemon`). This is routed to the **same maintenance agent** the
  Discord `@mention` path uses: it researches the mod on Modrinth and **opens a
  PR** — a human still merges (and the live deploy is unchanged). A cheap intent
  classifier decides per-message whether `!g …` is a mod request (→ maint agent)
  or a question (→ the fast read-only Q&A brain), so simple questions never queue
  behind a multi-minute install. Mirrors the existing "mod requests open to
  everyone" Discord posture.
- **Give items (operator-gated).** A player can ask Garvis to give an item from
  in-game (`!g give me 64 stone`, `!g give Steve an elytra`). This is the SAME
  validated catalog verb the Discord `give` uses (moderation.js), run as a live
  `rcon-cli give` — but **gated**: the requester must be a **server operator**
  (`server-data/ops.json`), since there's no Discord role to check from in-game.
  Non-ops are told it's op-only and pointed to an op or Discord. Off by default
  (`GARVIS_INGAME_GIVE`). Other moderation (op/ban/kick/teleport/gamemode) is still
  **not** done in-game — the classifier routes those to Q&A, which points to Discord.
- **Whispers (`!gw`).** A private line to Garvis: the reply is sent to the asker
  **alone** (never `@a`), rendered in whisper-gray italics with a
  `[Garvis whispers]` tag, and Garvis answers in a warmer, more personal register
  — a confidant, not the public announcer (favorable in tone, still honest on
  facts). Whispers get their **own per-player session** (`mc-whisper:<player>`),
  so whispered context can never surface in the public `!g` thread — a later
  public "!g what did I just tell you?" broadcast can't leak it, by construction.
  Q&A only: give/modreq stay on the public trigger (the prompt redirects action
  asks there). **Caveat:** the *typed* `!gw …` line is still public chat — the
  log-tail transport can't intercept chat, so only the **reply** is private.
  True private input is the Phase 2 `/g` mod's job.
- Works on a **vanilla NeoForge client** — no client mod, no install. Anyone
  already whitelisted onto the server can use it.

### How it works (no custom mod)

```
player types `!g …` (or `!gw …`) in chat
  → itzg server logs the line:  <Steve> !g how do waystones work?
  → bot tails `docker logs -f --since 1s <MC_CONTAINER>`   (ingame.js)
  → parseChatLine() extracts { player, message } for trigger-matching lines
    (both triggers are matched on the ONE log stream, longest token first;
     the matched trigger is passed to the handler for routing)
  → onInGameMessage() (index.js): per-player cooldown (one shared bucket for both triggers)
  → `!gw` (whisper) → "…thinking" ack → answerWhisper() (read-only Q&A brain,
  │                    warmer prompt, session mc-whisper:<player>)
  │                    reply tellraw'd to the ASKER only, whisper-gray italic
  → `!g` + give and/or mod requests enabled: classifyIngame() (one cheap, read-only call)
      ├─ "give"   → op-gate (isServerOp via ops.json) → resolveAction('give') → runAction()
      │             (the SAME validated catalog verb as Discord; non-ops are denied)
      ├─ "modreq" → "🔧 on it" ack → requestModInGame() → runMaintSerial()
      │             (the SAME maint agent as Discord, in the isolated clone → a PR)
      └─ "qa"     → "…thinking" ack → answerInGame() (read-only Q&A brain)
  → reply pushed back in-game via `rcon-cli tellraw @a {json}`  (moderation.js rconExec)
```

This deliberately reuses the **exact trust boundary the bot already owns**: it
already shells out to `docker exec <container> rcon-cli …` (no shell — `execFile`
with an argv array) for `/whitelist` and live moderation. The in-game bridge adds
**no new privileged path** — the only live-server write it makes is a fixed
`tellraw`, and it reuses the existing `rconExec()`.

The **mod-request path** likewise adds no new capability: it is just another
caller of `runMaintSerial()`, so it inherits every boundary the Discord
`@mention` mod-request path already has — the agent runs in the **isolated clone**
(`GARVIS_AGENT_WORKDIR`), carries `AGENT_DENY_TOOLS` (no docker/rcon, no edits to
the live server `.env`/world), only **opens a PR** (a human merges), and the
player's message is fenced as DATA. The git author/committer is set to the
Minecraft name (synthetic email `<name>@players.minecraft.local`); since the
sender name is server-stamped (see "No name spoofing" below), it can't be forged.

### Files

| File | Role |
|---|---|
| `apps/garvis-bot/src/ingame.js` | The bridge: tail the log, `parseChatLine()`, chunk + send `tellraw`, reattach on server restart. Pure MC transport — no model, no sessions. |
| `apps/garvis-bot/src/index.js` | Wiring: `buildInGamePrompt()`/`answerInGame()` (public Q&A), `buildWhisperPrompt()`/`answerWhisper()` (private `!gw` Q&A), `classifyIngameIntent()` (modreq-vs-qa router), `requestModInGame()` (→ `runMaintSerial`, the shared maint agent), `onInGameMessage()` (cooldowns + ack + trigger routing), and `startInGameBridge({…})` at boot. The maint prompt (`buildMaintPrompt`) takes an `ingame` flag for terse, plain-text, raw-PR-URL replies. |
| `apps/garvis-bot/src/moderation.js` | `rconExec()` (already exported) — reused to send `tellraw`. |
| `apps/garvis-bot/src/db.js` | Session store, reused with the keys `mc:<player>` (public) and `mc-whisper:<player>` (whispers — separate on purpose, see above) (collide with nothing — thread ids are numeric snowflakes). |

### Config (`apps/garvis-bot/.env`)

| Var | Default | Meaning |
|---|---|---|
| `GARVIS_INGAME` | `on` | Kill switch (`on` \| `off`). |
| `GARVIS_INGAME_TRIGGER` | `!g` | Chat prefix that summons Garvis (must be a whole leading token). |
| `GARVIS_INGAME_REPLY_TARGET` | `@a` | Who sees replies: `@a` (everyone) or a player selector. "…thinking" acks always go privately to the asker. Whisper replies ignore this — always the asker. |
| `GARVIS_INGAME_WHISPER` | `on` | Allow `!gw` **whispers** (`on` \| `off`) — private replies, warmer register, own session. |
| `GARVIS_INGAME_WHISPER_TRIGGER` | `!gw` | Chat prefix for a whisper (whole leading token, like the public trigger). |
| `GARVIS_INGAME_COOLDOWN_MS` | `15000` | Per-player cooldown for any `!g`/`!gw` (each is a full `claude` turn; one shared bucket so whispers don't double the budget). |
| `GARVIS_INGAME_MODREQ` | `on` | Allow `!g` **mod requests** (PRs) (`on` \| `off`). Only acts when `GARVIS_DISPATCH_MODE` ≠ `dry-run`; `off` keeps `!g` Q&A-only (and skips the classifier spawn entirely). |
| `GARVIS_INGAME_MAINT_COOLDOWN_MS` | `180000` | Heavier per-player cooldown for `!g` mod requests (a full research + PR run, separate bucket from the Q&A cooldown). |
| `GARVIS_INGAME_GIVE` | `off` | Allow `!g give …` (`on` \| `off`). **Operator-gated** (see below). Independent of `GARVIS_DISPATCH_MODE` — it's a live `rcon-cli give`, not the maint agent. `off` => give requests fall back to Q&A. |
| `MC_OPS_FILE` | _auto_ | Path to the live `ops.json` used for the give gate. Blank => `../../apps/server/server-data/ops.json` (the compose bind-mount). |
| `MC_CONTAINER` | `mc-neoforge` | Container to tail + `tellraw` into (shared with `/whitelist`). |

### Enable / apply

The bridge starts automatically with the bot (it shares the process). After
pulling these changes:

```bash
systemctl --user restart garvis-bot.service     # apply code changes
journalctl --user -u garvis-bot.service -f      # watch for: [ingame] watching container=…
```

Then in-game: `!g hello` — or `!gw hello` for a private reply.

### Security notes

- **Untrusted in-game chat is DATA.** The player's message is wrapped with
  `fencedData()` before it reaches the model — same discipline as every Discord
  path. The bridge never executes anything the player types.
- **No name spoofing.** The server stamps the real sender as the *first* `<name>`
  on the log line; a faked `<Bob> !g …` typed by Steve lands after `<Steve> ` and
  fails the trigger check. The reply targets `@a` (or a validated `3–16` char
  name), never raw player text.
- **No feedback loop.** `tellraw` output is delivered to clients, not re-logged as
  `<name>` chat, so Garvis can't trigger himself.
- **Give is op-gated, and the gate is independent of the LLM.** `!g give …` runs
  the fixed `give` catalog verb (validated item id + count 1–6400; the model only
  ever names a verb + args, never a shell), and ONLY after `isServerOp(player)`
  passes. The gate reads the live `ops.json` and matches the **server-stamped** name
  (the same unspoofable first-`<name>` used everywhere here), so a prompt-injected
  classifier buys nothing: the worst it can do is pick a *different* valid give for
  an *already-authorized op* — a reversible, audited action an op could run via
  vanilla `/give` anyway. The op check **fails closed**: a missing / unreadable /
  malformed `ops.json` denies. Limitation: the `!g` transport carries a name, not a
  UUID, so the match is by name (a real `/g` mod — Phase 2 — would carry the UUID for
  a stronger check). Give success is announced to `@a` (transparency); denials and
  errors go privately to the asker.
- **Same soft-boundary caveat as Discord.** The Q&A/maint agent runs on the host
  with `AGENT_DENY_TOOLS` (denies docker/rcon, edits to the live server
  config/world, and reads of `.env` files), but pattern-based Bash/Read denial is a
  **soft** control (a full/absolute path can evade a relative glob). `!g` does not
  add a new class of risk (the same brain already answers any guild member's
  @mention), but it does widen *who* can reach it to anyone whitelisted in-game.
- **Secret-scrub hardening (IMPLEMENTED 2026-06-29).** Every spawned agent's
  environment is built from a copy of the bot's with `AGENT_SCRUB_ENV`
  (`DISCORD_BOT_TOKEN`, `RCON_PASSWORD`) deleted — a **hard** control, unlike the
  pattern denies: the child literally never receives those vars, so no
  `printenv`/`process.env`/full-path trick surfaces them. `GH_TOKEN`/git identity
  and `claude`'s own creds are preserved (the agent still pushes + opens PRs). This
  applies to ALL spawns (Q&A, classifier, maint; in-game + Discord) since they all
  go through `runClaude`. The `.env` Read-denies (`Read(apps/server/.env)`,
  `Read(apps/garvis-bot/.env)`, `Read(**/.env)`) are belt-and-suspenders on top.
  The real boundary remains the OpenShell sandbox / the broker in the platform pivot.

### Known limits / future polish

- **Cost/load:** each `!g` spawns a `claude` process (seconds, CPU). With mod
  requests enabled, every `!g` also incurs a small intent-classifier spawn, and a
  recognized mod request runs the full maint agent (minutes, in the clone). The
  per-player cooldowns bound it (`GARVIS_INGAME_COOLDOWN_MS` for any `!g`,
  `GARVIS_INGAME_MAINT_COOLDOWN_MS` for mod requests); maint runs are also
  serialized through the one clone (shared with Discord), so they queue rather
  than overlap. Set `GARVIS_INGAME_MODREQ=off` to drop the classifier + maint path.
- **Public questions:** the question is visible in chat (it's normal chat). Replies
  default to everyone (`@a`); set a player selector if you want them private.
- **Plain text only:** in-game chat renders no markdown/links, so the prompt forces
  short, plain answers. Modrinth link *cards* (Discord) don't apply here; a mod
  request's reply does include the raw PR URL as plain text (the one link worth
  showing in chat) so a player can pass it to an admin to merge.

---

## Phase 2 — real `/g` slash command (PLANNED — not built yet)

Everything below is a **design sketch to build later**, not shipped.

### Why bother, given `!g` works

- A true `/g` is **private by default** (command args aren't broadcast to chat),
  **tab-completes**, and can't be confused with normal chat.
- It **closes the `!gw` privacy gap**: today only the *reply* is private — the
  typed `!gw …` line is still public chat, because the log-tail transport can't
  intercept chat. With a real command the *input* never enters public chat, so a
  whisper is finally private end-to-end.
- The server hands the mod a **structured, trustworthy payload** (player UUID, not
  just a name; dimension; coords), instead of us scraping a log line.
- It's the "real product" — `!g` is the validate-the-idea version.

### Shape

A **small server-side-only NeoForge mod** (clients need nothing extra — server
commands sync to vanilla-on-NeoForge clients):

```
/g <message>
  → mod's RegisterCommandsEvent handler captures { uuid, name, dim, pos, message }
  → async HTTPS POST to a Garvis HTTP endpoint (shared secret; bound to the
    docker network / host-gateway, never public)
  → Garvis endpoint runs the SAME brain as `!g`/Discord and returns reply text
  → mod shows the reply to the player via command source feedback (private)
```

**Whispers carry over.** A `/gw <message>` (or `/g whisper <message>`) variant
maps straight onto the existing whisper path: warmer register, reply to the
asker alone, separate `mc-whisper:<uuid>` session so whispered context never
surfaces in the public thread. The payload just carries a `whisper: true` flag
to the same endpoint. Since command input isn't broadcast, this retires the
Phase 1.5 caveat that the typed `!gw` line is public.

### What it would entail (the real cost — why it's deferred)

1. **A Java/Gradle mod build** added to this (currently all-JS/Docker) repo:
   a NeoForge MDK module, a `build.gradle`, the command + HTTP client, producing a
   jar dropped into `server-data/mods/` (it's not on Modrinth, so the existing
   deploy / client-pack machinery doesn't cover it — needs a build/copy step).
2. **A Garvis HTTP endpoint** (new small listener in `garvis-bot`, or a sidecar):
   `POST /ingame {player, uuid, message}` → reply. Reuses `runClaude` + the
   `mc:<uuid>` session map. Auth via a shared secret + bind to localhost/docker.
3. **Compose networking** so the `mc-neoforge` container can reach the host bot:
   add `extra_hosts: ["host.docker.internal:host-gateway"]` to the minecraft
   service and POST to `http://host.docker.internal:<port>` (or run the bot as a
   compose service on the shared network).
4. Same security model as `!g`: fence the message as data, per-player cooldown,
   Q&A-only to start. The structured UUID makes per-player identity *stronger*
   than the chat-name approach.

### Fit with the multi-tenant pivot

`docs/platform-architecture.md` favors Modrinth-only, platform-signed client
packs and treats arbitrary jars as a sharper edge (they run on players' PCs).
This mod is **server-side only** (never shipped to clients), so it sidesteps the
client-pack concern — but it's still a custom unsigned jar to build + maintain.
When the platform exists, the HTTP endpoint becomes the per-tenant agent's
slow-lane shim, and `/g` is just another front-end onto it.
