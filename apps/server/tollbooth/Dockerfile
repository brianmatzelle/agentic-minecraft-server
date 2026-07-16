# Garvis TV tollbooth — pay-to-command-Garvis (x402 + Owncast chat gate).
# Stateless: all ledger state lives in the mc-postgres sidecar.
#
# Multi-stage: the paywall's wallet stack (@metamask/sdk via @x402/paywall)
# hard-depends on bufferutil, which has no linux-arm64-musl prebuild — the
# builder stage carries python3/make/g++ for that one node-gyp compile and the
# runtime stage stays a clean node:22-alpine.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# 8090 = public app (landing + x402 /buy; host-published 127.0.0.1-only, the
#        cloudflared path route is the sole consumer)
# 8091 = Owncast webhook listener (compose-internal ONLY — never published;
#        keeps forged "chat" posts from ever arriving via the tunnel)
EXPOSE 8090 8091

CMD ["node", "src/server.js"]
