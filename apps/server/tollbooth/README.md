# tollbooth — pay to command Garvis 🎟️

Stream viewers on [Garvis TV](https://tv.starting.cc) buy **command credits in
USDC** and spend them in the stream chat to drive Garvis's in-game body and the
in-game TV. Built & E2E-verified on Base Sepolia testnet 2026-07-16 (real paid
purchases, settlement txs on-chain) — **LIVE ON BASE MAINNET (real money)
since 2026-07-16**.

**Two front doors, one code ledger:**

- **Humans → Base Pay** (`GET /tollbooth/pay`). The keyless `@base-org/account`
  SDK: the buyer's own browser pops the Base Account smart-wallet (passkey/email,
  no app to install), pays USDC to `X402_PAY_TO`, and the server mints a code
  after a server-side `getPaymentStatus` check. This is what works on a phone —
  the x402 browser paywall never completes on mobile (see gotcha below).
- **Agents → [x402](https://www.x402.org)** (`GET /tollbooth/buy`). The HTTP-402
  rail: a machine hits it, gets the 402 terms, pays, retries, gets a code.
  Settled by the keyless PayAI facilitator on mainnet.

Both mint the same one-time `GT-XXXX-XXXX` code; redemption is identical.

## The loop

```
viewer clicks "🎟️ Command Garvis" (Owncast external action) → /tollbooth landing

  HUMAN  → /tollbooth/pay → Base Pay button → smart-wallet popup pays $1 USDC
         → page POSTs the payment id to /pay/verify
         → server getPaymentStatus() confirms completed + right addr + amount
         → mints a one-time code (GT-XXXX-XXXX, 10 credits)

  AGENT  → GET /tollbooth/buy ──402──▶ PAYMENT-REQUIRED header terms
         → pays $1 USDC (facilitator verifies + settles; response BUFFERED
           until settlement succeeds — a failed settle never leaks the code)
         → gets the same kind of one-time code
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
| `X402_PAY_TO` | (required) | receiving EVM address. Owner's Coinbase Wallet since 2026-07-16 (same address works on testnet + mainnet) |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia) | `eip155:8453` = Base mainnet (**current setting**) |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` (**testnet-only**) | set to `https://facilitator.payai.network` in .env — keyless, settles mainnet + Sepolia; ignored when CDP keys are set |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | (empty) | optional: switches to Coinbase's hosted facilitator (@coinbase/x402) — but needs a business-verified CDP account, which is why we use PayAI |
| `TOLLBOOTH_PRICE_USD` / `TOLLBOOTH_CREDITS` | 1.00 / 10 | the bundle |
| `TOLLBOOTH_COOLDOWN_S` | 20 | per-viewer enqueue cooldown |

**Base Pay needs no extra config.** It's keyless — it reuses `X402_PAY_TO` as
the recipient and derives its testnet flag from `X402_NETWORK` (so mainnet vs
Sepolia flips both rails at once). The browser pulls the SDK from
`esm.sh/@base-org/account@<BASE_ACCOUNT_VERSION>` (pinned in `src/server.js`,
kept in sync with `package.json`); the server verifies with the installed copy.
No CDP account, no API keys — that's the whole reason it exists alongside the
CDP-gated option.

**Mainnet is LIVE** (2026-07-16): `X402_NETWORK=eip155:8453` +
`X402_FACILITATOR_URL=https://facilitator.payai.network` in apps/server/.env,
payTo = the owner's wallet. PayAI was chosen because Coinbase gates its CDP
facilitator behind business verification; PayAI is keyless, free, and was
E2E-proven with a real paid purchase through the edge before the flip
(settlement tx 0xd9f5e5cc… on Base Sepolia). Facilitators never custody
funds — settlement pays payTo directly on-chain — so the facilitator trust
surface is fake-verify/downtime, not theft. Back to testnet =
`X402_NETWORK=eip155:84532` + `docker compose up -d tollbooth`. The boot log
names the active network + facilitator; the tollbooth refuses to boot on
mainnet against the testnet-only default facilitator.

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
- **FAIL-OPEN via non-GET (fixed):** the x402 middleware only guards the verb
  it's registered for (`GET /tollbooth/buy`). Express routes **HEAD** (and any
  verb) to the GET handler, so a `HEAD /buy` — which iOS Safari fires for link
  prefetch/preview — sailed past the paywall as "no-payment-required" and minted
  a **free** code every time. That was the source of every unpaid code in the
  ledger. Fix: an explicit `app.head('/tollbooth/buy')` that 402s, plus the GET
  handler refuses to mint unless a payment header is actually present (a real
  verified payment always carries one; a bogus one is rejected by the middleware
  before it reaches the handler). If you add routes, remember the middleware
  gates ONE verb — guard the handler itself too.
- **Mobile browser paywall is unreliable:** the @x402/paywall wallet handshake
  (both "Coinbase Wallet" deep-link and "Injected" inside the Coinbase/Base app)
  repeatedly failed to produce a signed payment on an iPhone — the page loads
  (GET/HEAD) but no `pay=true` ever reaches the server, and the buyer sees a
  "network error." A headless x402 client (`@x402/fetch` + a funded key) settles
  mainnet fine — that's how the first real dollar was proven. Open UX problem for
  real (mostly-mobile) viewers; desktop + Coinbase Wallet extension is the
  known-good browser path.
