# Long-lived agent image for OpenShell (Layer 5) — the egress-sandboxed environment
# Garvis dispatches mod-install tasks into when GARVIS_DISPATCH_MODE=openshell.
#
# Requirements that are [VERIFIED] for OpenShell BYOC:
#   - non-root user `sandbox` at uid/gid 1000660000
#   - iproute2 present; writable /sandbox; NOT distroless/scratch
#   - the OpenShell supervisor REPLACES the CMD at runtime (start cmd passed after `--`)
#
# Toolchain the agent needs INSIDE the box (this is what the stock image lacked):
#   claude (the agent), git + gh (branch/commit/PR), curl + jq (Modrinth research).
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl wget git iproute2 nftables ca-certificates jq gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo) — needed so the agent can open PRs from the sandbox.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The agent's brain. Package name is [VERIFIED]. Installs `claude` to /usr/local/bin.
RUN npm install -g @anthropic-ai/claude-code

# Non-root sandbox user — uid/gid are [VERIFIED] required values for OpenShell.
RUN groupadd -g 1000660000 sandbox \
    && useradd -m -u 1000660000 -g sandbox sandbox \
    && install -d -o sandbox -g sandbox /sandbox
USER sandbox
WORKDIR /sandbox

# Verify tool locations match infra/openshell/policy.yaml `binaries[].path`:
#   docker run --rm <img> sh -c 'command -v git curl gh node claude'
#   -> /usr/bin/git /usr/bin/curl /usr/bin/gh /usr/local/bin/node /usr/local/bin/claude
#
# The real start command is supplied after `--` at `sandbox create` time (run.sh uses
# `sleep infinity` to keep the box alive); this CMD is only a fallback.
CMD ["sleep", "infinity"]
