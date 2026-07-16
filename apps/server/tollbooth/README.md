# tollbooth — pay to command Garvis 🎟️

Stream viewers on [Garvis TV](https://tv.starting.cc) buy **command credits with
USDC over [x402](https://www.x402.org)** (the HTTP 402 payment protocol) and
spend them in the stream chat to drive Garvis's in-game body and the in-game
TV. Built & E2E-verified on Base Sepolia testnet 2026-07-16 — including a real
paid purchase (settlement tx on-chain, $1 test USDC received).

## The loop

```
viewer clicks "🎟️ Command Garvis" (Owncast external action)
  → GET /tollbooth/buy  ──402──▶ browser: @x402/paywall wallet UI
                                 agent:   PAYMENT-REQUIRED header terms
  → pays $1 USDC (facilitator verifies + settles; response is BUFFERED
    until settlement succeeds — a failed settle never leaks the code)
  → gets a one-time code (GT-XXXX-XXXX, 10 credits)
  → types "!redeem GT-XXXX-XWDQ" in the stream chat
      Owncast ──CHAT webhook──▶ tollbooth :8091 → credits bound to their
                                chat identity (stream_viewers, postgres)
  → types "!g mine some iron" / "!g put a creeper on the TV"
      tollbooth checks credits + 20s cooldown → INSERT stream_commands
      garvis-bot worker (HOST, apps/garvis-bot/src/streamchat.js) claims it,
      classifies with the SAME in-game classifier, executes ONLY body/tv,
      burns 1 credit on success, replies in stream chat + tellraws the world
```

Chat commands: `!redeem <code>` · `!balance` · `!g <anything>` · `!help`.
A command that fails or classifies outside the sold powers costs **nothing**.

## Trust model (the important part)

- Stream viewers are **anonymous strangers with a wallet**. They get exactly
  the body-verb + TV surface in-game players already have — re-validated and
  denylisted in body.js/tv.js, executed with `asker:null` (in-world-only verbs
  like "come here" refuse; mine/farm anchor on any online player). They NEVER
  reach qa (free-form agent), give, modreq, or the rcon-empowered `!g` agent.
- The webhook listener (:8091) is compose-internal only. The public tunnel
  path reaches :8090 only — a forged "chat" POST can't arrive from outside.
- This process holds **no keys**. `X402_PAY_TO` is just the receiving address;
  verification + settlement happen at the facilitator; the SDK buffers the
  response until settlement succeeds (verified in @x402/express source — on
  settle failure the buffered body is discarded and the buyer gets an error;
  worst case is an orphaned unredeemed code row).
- Credits live in the convlog postgres (`stream_viewers` / `stream_codes` /
  `stream_commands` — schema duplicated in streamchat.js, keep in sync).
  Owncast identities are per-browser localStorage: a viewer who clears
  storage loses their balance (comp via SQL if it matters).

## Money config

| env | default | meaning |
|-----|---------|---------|
| `X402_PAY_TO` | (required) | receiving EVM address. **Currently a TESTNET THROWAWAY** — replace before mainnet |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia) | `eip155:8453` = Base mainnet |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | **testnet-only** facilitator |
| `TOLLBOOTH_PRICE_USD` / `TOLLBOOTH_CREDITS` | 1.00 / 10 | the bundle |
| `TOLLBOOTH_COOLDOWN_S` | 20 | per-viewer enqueue cooldown |

**Mainnet flip** (when the owner wants real money): set the three X402_* vars
— but note CDP's mainnet facilitator authenticates with CDP API keys via the
`@coinbase/x402` helper package, so server.js needs a ~3-line change (import
its facilitator config instead of a bare URL) unless a keyless public mainnet
facilitator is available. Also true up the earnings wallet: the current payTo
privkey is a scratchpad throwaway holding test USDC only.

## Ops

- Health: `curl -s localhost:8090/tollbooth/health` (or via the edge:
  `https://tv.starting.cc/tollbooth/health`).
- Logs: `docker logs mc-tollbooth` (sells/redeems/queues) · worker side:
  `journalctl --user -u garvis-bot | grep '\[stream\]'`.
- Kill switches: stop selling = `docker compose stop tollbooth` (bought
  credits keep working) · stop executing = `GARVIS_STREAM_COMMANDS=off` in
  apps/garvis-bot/.env + restart garvis-bot.
- Comp credits by hand: `INSERT INTO stream_codes (code, credits, payment_ref)
  VALUES ('GTFRIENDAA', 10, 'comped');` → have them `!redeem GT-FRIE-NDAA`.
- The Owncast integrations token (`OWNCAST_BOT_TOKEN`, in BOTH
  apps/server/.env and apps/garvis-bot/.env) is the bot's chat voice —
  rotating it means updating both + restarting tollbooth and garvis-bot.
  Beware: the token is base64 and can end in `=` — copy with
  `sed -n 's/^OWNCAST_BOT_TOKEN=//p'`, never `cut -d= -f2` (that truncation
  cost us a silent 401 once).

## Gotchas earned

- Owncast renders chat as HTML — angle brackets in bot replies (`<code>`,
  `<player>`) get eaten as tags. Plain words only.
- Owncast webhooks fire for integration-sent messages too — filter on
  `user.isBot` or the bot loops on its own replies.
- The paywall serves to real browsers only (Accept + User-Agent sniffing);
  curl with `Accept: text/html` alone still gets JSON terms. v2 puts the
  terms in the base64 `PAYMENT-REQUIRED` response header, NOT the body.
- `@x402/paywall` drags in @metamask/sdk → `bufferutil`, a native addon with
  no arm64-musl prebuild — hence the Dockerfile's python3/make/g++ builder
  stage.
- cloudflared path routes: regex, first match wins — the `/tollbooth` rule
  must sit ABOVE the tv.starting.cc catch-all in ~/.cloudflared/config.yml.
