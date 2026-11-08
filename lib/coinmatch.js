// "They said dog in vest": find coins named after what was said.
// From each line, build short phrases out of the meaningful words ("dog in vest" → "dog vest"),
// search DexScreener and pump.fun for Solana coins whose name/ticker contains every word, and return
// the best few with image, ticker, market cap, age and trading links. Works without Claude.

const dex = require('./dex');
const limit = require('./limit');
const { STOP, CT_NOISE, PLATFORMS } = require('./extract');

// Little words that can sit inside a coin phrase ("dog IN vest", "cat WITH hat") but aren't part of the name.
const LINK = new Set(['in', 'with', 'on', 'the', 'a', 'an', 'of', 'and', 'wearing', 'named', 'called', 'my', 'his', 'her', 'their', 'little', 'big']);
// Spoken filler that is never a coin name.
const FILLER = new Set('makes making swear buying bought selling running runs ran crazy insane sending pumping dumping printing cooking cooked holding going went coming came saw seeing watching watch trying tried happened happening yeah yes yo bro dude like just really literally gonna wanna gotta okay ok lol lmao oh uh um hmm well right so very actually basically guys chat know mean think thing things stuff something someone people time way lot what who why how when where there here this that these those then than look looks looking going go got get getting said say says saying tell talking talk see seen want need make made good bad new old fuck fucking shit holy damn wait hold low key lowkey'.split(' '));

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stem = w => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Short phrases worth looking up from one spoken line: two- and three-word combinations of real words. */
function phrasesFrom(text) {
  const toks = String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const isContent = w => w.length >= 3 && !STOP.has(w) && !FILLER.has(w) && !LINK.has(w) && !CT_NOISE.has(w) && !PLATFORMS.has(w) && !/^\d+$/.test(w);
  const out = new Set();
  for (let i = 0; i < toks.length; i++) {
    if (!isContent(toks[i])) continue;
    const words = [toks[i]];
    let gap = 0;
    for (let j = i + 1; j < toks.length && words.length < 3; j++) {
      if (isContent(toks[j])) { words.push(toks[j]); gap = 0; if (words.length >= 2) out.add(words.join(' ')); }
      else if (LINK.has(toks[j]) && ++gap <= 2) continue;
      else break;
    }
  }
  return [...out].slice(0, 4);
}

const cache = new Map(); // phrase -> {at, coins}

/** pump.fun's own search: brand-new coins before DexScreener lists them. Best effort. */
async function pumpSearch(q) {
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins?offset=0&limit=20&sort=market_cap&order=DESC&includeNsfw=false&searchTerm=${encodeURIComponent(q)}`,
      { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (Array.isArray(j) ? j : j.coins || []).map(c => ({
      mint: c.mint, symbol: c.symbol, name: c.name, image: c.image_uri || null,
      marketCap: c.usd_market_cap ?? null, createdAt: c.created_timestamp || null, pair: c.bonding_curve || null, pad: 'Pump', source: 'pump.fun',
    }));
  } catch { return []; }
}

async function dexSearch(q) {
  try {
    const pairs = await limit.dex(() => dex.searchPairs(q, 60000));
    return pairs.filter(p => p.chainId === 'solana').map(p => ({
      mint: p.baseToken?.address, symbol: p.baseToken?.symbol, name: p.baseToken?.name, image: p.info?.imageUrl || null,
      marketCap: p.marketCap ?? p.fdv ?? null, createdAt: p.pairCreatedAt || null, pair: p.pairAddress,
      pad: /pump/i.test(p.dexId) || /pump$/.test(p.baseToken?.address || '') ? 'Pump' : /meteora|dbc/i.test(p.dexId) ? 'Meteora' : /raydium/i.test(p.dexId) ? 'Raydium' : p.dexId,
      volume: p.volume?.h24 ?? null, source: 'dexscreener',
    }));
  } catch { return []; }
}

/** Coins whose name or ticker contains every word of the phrase, biggest first. */
async function findCoins(phrase) {
  const key = phrase.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.coins;
  const words = key.split(' ').map(stem);
  const [a, b] = await Promise.all([dexSearch(phrase), pumpSearch(phrase)]);
  const byMint = new Map();
  for (const c of [...a, ...b]) {
    if (!c.mint) continue;
    const hay = squash(c.name) + ' ' + squash(c.symbol);
    if (!words.every(w => hay.includes(w))) continue; // must actually be named after what was said
    const prev = byMint.get(c.mint);
    byMint.set(c.mint, prev ? { ...c, ...prev, image: prev.image || c.image, marketCap: Math.max(prev.marketCap || 0, c.marketCap || 0) || null } : c);
  }
  const coins = [...byMint.values()].sort((x, y) => (y.marketCap || 0) - (x.marketCap || 0)).slice(0, 3).map(c => ({
    ...c,
    ageMin: c.createdAt ? Math.round((Date.now() - c.createdAt) / 60000) : null,
    links: {
      axiom: c.pair ? `https://axiom.trade/meme/${c.pair}` : `https://axiom.trade/meme/${c.mint}`,
      gmgn: `https://gmgn.ai/sol/token/${c.mint}`,
      dexscreener: `https://dexscreener.com/solana/${c.mint}`,
    },
  }));
  cache.set(key, { at: Date.now(), coins });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return coins;
}

/** Everything for one line: [{phrase, coins:[...]}] for phrases that have coins. */
async function coinsForLine(text) {
  const out = [];
  for (const phrase of phrasesFrom(text)) {
    const coins = await findCoins(phrase);
    if (coins.length) out.push({ phrase, coins });
  }
  return out;
}

module.exports = { phrasesFrom, findCoins, coinsForLine };
