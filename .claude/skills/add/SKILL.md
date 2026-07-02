---
name: add
description: Merge a vetted PR into the live NeoForge 1.21.1 MC server and redeploy, after verifying server and client mod/loader versions stay in sync. Owner-invoked as /add <PR>.
argument-hint: "[PR number, e.g. 50]"
disable-model-invocation: true
allowed-tools: "Read, Grep, Bash(gh *), Bash(git *), Bash(node *), Bash(docker *), Bash(scripts/deploy.sh*)"
---

# add — version-check, merge PR #$ARGUMENTS, redeploy

Live repo `~/projects/active/minecraft` stays on **main**. Target PR = **#$ARGUMENTS**.

## 1. Review
```bash
gh pr view $ARGUMENTS && gh pr diff $ARGUMENTS
```
Any mod change must touch **both** sides: server `apps/agent/modlist.txt` *and* client `scripts/build-client-mrpack.mjs` + regenerated `apps/client/` artifacts.

## 2. Version-match gate (server ⇄ client) — before merge
```bash
cd ~/projects/active/minecraft
gh pr checkout $ARGUMENTS
node scripts/build-client-mrpack.mjs && git diff --exit-code apps/client/   # clean = client jars match the pins
```
Also confirm **MC version equal**: `apps/server/.env` `MC_VERSION` == `apps/client/modrinth.index.json` `dependencies.minecraft` == `MC_VERSION` in `build-client-mrpack.mjs` (all `1.21.1`). Drift-prone mods (`cobblemon`, `kotlin-for-forge`, `sophisticated-core`, `cobbreeding`) are pinned on both sides — server `slug:<versionId>` (modlist.txt) and client `pin:<version_number>` (build-client-mrpack.mjs) must be the same Modrinth build. **Dirty diff → the PR forgot to regen the pack; stop and fix before merging.**

## 3. Merge + follow main + stamp the auto-deploy state — IMMEDIATELY, before deploying
```bash
git checkout main
gh pr merge $ARGUMENTS --merge --delete-branch
git pull --ff-only
printf 'last_deployed_sha=%s\nlast_result=ok\n' "$(git rev-parse HEAD)" > apps/server/.auto-deploy-state
```
The stamp is NOT optional: the `garvis-auto-deploy.timer` watcher fires every 3 min, and a mod-PR merge is allowlist-eligible — without the stamp it re-deploys the same SHA with `--health-check`, which can **never** succeed on an already-booted server (it tails live logs for a `Done` that already printed) → false 420s timeout → **rolls the live server back to the old mod set** (near-miss 2026-07-02, PR #48; killed with 20s to spare). If a watcher run is already in-flight (`pgrep -af deploy.sh`), kill it before its timeout — killing is safe, rollback only happens on the failure path.

## 4. Redeploy — **no** `--health-check` (false-timeout → bad rollback on this fast box)
```bash
scripts/deploy.sh                 # modlist.txt → MODRINTH_PROJECTS → docker compose up -d
docker logs -f --since 2s mc-neoforge 2>&1 | sed -u 's/\x1b\[[0-9;]*m//g' \
  | grep --line-buffered -iE 'Downloading|Done \([0-9.]+s\)|ERROR|Exception|No candidate|incompatible'
```
Wait for `Done (Ns)!`. Report mods added + boot status; leave repo clean on **main**. Never touch `apps/server/server-data/`.
