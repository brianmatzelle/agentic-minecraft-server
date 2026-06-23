# Layer 2 — Maintenance agent (Hermes + claude-code)

The agent edits the repo and opens PRs on a schedule. It runs **inside the
OpenShell sandbox** (Layer 5), never touches the live world, and has **no Discord
token**. Scheduled work = Hermes cron; on-demand friend requests = the bot
(Layer 3) dispatching a scoped `claude -p` run into the sandbox.

## Files
| File | Install to | What |
|---|---|---|
| `config.yaml` | `~/.hermes/config.yaml` | Hermes settings (run `hermes setup` after) |
| `cron-job.example.json` | via `hermes cron` CLI | nightly maintenance job (don't hand-edit `jobs.json`) |
| `discord.env.example` | `~/.hermes/.env` | bot token + **deny-by-default** allowlist + home channel |
| `claude/settings.json` | passed via `claude --settings …` | bounded-autonomy permissions (broad allow, hard deny on exfil/push/destructive) |
| `claude/managed-settings.json` | OS managed path **in the agent image** | un-overridable: blocks bypass mode, locks hooks |
| `claude/hooks/block-downloaders.sh` | PreToolUse hook on Bash | `exit 2` backstop against downloaders/installers/push |

> The `"//"` keys in the JSON files are inline docs — valid JSON, ignored by the
> tools, safe to delete.

## Why settings live here (not the repo root `.claude/`)
A committed root `.claude/settings.json` `deny` would bind **your own** interactive
Claude Code in this repo too (deny wins over allow at every precedence). Keeping the
agent's locks under `agent/` scopes them to the sandboxed agent.

## Confirm at install
- Your Hermes build's `config.yaml` keys (`hermes setup` validates/migrates `_config_version`).
- That `DISCORD_ALLOWED_USERS/ROLES` + `REQUIRE_MENTION` are honored (the authz gate).
- The exact `deliver` value that routes cron output to Discord.
- `managed-settings.json` delivery path inside the image (else it has no effect).
