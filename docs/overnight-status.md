# Overnight status — modded server + Garvis (2026-06-23)

**TL;DR:** Your server is set up and live. ComputerCraft and Cobblemon — plus a
performance pack — are installed and running on NeoForge 1.21.1, all added **by
Garvis** (he researched each, opened a PR; a human reviewed/merged/deployed). Garvis
himself got a big upgrade: friends can now ask him for mods in plain English and he
handles it end-to-end, robustly.

## What's live on the server right now
9 mods, NeoForge 1.21.1, server healthy (`Done`, no crashes):

| Mod | Version | Why | Client-side? |
|-----|---------|-----|--------------|
| CC: Tweaked | 1.120.0 | ComputerCraft (you asked) | **required** |
| Cobblemon | 1.7.3 | Pokémon (you asked) | **required** |
| Kotlin for Forge | 5.11.0 | Cobblemon dependency | comes with Cobblemon |
| Lithium | 0.15.3 | tick/game-logic perf | no |
| FerriteCore | 7.0.3 | memory | no |
| ModernFix | 5.27.14 | startup/mem/perf | no |
| spark | 1.10.124 | profiler (diagnose lag) | no |
| Chunky | 1.4.23 | chunk pre-gen | no |
| Noisium | 2.3.0 | faster worldgen | no |

- **ComputerCraft note:** the original ComputerCraft is dead for modern MC; Garvis
  correctly used **CC: Tweaked**, the maintained successor.
- **Players need client mods:** CC: Tweaked + Cobblemon (+ Kotlin for Forge) must be
  installed on each player's client too. The perf mods are server-only. See the
  updated `docs/windows-client-install.md`.
- **Whitelist is ON** with only `DubstepCow` (your config). Add friends' usernames to
  `MC_WHITELIST` in `apps/server/.env` and re-run the deploy to let them in.

## What changed in the repo (all via PRs you can review)
- **#1** server-setup: whitelist wiring, `apps/agent/modlist.txt` (canonical mod
  list), `scripts/deploy.sh` (the deploy gate: modlist → `.env` → recreate container).
- **#2 / #4** Garvis v2 + journal logging (see below).
- **#3 (Garvis)** CC: Tweaked. **#6 (Garvis)** Cobblemon. **#7 (Garvis)** perf pack.
- **#5** itzg `MODRINTH_ALLOWED_VERSION_TYPE=alpha` fix — CC: Tweaked publishes stable
  builds on Modrinth's *alpha* channel and itzg defaulted to release-only, rejecting it.
- **#8** client-install docs. **#9** OpenShell dispatch wiring (ready, OFF by default).

## Garvis is now robust + beginner-friendly
The old bot returned *"Garvis returned nothing"* on the ComputerCraft request — a hard
6-turn cap starving any task that needs research. Fixed, plus:
- **Plain-English installs:** an authorized member says *"@garvis add cobblemon"* and he
  researches NeoForge 1.21.1 **server-side** compatibility (+ deps + client-side need),
  edits the modlist on a branch, and opens a **PR**. No slug syntax needed.
- **Knows when to say no:** asked to add **Sodium** (a client-only FPS mod), he declined
  gracefully, explained why, and offered to make a client modpack list — instead of
  opening a broken PR.
- **Safe by construction:** the agent works in an **isolated clone**, never the live
  repo; runs are serialized; he never merges or deploys — a human does.
- Q&A / `/installhelp` and mod requests are now open to everyone — no allowlist; a
  per-user cooldown (`GARVIS_COOLDOWN_MS`) is the only anti-spam gate, and every mod
  PR still needs a human to merge. Friendly errors + a quiet auto-retry.

Track record tonight: **3/3 install requests succeeded** (~1 min each), each with an
accurate PR; **1/1 bad request declined correctly**. He even caught a dependency I'd
gotten wrong — Cobblemon needs **Kotlin for Forge**, not Architectury.

## How to run things
- **Add a mod:** @mention Garvis (`@garvis add <mod>`) — or edit `apps/agent/modlist.txt`
  yourself. Then **merge the PR** and run **`scripts/deploy.sh`**.
- **Deploy:** `scripts/deploy.sh` (or `--dry-run` to preview). Never touches the live
  world (`server-data/`).
- **Let a friend drive Garvis:** nothing to configure — anyone can @mention Garvis to
  ask a question or request a mod. (Set `GARVIS_DISPATCH_MODE=local` so requests
  actually open PRs; `dry-run` keeps @mentions Q&A-only.)

## OpenShell (egress sandbox) — prepared, not enabled
You said to park security for later, so this is OFF (`GARVIS_DISPATCH_MODE=local`) but
ready:
- Fixed the agent image (`infra/openshell/Dockerfile`) — it was missing `gh` and had a
  broken start command. **It now builds** with claude + git + gh + curl.
- Wired `GARVIS_DISPATCH_MODE=openshell` so the agent runs *inside* the egress sandbox
  via `openshell sandbox exec` (chat stays local).
- `infra/openshell/run.sh` does the full bring-up (build → create → policy → upload
  creds → clone → sanity-check).
- **Before flipping it on:** run `run.sh`, confirm `claude` auth works inside the box
  (uploaded `~/.claude/.credentials.json` vs. an `ANTHROPIC_API_KEY`), confirm the
  `sandbox create` attach behavior, then set `GARVIS_DISPATCH_MODE=openshell`.
- Until then the agent runs locally with full host capability (fast + reliable, but no
  egress sandbox — the thing to button up in the security pass).

## Notes / heads-up
- Cobblemon logs some `SoundEngine`/`Channel` mixin WARNs on boot — harmless (client
  mixins skipped on a dedicated server). ModernFix↔Lithium "Skipping method" is also
  expected (they intentionally defer to each other).
- The agent's local clone lives at `~/projects/active/minecraft-agent` (isolated from
  your working copy). It pushes branches to GitHub over HTTPS using the `gh` token.
- Restarting the server applies env/whitelist changes; the first boot after adding a
  mod downloads it (a little slower).
