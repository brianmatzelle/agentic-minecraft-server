# Layer 3 — @Garvis Discord bot

Friend-facing Node service (discord.js). Slash commands **plus @mention chat**;
**no privileged MESSAGE_CONTENT intent** — a direct @mention is what makes Discord
populate message content for us. Runs **outside** the OpenShell sandbox (it holds
the Discord token) and dispatches a *scoped* task into the sandbox.

## Commands
- `/installhelp` — replies with `docs/windows-client-install.md` (no agent call).
- `/requestmod slug:<modrinth-slug> reason:<text>` — authz-gated; builds a **fixed
  scoped task** (the user's text is embedded as quoted DATA, never as instructions)
  and dispatches it. Agent opens a PR for owner approval.
- `/debug topic:<text>` — opens a thread with a persistent claude session for
  back-and-forth troubleshooting.
- `/whitelist username:<mc-java-name>` — authz-gated; lets a trusted friend whitelist
  a Minecraft **Java** username (theirs or someone else's). The bot adds them **live**
  (`docker exec <MC_CONTAINER> rcon-cli whitelist add`, instant, no restart) **and**
  persists the name to `MC_WHITELIST` in `apps/server/.env` so it survives the
  `OVERRIDE_WHITELIST=TRUE` rewrite on the next restart. Username is validated
  (`[A-Za-z0-9_]{3,16}`) and passed as argv, never a shell string. Unlike `/requestmod`
  this acts on the live server directly (not via the sandboxed agent) — see
  `src/whitelist.js` and `docs/security.md` ("Deliberate exception — `/whitelist`").
  Requires the bot's host user to be able to run `docker`.

## @mention chat
`@Garvis <question>` in any text channel he can see → he opens a thread, answers
there, and remembers the conversation (same session machinery as `/debug`).
Follow-ups **inside the thread must @mention him too**: without the MESSAGE_CONTENT
intent, Discord only delivers message content when the bot is directly mentioned.
Requires **View Channel**, **Send Messages**, **Create Public Threads**, and **Send
Messages in Threads** in that channel.

## Files
- `package.json` — discord.js v14 + dotenv.
- `src/register-commands.js` — registers the guild slash commands (run once, and after adding/changing a command).
- `src/index.js` — the bot: deny-by-default authz, per-user cooldown, scoped-task builder, dispatcher.
- `src/whitelist.js` — `/whitelist` plumbing: username validation, idempotent MC_WHITELIST `.env` update, and the live `rcon-cli whitelist add`. The only place the bot touches the live server.
- `garvis-bot.service` — systemd `--user` unit that runs the bot (see "Run as a service").
- `.env.example` — copy to `bot/.env` (gitignored). **Freshly rotated token only.**

## Run
```bash
cd bot && npm install
cp .env.example .env        # fill DISCORD_* + allowlist; keep GARVIS_DISPATCH_MODE=dry-run
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
When `GARVIS_DISPATCH_MODE` is **not** `dry-run`, an **authorized** member can just
@mention Garvis in plain English — "**@garvis add cobblemon**", "*can we get
computercraft?*" — and he:
1. researches it on Modrinth and confirms **NeoForge 1.21.1 server-side** support (+ deps, client-side need),
2. adds it to `apps/agent/modlist.txt` on a branch,
3. opens a **PR** for a human to merge, and
4. replies with a friendly summary + the PR link.

No slug syntax required. `/requestmod slug:<x>` still works for the precise path.
Q&A and `/installhelp` stay open to **everyone**; only repo-changing actions are
gated by the allowlist.

The agent does this work in an **isolated clone** (`GARVIS_AGENT_WORKDIR`), never
the live repo, with a turn/time budget sized for real research (not the old 6-turn
cap that made him silently "return nothing").

## Dispatch modes (`GARVIS_DISPATCH_MODE`)
- `dry-run` — posts the exact task it *would* run; nothing executes. @mentions stay help-only. Safe demo.
- `local` — spawns a real `claude` agent in `GARVIS_AGENT_WORKDIR` that researches + opens the PR.
- `openshell` — same agent, wrapped in the OpenShell egress sandbox (`infra/openshell`).

Authz is deny-by-default: empty `DISCORD_ALLOWED_USERS`/`ROLES` = nobody can trigger installs.
