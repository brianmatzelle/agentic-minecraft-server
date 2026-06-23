---
name: garvis-ops
description: Drive the @Garvis Discord bot (via the Playwright browser) to research and install Minecraft mods and maintain the live NeoForge 1.21.1 server — fixing Garvis when he breaks, and shipping every change through PR → merge → deploy. Use when setting up or maintaining this modded server with Garvis, or running an autonomous "do it while I sleep" session.
argument-hint: "[goal, e.g. \"add waystones and create\" | \"set up a fresh modpack\" | (empty = ask)]"
disable-model-invocation: true
---

# garvis-ops — direct Claude-driving-Claude for the modded MC server

You (Claude Code) orchestrate **Garvis**, a friend-facing Discord bot that *itself*
shells out to `claude`. You drive Garvis through the **Playwright browser** in Discord,
he researches + opens mod PRs, you fix him when he breaks, then you merge + deploy.
The repo is the source of truth; a human (you, on the owner's behalf) approves.

**The goal for this run** = the `/garvis-ops` argument, or the owner's request this
session. If neither is given, ask what they want before driving anything.

## 0. Kick off — confirm the 4 defaults (only if not already set this session)
These shaped the original run; restate them and let the owner override:
1. **Delivery**: full pipeline **LIVE** (PR → you merge → `scripts/deploy.sh`). *(default)*
2. **Sandbox**: OpenShell is wired but **OFF**; agent runs `local`. Flip on only if asked.
3. **Scope**: do exactly what's asked, then optionally a vetted **server-only perf pack**
   (don't bloat the client bundle — see §6).
4. **If Garvis blocks**: pragmatic — repair him, and finish the step directly if needed.
For a long unattended run, ask these up front (use AskUserQuestion), then proceed.

## 1. Verify the stack (always do this first)
```bash
systemctl --user status garvis-bot.service --no-pager | head -3   # bot up? dispatch=local?
docker ps --filter name=mc-neoforge --format '{{.Status}}'         # server healthy?
git -C ~/projects/active/minecraft status --short                  # live repo clean on main?
ls ~/projects/active/minecraft-agent/.git >/dev/null && echo "agent clone OK"
```
Then open Discord in the browser and confirm you're **logged in** (the one thing you
can't fix unattended): navigate to the ops thread and snapshot.
- Ops Discord thread: `https://discord.com/channels/291059519604129792/1518882806393077760`
- Bot is authorized for user `bri` (id `291044123673100299`); you drive as bri.

## 2. The core loop (per mod / task)
1. **Drive Garvis** in Discord with a *plain-English* request, exactly like a
   non-technical friend would: `@garvis can you add <mod>?`
   → see `references/discord-playwright.md` for the **@mention dance** (it's fiddly).
2. **Watch** the run: `Monitor` the bot journal for `[claude] start/ok/soft-fail`:
   `journalctl --user -u garvis-bot.service -n0 -f -o cat | grep --line-buffered -E '\[claude\]|Error'`
   Each install is ~1 min. He opens a PR and replies in-thread with the link.
3. **Review** the PR Garvis opened (`gh pr view <n>`, `gh pr diff <n>`) — confirm the
   right slug, NeoForge 1.21.1 **server-side**, and any required deps.
4. **If it broke**, fix it → `references/failure-playbook.md`. Restart the bot to apply
   code fixes: `systemctl --user restart garvis-bot.service`.
5. **Merge + deploy** (see §3).

## 3. Merge + deploy (the deploy gate)
```bash
cd ~/projects/active/minecraft
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only        # live repo follows main
scripts/deploy.sh                               # modlist.txt → MODRINTH_PROJECTS → up -d
# verify boot:
docker logs -f --since 2s mc-neoforge 2>&1 | sed -u 's/\x1b\[[0-9;]*m//g' \
  | grep --line-buffered -iE 'Downloading|Done \([0-9.]+s\)|ERROR|Exception|No candidate|incompatible'
```
`scripts/deploy.sh --dry-run` previews. **Never** touch `apps/server/server-data/`.
Batch independent mods into one deploy when you can (one restart). Merge a mod PR
**before** driving the next mod so each agent branches off an up-to-date `main`
(avoids modlist.txt conflicts).

## 4. Branch hygiene (so the live bot + deploys never collide)
- Live repo `~/projects/active/minecraft` stays on **main**. For *your own* edits:
  branch → commit → push → PR → merge → `git checkout main && git pull`.
- Garvis's agent works only in the **isolated clone** `~/projects/active/minecraft-agent`
  (it `reset --hard origin/main` each run). Never run a second agent there concurrently
  (runs are serialized in the bot for this reason).
- Save Playwright snapshots under `.playwright-mcp/` (gitignored), not the repo root.

## 5. Fixing Garvis — quick map (full detail in references/failure-playbook.md)
- **"Garvis returned nothing"** → turn-limit starvation. Budgets live in `apps/garvis-bot/src/index.js` (`HELP_TURNS`, `MAINT_TURNS`).
- **He won't actually install** → `GARVIS_DISPATCH_MODE` must be `local` (or `openshell`), not `dry-run` (in `apps/garvis-bot/.env`).
- **itzg `No candidate versions … matched versionType=release`** → mod is on Modrinth's *alpha* channel; compose already sets `MODRINTH_ALLOWED_VERSION_TYPE=alpha`.
- **Discord pill disappears when typing** → never use `browser_type` without `slowly:true` (plain `fill` wipes the @mention). See the dance doc.
- **Agent can't `git push`** → the clone uses HTTPS + the `gh` token credential helper (`gh auth setup-git`), not ssh-agent.

## 6. Picking mods (your judgment, when asked to "go further")
- Verify each on Modrinth for **NeoForge 1.21.1 + server-side** before driving Garvis
  (he double-checks too): `curl -s "https://api.modrinth.com/v2/project/<slug>"`.
- Prefer **server-only** mods (client_side optional/unsupported) so friends don't need
  more client installs. Proven safe pack: `lithium ferrite-core modernfix spark chunky noisium`.
- Mods that are `client_side: required` (CC: Tweaked, Cobblemon, most gameplay/visual
  mods) must also be added to the **client bundle** → update `docs/windows-client-install.md`
  and the bot's `SERVER_MODS`.

## 7. Wrap up
- Update `docs/overnight-status.md` (the morning report) and leave the repo clean on main.
- All changes ship as PRs — keep the audit trail.

## Reference files (read on demand)
- `references/discord-playwright.md` — the exact @mention dance + composer handling.
- `references/failure-playbook.md` — every known Garvis/itzg/deploy failure + fix.
- Repo context: `docs/overnight-status.md`, `docs/architecture.md`, `apps/garvis-bot/README.md`.

> Note: a skill folder created mid-session may not load until Claude Code restarts.
> If `/garvis-ops` isn't in the `/` menu, restart, or `/doctor` to check for parse errors.
