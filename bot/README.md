# Layer 3 — @Garvis Discord bot

Friend-facing Node service (discord.js). Two slash commands; **no privileged
MESSAGE_CONTENT intent**. Runs **outside** the OpenShell sandbox (it holds the
Discord token) and dispatches a *scoped* task into the sandbox.

## Commands
- `/installhelp` — replies with `docs/windows-client-install.md` (no agent call).
- `/requestmod slug:<modrinth-slug> reason:<text>` — authz-gated; builds a **fixed
  scoped task** (the user's text is embedded as quoted DATA, never as instructions)
  and dispatches it. Agent opens a PR for owner approval.

## Files
- `package.json` — discord.js v14 + dotenv.
- `src/register-commands.js` — registers the two guild slash commands (run once).
- `src/index.js` — the bot: deny-by-default authz, per-user cooldown, scoped-task builder, dispatcher.
- `.env.example` — copy to `bot/.env` (gitignored). **Freshly rotated token only.**

## Run
```bash
cd bot && npm install
cp .env.example .env        # fill DISCORD_* + allowlist; keep GARVIS_DISPATCH_MODE=dry-run
npm run register            # register slash commands to your guild
npm start                   # @Garvis comes online
```

## Dispatch modes (`GARVIS_DISPATCH_MODE`)
- `dry-run` (default) — posts the exact task it *would* run; nothing executes. Safe to demo immediately.
- `openshell` — `openshell sandbox exec <name> -- claude -p "<task>" --settings agent/claude/settings.json …` **[wire at install]**
- `local` — spawn `claude -p` locally (dev only, no sandbox). **[wire at install]**

Authz is deny-by-default: empty `DISCORD_ALLOWED_USERS`/`ROLES` = nobody can `/requestmod`.
