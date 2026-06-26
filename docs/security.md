# Security model

Friends can drive an autonomous agent with broad capability. The chosen posture
is **broad-but-bounded autonomy**: full autonomy *inside a small blast radius*,
enforced by an OpenShell egress sandbox rather than per-action prompts.

## What an egress sandbox DOES and does NOT defend against
- ✅ Defends: data exfiltration, unapproved downloads/installs, SSRF, reaching
  loopback/metadata/private ranges, compromising the host network.
- ❌ Does NOT defend: a prompt-injected agent **misusing the capabilities you
  granted it inside the box** (e.g. trashing the working copy), or making a bad
  change. Contain that with blast-radius design below, not with the sandbox.

## Blast-radius design (the point of "broad autonomy")
1. The agent's only writable state is an **isolated clone of this repo**. It
   never has the live world (`server-data/`) or production kube credentials.
2. A **deploy gate** sits between repo and live server. Repo changes are applied
   by a separate, reviewed step — not by the agent.
3. Run the agent **non-root**, with **no host secrets** mounted.
4. **Egress allowlist** (OpenShell): only `api.anthropic.com`, approved mod
   hosts (Modrinth/CurseForge), GitHub, and the package mirrors actually needed.
   Everything else default-deny. (Exact list: `openshell/` — pending research.)
5. **Spend cap + kill switch** so an injected loop can't run up cost.

## Non-negotiables
- **S0 — Rotate the leaked Discord token.** It was pasted in plaintext and is
  compromised. Developer Portal → Bot → Reset Token. New token only in `.env`.
- **S1 — Never `--dangerously-skip-permissions` / `bypassPermissions`.** It
  "offers no protection against prompt injection." Set the managed
  `disableBypassPermissionsMode: "disable"`.
- **S2 — Untrusted Discord text is data, not instructions.** Wrap it; never
  concatenate a friend's message into the agent's instruction/system prompt.
  Scope the task to "propose a mod addition as a PR," not "do what this says."
- **S3 — Tool surface via `deny` rules** (enforced by Claude Code, not the
  model): deny `curl`/`wget`/`npm`/`pip`/`git push`/`rm -rf`/reads of `.env`,
  `~/.ssh/**`, `**/*token*`. Deny overrides allow in every mode.
- **S4 — Human-in-the-loop for mod installs.** Mod jars run install scripts;
  review source + artifact before merge. No silent installs to the live server.
- **S5 — PreToolUse hook backstop** (`exit 2` to hard-block downloads/installers)
  with `allowManagedHooksOnly` so it can't be swapped out.
- **S6 — Least-privilege Discord:** per-user cooldowns as anti-spam. (This
  originally also proposed a `DISCORD_ALLOWED_USERS`/`ROLES` allowlist; the owner
  has since removed it, opening both `/whitelist` and @mention mod-requests to
  everyone — see the self-service exceptions below.)

Concrete config for S1–S6 lands in `agent/` and `openshell/` after the
deep-research synthesis.

## Implemented now — op/admin-escalation hardening (2026-06-23)

Red-team finding: asked (and then social-engineered with owner-impersonation +
urgency) to `op` a Discord user, Garvis **declined** both times — but only because
the *model* chose to. The capability was always present: the agent runs with the
host's `bypassPermissions` and could reach `docker exec … rcon-cli op …`. "Declined"
is not "prevented." These controls turn the soft, model-dependent "no" into layered
hard(er) stops. Full trace + analysis: the `harden/op-guardrails` PR.

- **G1 — Agent deny rules (the lever).** Every spawned agent (Q&A *and* maintenance)
  is launched with `--disallowedTools` blocking `docker`/`docker-compose`/`rcon-cli`/
  `mc-send-to-console` and edits/writes to `apps/server/.env` and `server-data/**`
  (`AGENT_DENY_TOOLS` in `apps/garvis-bot/src/index.js`). Claude Code enforces
  `deny`/disallowed-tools **even under `bypassPermissions`** (only allow/ask is
  skipped), and a spawn flag survives the clone's `git reset --hard && git clean -fd`
  (the agent can't wipe an argv). Costs the agent nothing — it only needs
  git/gh/curl/file-edits in its clone.
  ⚠️ **Soft control:** pattern-based Bash denial is bypassable (full paths, a helper
  script that shells out, etc.). It raises the bar; it is not a wall. The wall is S1
  (don't run with bypassPermissions) + the OpenShell sandbox (no docker socket / no
  host shell) — still the priority follow-up.
- **G2 — Ops are repo-source-of-truth.** `OVERRIDE_OPS: "TRUE"` (compose) rewrites
  `ops.json` from `MC_OPS` (in `.env`) on every boot, so any drift or console-granted
  op is wiped on restart. Mirrors the existing `OVERRIDE_WHITELIST` pattern.
- **G3 — Audit tripwire.** `scripts/ops-tripwire.sh` (systemd unit in
  `infra/systemd/ops-tripwire.service`) follows the server log and alarms on any
  op/de-op/ban/whitelist/RCON action, plus (best-effort) writes to the live ops/
  whitelist/`.env` files — so an escalation, attempted or real, is never silent.
- **G4 — Identity caveat (policy).** Garvis cannot verify who is typing; ANY Discord
  member may *ask* for things but that is not authority to grant admin. Privileged
  live-server actions (op/ban/etc.) are done by the human on the host, never by the
  agent acting on a chat message — which is exactly what Garvis told the impersonator.
  This matters more now that mod-requests are open to everyone (below): a request only
  ever produces a PR a human must review and merge.

## Deliberate exception — `/whitelist` self-service (2026-06-24)

The owner chose to let trusted friends whitelist players from Discord (UX over the
strict G4 posture; the owner's standing priority is beginner-friendliness). `/whitelist
{username}` is the first command where the **bot itself** performs a privileged
live-server action. The blast radius is intentionally the smallest possible privilege:
**whitelist add only** — *not* op, deop, ban, or arbitrary console. Whitelisting only
grants the ability to *join* an already-survival server; it grants no in-game power.

What keeps this in line with the model:

- **It runs in the bot, not the sandboxed agent.** The handler calls `docker exec …
  rcon-cli whitelist add` directly via `execFile` (no shell) in `apps/garvis-bot/src/
  whitelist.js`. The G1 deny rules (`AGENT_DENY_TOOLS`) are unchanged, so a
  prompt-injected *agent* still cannot reach docker/rcon — only this one fixed,
  validation-gated, username-only code path can.
- **Open to everyone, cooldown-gated.** No allowlist — any Discord user can call it
  (self-service joining); the only gates are username validation and a per-user
  cooldown. The @mention mod-request path is open the same way (see below).
- **Username is data, never a command.** Validated against `^[A-Za-z0-9_]{3,16}$`
  (Minecraft Java charset) and passed as argv, so it cannot inject a shell/rcon command.
- **Repo stays source of truth.** The add is also persisted to `MC_WHITELIST` in
  `apps/server/.env` (idempotent, atomic write, file mode preserved) so it survives the
  `OVERRIDE_WHITELIST=TRUE` rewrite on restart — same source-of-truth discipline as G2.
- **Still audited.** This intentionally trips the **G3 tripwire** (`Added … to the
  whitelist` + a `whitelist.json` / `.env` write). That is expected, not an incident —
  `/whitelist` is now a known-legitimate source of those events.

Residual risk (accepted by the owner): with no allowlist, ANY Discord user can
whitelist anyone (including griefers), and the bot process holds a docker socket reach
to one rcon verb. If the posture tightens later, the safer alternatives are a
PR-for-approval flow (as the mod-request path already uses), or moving whitelist
writes behind a reviewed deploy.

## Deliberate exception — open mod-requests via @mention (2026-06-24)

`/requestmod` (allowlist-gated) is removed; anyone can now @mention Garvis in plain
English ("@garvis add cobblemon") and he researches the mod and opens a PR. This
trades the Discord-actor allowlist for beginner-friendliness (the owner's standing
priority — the same call as `/whitelist` self-service). It widens *who can trigger* the
maintenance agent, not *what it can do*: every real boundary is unchanged.

- **Output is a PR, never a live change.** The agent works only in its isolated repo
  clone and opens a PR; a human still reviews + merges (S4). Worst case from an
  untrusted requester is a junk PR or wasted compute, not a server change.
- **Untrusted text stays data (S2).** The message is nonce-fenced and scoped to
  "propose a mod addition," never executed as instructions.
- **Same hard stops (G1/S1/S3 + sandbox).** `AGENT_DENY_TOOLS` still blocks
  docker/rcon and live `.env`/`server-data` writes; the OpenShell egress sandbox is
  still the real wall. Opening the front door changes none of this.
- **Anti-spam only.** A per-user cooldown (`GARVIS_COOLDOWN_MS`, default 60s) is the
  one gate, and maintenance runs serialize through a single clone, so a flood can't
  fan out.

Residual risk (accepted by the owner): anyone can make Garvis spend tokens and open
PRs. The cooldown + serialization bound the rate; the no-merge gate bounds the impact.
Re-gating later means restoring the `isAuthorized` allowlist (it lives in git history).

## Deliberate exception — auto-deploy of mod-add PRs (2026-06-25)

The owner chose to remove the human-merge + manual-`deploy.sh` latency: a friend's mod
request should go live on its own (the "auto-deploy mods" decision). This relaxes **S4
(human-in-the-loop for mod installs)** — bounded hard so the relaxation is narrow. Full
operator guide: `docs/auto-deploy.md`.

What keeps this in line with the model:

- **The agent's constraints are UNCHANGED.** The maintenance agent still only edits the
  repo in its isolated clone and opens a PR — it does **not** merge, push to `main`,
  `docker`, or deploy (still blocked by `AGENT_DENY_TOOLS` + its own deny rules). The
  agent rule in `CLAUDE.md` ("do not install to a live server or merge to main yourself")
  still holds for the *agent*.
- **Auto-merge is a separate, trusted host process, not the agent.** `scripts/auto-deploy.sh`
  (an opt-in systemd `--user` timer) is fixed code on the host — the same trusted-process
  posture as the `/whitelist` and live-moderation paths, not an LLM with a shell.
- **File allowlist = the supply-chain boundary.** A PR is auto-merged **only** if its whole
  diff is within `apps/agent/modlist.txt` + the two client-pack files. Any code, compose,
  `.env`, workflow, or script change is never auto-merged and still needs a human. So the
  automated path can only change *which Modrinth slugs* are installed — nothing executable
  in the repo. (It does **not** review the jar contents themselves — see residual risk.)
- **Boot-health rollback bounds the blast radius.** `deploy.sh --health-check` waits for
  itzg's `Done` marker and, on a crash-loop, restores the previous `MODRINTH_PROJECTS` and
  redeploys — so a bad mod auto-add can never leave the world down. The failing commit is
  quarantined (never auto-retried) and an alert fires.
- **Off by default.** `GARVIS_AUTODEPLOY` and `GARVIS_AUTOMERGE` are both `off` until the
  owner enables them; the kill switch is `systemctl --user disable --now
  garvis-auto-deploy.timer`.

Residual risk (accepted by the owner): dropping human review means a mod jar reaches the
live server without a person inspecting its source/artifact. The allowlist limits *what
files* change and the boot-rollback limits *downtime*, but neither inspects jar contents —
a malicious-but-stable mod would deploy. Mitigations if the posture tightens: leave
`GARVIS_AUTOMERGE=off` (auto-deploy only what a human merged), or add a pre-merge Modrinth
validation/allowlist of trusted authors.

## Live moderation — the fixed verb catalog (2026-06-25)

Goal: let friends act as full Minecraft **server moderators** in plain English, through
Garvis — *without* exposing any path to arbitrary code execution on the host. This is
the `/whitelist` exception generalized into a full toolkit, and it relies on the same
property that made `/whitelist` safe.

**The mechanism (`apps/garvis-bot/src/moderation.js`).** A `@mention` is first run through
a cheap classifier that asks Garvis to map the message to **one verb from a hard-coded
catalog + its args** (`{"action": "ban", "args": {"player": "Steve"}}`). The bot then:
1. **re-validates** every arg against a strict allowlist (usernames `^[A-Za-z0-9_]{3,16}$`,
   gamerules against a fixed map, enums, bounded ints, item-id regex, IPv4) — `resolveAction()`;
2. **role-gates** destructive verbs (below);
3. runs a **fixed** `docker exec <container> rcon-cli <verb> <validated argv…>` via
   `execFile` (no shell) — `runAction()` / `rconExec()`.

**Why this is safe-by-construction — the load-bearing claim.** The LLM never holds a
shell and never constructs a command; it only ever emits a *verb name + args*, and the
bot independently validates and executes. **A fully prompt-injected Garvis cannot escalate:**
- It can only name verbs that exist in the catalog. There is no `Bash`, no `docker run`,
  no file write, no host shell in this code path — those capabilities are not present to
  be abused. The blast radius is the union of the catalog verbs, nothing more.
- Destructive verbs (`ban`/`pardon`, `op`/`deop`, `kick`, `whitelist_remove`, `gamemode`,
  `ban-ip`, `restart`) are gated on the **Discord author's** role/identity (`GARVIS_MOD_ROLE_ID`
  / `GARVIS_OWNER_ID`), checked in the bot — injection of the *message* cannot grant a role.
- The worst an injected OPEN verb (`whitelist_add`, `tp`, `give`, `time`, `weather`,
  `broadcast`, `difficulty`, `gamerule`, `list`) achieves is a reversible, audited action
  the actual author was already permitted to run. So injection yields **no privilege gain**.

This is the deliberate division of labor: **OpenShell (Layer 5) is the wall for the one
component that legitimately needs a shell — the mod-research agent.** Live moderation
needs *no* shell, so it gets a *no-shell* design instead of a sandbox. The two dangers
("agent with a shell reaching the host" vs. "friends performing live server admin") have
different walls.

**Runs in the bot, not the agent.** Like `/whitelist`, these verbs execute in the trusted
bot process (it holds the token, runs on the host) — NOT the sandboxed maintenance agent,
which is still denied docker/rcon by `AGENT_DENY_TOOLS`. The split is unchanged.

**Persistence.** Verbs whose effect the compose `OVERRIDE_*` rewrite would wipe on
restart are written back to the repo `.env` source of truth: `op`/`deop` → `MC_OPS`,
`whitelist_add`/`whitelist_remove` → `MC_WHITELIST` (`OVERRIDE_OPS`/`OVERRIDE_WHITELIST`
are `TRUE`). Bans live in `server-data/banned-*.json` and survive restarts on their own.

**Audit.** Every action logs `[mod-action] <user> -> <verb> <args>` and trips the G3
ops-tripwire (expected, like `/whitelist`). Anti-spam: a short per-user `modaction`
cooldown (`GARVIS_MOD_ACTION_COOLDOWN_MS`), separate from the 60s gate on paid paths.
Kill switch: `GARVIS_MODERATION=off`.

Residual risk (accepted by the owner): a mod (or the owner) can ban/op the wrong person,
and OPEN verbs let any guild member nudge world state (weather/time/give) — all reversible
and audited. Identity is Discord-level (the G4 caveat): we trust who Discord says sent a
message; we can't verify the human behind the account. To tighten, narrow the OPEN set or
the catalog itself — both are one-line edits in `moderation.js` (`gated` flags / `VERBS`).
