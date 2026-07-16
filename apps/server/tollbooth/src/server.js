// Garvis TV tollbooth — pay to command Garvis, over x402.
//
// Two listeners, one ledger (the mc-postgres sidecar):
//
//   PUBLIC (:8090, host-published 127.0.0.1-only → cloudflared path route
//   https://tv.starting.cc/tollbooth):
//     GET /tollbooth        — landing page: what it is, price, how to redeem
//     GET /tollbooth/pay    — Base Pay checkout (the human/mobile front door):
//                             a keyless @base-org/account button; the buyer's
//                             own browser pays USDC to X402_PAY_TO, then POSTs
//                             the payment id to /pay/verify below.
//     POST /tollbooth/pay/verify — server-side getPaymentStatus (keyless): on a
//                             'completed' pay to the right address for the right
//                             amount, mints a one-time redeem code. Never trusts
//                             the page; dedupes the id.
//     GET /tollbooth/buy    — x402-GATED (HTTP 402 → pay USDC → retry): the
//                             AGENT rail — a settled payment mints the same kind
//                             of code. Agents get machine-readable 402 terms.
//                             (The @x402/paywall browser UI never completes on
//                             mobile — that's why /pay exists.) NO account, NO keys.
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
// X402_NETWORK=eip155:8453 and use a mainnet facilitator: either keyless via
// X402_FACILITATOR_URL (PayAI — what production uses) or Coinbase's via CDP
// API keys, and make X402_PAY_TO a wallet the owner controls.
// This process never holds keys — payTo is just the receiving address.
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createFacilitatorConfig } from '@coinbase/x402';
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
const DEFAULT_FACILITATOR = 'https://x402.org/facilitator';           // TESTNET-ONLY
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR;
const PRICE_USD = String(process.env.TOLLBOOTH_PRICE_USD || '1.00'); // dollars, no "$"
const CREDITS = Math.max(1, Number(process.env.TOLLBOOTH_CREDITS || 10));
const COOLDOWN_S = Math.max(0, Number(process.env.TOLLBOOTH_COOLDOWN_S || 20));
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://tv.starting.cc/tollbooth';
const STREAM_URL = process.env.STREAM_URL || 'https://tv.starting.cc';
const PUBLIC_PORT = Number(process.env.TOLLBOOTH_PUBLIC_PORT || 8090);
const WEBHOOK_PORT = Number(process.env.TOLLBOOTH_WEBHOOK_PORT || 8091);
const TESTNET = NETWORK !== 'eip155:8453';

// Base Pay — the human/mobile front door (keyless USDC checkout via
// @base-org/account). x402 stays the agent rail; this is what a viewer on a
// phone actually uses, because the @x402/paywall injected-wallet handshake
// never completes on mobile. The buyer's browser loads THIS version from
// esm.sh; the server verifies with the installed copy — keep both in sync with
// package.json. It shares X402_NETWORK (testnet flag) and X402_PAY_TO.
const BASE_ACCOUNT_VERSION = '2.5.7';

// Facilitator: with CDP API keys present, use Coinbase's hosted facilitator
// (auth'd verify/settle; 1,000 free tx/month, then $0.001; needs a
// business-verified CDP account). Without keys, X402_FACILITATOR_URL is used
// as-is — but the DEFAULT one is TESTNET-ONLY, so mainnet demands either CDP
// keys or an explicitly chosen mainnet facilitator (keyless options exist,
// e.g. https://facilitator.payai.network) rather than booting a
// silently-broken paywall. Facilitators never custody funds — settlement pays
// PAY_TO directly — so the trust surface is fake-verify/downtime, not theft.
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || '';
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || '';
const useCdp = Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);

if (!PG_URL) { console.error('[tollbooth] TOLLBOOTH_PG_URL is required'); process.exit(1); }
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) { console.error('[tollbooth] X402_PAY_TO must be an EVM address'); process.exit(1); }
if (!TESTNET && !useCdp && FACILITATOR_URL === DEFAULT_FACILITATOR) { console.error('[tollbooth] mainnet needs a mainnet facilitator — set CDP_API_KEY_ID + CDP_API_KEY_SECRET, or point X402_FACILITATOR_URL at one that settles eip155:8453 (e.g. https://facilitator.payai.network)'); process.exit(1); }
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

// ── Base Pay verification ──────────────────────────────────────────────────
// getPaymentStatus is keyless (reads Base on-chain state) and documented as a
// backend call. Loaded lazily so a bad import can never take down the x402 rail
// or the webhook — only Base Pay checkout degrades.
let _basePayStatus = null;
function basePayStatus(args) {
  if (!_basePayStatus) _basePayStatus = import('@base-org/account').then((m) => m.getPaymentStatus);
  return _basePayStatus.then((fn) => fn(args));
}

// Mint (or re-return) the ONE code owed for a Base Pay payment id. Idempotent:
// a page reload / double-submit of the same id yields the same code, never a
// second mint. An xact advisory lock keyed on the id serializes concurrent
// verifies of the same payment without any global unique constraint (comped and
// x402 refs share the column and mustn't be forced unique).
async function mintForBasePay(id) {
  const ref = `basepay:${id}`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ref]);
    const seen = await c.query('SELECT code FROM stream_codes WHERE payment_ref = $1 LIMIT 1', [ref]);
    if (seen.rows.length) { await c.query('COMMIT'); return { code: seen.rows[0].code, fresh: false }; }
    let code = null;
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      let cand = 'GT';
      for (const b of crypto.randomBytes(8)) cand += CODE_ALPHABET[b % CODE_ALPHABET.length];
      try {
        await c.query('INSERT INTO stream_codes (code, credits, payment_ref) VALUES ($1, $2, $3)', [cand, CREDITS, ref]);
        code = cand;
      } catch (e) { if (e.code !== '23505') throw e; }        // dup code — roll again
    }
    if (!code) throw new Error('could not mint a unique code');
    await c.query('COMMIT');
    return { code, fresh: true };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
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

const facilitatorClient = new HTTPFacilitatorClient(
  useCdp ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET) : { url: FACILITATOR_URL },
);

// Ops logging: the middleware turns a facilitator failure into a bare 502 that
// the buyer only sees as a "network error" — so log the real verify/settle
// outcome here. settle success = the money event (payer + on-chain tx).
for (const m of ['verify', 'settle']) {
  const orig = facilitatorClient[m]?.bind(facilitatorClient);
  if (!orig) continue;
  facilitatorClient[m] = async (...a) => {
    try {
      const r = await orig(...a);
      if (m === 'settle') log(`settle ${r?.success ? 'OK' : 'FAILED'} payer=${r?.payer || '?'} tx=${r?.transaction || '-'} net=${r?.network || '-'}`);
      else if (r && r.isValid === false) log(`verify rejected: ${r?.invalidReason || 'unknown'}`);
      return r;
    } catch (e) {
      log(`facilitator.${m} threw: ${e?.message}`);
      throw e;
    }
  };
}

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
    <li>Buy a code below — pay <b>$${PRICE_USD} in USDC with Base Pay</b>, right from your phone. No signup, no app.</li>
    <li>Type <code>!redeem YOUR-CODE</code> in the <a href="${STREAM_URL}">stream chat</a>.</li>
    <li>Command away: <code>!g mine some iron</code> · <code>!g put a creeper on the TV</code> · <code>!g spectate a player</code></li>
  </ol>
  <a class="btn" href="${PUBLIC_URL}/pay">Buy ${CREDITS} commands — $${PRICE_USD}</a>
  <p class="dim">A command only costs a credit when it works. Agents welcome: <code>GET ${PUBLIC_URL}/buy</code> speaks HTTP 402.</p>
  ${TESTNET ? '<p class="warn">⚠️ Currently on Base Sepolia TESTNET — payments use test USDC, not real money.</p>' : ''}
`);

app.get(['/tollbooth', '/tollbooth/'], (_req, res) => { res.type('html').send(landing()); });

// Base Pay checkout — the mobile front door. Loads the SDK straight into the
// buyer's browser from esm.sh (their phone fetches it, not this container), pops
// the Base Account smart-wallet popup, then hands the payment id to us to
// verify + mint. All the money-side validation happens server-side in
// /pay/verify — the page is untrusted glue.
const payPage = () => page('Buy Garvis commands', `
  <h1>🎟️ Buy ${CREDITS} commands — $${PRICE_USD}</h1>
  <p>Pay <b>$${PRICE_USD} in USDC</b> with <b>Base Pay</b> — sign in with a passkey or email, no wallet app to install. You'll get a one-time code to <code>!redeem</code> in the <a href="${STREAM_URL}">stream chat</a>.</p>
  ${TESTNET ? '<p class="warn">⚠️ Base Sepolia TESTNET — this charges test USDC, not real money.</p>' : ''}
  <p><button id="buy" class="btn" style="border:0;cursor:pointer;font:inherit;font-weight:600">Pay $${PRICE_USD} with Base</button></p>
  <p id="status" class="dim" role="status" aria-live="polite"></p>
  <div id="result" style="display:none">
    <p>✅ Paid — here's your code:</p>
    <div class="code big" id="code"></div>
    <p>In the <a href="${STREAM_URL}">stream chat</a>, type:</p>
    <p><code id="redeem"></code></p>
    <p>then spend your ${CREDITS} commands: <code>!g mine some iron</code> · <code>!g put a creeper on the TV</code> · <code>!g spectate a player</code></p>
    <p class="warn">Save this code — it's shown once and works once.</p>
  </div>
  <p class="dim">Prefer an agent or CLI? <code>GET ${PUBLIC_URL}/buy</code> speaks HTTP 402 (x402).</p>
  <script type="module">
    import { pay } from 'https://esm.sh/@base-org/account@${BASE_ACCOUNT_VERSION}';
    const PAY_TO=${JSON.stringify(PAY_TO)}, AMOUNT=${JSON.stringify(PRICE_USD)}, TESTNET=${TESTNET}, VERIFY=${JSON.stringify(PUBLIC_URL + '/pay/verify')};
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=document.getElementById('buy'), statusEl=document.getElementById('status'), resultEl=document.getElementById('result');
    async function confirmPayment(id){
      for(let i=0;i<20;i++){
        const r=await fetch(VERIFY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
        let d={}; try{ d=await r.json(); }catch(_){}
        // 202 = still settling — MUST be checked before r.ok (202 is a 2xx, so
        // r.ok is true for it too). Only a 200 carries the minted code.
        if(r.status===202){ statusEl.textContent='Confirming on-chain… ('+(i+1)+')'; await sleep(1500); continue; }
        if(r.status===200&&d&&d.code) return d;
        throw new Error((d&&d.error)||('could not verify ('+r.status+')'));
      }
      throw new Error('still settling after 30s — your payment is safe on-chain; reload and it will finish, or contact the admin');
    }
    btn.addEventListener('click', async ()=>{
      btn.disabled=true; statusEl.textContent='Opening Base Pay…';
      try{
        const res=await pay({amount:AMOUNT,to:PAY_TO,testnet:TESTNET});
        if(res&&res.error) throw new Error(res.error);
        const id=res&&res.id; if(!id) throw new Error('payment was not completed');
        statusEl.textContent='Payment sent — confirming…';
        const d=await confirmPayment(id);
        statusEl.textContent='';
        document.getElementById('code').textContent=d.code;
        document.getElementById('redeem').textContent=d.redeem||('!redeem '+d.code);
        resultEl.style.display='block'; btn.style.display='none';
      }catch(e){
        statusEl.textContent='⚠️ '+((e&&e.message)||'payment failed')+' — you can try again.';
        btn.disabled=false;
      }
    });
  </script>
`);

app.get('/tollbooth/pay', (_req, res) => { res.type('html').send(payPage()); });

// Verify a Base Pay payment id on-chain (keyless getPaymentStatus) and mint the
// code. NEVER trusts the page: revalidates recipient + amount here, dedupes the
// id (idempotent), and only 'completed' pays out. 202 = still settling (client
// polls); 402 = a real rejection.
app.post('/tollbooth/pay/verify', express.json({ limit: '8kb' }), async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,256}$/.test(id)) return res.status(400).json({ error: 'bad payment id' });
  try {
    const st = await basePayStatus({ id, testnet: TESTNET });
    const status = String(st?.status || '').toLowerCase();
    if (status !== 'completed') {
      const terminal = ['failed', 'error', 'not_found', 'notfound', 'canceled', 'cancelled', 'expired', 'reverted'].includes(status);
      log(`basepay ${terminal ? 'rejected' : 'pending'}: id=${id.slice(0, 80)} status=${status || 'unknown'}`);
      return res.status(terminal ? 402 : 202).json(terminal ? { error: `payment ${status}` } : { pending: true, status: status || 'unknown' });
    }
    const recipient = String(st?.recipient || '').toLowerCase();
    const amount = Number(st?.amount);
    if (recipient !== PAY_TO.toLowerCase()) { log(`basepay rejected: recipient ${recipient} != payTo`); return res.status(402).json({ error: 'payment went to the wrong address' }); }
    if (!(amount + 1e-6 >= Number(PRICE_USD))) { log(`basepay rejected: amount ${amount} < ${PRICE_USD}`); return res.status(402).json({ error: 'payment amount too low' }); }
    const { code, fresh } = await mintForBasePay(id);
    const pretty = displayCode(code);
    log(`basepay code ${fresh ? 'minted' : 're-served'} (${CREDITS} credits) payer=${String(st?.sender || '?').slice(0, 12)} amt=${amount}`);
    res.json({ code: pretty, credits: CREDITS, redeem: `!redeem ${pretty}`, chat: STREAM_URL });
  } catch (e) {
    log(`basepay verify failed: ${e.message}`);
    res.status(500).json({ error: 'could not verify payment — if you were charged, your funds are safe on-chain; contact the admin' });
  }
});

// HEAD /buy: prefetch/preview probes — never a payment. Answer 402 and stop,
// so Express doesn't fall through to the GET mint handler.
app.head('/tollbooth/buy', (_req, res) => res.status(402).end());

// Belt-and-suspenders: the x402 middleware only guards the GET verb, but
// Express routes HEAD (and any verb) to this GET handler — a HEAD /buy (iOS
// Safari prefetch, link previews, crawlers) sails past the paywall as
// "no-payment-required" and would mint a free code. The middleware only ever
// lets a request through here AFTER verifying a payment, and a verified
// payment always carries the payment header — so if there's no payment header,
// this was NOT verified: refuse to mint. (A bogus header can't reach here
// either: the middleware fails its verification and 402s first.)
app.get('/tollbooth/buy', async (req, res) => {
  try {
    const ref = (req.get('payment-signature') || req.get('x-payment') || '').slice(0, 120) || null;
    if (!ref) { log(`refused mint: no payment header on ${req.method} ${req.originalUrl}`); return res.status(402).json({ error: 'payment required' }); }
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

// Log any error the paywall middleware surfaces (502 facilitator boundary, 500
// handler) — otherwise a buyer's "network error" leaves no server-side trace.
app.use((err, _req, res, _next) => {
  log(`express error: ${err?.message}`);
  if (!res.headersSent) res.status(500).json({ error: 'internal' });
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
app.listen(PUBLIC_PORT, () => log(`public app on :${PUBLIC_PORT} (${PUBLIC_URL}) — ${TESTNET ? 'TESTNET ' + NETWORK : 'MAINNET'} → ${PAY_TO.slice(0, 10)}… via ${useCdp ? 'CDP facilitator' : FACILITATOR_URL}`));
hooks.listen(WEBHOOK_PORT, () => log(`owncast webhook listener on :${WEBHOOK_PORT} (compose-internal)`));
