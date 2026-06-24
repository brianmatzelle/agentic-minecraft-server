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
- **S6 — Least-privilege Discord:** slash commands (not the MESSAGE_CONTENT
  intent), `DISCORD_ALLOWED_USERS`/`ROLES` allowlist (deny-by-default),
  per-user cooldowns.

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
- **G4 — Identity caveat (policy).** Garvis cannot verify who is typing; an
  "authorized Discord member" may *ask* for things but that is not authority to grant
  admin. Privileged live-server actions (op/ban/etc.) are done by the human on the
  host, never by the agent acting on a chat message — which is exactly what Garvis
  told the impersonator.

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
  authz-gated, parameterless-except-username code path can.
- **Deny-by-default authz + cooldown.** Gated by the same `isAuthorized` allowlist
  (`DISCORD_ALLOWED_USERS`/`ROLES`) and per-user cooldown as `/requestmod`. Empty
  allowlist ⇒ nobody can use it.
- **Username is data, never a command.** Validated against `^[A-Za-z0-9_]{3,16}$`
  (Minecraft Java charset) and passed as argv, so it cannot inject a shell/rcon command.
- **Repo stays source of truth.** The add is also persisted to `MC_WHITELIST` in
  `apps/server/.env` (idempotent, atomic write, file mode preserved) so it survives the
  `OVERRIDE_WHITELIST=TRUE` rewrite on restart — same source-of-truth discipline as G2.
- **Still audited.** This intentionally trips the **G3 tripwire** (`Added … to the
  whitelist` + a `whitelist.json` / `.env` write). That is expected, not an incident —
  `/whitelist` is now a known-legitimate source of those events.

Residual risk (accepted by the owner): a friend on the allowlist can whitelist anyone
(including griefers), and the bot process holds a docker socket reach to one rcon verb.
If the posture tightens later, the safer alternatives are the `/requestmod`-style
PR-for-approval flow, or moving whitelist writes behind a reviewed deploy.
