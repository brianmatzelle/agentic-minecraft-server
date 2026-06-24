// Modrinth resource embeds.
//
// Garvis's reply text comes from a free-form LLM, so we never get a structured "mod"
// object to hand Discord — instead we POST-PROCESS the text: find any Modrinth project
// links it mentions and render each as a rich preview card "off rip", rather than
// leaning on Discord's best-effort auto-unfurl (which needs the bot to hold the Embed
// Links permission AND a successful server-side OG fetch, and often just doesn't fire).
//
// Doing it here means it works UNIFORMLY across every send path — @mention Q&A,
// /installhelp, /debug, /requestmod — because they all funnel through sendChunked /
// editReplyChunked. Anywhere a Modrinth link appears in a reply, a card appears.
import { EmbedBuilder } from 'discord.js';

const MODRINTH_GREEN = 0x1bd96a;            // brand green; fallback when a project has no icon color
const API = 'https://api.modrinth.com/v2/project';
// Modrinth's API etiquette asks bots to identify themselves with contact info.
const USER_AGENT = 'brianmatzelle/garvis-bot (+https://github.com/brianmatzelle; Minecraft server Discord bot)';
const MAX_EMBEDS = 5;                        // Discord allows 10/msg; keep replies uncluttered
const FETCH_TIMEOUT_MS = 4000;              // never let a slow metadata fetch stall a reply

// All of these web path segments resolve to the same /project/<slug> API endpoint, so we
// accept any of them in a link but always re-derive the real path from project_type.
const PROJECT_PATH = 'mod|modpack|plugin|datapack|resourcepack|shader|project';
const SLUG_RE = new RegExp(
  `https?://modrinth\\.com/(?:${PROJECT_PATH})/([A-Za-z0-9][A-Za-z0-9_-]{1,63})`,
  'gi',
);

// slug -> resolved card data. Mod metadata is near-static, so a process-lifetime cache is
// plenty and spares the API on repeated links. Only SUCCESSES are cached — a transient
// failure shouldn't poison the slug for the bot's whole lifetime.
const cache = new Map();

// Pull unique Modrinth project slugs out of free-form reply text, in first-seen order.
export function extractModrinthSlugs(text) {
  const slugs = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(SLUG_RE)) {
    const slug = m[1];
    const key = slug.toLowerCase();
    if (!seen.has(key)) { seen.add(key); slugs.push(slug); }
  }
  return slugs;
}

function formatDownloads(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

async function fetchProject(slug) {
  const key = slug.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let data = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${API}/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const p = await res.json();
      data = {
        title: p.title || slug,
        slug: p.slug || slug,
        type: p.project_type || 'mod',
        description: typeof p.description === 'string' ? p.description : '',
        icon: p.icon_url || null,
        color: Number.isInteger(p.color) ? p.color : MODRINTH_GREEN,
        downloads: typeof p.downloads === 'number' ? p.downloads : null,
        clientSide: p.client_side || 'unknown',
        serverSide: p.server_side || 'unknown',
      };
    }
  } catch { /* timeout / network / non-OK — leave data null, render nothing for this slug */ }
  if (data) cache.set(key, data);
  return data;
}

function toEmbed(d) {
  const e = new EmbedBuilder()
    .setColor(d.color)
    .setTitle(d.title)
    .setURL(`https://modrinth.com/${d.type}/${d.slug}`)
    .setAuthor({ name: 'Modrinth', url: 'https://modrinth.com' });
  if (d.description) e.setDescription(d.description.slice(0, 300));
  if (d.icon) e.setThumbnail(d.icon);
  // server/client side is the question players actually have ("do I have to install it?").
  const footer = [];
  if (d.downloads != null) footer.push(`⬇ ${formatDownloads(d.downloads)}`);
  footer.push(`server: ${d.serverSide}`, `client: ${d.clientSide}`);
  return e.setFooter({ text: footer.join(' • ') });
}

// Build rich embeds for every Modrinth link in `text` (capped, deduped). Returns [] when
// there are none, when the runtime lacks global fetch, or when lookups fail — callers
// attach the result unconditionally, so an empty array is a no-op.
export async function buildModrinthEmbeds(text) {
  if (typeof fetch !== 'function') return [];
  const slugs = extractModrinthSlugs(text).slice(0, MAX_EMBEDS);
  if (slugs.length === 0) return [];
  const datas = await Promise.all(slugs.map(fetchProject));
  return datas.filter(Boolean).map(toEmbed);
}
