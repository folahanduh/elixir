// Elixir Lens: the mascot's "is this coin any good?" research.
// You box or highlight something on the page; this finds the coin in it (a CA, a $TICKER or a name),
// gathers real data (DexScreener market, rug/bundle checks, holder concentration, what the watchlist,
// whale tracker and KOL wallets saw), scores it with plain rules, and, if an Anthropic key is set,
// has Claude write the verdict from those facts only. Without a key, the rule-based summary is used.

const limit = require('./limit');

let Anthropic = null;
const sdk = () => { if (!Anthropic) { try { const mod = require('@anthropic-ai/sdk'); Anthropic = mod.Anthropic || mod.default || mod; } catch {} } return Anthropic; };

const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
const SOL = 'So11111111111111111111111111111111111111112';
const MAJORS = new Set(['SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'WSOL', 'JUP', 'BONK', 'WIF']);
const usd = n => (n == null ? '?' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));
const age = ms => { const m = ms / 60000; return m < 60 ? Math.round(m) + 'm' : m < 2880 ? (m / 60).toFixed(1) + 'h' : Math.round(m / 1440) + 'd'; };

/** Best Solana pair for a mint (deepest liquidity). */
async function pairForMint(mint) {
  const r = await limit.dex(() => fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : [])));
  return (Array.isArray(r) ? r : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}
/** A coin by name or ticker: the Solana pair with the most liquidity among exact symbol/name matches. */
async function pairForWord(word) {
  const r = await limit.dex(() => fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : {})));
  const w = word.toLowerCase().replace(/^\$/, '');
  const pairs = (r.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken?.address !== SOL);
  const exact = pairs.filter(p => p.baseToken?.symbol?.toLowerCase() === w || p.baseToken?.name?.toLowerCase() === w);
  return (exact.length ? exact : pairs).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

/** What coin is the user pointing at? Mints the page tagged come first, then CAs in the text, then $TICKERs. */
async function findCoin({ text = '', mints = [] }, ctx) {
  const tried = new Set();
  const tryMint = async m => {
    if (!isAddr(m) || tried.has(m) || m === SOL) return null;
    tried.add(m);
    const pair = await pairForMint(m).catch(() => null);
    if (pair) return { mint: m, pair };
    if (ctx.radar?.items?.get(m)) return { mint: m, pair: null };      // brand new, not on DexScreener yet
    // A pool / pair address (DexScreener and Axiom links use these): look up its coin
    try {
      const pp = await limit.dex(() => fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${m}`, { signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : {})));
      const p = pp.pairs?.[0] || pp.pair;
      if (p?.baseToken?.address && p.baseToken.address !== SOL) return { mint: p.baseToken.address, pair: await pairForMint(p.baseToken.address).catch(() => p) || p };
    } catch {}
    try { const s = await ctx.rpc?.('getTokenSupply', [m]); if (s?.value) return { mint: m, pair: null }; } catch {}
    return null;
  };
  for (const m of mints) { const hit = await tryMint(m); if (hit) return hit; }
  for (const m of String(text).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) { const hit = await tryMint(m); if (hit) return hit; }
  // The page you're on (pump.fun/coin/<CA>, dexscreener.com/solana/<pair>, gmgn.ai/sol/token/<CA>…)
  for (const m of String(ctx.pageUrl || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) { const hit = await tryMint(m); if (hit) return hit; }
  const tickers = [...new Set((String(text).match(/\$[A-Za-z][A-Za-z0-9]{1,15}/g) || []).map(t => t.slice(1)).filter(t => !MAJORS.has(t.toUpperCase())))];
  for (const t of tickers.slice(0, 3)) { const p = await pairForWord(t).catch(() => null); if (p) return { mint: p.baseToken.address, pair: p }; }
  // Last try: a short highlighted phrase is probably a coin name
  const plain = String(text).trim();
  if (plain && plain.length <= 32 && !/\s{2,}/.test(plain) && plain.split(/\s+/).length <= 4) { const p = await pairForWord(plain).catch(() => null); if (p) return { mint: p.baseToken.address, pair: p }; }
  return null;
}

/** Top-holder concentration from the RPC (top 20 accounts). Pools / curves are counted separately. */
async function holders(ctx, mint) {
  if (!ctx.rpc) return null;
  try {
    const [sup, largest] = await Promise.all([ctx.rpc('getTokenSupply', [mint]), ctx.rpc('getTokenLargestAccounts', [mint])]);
    const total = Number(sup?.value?.amount || 0);
    if (!total) return null;
    const accts = largest?.value || [];
    const infos = (await ctx.rpc('getMultipleAccounts', [accts.map(a => a.address), { encoding: 'jsonParsed' }]))?.value || [];
    const owners = infos.map(i => i?.data?.parsed?.info?.owner || null);
    const ownerInfo = (await ctx.rpc('getMultipleAccounts', [owners.filter(Boolean), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => null))?.value || [];
    const programOwned = new Set(owners.filter(Boolean).filter((o, i) => ownerInfo[i]?.owner && ownerInfo[i].owner !== '11111111111111111111111111111111'));
    let people = [], pools = 0;
    accts.forEach((a, i) => { const pct = (Number(a.amount) / total) * 100; if (programOwned.has(owners[i])) pools += pct; else people.push(pct); });
    people.sort((a, b) => b - a);
    return { top1: people[0] || 0, top10: people.slice(0, 10).reduce((s, x) => s + x, 0), pools };
  } catch { return null; }
}

/** All the facts, then a rule-based score. */
async function research(input, ctx) {
  const found = await findCoin(input, ctx);
  if (!found) return { found: false, message: 'No coin found in what you selected. Box a ticker, a CA, or a coin card.' };
  const { mint } = found;
  let pair = found.pair;
  const radarItem = ctx.radar?.get?.(mint) || null;
  const [risk, hold] = await Promise.all([
    ctx.risk?.assess(mint, pair ? { volume: pair.volume?.h24, marketCap: pair.marketCap ?? pair.fdv, liquidity: pair.liquidity?.usd } : {}).catch(() => null),
    holders(ctx, mint),
  ]);
  const now = Date.now();
  const kolBuys = (ctx.kols?.events || []).filter(e => e.mint === mint && e.side === 'buy');
  const kolSells = (ctx.kols?.events || []).filter(e => e.mint === mint && e.side === 'sell');
  const whaleEvents = (ctx.whales?.events || []).filter(e => e.mint === mint);
  const facts = {
    mint,
    symbol: pair?.baseToken?.symbol || radarItem?.symbol || null,
    name: pair?.baseToken?.name || radarItem?.name || null,
    image: pair?.info?.imageUrl || radarItem?.image || null,
    dex: pair?.dexId || radarItem?.pad || null,
    ageMin: pair?.pairCreatedAt ? Math.round((now - pair.pairCreatedAt) / 60000) : radarItem?.createdAt ? Math.round((now - radarItem.createdAt) / 60000) : null,
    marketCap: pair?.marketCap ?? pair?.fdv ?? radarItem?.mcUsd ?? null,
    liquidity: pair?.liquidity?.usd ?? null,
    volume: { m5: pair?.volume?.m5 ?? null, h1: pair?.volume?.h1 ?? null, h24: pair?.volume?.h24 ?? null },
    txns: { m5: pair?.txns?.m5 || null, h1: pair?.txns?.h1 || null, h24: pair?.txns?.h24 || null },
    priceChange: { m5: pair?.priceChange?.m5 ?? null, h1: pair?.priceChange?.h1 ?? null, h24: pair?.priceChange?.h24 ?? null },
    socials: [...(pair?.info?.socials || []).map(s => s.type), ...(pair?.info?.websites || []).map(() => 'website')],
    risk: risk ? { score: risk.score ?? null, flags: (risk.flags || []).filter(f => f.level !== 'info').map(f => `${f.level}: ${f.label}`).slice(0, 8) } : null,
    holders: hold,
    launch: radarItem ? { bigMoneyInSol: Math.round(radarItem.inSol || 0), bigBuys: radarItem.bigBuys, devBuySol: radarItem.devSol, wallets: radarItem.wallets } : null,
    trackedWallets: { kolBuys: kolBuys.length, kolNames: [...new Set(kolBuys.map(e => e.kol))].slice(0, 6), kolSells: kolSells.length, whaleMoves: whaleEvents.map(e => e.kind) },
  };

  // ---- rules ----
  const good = [], bad = [], info = [];
  let score = 50;
  const L = facts.liquidity, M = facts.marketCap, v1 = facts.volume.h1, t1 = facts.txns.h1;
  if (L != null) {
    if (L < 5000) { score -= 20; bad.push(`Very thin liquidity (${usd(L)}): hard to get out`); }
    else if (M && L / M < 0.03) { score -= 8; bad.push(`Liquidity is only ${((L / M) * 100).toFixed(1)}% of market cap`); }
    else if (L >= 50000) { score += 6; good.push(`Healthy liquidity (${usd(L)})`); }
  } else if (facts.dex === 'Pump' || facts.dex === 'pumpfun' || facts.dex === 'LetsBonk') info.push('Still on the bonding curve (no pool yet)');
  if (v1 != null) {
    if (v1 >= 100000) { score += 10; good.push(`Strong volume: ${usd(v1)} in the last hour`); }
    else if (v1 < 2000 && (facts.ageMin || 0) > 30) { score -= 10; bad.push(`Barely trading (${usd(v1)} in the last hour)`); }
  }
  if (t1 && t1.buys != null) {
    const ratio = t1.buys / Math.max(1, t1.sells);
    if (ratio >= 1.5 && t1.buys >= 50) { score += 6; good.push(`Buyers outnumber sellers ${t1.buys} to ${t1.sells} this hour`); }
    else if (ratio < 0.7 && t1.sells >= 30) { score -= 8; bad.push(`More sells than buys this hour (${t1.sells} vs ${t1.buys})`); }
  }
  const p1 = facts.priceChange.h1;
  if (p1 != null && p1 <= -50) { score -= 12; bad.push(`Down ${Math.abs(p1).toFixed(0)}% in the last hour`); }
  if (facts.risk) {
    const highs = facts.risk.flags.filter(f => f.startsWith('high'));
    const meds = facts.risk.flags.filter(f => f.startsWith('medium'));
    if (highs.length) { score -= 12 * Math.min(3, highs.length); highs.slice(0, 3).forEach(f => bad.push(f.replace(/^high: /, ''))); }
    meds.slice(0, 2).forEach(f => { score -= 4; bad.push(f.replace(/^medium: /, '')); });
    if (!highs.length && !meds.length) { score += 8; good.push('Rug checks clean (mint/freeze authority, bundles, creator history)'); }
  }
  if (hold) {
    if (hold.top1 >= 15) { score -= 12; bad.push(`One wallet holds ${hold.top1.toFixed(1)}% of supply`); }
    if (hold.top10 >= 45) { score -= 10; bad.push(`Top 10 holders own ${hold.top10.toFixed(0)}%`); }
    else if (hold.top10 <= 25) { score += 6; good.push(`Spread out: top 10 holders own ${hold.top10.toFixed(0)}%`); }
  }
  if (facts.trackedWallets.kolBuys >= 2) { score += 10; good.push(`${facts.trackedWallets.kolBuys} buys from your KOL wallets (${facts.trackedWallets.kolNames.join(', ')})`); }
  else if (facts.trackedWallets.kolBuys === 1) { score += 4; info.push(`A KOL wallet bought (${facts.trackedWallets.kolNames[0]})`); }
  if (facts.trackedWallets.kolSells >= 2) { score -= 6; bad.push(`${facts.trackedWallets.kolSells} KOL sells`); }
  if (facts.launch?.bigMoneyInSol >= 100) { score += 6; good.push(`${facts.launch.bigMoneyInSol} SOL of big buys in its first minutes`); }
  if (facts.trackedWallets.whaleMoves.length) info.push(`Whale tracker saw: ${[...new Set(facts.trackedWallets.whaleMoves)].join(', ')}`);
  if (facts.socials.length) info.push(`Socials: ${[...new Set(facts.socials)].join(', ')}`); else if ((facts.ageMin || 0) > 60) { score -= 4; bad.push('No socials or website listed'); }
  if (facts.ageMin != null) info.push(`Age ${age(facts.ageMin * 60000)}${M ? ' · mc ' + usd(M) : ''}`);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 && !bad.some(b => /rugged|authority|holds \d{2}/.test(b)) ? 'good' : score >= 45 ? 'mixed' : 'avoid';
  const lc = s => (s ? s[0].toLowerCase() + s.slice(1) : s); // only the first letter: keep "$95.0K", "KOL"
  const summary = verdict === 'good' ? `Looks healthy so far: ${good.slice(0, 2).map(lc).join('; ') || 'no red flags found'}.`
    : verdict === 'avoid' ? `Too many red flags: ${bad.slice(0, 2).map(lc).join('; ')}.`
      : `Mixed: ${[good[0], bad[0]].filter(Boolean).map(lc).join(', but ') || 'not enough data yet'}.`;
  return { found: true, facts, rules: { score, verdict, summary, good, bad, info }, links: links(mint, pair) };
}

const links = (mint, pair) => ({
  axiom: `https://axiom.trade/meme/${pair?.pairAddress || mint}`, gmgn: `https://gmgn.ai/sol/token/${mint}`,
  dexscreener: `https://dexscreener.com/solana/${mint}`, solscan: `https://solscan.io/token/${mint}`, rugcheck: `https://rugcheck.xyz/tokens/${mint}`,
});

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'headline', 'summary', 'good', 'bad'],
  properties: {
    verdict: { type: 'string', enum: ['good', 'mixed', 'avoid'] },
    headline: { type: 'string' },
    summary: { type: 'string' },
    good: { type: 'array', items: { type: 'string' } },
    bad: { type: 'array', items: { type: 'string' } },
  },
};
const SYSTEM = `You are Elixir's coin analyst for a Solana memecoin trader. You get facts that were just measured about one coin (market data, rug/bundle checks, holder concentration, what tracked KOL and whale wallets did, and a rule-based score). Judge only from these facts; never invent numbers, news or people.

Return:
- verdict: "good" (worth a look: real flow, no serious red flags), "mixed" (some promise, real risks), or "avoid" (serious red flags or dead).
- headline: at most 8 words.
- summary: 2-3 plain sentences a trader can read in five seconds. Lead with the deciding reason.
- good / bad: up to 4 short points each, using the numbers given.

Memecoins are high risk by nature; say so only when it matters, and never present any of this as financial advice or a guarantee.`;

/** Claude's verdict, written from the facts (null without a key, or on any failure: the rules stand). */
async function aiVerdict(cfg, facts, rules) {
  const key = cfg.keys.anthropic;
  if (!sdk() || !key) return null;
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 30000 });
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 1)}\n\nRule-based score: ${rules.score}/100 (${rules.verdict}).\nRule notes - good: ${rules.good.join('; ') || 'none'} | bad: ${rules.bad.join('; ') || 'none'}` }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === 'refusal') return null;
    const out = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    return { verdict: out.verdict, headline: out.headline, summary: out.summary, good: out.good.slice(0, 4), bad: out.bad.slice(0, 4) };
  } catch { return null; }
}

const cache = new Map();
async function lens(input, ctx) {
  const key = JSON.stringify([input.mints?.slice(0, 3) || [], String(input.text || '').slice(0, 200)]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.r;
  const r = await research(input, ctx);
  if (r.found) r.ai = await aiVerdict(ctx.getConfig(), r.facts, r.rules);
  cache.set(key, { at: Date.now(), r });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return r;
}

module.exports = { lens, findCoin };
