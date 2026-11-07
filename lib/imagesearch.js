// "What could the coin image be?" For a play's words, search live indexes for visual references:
//   DexScreener  – every chain's tokens: images other coins with the same name already use
//   CoinGecko    – established coins and chains (~17k)
//   Wikipedia    – animals, people, objects and memes (millions of articles, with lead images)
//   Imgflip      – the most-used meme templates
// Results are cached so a hot play doesn't hammer the APIs.

const UA = 'NarrativeRadar/1.0 (local research tool)';
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return v;
}
const getJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
};
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const httpsOnly = u => (/^https:\/\//.test(String(u || '')) ? u : null);

/** Coins on any chain whose name or symbol matches, with the image they launched with. */
async function dexCoins(term, searchPairs) {
  const q = squash(term);
  const pairs = await searchPairs(term);
  const byToken = new Map();
  for (const p of pairs) {
    const img = httpsOnly(p.info?.imageUrl);
    if (!img) continue;
    const sym = squash(p.baseToken?.symbol), name = squash(p.baseToken?.name);
    if (!(sym === q || name === q || (q.length >= 4 && (sym.includes(q) || name.includes(q))))) continue;
    const key = p.chainId + ':' + p.baseToken.address;
    const liq = p.liquidity?.usd || 0;
    if (byToken.has(key) && byToken.get(key).liq >= liq) continue;
    byToken.set(key, { kind: 'coin', label: `$${p.baseToken.symbol}`, sub: `${p.chainId} · ${fmt(p.marketCap ?? p.fdv)}`, image: img, url: p.url, liq, createdAt: p.pairCreatedAt || null });
  }
  return [...byToken.values()].sort((a, b) => b.liq - a.liq).slice(0, 6);
}

async function geckoCoins(term) {
  const j = await cached('cg:' + term.toLowerCase(), 10 * 60000, () => getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(term)}`));
  return (j.coins || []).filter(c => httpsOnly(c.large || c.thumb)).slice(0, 4).map(c => ({
    kind: 'established', label: c.symbol ? `$${String(c.symbol).toUpperCase()}` : c.name, sub: `${c.name}${c.market_cap_rank ? ' · #' + c.market_cap_rank : ''}`,
    image: c.large || c.thumb, url: `https://www.coingecko.com/en/coins/${encodeURIComponent(c.id)}`,
  }));
}

async function wiki(term) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=6&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=240&gsrsearch=' + encodeURIComponent(term);
  const j = await cached('wk:' + term.toLowerCase(), 60 * 60000, () => getJson(url));
  return Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index).filter(p => httpsOnly(p.thumbnail?.source)).slice(0, 4).map(p => ({
    kind: 'wiki', label: p.title, sub: p.description || 'Wikipedia', image: p.thumbnail.source, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
  }));
}

async function memeTemplates(words) {
  const j = await cached('imgflip', 24 * 3600000, () => getJson('https://api.imgflip.com/get_memes'));
  const memes = j.data?.memes || [];
  const ws = words.map(w => w.toLowerCase()).filter(w => w.length >= 3);
  return memes.map(m => {
    const name = m.name.toLowerCase();
    const hits = ws.filter(w => name.includes(w)).length;
    return { m, hits };
  }).filter(x => x.hits).sort((a, b) => b.hits - a.hits).slice(0, 3).map(({ m }) => ({
    kind: 'meme', label: m.name, sub: 'meme template', image: m.url, url: `https://imgflip.com/meme/${m.id}`,
  }));
}

const fmt = n => n == null ? '' : '$' + (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : Math.round(n));

/**
 * @param {{terms:string[], subject:string|null, text:string}} q
 * @returns {Promise<{groups: {key:string, title:string, items:object[]}[], errors:string[]}>}
 */
async function searchImages(q, { searchPairs, demo = false } = {}) {
  if (demo) return demoImages(q);
  const errors = [];
  const safe = p => p.catch(e => { errors.push(e.message); return []; });
  const terms = q.terms.slice(0, 2);
  const words = [...new Set([...q.terms.flatMap(t => t.split(/\s+/)), q.subject].filter(Boolean))];
  const [coins, est, wk, memes] = await Promise.all([
    safe(Promise.all(terms.map(t => dexCoins(t, searchPairs))).then(r => r.flat())),
    safe(Promise.all(terms.slice(0, 1).map(geckoCoins)).then(r => r.flat())),
    safe(Promise.all([...new Set([q.subject, terms[0]].filter(Boolean))].map(wiki)).then(r => r.flat())),
    safe(memeTemplates(words)),
  ]);
  const dedupe = arr => arr.filter((x, i) => arr.findIndex(y => y.image === x.image) === i);
  return {
    groups: [
      { key: 'coins', title: 'Same-name coins (images deployers reuse)', items: dedupe(coins).slice(0, 6) },
      { key: 'wiki', title: 'The subject (Wikipedia)', items: dedupe(wk).slice(0, 4) },
      { key: 'memes', title: 'Meme templates', items: memes },
      { key: 'established', title: 'Established coins / chains', items: est },
    ].filter(g => g.items.length),
    errors,
  };
}

// Demo: no network, so draw simple placeholder tiles.
function tile(glyph, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${bg}"/><text x="60" y="78" font-size="64" text-anchor="middle">${glyph}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
function demoImages(q) {
  const t = q.terms[0] || 'coin';
  const subject = q.subject || 'dog';
  const g = { dog: '🐕', goat: '🐐', penguin: '🐧', frog: '🐸', hamster: '🐹', cat: '🐈' }[subject] || '🐾';
  return {
    groups: [
      { key: 'coins', title: 'Same-name coins (images deployers reuse)', items: [
        { kind: 'coin', label: '$' + t.replace(/\s+/g, '').toUpperCase().slice(0, 10), sub: 'solana · $41K', image: tile(g, '#1d2a3a'), url: '#' },
        { kind: 'coin', label: '$' + t.split(' ').pop().toUpperCase().slice(0, 10), sub: 'base · $8K', image: tile(g, '#2a1d3a'), url: '#' },
      ] },
      { key: 'wiki', title: 'The subject (Wikipedia)', items: [{ kind: 'wiki', label: subject[0].toUpperCase() + subject.slice(1), sub: 'Wikipedia', image: tile(g, '#203020'), url: '#' }] },
      { key: 'memes', title: 'Meme templates', items: [{ kind: 'meme', label: 'Doge', sub: 'meme template', image: tile('🐶', '#3a321d'), url: '#' }] },
      { key: 'established', title: 'Established coins / chains', items: [{ kind: 'established', label: '$DOGE', sub: 'Dogecoin · #8', image: tile('Ð', '#2d2a1a'), url: '#' }] },
    ],
    errors: [],
  };
}

module.exports = { searchImages };
