# Auto-deploy — mod requests go live without waiting for the owner

This is the latency fix for "Garvis is too slow": a friend asks for a mod, and instead of
the request sitting in a PR until the owner merges + runs `deploy.sh` by hand, an opt-in
host watcher merges it and deploys it live within a few minutes — **with a boot-health
check that auto-rolls-back a server that won't start, so it can never leave the world
down.** The world (`server-data/`) and the host are never exposed to this path; it only
ever merges a PR and runs the existing deploy gate.

## The pieces

| File | Role |
|---|---|
| `scripts/deploy.sh --health-check` | The deploy gate + a boot-health check. After `docker compose up -d` it waits for itzg's `Done (Ns)!` marker; if the server doesn't boot it **restores the previous `MODRINTH_PROJECTS` and redeploys**, then exits non-zero. Benefits manual deploys too. |
| `scripts/auto-deploy.sh` | The watcher. One pass: (1) optionally auto-merge eligible mod-add PRs, (2) fast-forward `main`, (3) run a health-checked deploy if the mod files changed, (4) quarantine + alert on failure. Inert unless `GARVIS_AUTODEPLOY=on`. |
| `infra/systemd/garvis-auto-deploy.{service,timer}` | Runs the watcher every ~3 minutes as a `--user` oneshot. |

## How a request flows (end to end)

1. A friend `@garvis add waystones`. The maintenance agent (in its isolated clone) opens a
   PR on branch `add-mod/waystones` touching **only** `apps/agent/modlist.txt` (+ the client
   pack if needed). *(unchanged from today)*
2. The watcher sees the open PR. Because its diff is confined to the **mod-list /
   client-pack allowlist**, it auto-merges it (`GARVIS_AUTOMERGE=on`).
3. The watcher fast-forwards `main` and runs `deploy.sh --health-check`.
4. itzg downloads the new mod and boots. If it reaches `Done`, the deploy sticks. If it
   crash-loops (a bad/incompatible mod — see the cobblemon-mega-showdown datapack NPE in
   `docs/overnight-status.md`), `deploy.sh` reverts to the previous mod set and the server
   comes back up on the last-known-good state. The bad commit is **quarantined** (never
   auto-retried) and an alert fires.

## The supply-chain boundary (read this before enabling auto-merge)

`CLAUDE.md` treats every mod addition as **supply-chain-sensitive** — mod jars can run
install scripts. Auto-merge relaxes the "a human reviews every mod before it goes live"
rule, so it is bounded hard:

- **File allowlist.** A PR is auto-merged **only** if its entire diff is within
  `apps/agent/modlist.txt`, `apps/client/modrinth.index.json`,
  `apps/client/starting-cc-client.mrpack`. A PR that touches *any* code, `docker-compose.yml`,
  `.env`, a workflow, or a script is **never** auto-merged — it waits for a human. So the
  automated path can only ever change *which Modrinth slugs* are installed, nothing else.
- **Branch convention.** Only PRs on `add-mod/*` (the agent's mod-add branch) are considered.
- **Boot-rollback** catches a mod that *crashes* the server. It does **not** catch a
  malicious-but-stable jar — that residual risk is the cost of dropping human review, and is
  why auto-merge is a separate, off-by-default switch (`GARVIS_AUTOMERGE`). Leave it off to
  keep "auto-deploy on human merge" (safer): the owner still clicks merge, but never has to
  touch the host.

## Enabling

```bash
cp infra/systemd/garvis-auto-deploy.{service,timer} ~/.config/systemd/user/
# edit ~/.config/systemd/user/garvis-auto-deploy.service: set GARVIS_AUTODEPLOY=on,
# GARVIS_AUTOMERGE=on/off, optional GARVIS_ALERT_WEBHOOK
systemctl --user daemon-reload
systemctl --user enable --now garvis-auto-deploy.timer
journalctl --user -u garvis-auto-deploy.service -f
```

Host prereqs (the watcher runs as your user): `docker` works, `git fetch` over SSH works
non-interactively (the deploy key has no passphrase, or an agent is running), and
`gh auth status` is logged in (for auto-merge).

## Config (env, set in the .service or the shell)

| Var | Default | Meaning |
|---|---|---|
| `GARVIS_AUTODEPLOY` | `off` | Master switch. Off ⇒ the watcher does nothing. |
| `GARVIS_AUTOMERGE` | `off` | Also auto-merge file-allowlisted mod-add PRs. Off ⇒ deploy only what a human merged. |
| `GARVIS_DEPLOY_TIMEOUT` | `420` | Seconds to wait for `Done` before declaring boot failed and rolling back. |
| `GARVIS_ALERT_WEBHOOK` | — | Optional Discord webhook for deploy/rollback alerts. |
| `GARVIS_PR_HEAD_PREFIX` | `add-mod/` | Branch prefix the watcher treats as agent mod-adds. |

## Kill switch & recovery

- **Stop auto-deploy:** `systemctl --user disable --now garvis-auto-deploy.timer` (or set
  `GARVIS_AUTODEPLOY=off`).
- **After a quarantined failure:** the live server is already back on the previous mods. Fix
  the offending mod in a new PR (e.g. pin a compatible version), merge it, and the watcher
  deploys the new commit. State lives in `apps/server/.auto-deploy-state` (gitignored);
  delete it to reset the watcher's memory.
- A `deploy.sh --health-check` whose **rollback also fails to boot** stops and shouts for
  manual help rather than looping.
