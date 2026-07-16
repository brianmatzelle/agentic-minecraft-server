// Garvis TV tollbooth — pay to command Garvis, over x402.
//
// Two listeners, one ledger (the mc-postgres sidecar):
//
//   PUBLIC (:8090, host-published 127.0.0.1-only → cloudflared path route
//   https://tv.starting.cc/tollbooth):
//     GET /tollbooth        — landing page: what it is, price, how to redeem
//     GET /tollbooth/buy    — x402-GATED (HTTP 402 → pay USDC → retry): a
//                             settled payment mints a one-time redeem code
//                             worth TOLLBOOTH_CREDITS commands. Browsers get
//                             the @x402/paywall wallet UI; agents get the
//                             machine-readable 402 terms. NO account, NO keys.
//     GET /tollbooth/health — {ok, queued, viewers} for ops checks
//
//   WEBHOOK (:8091, compose-internal ONLY — owncast posts here; never
//   published, so forged "chat" can't arrive via the tunnel):
//     POST /owncast-webhook — Owncast CHAT events. Commands understood:
//       !redeem <code>  bind a paid code's credits to this chat identity
//       !balance        credits + queue position
//       !g <anything>   queue a command for the garvis-bot worker (host side,
//                       apps/garvis-bot/src/streamchat.js) — which classifies
//                       and executes ONLY body verbs + TV, burning 1 credit
//                       on success. !help lists all of this in chat.
//
// Money: x402 verification+settlement is done by the FACILITATOR (default
// https://x402.org/facilitator = Base Sepolia TESTNET). Mainnet = set
// X402_NETWORK=eip155:8453, point X402_FACILITATOR_URL at a mainnet
// facilitator (e.g. CDP's), and make X402_PAY_TO a wallet the owner controls.
// This process never holds keys — payTo is just the receiving address.
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';
import { initDb } from './schema.js';

const log = (m) => console.log(`[tollbooth] ${m}`);

// ── Config ────────────────────────────────────────────────────────────────
const PG_URL = process.env.TOLLBOOTH_PG_URL || process.env.DATABASE_URL || '';
const OWNCAST_URL = process.env.OWNCAST_URL || 'http://owncast:8080';
const OWNCAST_BOT_TOKEN = process.env.OWNCAST_BOT_TOKEN || '';
const PAY_TO = process.env.X402_PAY_TO || '';
const NETWORK = process.env.X402_NETWORK || 'eip155:84532';          // Base Sepolia
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const PRICE_USD = String(process.env.TOLLBOOTH_PRICE_USD || '1.00'); // dollars, no "$"
const CREDITS = Math.max(1, Number(process.env.TOLLBOOTH_CREDITS || 10));
const COOLDOWN_S = Math.max(0, Number(process.env.TOLLBOOTH_COOLDOWN_S || 20));
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://tv.starting.cc/tollbooth';
const STREAM_URL = process.env.STREAM_URL || 'https://tv.starting.cc';
const PUBLIC_PORT = Number(process.env.TOLLBOOTH_PUBLIC_PORT || 8090);
const WEBHOOK_PORT = Number(process.env.TOLLBOOTH_WEBHOOK_PORT || 8091);
const TESTNET = NETWORK !== 'eip155:8453';

if (!PG_URL) { console.error('[tollbooth] TOLLBOOTH_PG_URL is required'); process.exit(1); }
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) { console.error('[tollbooth] X402_PAY_TO must be an EVM address'); process.exit(1); }
if (!OWNCAST_BOT_TOKEN) log('WARNING: OWNCAST_BOT_TOKEN unset — chat replies disabled (webhook still processes)');

const pool = new pg.Pool({ connectionString: PG_URL, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
pool.on('error', (e) => log(`idle pool error: ${e.message}`));

// ── Owncast chat reply (integrations API; shows as the token's bot name) ──
async function say(text) {
  if (!OWNCAST_BOT_TOKEN) return;
  try {
    const r = await fetch(`${OWNCAST_URL}/api/integrations/chat/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OWNCAST_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: String(text).slice(0, 500) }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) { log(`chat send failed: ${e.message}`); }
}

// ── Redeem codes ──────────────────────────────────────────────────────────
// Crockford-ish alphabet (no 0/O/1/I/L) so codes survive being read off a
// screen and retyped into chat. Canonical form has no dashes; display adds
// them. Normalizing input strips anything non-alphanumeric + uppercases.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const displayCode = (c) => `${c.slice(0, 2)}-${c.slice(2, 6)}-${c.slice(6, 10)}`;
const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function mintCode(paymentRef) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = 'GT';
    for (const b of crypto.randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    try {
      await pool.query(
        `INSERT INTO stream_codes (code, credits, payment_ref) VALUES ($1, $2, $3)`,
        [code, CREDITS, paymentRef ?? null],
      );
      return code;
    } catch (e) {
      if (e.code !== '23505') throw e;   // 23505 = duplicate key; roll again
    }
  }
  throw new Error('could not mint a unique code');
}

// ── Viewer ledger helpers ─────────────────────────────────────────────────
async function viewerState(owncastId) {
  const r = await pool.query(
    `SELECT
       COALESCE((SELECT credits FROM stream_viewers WHERE owncast_id = $1), 0)                                        AS credits,
       (SELECT count(*)::int FROM stream_commands WHERE owncast_id = $1 AND status IN ('queued','running'))           AS pending,
       (SELECT max(created_at) FROM stream_commands WHERE owncast_id = $1)                                            AS last_at`,
    [owncastId],
  );
  return r.rows[0];
}

async function redeem(owncastId, displayName, rawCode) {
  const code = normalizeCode(rawCode);
  if (!/^GT[A-Z0-9]{8}$/.test(code)) return { ok: false, why: 'shape' };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `UPDATE stream_codes SET redeemed_by = $2, redeemed_at = now()
       WHERE code = $1 AND redeemed_by IS NULL RETURNING credits`,
      [code, owncastId],
    );
    if (!r.rows.length) { await c.query('ROLLBACK'); return { ok: false, why: 'unknown_or_used' }; }
    const add = r.rows[0].credits;
    const v = await c.query(
      `INSERT INTO stream_viewers (owncast_id, display_name, credits) VALUES ($1, $2, $3)
       ON CONFLICT (owncast_id) DO UPDATE
         SET credits = stream_viewers.credits + EXCLUDED.credits,
             display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING credits`,
      [owncastId, displayName, add],
    );
    await c.query('COMMIT');
    return { ok: true, added: add, balance: v.rows[0].credits };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// ── Stream-chat command router (webhook side) ─────────────────────────────
const HELP =
  `commands → !redeem YOUR-CODE · !balance · !g your command — e.g. "!g mine some iron", "!g put a creeper on the TV", ` +
  `"!g spectate somebody", "!g follow a player", "!g go to 0 70 0". Credits: ${PUBLIC_URL}`;

async function handleChat(payload) {
  if (payload?.type !== 'CHAT') return;
  const u = payload.eventData?.user;
  if (!u?.id || u.isBot) return;                             // never react to our own replies
  const raw = String(payload.eventData?.rawBody ?? payload.eventData?.body ?? '');
  const text = raw.replace(/<[^>]*>/g, '').trim();           // body can arrive rendered; strip tags
  if (!text.startsWith('!')) return;
  const name = String(u.displayName || 'viewer').slice(0, 40);

  let m;
  if (/^!(help|commands)\b/i.test(text)) {
    await say(`@${name} ${HELP}`);
  } else if ((m = text.match(/^!redeem\s+(.+)$/i))) {
    const res = await redeem(u.id, name, m[1]);
    await say(res.ok
      ? `@${name} ✅ +${res.added} credits — balance ${res.balance}. Try: !g mine some iron · !g put a creeper on the TV`
      : `@${name} that code isn't valid (or it's already been used). Codes come from ${PUBLIC_URL}`);
  } else if (/^!balance\b/i.test(text)) {
    const s = await viewerState(u.id);
    await say(`@${name} balance: ${s.credits} credit${s.credits === 1 ? '' : 's'}${s.pending ? ` (${s.pending} command${s.pending === 1 ? '' : 's'} in flight)` : ''}. Top up: ${PUBLIC_URL}`);
  } else if ((m = text.match(/^!(?:g|garvis)\b\s*(.*)$/is))) {
    const request = m[1].trim().slice(0, 400);
    if (!request) { await say(`@${name} ${HELP}`); return; }
    const s = await viewerState(u.id);
    const available = s.credits - s.pending;
    if (available <= 0) {
      await say(`@${name} you're out of command credits (balance ${s.credits}${s.pending ? `, ${s.pending} queued` : ''}) — grab ${CREDITS} for $${PRICE_USD} at ${PUBLIC_URL} 🎟️`);
      return;
    }
    if (COOLDOWN_S && s.last_at && Date.now() - new Date(s.last_at).getTime() < COOLDOWN_S * 1000) {
      await say(`@${name} easy there — one command every ${COOLDOWN_S}s. Try again in a moment.`);
      return;
    }
    await pool.query(
      `INSERT INTO stream_commands (owncast_id, display_name, request) VALUES ($1, $2, $3)`,
      [u.id, name, request],
    );
    await say(`@${name} 🎟️ got it — Garvis is on it, watch the world. (1 credit if it works; ${available - 1} left after this)`);
    log(`queued for ${name}: ${request.slice(0, 80)}`);
  }
}

// ── Public app: landing + x402-gated /buy ─────────────────────────────────
const app = express();
app.disable('x-powered-by');

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({ appName: 'Garvis TV Tollbooth', testnet: TESTNET })
  .build();

app.use(paymentMiddleware(
  {
    'GET /tollbooth/buy': {
      accepts: { scheme: 'exact', price: `$${PRICE_USD}`, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 },
      description: `${CREDITS} Garvis commands on the live stream at ${STREAM_URL}`,
      mimeType: 'application/json',
    },
  },
  resourceServer,
  { appName: 'Garvis TV Tollbooth', testnet: TESTNET },
  paywall,
));

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
  body{background:#0d1117;color:#e6edf3;font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px}
  a{color:#58a6ff} h1{font-size:1.6em} code,.code{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:2px 8px}
  .big{font-size:2em;letter-spacing:2px;display:inline-block;padding:12px 20px;margin:12px 0}
  .btn{display:inline-block;background:#238636;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:12px 0}
  .warn{color:#d29922} .dim{color:#8b949e;font-size:.9em}
</style></head><body>${body}</body></html>`;

const landing = () => page('Garvis TV Tollbooth', `
  <h1>🎟️ Command Garvis</h1>
  <p>Garvis is the AI playing Minecraft live on <a href="${STREAM_URL}">Garvis TV</a>. For
  <b>$${PRICE_USD}</b> you get <b>${CREDITS} commands</b>: send him mining or farming, make him
  follow a player, put anything on the in-game TV, or lock the stream camera to somebody's POV.</p>
  <ol>
    <li>Buy a code below — pay with USDC straight from your wallet (<a href="https://www.x402.org">x402</a>, no signup).</li>
    <li>Type <code>!redeem YOUR-CODE</code> in the <a href="${STREAM_URL}">stream chat</a>.</li>
    <li>Command away: <code>!g mine some iron</code> · <code>!g put a creeper on the TV</code> · <code>!g spectate a player</code></li>
  </ol>
  <a class="btn" href="${PUBLIC_URL}/buy">Buy ${CREDITS} commands — $${PRICE_USD}</a>
  <p class="dim">A command only costs a credit when it works. Agents welcome: <code>GET ${PUBLIC_URL}/buy</code> speaks HTTP 402.</p>
  ${TESTNET ? '<p class="warn">⚠️ Currently on Base Sepolia TESTNET — payments use test USDC, not real money.</p>' : ''}
`);

app.get(['/tollbooth', '/tollbooth/'], (_req, res) => { res.type('html').send(landing()); });

// Only reached once the x402 middleware has verified payment.
app.get('/tollbooth/buy', async (req, res) => {
  try {
    const ref = (req.get('payment-signature') || req.get('x-payment') || '').slice(0, 120) || null;
    const code = await mintCode(ref);
    const pretty = displayCode(code);
    log(`code minted (${CREDITS} credits)${ref ? ' [ref captured]' : ''}`);
    if ((req.get('accept') || '').includes('text/html')) {
      res.type('html').send(page('Your Garvis code', `
        <h1>✅ Paid — here's your code</h1>
        <div class="code big">${pretty}</div>
        <p>Now in the <a href="${STREAM_URL}">stream chat</a>, type:</p>
        <p><code>!redeem ${pretty}</code></p>
        <p>then spend your ${CREDITS} commands: <code>!g mine some iron</code> · <code>!g put a creeper on the TV</code> · <code>!g spectate a player</code> · <code>!g follow a player</code></p>
        <p class="warn">Save this code — it's shown once and works once.</p>`));
    } else {
      res.json({ code: pretty, credits: CREDITS, redeem: `!redeem ${pretty}`, chat: STREAM_URL });
    }
  } catch (e) {
    log(`buy handler failed: ${e.message}`);
    res.status(500).json({ error: 'could not mint a code — payment NOT lost, contact the admin' });
  }
});

app.get('/tollbooth/health', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT
      (SELECT count(*)::int FROM stream_commands WHERE status IN ('queued','running')) AS queued,
      (SELECT count(*)::int FROM stream_viewers) AS viewers,
      (SELECT count(*)::int FROM stream_codes WHERE redeemed_by IS NULL) AS unredeemed`);
    res.json({ ok: true, network: NETWORK, ...r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Webhook app (compose-internal) ────────────────────────────────────────
const hooks = express();
hooks.disable('x-powered-by');
hooks.post('/owncast-webhook', express.json({ limit: '64kb' }), (req, res) => {
  res.status(200).end();                                       // ack fast; Owncast doesn't retry anyway
  handleChat(req.body).catch((e) => log(`webhook handling failed: ${e.message}`));
});

// ── Boot ──────────────────────────────────────────────────────────────────
await initDb(pool, log);
app.listen(PUBLIC_PORT, () => log(`public app on :${PUBLIC_PORT} (${PUBLIC_URL}) — ${TESTNET ? 'TESTNET ' + NETWORK : 'MAINNET'} → ${PAY_TO.slice(0, 10)}…`));
hooks.listen(WEBHOOK_PORT, () => log(`owncast webhook listener on :${WEBHOOK_PORT} (compose-internal)`));
