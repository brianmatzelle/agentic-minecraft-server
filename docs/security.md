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
