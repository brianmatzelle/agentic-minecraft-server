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

## @mention chat
`@Garvis <question>` in any text channel he can see → he opens a thread, answers
there, and remembers the conversation (same session machinery as `/debug`).
Follow-ups **inside the thread must @mention him too**: without the MESSAGE_CONTENT
intent, Discord only delivers message content when the bot is directly mentioned.
Requires **View Channel**, **Send Messages**, **Create Public Threads**, and **Send
Messages in Threads** in that channel.

## Files
- `package.json` — discord.js v14 + dotenv.
- `src/register-commands.js` — registers the two guild slash commands (run once).
- `src/index.js` — the bot: deny-by-default authz, per-user cooldown, scoped-task builder, dispatcher.
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

## Dispatch modes (`GARVIS_DISPATCH_MODE`)
- `dry-run` (default) — posts the exact task it *would* run; nothing executes. Safe to demo immediately.
- `openshell` — `openshell sandbox exec <name> -- claude -p "<task>" --settings agent/claude/settings.json …` **[wire at install]**
- `local` — spawn `claude -p` locally (dev only, no sandbox). **[wire at install]**

Authz is deny-by-default: empty `DISCORD_ALLOWED_USERS`/`ROLES` = nobody can `/requestmod`.
