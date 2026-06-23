#!/usr/bin/env bash
# Stand up the egress-sandboxed maintenance agent (Layer 5).
# Command FORMS are [VERIFIED]; flag sets / the long-run start command are
# [ILLUSTRATIVE] — run `openshell <cmd> --help` to confirm before relying on these.
set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-mc-maint-agent}"

# 1) Register a local gateway (once per host).
openshell gateway add http://127.0.0.1:8080 --local --name local

# 2) Build the image + create the long-lived sandbox.
#    The start command goes AFTER `--` (it replaces the image CMD). [VERIFIED form]
#    NOTE: confirm whether <name> is required vs auto-assigned (`sandbox create --help`).
openshell sandbox create \
    --from openshell/Dockerfile \
    --name "${SANDBOX_NAME}" \
    -- hermes serve                      # [ILLUSTRATIVE start cmd — confirm Hermes long-run subcommand]

# 3) Apply the default-deny egress allowlist (NAME before --policy). [VERIFIED order]
openshell policy set "${SANDBOX_NAME}" --policy openshell/policy.yaml --wait
openshell policy get "${SANDBOX_NAME}"

# 4) Inside the sandbox, the agent clones the repo into /sandbox (its only writable state):
#       git clone https://github.com/<you>/minecraft-server /sandbox/minecraft-server
#    Secrets injected as env (NOT the Discord token): ANTHROPIC_API_KEY, GH_TOKEN.

echo "Sandbox '${SANDBOX_NAME}' is up. Connect: openshell sandbox connect ${SANDBOX_NAME}"
echo "KILL SWITCH: openshell sandbox delete ${SANDBOX_NAME}"
