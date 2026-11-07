// Checks whether a word already has a token trading, using DexScreener's public search API.
// Returns ready-made links for GMGN, Axiom, DexScreener and pump.fun.

const GMGN_CHAIN = { solana: 'sol', bsc: 'bsc', base: 'base', ethereum: 'eth', tron: 'tron' };

const cache = new Map(); // word -> { at, result }
const inflight = new Map();
const CACHE_MS = 45_000;

function links(chainId, tokenAddress, pairAddress, dexUrl) {
  const out = { dexscreener: dexUrl };
  const g = GMGN_CHAIN[chainId];
  if (g) out.gmgn = `https://gmgn.ai/${g}/token/${tokenAddress}`;
  if (chainId === 'solana') {
    out.axiom = `https://axiom.trade/meme/${pairAddress}`;
    if (/pump$/i.test(tokenAddress)) out.pumpfun = `https://pump.fun/coin/${tokenAddress}`;
  }
  return out;
}

function summarize(word, pairs, chains) {
  const w = word.toLowerCase().replace(/\s+/g, '');
  const byToken = new Map();
  for (const p of pairs || []) {
    if (chains.length && !chains.includes(p.chainId)) continue;
    const sym = (p.baseToken?.symbol || '').toLowerCase().replace(/\s+/g, '');
    const name = (p.baseToken?.name || '').toLowerCase().replace(/\s+/g, '');
    const exact = sym === w || name === w;
    const loose = sym.includes(w) || name.includes(w);
    if (!loose) continue;
    const key = p.chainId + ':' + p.baseToken.address;
    const prev = byToken.get(key);
    const liq = p.liquidity?.usd || 0;
    if (prev && (prev.liquidityUsd || 0) >= liq) continue;
    byToken.set(key, {
      chain: p.chainId,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      address: p.baseToken.address,
      pairAddress: p.pairAddress,
      dex: p.dexId,
      exact,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: liq,
      volume5m: p.volume?.m5 ?? null,
      volume1h: p.volume?.h1 ?? null,
      volume24: p.volume?.h24 ?? null,
      labels: p.labels || [],
      change5m: p.priceChange?.m5 ?? null,
      createdAt: p.pairCreatedAt || null,
      links: links(p.chainId, p.baseToken.address, p.pairAddress, p.url),
    });
  }
  const tokens = [...byToken.values()].sort((a, b) =>
    (b.exact - a.exact) || ((b.marketCap || 0) - (a.marketCap || 0)));
  const now = Date.now();
  const newest = tokens.reduce((m, t) => (t.createdAt && t.createdAt > m ? t.createdAt : m), 0);
  const ageMin = newest ? (now - newest) / 60000 : null;
  let status = 'none';
  if (tokens.length) status = ageMin !== null && ageMin <= 15 ? 'fresh' : 'exists';
  return {
    word,
    status, // none | fresh | exists
    count: tokens.length,
    newestAgeMin: ageMin === null ? null : Math.round(ageMin * 10) / 10,
    top: tokens.slice(0, 5),
    checkedAt: now,
  };
}

async function lookup(word, { chains = ['solana'], demo = false } = {}) {
  const key = word.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let pairs;
    if (demo) {
      pairs = demoPairs(word);
    } else {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(word)}`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`DexScreener ${res.status}`);
      pairs = (await res.json()).pairs || [];
    }
    const result = summarize(word, pairs, chains);
    cache.set(key, { at: Date.now(), result });
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// Deterministic fake market data so demo mode shows all three states.
function demoPairs(word) {
  const h = [...word].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const kind = h % 3;
  if (kind === 0) return [];
  const sym = word.replace(/\s+/g, '').toUpperCase().slice(0, 10);
  const mk = (i, ageMin, mcap) => ({
    chainId: 'solana', dexId: i ? 'raydium' : 'pumpfun',
    url: `https://dexscreener.com/solana/demo${h}${i}`,
    pairAddress: `Demo${h}${i}Pair`,
    baseToken: { address: `Demo${h}${i}xxxxxxxxxxxxxpump`, name: word, symbol: sym },
    marketCap: mcap, liquidity: { usd: mcap / 8 }, volume: { m5: mcap / 20, h1: mcap / 4 },
    priceChange: { m5: (h % 90) - 20 }, pairCreatedAt: Date.now() - ageMin * 60000,
  });
  return kind === 1
    ? [mk(0, 3 + (h % 9), 18000 + (h % 50000)), mk(1, 40, 6000)]
    : [mk(0, 600 + (h % 3000), 900000 + (h % 4000000))];
}

// Raw pairs for a search term, cached briefly. Used by the play tracker, which polls often.
const rawCache = new Map();
async function searchPairs(term, maxAgeMs = 12000) {
  const key = term.toLowerCase();
  const hit = rawCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.pairs;
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = (await res.json()).pairs || [];
  rawCache.set(key, { at: Date.now(), pairs });
  if (rawCache.size > 500) rawCache.delete(rawCache.keys().next().value);
  return pairs;
}

// Symbol, name and market cap for a token mint (used by the KOL tracker).
const tokenCache = new Map();
async function tokenInfo(mint) {
  const hit = tokenCache.get(mint);
  if (hit && Date.now() - hit.at < 30000) return hit.info;
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = await res.json();
  const p = (Array.isArray(pairs) ? pairs : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const info = p ? { symbol: p.baseToken?.symbol, name: p.baseToken?.name, marketCap: p.marketCap ?? p.fdv ?? null, pairAddress: p.pairAddress, dexId: p.dexId } : null;
  tokenCache.set(mint, { at: Date.now(), info });
  if (tokenCache.size > 2000) tokenCache.delete(tokenCache.keys().next().value);
  return info;
}

module.exports = { lookup, searchPairs, tokenInfo };
