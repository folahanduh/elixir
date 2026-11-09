// Coin pictures that actually load. The page asks Elixir for /img/coin/<mint>; Elixir tries every source it
// knows until one returns a real image, saves it in data/img, and serves it from disk after that.
// Sources, in order: the link we were given, the same IPFS file on faster gateways, pump.fun's API,
// DexScreener, GeckoTerminal. Only public https hosts are fetched (no local / private addresses).

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'img');
const MAX = 3 * 1024 * 1024;
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
const misses = new Map();   // mint -> time of the last failed lookup (retry after 10 min)
const inflight = new Map(); // mint -> promise
const isMint = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));

/** Public https URLs only: never the user's own network. */
function safeUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return null;
    return url.toString();
  } catch { return null; }
}

/** The same file on other IPFS gateways (pump.fun pictures live on IPFS; one slow gateway breaks them). */
function variants(u) {
  if (!u) return [];
  const s = String(u).trim();
  const cid = s.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i)?.[1] || s.match(/\/ipfs\/([^?#]+)/i)?.[1] || s.match(/^https:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+\/?(.*)$/i)?.slice(1).filter(Boolean).join('/');
  const out = [];
  if (/^https:/i.test(s)) out.push(s);
  if (cid) for (const g of GATEWAYS) out.push(g + cid);
  return [...new Set(out)];
}

async function tryFetch(u) {
  const url = safeUrl(u);
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/.test(type)) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX) return null;
    return { buf, type };
  } catch { return null; }
}

/** Picture URLs other services know for this coin. */
async function lookups(mint, getInfo) {
  const urls = [];
  try { const i = await getInfo?.(mint); if (i?.image) urls.push(i.image); } catch {}
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (r.ok) { const j = await r.json(); if (j?.image_uri) urls.push(j.image_uri); }
  } catch {}
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(4000) });
    if (r.ok) { const j = await r.json(); const u = j?.data?.attributes?.image_url; if (u && u !== 'missing.png') urls.push(u); }
  } catch {}
  return urls;
}

async function resolve(mint, hint, getInfo) {
  for (const u of variants(hint)) { const got = await tryFetch(u); if (got) return got; }
  for (const src of await lookups(mint, getInfo)) for (const u of variants(src)) { const got = await tryFetch(u); if (got) return got; }
  return null;
}

/** {buf, type} for a coin's picture, or null. Cached on disk. */
async function coinImage(mint, hint, getInfo) {
  if (!isMint(mint)) return null;
  const file = path.join(DIR, mint);
  try { return { buf: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') }; } catch {}
  if (Date.now() - (misses.get(mint) || 0) < 10 * 60000) return null;
  if (inflight.has(mint)) return inflight.get(mint);
  const p = resolve(mint, hint, getInfo).then(got => {
    if (got) {
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, got.buf); fs.writeFileSync(file + '.type', got.type); } catch {}
    } else { misses.set(mint, Date.now()); if (misses.size > 5000) misses.clear(); }
    return got;
  }).finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}

module.exports = { coinImage, variants, safeUrl };
