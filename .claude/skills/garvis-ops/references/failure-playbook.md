# Garvis / itzg / deploy failure playbook

Every failure mode hit during the original build, with the fix. "Fix Garvis when he
inevitably breaks" is the job — expect these.

## Garvis (the bot / agent)

### "Garvis returned nothing." (the classic)
- **Cause:** the `claude` run produced an empty result — usually `--max-turns` too low
  to finish researching + acting, so it exhausts turns with no final text.
- **Fix:** budgets are in `apps/garvis-bot/src/index.js`: `HELP_TURNS` (Q&A),
  `MAINT_TURNS` (installs, ~40), and `MAINT_TIMEOUT_MS`. Raise if a legit task starves.
  Soft misses already auto-retry once. Restart the bot after edits.
- **Diagnose:** the bot logs `[claude] soft-fail … turns=N stderr=…` to the journal.

### Garvis answers questions but won't install
- **Cause:** `GARVIS_DISPATCH_MODE=dry-run` (only echoes), or the speaker isn't in
  `DISCORD_ALLOWED_USERS`, or the message wasn't a real @mention.
- **Fix:** set `GARVIS_DISPATCH_MODE=local` in `apps/garvis-bot/.env`; restart bot.
  Confirm `dispatch=local` in the startup log line.

### Headless `claude -p` silently does nothing / is blocked
- **Cause:** in a normal config, headless claude can't approve tool calls (no human).
- **Why it works here:** host `~/.claude/settings.json` is `bypassPermissions`, so the
  spawned agent has full capability. If you ever see permission blocks, that's the lever.

### Agent can't push the branch / open the PR
- **Cause:** SSH push needs an ssh-agent the systemd bot doesn't have.
- **Fix (already applied):** the agent clone uses **HTTPS + the gh token credential
  helper**: `gh auth setup-git` and `git remote set-url origin https://github.com/<…>.git`.
  Verify with a throwaway: `git -C ~/projects/active/minecraft-agent push --dry-run`.

### Two agents corrupt the clone
- **Cause:** concurrent runs in the single shared clone.
- **Fix:** maintenance runs are serialized (`runMaintSerial`). Don't manually run a
  second `claude` in `~/projects/active/minecraft-agent` while the bot is working.

### Garvis resolved the wrong dependency (trust, but verify)
- He's usually right (he caught that Cobblemon needs **kotlin-for-forge**, not
  architectury). Confirm a dep by resolving the Modrinth project_id to a slug:
  `curl -s "https://api.modrinth.com/v2/project/<slug>/version?loaders=%5B%22neoforge%22%5D&game_versions=%5B%221.21.1%22%5D"`
  then `GET /v2/project/<project_id>` to get the real slug.

## itzg / server boot

### `No candidate versions of '<Mod>' … matched versionType=release`
- **Cause:** the mod publishes on Modrinth's **alpha/beta** channel (CC: Tweaked does);
  itzg defaults to release-only.
- **Fix:** `MODRINTH_ALLOWED_VERSION_TYPE=alpha` in `apps/server/docker-compose.yml`
  (NOT `MODRINTH_DEFAULT_VERSION_TYPE` — itzg ignores that name). Already set.

### Container restart-loops on boot
- It errors **before** the JVM starts (e.g. mod download failure) and `restart:
  unless-stopped` retries. The world is untouched. Read the error:
  `docker logs --tail 20 mc-neoforge | sed 's/\x1b\[[0-9;]*m//g'`.

### Benign boot noise (do NOT chase these)
- Cobblemon `SoundEngine`/`Channel` mixin WARN/ERROR → client mixins skipped on a
  dedicated server. Fine.
- ModernFix ↔ Lithium "Method overwrite conflict … Skipping method" → expected; they
  intentionally defer to each other.
- FerriteCore `refmap … could not be read` → cosmetic.
- Success signal is always: `Done (N.Ns)! For help, type "help"`.

## Deploy / git

### `git checkout main` fails — "local changes would be overwritten"
- You left uncommitted edits in the live repo. Commit them to a branch first (the live
  bot runs from the working tree, so don't leave it dirty mid-flow).

### Mod PR #B conflicts with #A in modlist.txt
- Both branched off the same `main` and edited the same line. Merge #A, then have the
  next agent run (it `reset --hard origin/main`) so #B branches off the updated list.

## OpenShell (only if turning the sandbox ON — security pass)
- Build the image: `infra/openshell/Dockerfile` (validated; ships git/gh/node/claude/curl).
- Bring up: `bash infra/openshell/run.sh` (build → create → policy → upload creds → clone).
- Then set `GARVIS_DISPATCH_MODE=openshell`, `OPENSHELL_SANDBOX`, `OPENSHELL_WORKDIR`.
- Open questions to confirm on bring-up: claude auth inside the box (uploaded
  `~/.claude/.credentials.json` vs. an `ANTHROPIC_API_KEY`), and whether `sandbox create
  -- sleep infinity` detaches. Broaden egress for forum/docs hosts via `openshell policy update`.
