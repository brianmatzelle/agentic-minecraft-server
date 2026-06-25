# Layer 3 — @Garvis Discord bot

Friend-facing Node service (discord.js). Slash commands **plus @mention chat**;
**no privileged MESSAGE_CONTENT intent** — a direct @mention is what makes Discord
populate message content for us. Runs **outside** the OpenShell sandbox (it holds
the Discord token) and dispatches a *scoped* task into the sandbox.

## Commands
- `/installhelp` — replies with `docs/windows-client-install.md` (no agent call).
- `/debug topic:<text>` — opens a thread with a persistent claude session for
  back-and-forth troubleshooting.
- `/whitelist username:<mc-java-name>` — open to everyone; whitelist a Minecraft
  **Java** username (theirs or someone else's). The bot adds them **live**
  (`docker exec <MC_CONTAINER> rcon-cli whitelist add`, instant, no restart) **and**
  persists the name to `MC_WHITELIST` in `apps/server/.env` so it survives the
  `OVERRIDE_WHITELIST=TRUE` rewrite on the next restart. Username is validated
  (`[A-Za-z0-9_]{3,16}`) and passed as argv, never a shell string. Unlike the
  mod-request flow, this acts on the live server directly (not via the sandboxed
  agent) — see `src/whitelist.js` and `docs/security.md` ("Deliberate exception —
  `/whitelist`"). Requires the bot's host user to be able to run `docker`.

> **Requesting a mod has no command** — anyone just @mentions Garvis and asks (see
> below). `/requestmod` was removed in favour of that.

## @mention chat (and mod requests)
`@Garvis <question>` in any text channel he can see → he opens a thread, answers
there, and remembers the conversation (same session machinery as `/debug`). **Anyone**
can also just ask him to add a mod — "**@garvis add cobblemon**" — and (when dispatch
is live) he researches it and opens a PR; see "Natural-language installs" below.
Follow-ups **inside the thread must @mention him too** — that's how we scope which
messages are meant for him. Requires **View Channel**, **Send Messages**, **Create
Public Threads**, and **Send Messages in Threads** in that channel.

## Rich Modrinth previews
Garvis renders any **Modrinth** link in his replies as a rich preview card "off rip"
(mod icon, summary, download count, and **server/client side** — the bit players
actually care about), instead of leaving a bare blue link for Discord to maybe
auto-unfurl. His reply text comes from a free-form LLM, so there's no structured "mod"
object to embed — `src/embeds.js` instead post-processes the text: it pulls out Modrinth
project links, looks each up via the Modrinth API, and attaches the cards to the last
message. This works on **every** path (@mention chat, mod requests, `/installhelp`,
`/debug`) because they all funnel through `sendChunked`/`editReplyChunked`. Lookups
are cached, time-boxed, and fail soft — a metadata hiccup just means no card, never a
missing reply. The prompts nudge the agent to drop the canonical
`https://modrinth.com/mod/<slug>` link so the cards fire reliably.

## Files
- `package.json` — discord.js v14 + dotenv.
- `src/register-commands.js` — registers the guild slash commands (run once, and after adding/changing a command).
- `src/index.js` — the bot: @mention router (Q&A vs. capable maintenance agent), per-user cooldown, slash-command handlers.
- `src/embeds.js` — turns Modrinth links in replies into rich preview cards (see "Rich Modrinth previews").
- `src/whitelist.js` — `/whitelist` plumbing: username validation, idempotent MC_WHITELIST `.env` update, and the live `rcon-cli whitelist add`. The only place the bot touches the live server.
- `garvis-bot.service` — systemd `--user` unit that runs the bot (see "Run as a service").
- `.env.example` — copy to `bot/.env` (gitignored). **Freshly rotated token only.**

## Run
```bash
cd bot && npm install
cp .env.example .env        # fill DISCORD_*; keep GARVIS_DISPATCH_MODE=dry-run
npm run register            # register slash commands to your guild
npm start                   # @Garvis comes online
```

## Run as a service (systemd `--user`)
`garvis-bot.service` is the unit that keeps the bot running. Its paths are
environment-specific: the nvm-managed `node`, and `~/.local/bin` on `PATH` so the
spawned `claude` CLI resolves (the bot shells out to `claude` for replies — if that
dir is missing from `PATH` you get `spawn claude ENOENT`).

```bash
cp garvis-bot.service ~/.config/systemd/user/   # adjust paths for your machine
systemctl --user daemon-reload
systemctl --user enable --now garvis-bot.service
systemctl --user restart garvis-bot.service     # apply code changes
journalctl --user -u garvis-bot.service -f      # tail logs
```

## Natural-language installs (beginner-friendly)
When `GARVIS_DISPATCH_MODE` is **not** `dry-run`, **anyone** can just @mention Garvis
in plain English — "**@garvis add cobblemon**", "*can we get computercraft?*" — and he:
1. researches it on Modrinth and confirms **NeoForge 1.21.1 server-side** support (+ deps, client-side need),
2. adds it to `apps/agent/modlist.txt` on a branch,
3. opens a **PR** for a human to merge, and
4. replies with a friendly summary + the PR link.

No command and no allowlist — the capable agent itself decides whether a message is a
question (answer it) or a mod request (open a PR). The only gate is a per-user
cooldown; a human still reviews and merges every PR. See `docs/security.md`
("Deliberate exception — open mod-requests via @mention") for the rationale.

The agent does this work in an **isolated clone** (`GARVIS_AGENT_WORKDIR`), never
the live repo, with a turn/time budget sized for real research (not the old 6-turn
cap that made him silently "return nothing").

## Dispatch modes (`GARVIS_DISPATCH_MODE`)
- `dry-run` — posts the exact task it *would* run; nothing executes. @mentions stay help-only. Safe demo.
- `local` — spawns a real `claude` agent in `GARVIS_AGENT_WORKDIR` that researches + opens the PR.
- `openshell` — same agent, wrapped in the OpenShell egress sandbox (`infra/openshell`).

Mod requests and `/whitelist` are open to everyone (no allowlist); a per-user cooldown
(`GARVIS_COOLDOWN_MS`) is the only anti-spam gate, and every mod PR still needs a human to merge.
