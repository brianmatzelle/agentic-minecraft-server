# Layer 5 — OpenShell egress sandbox (wraps the AGENT, not the server)

OpenShell is **egress-only** — it cannot host the inbound Minecraft listener. The
game server runs as a normal container/pod (Layer 1/4). This layer exists to make
the agent's **broad autonomy** survivable by clamping its *outbound* blast radius.

## Files
| File | What |
|---|---|
| `policy.yaml` | default-deny egress allowlist (Anthropic, Modrinth, GitHub, NeoForge maven) + non-root + writable `/sandbox` only |
| `Dockerfile` | custom long-lived agent image (non-root uid/gid `1000660000`, `claude-code`, Hermes) |
| `run.sh` | gateway register → sandbox create → `policy set` → connect; includes the kill switch |

## Bring-up
```bash
bash infra/openshell/run.sh        # build image → create sandbox → policy → creds → clone
# then point the bot at it:
#   GARVIS_DISPATCH_MODE=openshell  OPENSHELL_SANDBOX=mc-maint-agent  OPENSHELL_WORKDIR=/sandbox/minecraft
# kill switch:  openshell sandbox delete mc-maint-agent
```

When `GARVIS_DISPATCH_MODE=openshell`, the bot runs the maintenance agent **inside**
this sandbox via `openshell sandbox exec` (see `apps/garvis-bot/src/index.js`).
Default is `local` (host clone) — flip to `openshell` only after bring-up.

## Status (verified 2026-06-23)
- ✅ `Dockerfile` **builds** and ships `git`, `gh` (2.95), `node`, `claude`, `curl`
  (`gh` was missing before; the broken `hermes` CMD was dropped for `sleep infinity`).
- ✅ CLI forms confirmed: `sandbox create --from <Dockerfile> --policy <file> -- <cmd>`
  builds locally then creates; `sandbox exec -n <name> --workdir <dir> -- <cmd>`;
  `sandbox upload`; `policy set/update/get --full`.
- ✅ `policy.yaml` binary paths corrected (`node` → `/usr/local/bin/node`).
- ⬜ Confirm on bring-up: claude auth inside the box (uploaded
  `~/.claude/.credentials.json` vs. an `ANTHROPIC_API_KEY`), and that `sandbox create`
  with `-- sleep infinity` detaches (else create it without a blocking command).
- ⬜ Broaden egress for any mod **forum/docs** hosts you want research to reach
  (`policy update`); the default allowlist is Modrinth + GitHub + NeoForge + Anthropic.

> What the sandbox does NOT stop: a prompt-injected agent misusing granted
> capabilities, or exfil via an allowed host (SNI-filtered, not payload-inspected).
> The deploy gate + PR review + no-secrets-in-box cover that. See `../docs/security.md`.
