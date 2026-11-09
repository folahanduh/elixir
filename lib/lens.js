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
const pairCache = new Map(); // mint -> {at, p: Promise<pair|null>}
function pairForMint(mint) {
  const hit = pairCache.get(mint);
  if (hit && Date.now() - hit.at < 15000) return hit.p;
  const p = fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(2500) }).then(x => (x.ok ? x.json() : []))
    .then(r => (Array.isArray(r) ? r : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null).catch(() => null);
  pairCache.set(mint, { at: Date.now(), p });
  if (pairCache.size > 500) pairCache.delete(pairCache.keys().next().value);
  return p;
}
/** A coin by name or ticker: the Solana pair with the most liquidity among exact symbol/name matches. */
async function pairForWord(word) {
  const r = await limit.dex(() => fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : {})));
  const w = word.toLowerCase().replace(/^\$/, '');
  const pairs = (r.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken?.address !== SOL);
  const exact = pairs.filter(p => p.baseToken?.symbol?.toLowerCase() === w || p.baseToken?.name?.toLowerCase() === w);
  return (exact.length ? exact : pairs).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

/** A pool / pair address (Axiom and DexScreener links use these) → its coin. Cached like pairForMint. */
const pairAddrCache = new Map();
function coinForPairAddress(addr) {
  const hit = pairAddrCache.get(addr);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`, { signal: AbortSignal.timeout(2500) }).then(x => (x.ok ? x.json() : {}))
    .then(pp => { const q = pp.pairs?.[0] || pp.pair; return q?.baseToken?.address && q.baseToken.address !== SOL ? q : null; }).catch(() => null);
  pairAddrCache.set(addr, { at: Date.now(), p });
  if (pairAddrCache.size > 500) pairAddrCache.delete(pairAddrCache.keys().next().value);
  return p;
}

// ---------- launchpad coins (pump.fun, LetsBonk, Bags, Believe, Moonshot…) ----------
// Brand-new coins on a bonding curve often aren't on DexScreener yet. Jupiter's token list has them (market cap,
// curve progress, holders, flow, mint/freeze audit) from the first trades, so it's asked at the same time.
// Every field is optional: if Jupiter changes its format, the coin is simply looked up the other ways.
const jupCache = new Map();
function jupPair(mint) {
  const hit = jupCache.get(mint);
  if (hit && Date.now() - hit.at < 15000) return hit.p;
  const p = fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(2000) })
    .then(r => (r.ok ? r.json() : [])).then(list => {
      const t = (Array.isArray(list) ? list : list?.tokens || []).find(x => (x.id || x.mint || x.address) === mint);
      return t ? fromJup(t, mint) : null;
    }).catch(() => null);
  jupCache.set(mint, { at: Date.now(), p });
  if (jupCache.size > 500) jupCache.delete(jupCache.keys().next().value);
  return p;
}
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Jupiter's token → the same shape as a DexScreener pair, plus launchpad details under .jup */
function fromJup(t, mint) {
  const st = k => t[k] || {};
  const vol = s => { const v = (num(s.buyVolume) || 0) + (num(s.sellVolume) || 0); return v || null; };
  const tx = s => (num(s.numBuys) != null ? { buys: num(s.numBuys), sells: num(s.numSells) || 0 } : null);
  const socials = [...(t.twitter ? [{ type: 'twitter', url: t.twitter }] : []), ...(t.telegram ? [{ type: 'telegram', url: t.telegram }] : [])];
  return {
    chainId: 'solana', dexId: t.launchpad || 'jupiter', pairAddress: t.graduatedPool || t.firstPool?.id || null,
    baseToken: { address: mint, symbol: t.symbol || null, name: t.name || null },
    marketCap: num(t.mcap), fdv: num(t.fdv), priceUsd: num(t.usdPrice), liquidity: { usd: num(t.liquidity) },
    volume: { m5: vol(st('stats5m')), h1: vol(st('stats1h')), h24: vol(st('stats24h')) },
    txns: { m5: tx(st('stats5m')), h1: tx(st('stats1h')), h24: tx(st('stats24h')) },
    priceChange: { m5: num(st('stats5m').priceChange), h1: num(st('stats1h').priceChange), h24: num(st('stats24h').priceChange) },
    pairCreatedAt: Date.parse(t.firstPool?.createdAt || t.createdAt || '') || null,
    info: { imageUrl: t.icon || null, socials, websites: t.website ? [{ url: t.website }] : [] },
    jup: {
      launchpad: t.launchpad || null, curve: num(t.bondingCurve), graduated: Boolean(t.graduatedPool || t.graduatedAt),
      holders: num(t.holderCount), dev: t.dev || null, audit: t.audit || null, organic: num(t.organicScore),
    },
  };
}
/** The first of these that finds something (null when none do). */
const firstHit = ps => new Promise(res => {
  let left = ps.length;
  if (!left) return res(null);
  for (const p of ps) Promise.resolve(p).then(v => (v ? res(v) : --left || res(null)), () => --left || res(null));
});
/** A coin's market data: DexScreener or Jupiter, whichever answers first. */
const marketFor = mint => firstHit([pairForMint(mint), jupPair(mint)]);

/** A bonding-curve address (Axiom's links for coins still on the curve) → its coin. */
async function coinForCurve(addr, ctx) {
  const known = ctx.radar?.mintForCurve?.(addr);                             // pump.fun coins the radar saw launch
  if (known) return known;
  if (!ctx.rpc) return null;
  // The curve owns the token account that holds the coin's unsold supply: one lookup per token program.
  const progs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
  const found = await Promise.all(progs.map(programId => ctx.rpc('getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed' }]).catch(() => null)));
  for (const r of found) for (const a of r?.value || []) {
    const m = a.account?.data?.parsed?.info?.mint;
    if (m && m !== SOL && m !== 'EPjFWdd5AufqZSqeM2qJqEtcAqP3vbzBR8Kc4AgRdJr' && Number(a.account.data.parsed.info.tokenAmount?.uiAmount) > 0) return m;
  }
  return null;
}

/** Any address → {mint, pair}: a coin's CA, a pool address, or a launchpad bonding curve. Fastest answer wins. */
async function resolveAddr(m, ctx) {
  if (!isAddr(m) || m === SOL) return null;
  const inRadar = ctx.radar?.items?.get(m);
  const asCoin = marketFor(m).then(p => p && { mint: m, pair: p });
  const asPool = coinForPairAddress(m).then(q => q && { mint: q.baseToken.address, pair: q });
  const curveMint = ctx.radar?.mintForCurve?.(m);
  const asCurve = curveMint ? marketFor(curveMint).then(p => ({ mint: curveMint, pair: p })) : null;
  if (inRadar) { const hit = await within(asCoin, 900); return hit || { mint: m, pair: null }; } // brand new: don't wait long
  const hit = await firstHit([asCoin, asPool, asCurve].filter(Boolean));
  if (hit) return hit;
  // Nothing knows this address: it may be a launchpad curve (ask the chain) or a coin with no trades yet.
  const viaCurve = await coinForCurve(m, ctx).catch(() => null);
  if (viaCurve) return { mint: viaCurve, pair: await marketFor(viaCurve) };
  try { const s = await ctx.rpc?.('getTokenSupply', [m]); if (s?.value) return { mint: m, pair: null }; } catch {}
  return null;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How many times a word appears as a whole word (case-insensitive). */
const count = (hay, w) => (w && w.length >= 2 ? (String(hay).match(new RegExp(`(^|[^A-Za-z0-9])\\$?${esc(w)}([^A-Za-z0-9]|$)`, 'gi')) || []).length : 0);

/** A $TICKER only Jupiter knows (fresh launchpad coins): exact ticker, the biggest one. */
async function jupWord(sym) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(sym)}`, { signal: AbortSignal.timeout(2000) });
    const list = r.ok ? await r.json() : [];
    const t = (Array.isArray(list) ? list : []).filter(x => String(x.symbol || '').toLowerCase() === sym.toLowerCase()).sort((a, b) => (num(b.mcap) || 0) - (num(a.mcap) || 0))[0];
    return t ? fromJup(t, t.id || t.mint) : null;
  } catch { return null; }
}

/**
 * Which coin is the user pointing at? Every address in the box (links, data on the page, CAs in the text)
 * and the page's own coin are looked up together, then ranked by how well each fits what was boxed:
 * its ticker / name written in the box, a CA typed out in the box, the page you're on (and its tab title).
 * A coin that is only a link at the edge of the box (a ticker strip, a sidebar) loses to the one you boxed.
 */
async function findCoin({ text = '', mints = [], pageTitle = '' }, ctx) {
  const textCAs = String(text).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const urlAddrs = String(ctx.pageUrl || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const cands = new Map(); // address -> {from: Set, order}
  const add = (a, from, order) => { if (!isAddr(a) || a === SOL) return; const c = cands.get(a) || { from: new Set(), order }; c.from.add(from); c.order = Math.min(c.order, order); cands.set(a, c); };
  textCAs.forEach((a, i) => add(a, 'text', i));
  urlAddrs.forEach((a, i) => add(a, 'page', i));
  mints.forEach((a, i) => add(a, 'link', i));
  // $ amounts in the box ("$50.7K", "$1.2M"): a coin whose market cap matches one is the one shown there
  const amounts = [...String(text).matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([KMB])?\b/gi)].map(m => parseFloat(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1)).filter(v => v >= 1000);
  const mcShown = pair => { const mc = pair?.marketCap ?? pair?.fdv; return mc ? amounts.some(v => Math.abs(v - mc) / mc < 0.12) : false; };
  const list = [...cands.entries()].slice(0, 10);
  if (list.length) {
    const resolved = await Promise.all(list.map(async ([a, c]) => ({ addr: a, c, hit: await resolveAddr(a, ctx).catch(() => null) })));
    const byMint = new Map();
    for (const { addr, c, hit } of resolved) {
      if (!hit) continue;
      const sym = hit.pair?.baseToken?.symbol || ctx.radar?.items?.get(hit.mint)?.symbol || '';
      const name = hit.pair?.baseToken?.name || ctx.radar?.items?.get(hit.mint)?.name || '';
      let score = 0;
      score += Math.min(4, count(text, sym)) * 3;                                 // its ticker written in the box
      if (name && name.toLowerCase() !== sym.toLowerCase()) score += Math.min(3, count(text, name)) * 2;
      if (c.from.has('text')) score += 6;                                         // a CA written out in the box
      // the coin whose page this is: a big plus when what you boxed mentions it, otherwise only a tie-breaker
      // (box just another coin in a ticker strip on this page and you get that other coin)
      if (c.from.has('page')) score += count(text, sym) || count(text, name) ? 4 + (count(pageTitle, sym) ? 3 : 0) : 1.5;
      if (c.from.has('link')) score += Math.max(0, 2 - c.order * 0.3);            // a link inside the box
      if (text.includes(addr)) score += 2;
      if (mcShown(hit.pair)) score += 8;                                          // its market cap is written right there
      const prev = byMint.get(hit.mint);
      if (!prev || score > prev.score) byMint.set(hit.mint, { ...hit, score: (prev?.score || 0) + score });
      else prev.score += score * 0.5;
    }
    const best = [...byMint.values()].sort((a, b) => b.score - a.score || (b.pair?.liquidity?.usd || 0) - (a.pair?.liquidity?.usd || 0))[0];
    if (best) return { mint: best.mint, pair: best.pair };
  }
  const tickers = [...new Set((String(text).match(/\$[A-Za-z][A-Za-z0-9]{1,15}/g) || []).map(t => t.slice(1)).filter(t => !MAJORS.has(t.toUpperCase())))];
  for (const t of tickers.slice(0, 3)) {
    const p = (await pairForWord(t).catch(() => null)) || (await jupWord(t));
    if (p) return { mint: p.baseToken.address, pair: p };
  }
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
function research(found, ctx, slow = {}) {
  const { mint } = found;
  let pair = found.pair;
  const radarItem = ctx.radar?.get?.(mint) || null;
  const risk = slow.risk || null;
  let hold = slow.holders || null;
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
    launchpad: pair?.jup?.launchpad || radarItem?.pad || null,
    bondingCurvePct: pair?.jup?.curve ?? null, graduated: pair?.jup?.graduated ?? null,
    holderCount: pair?.jup?.holders ?? null,
    jupAudit: pair?.jup?.audit ? { mintAuthorityOff: pair.jup.audit.mintAuthorityDisabled ?? null, freezeAuthorityOff: pair.jup.audit.freezeAuthorityDisabled ?? null, top10Pct: num(pair.jup.audit.topHoldersPercentage), devPct: num(pair.jup.audit.devBalancePercentage), devMigrations: num(pair.jup.audit.devMigrations), suspicious: pair.jup.audit.isSus ?? null } : null,
    risk: risk ? { score: risk.score ?? null, flags: (risk.flags || []).filter(f => f.level !== 'info').map(f => `${f.level}: ${f.label}`).slice(0, 8) } : null,
    holders: hold,
    launch: radarItem ? { bigMoneyInSol: Math.round(radarItem.inSol || 0), bigBuys: radarItem.bigBuys, devBuySol: radarItem.devSol, wallets: radarItem.wallets } : null,
    trackedWallets: { kolBuys: kolBuys.length, kolNames: [...new Set(kolBuys.map(e => e.kol))].slice(0, 6), kolSells: kolSells.length, whaleMoves: whaleEvents.map(e => e.kind) },
    narrative: slow.story ? {
      ruleVerdict: slow.story.verdict, reasons: slow.story.reasons, counts: slow.story.counts,
      origin: slow.story.origin ? { author: slow.story.origin.author, text: slow.story.origin.text.slice(0, 200), coinLaunchedSecAfter: slow.story.origin.afterSec } : null,
      tweets: slow.story.tweets.slice(-10).map(t => ({ author: t.author, followers: t.followers, verified: t.verified, minutesVsLaunch: t.vsLaunchMin, promo: t.promo, text: t.text.slice(0, 160) })),
    } : null,
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
  const ja = facts.jupAudit;
  if (ja) {
    const has = re => bad.some(b => re.test(b));
    if (ja.mintAuthorityOff === false && !has(/mint authority/i)) { score -= 12; bad.push('Mint authority not revoked'); }
    if (ja.freezeAuthorityOff === false && !has(/freeze/i)) { score -= 12; bad.push('Freeze authority on'); }
    if (ja.devPct >= 10) { score -= 8; bad.push(`Dev still holds ${ja.devPct.toFixed(0)}%`); }
    if (ja.suspicious) { score -= 10; bad.push('Jupiter flags it as suspicious'); }
    if (!hold && ja.top10Pct != null) facts.holders = { top1: null, top10: ja.top10Pct, from: 'jupiter' };
  }
  if (facts.bondingCurvePct != null && !facts.graduated) info.push(`On ${facts.launchpad || 'the launchpad'}'s bonding curve: ${Math.round(facts.bondingCurvePct)}% to graduation`);
  if (facts.holderCount) info.push(`${facts.holderCount.toLocaleString('en')} holders`);
  hold = hold || facts.holders;
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
  return { found: true, facts, rules: { score, verdict, summary, good, bad, info }, links: links(mint, pair), story: slow.story || null };
}

const links = (mint, pair) => ({
  axiom: `https://axiom.trade/meme/${pair?.pairAddress || mint}`, gmgn: `https://gmgn.ai/sol/token/${mint}`,
  dexscreener: `https://dexscreener.com/solana/${mint}`, solscan: `https://solscan.io/token/${mint}`, rugcheck: `https://rugcheck.xyz/tokens/${mint}`,
});

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'headline', 'summary', 'good', 'bad', 'why', 'narrative'],
  properties: {
    verdict: { type: 'string', enum: ['good', 'mixed', 'avoid'] },
    headline: { type: 'string' },
    summary: { type: 'string' },
    good: { type: 'array', items: { type: 'string' } },
    bad: { type: 'array', items: { type: 'string' } },
    why: { type: 'string' },
    narrative: { type: 'object', additionalProperties: false, required: ['verdict', 'reason'], properties: { verdict: { type: 'string', enum: ['real', 'unclear', 'manufactured'] }, reason: { type: 'string' } } },
  },
};
const SYSTEM = `You are Elixir's coin analyst for a Solana memecoin trader. You get facts that were just measured about one coin (market data, rug/bundle checks, holder concentration, what tracked KOL and whale wallets did, and a rule-based score). Judge only from these facts; never invent numbers, news or people.

Return:
- verdict: "good" (worth a look: real flow, no serious red flags), "mixed" (some promise, real risks), or "avoid" (serious red flags or dead).
- headline: at most 8 words.
- summary: 1-2 plain sentences a trader can read in five seconds. Lead with the deciding reason.
- good / bad: up to 3 points each, each under 12 words, using the numbers given.
- why: 1-2 short sentences on what is driving it, from the narrative tweets given (who said what, and when relative to launch). If there are no tweets, say the move has no visible story yet.
- narrative: is the story behind the coin real? "real" = a real person/account talked about the subject before the coin existed, or real people discuss the subject itself; "manufactured" = the coin came first and the mentions are mostly ticker/CA promotion from small accounts; "unclear" otherwise. reason: one sentence citing the evidence (accounts, timing).

Memecoins are high risk by nature; say so only when it matters, and never present any of this as financial advice or a guarantee.`;

/** Claude's verdict, written from the facts (null without a key, or on any failure: the rules stand). */
// One client per key: its connection stays open between coins (no new TLS handshake per answer).
let aiClient = null, aiClientKey = '';
// Fast mode: skipped for good if this account can't use it, and for a minute after its rate limit.
let fastOff = false, fastPauseUntil = 0;
async function aiVerdict(cfg, facts, rules) {
  const key = cfg.keys.anthropic;
  if (!sdk() || !key) return null;
  try {
    if (!aiClient || aiClientKey !== key) { aiClient = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20000 }); aiClientKey = key; }
    const client = aiClient;
    const content = `Facts:\n${JSON.stringify(facts)}\n\nRule-based score: ${rules.score}/100 (${rules.verdict}).\nRule notes - good: ${rules.good.join('; ') || 'none'} | bad: ${rules.bad.join('; ') || 'none'}`;
    // Settings → "AI write-up" (default: fastest) = Claude Haiku 5.5 with thinking off (a second or two). If it declines or
    // errors, the same request goes to Claude Opus 5.5 below.
    if (cfg.lensModel !== 'best') {
      try {
        const res = await client.messages.create({
          model: 'claude-haiku-5-5', max_tokens: 900,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
          system: SYSTEM, messages: [{ role: 'user', content }],
        });
        if (res.stop_reason !== 'refusal' && res.stop_reason !== 'max_tokens') return shape(JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join('')), 'Claude Haiku 5.5');
      } catch (e) { if (e instanceof Anthropic.AuthenticationError) return null; }
    }
    const useFast = !fastOff && Date.now() > fastPauseUntil;
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 900,      // a short verdict: fewer tokens = faster
      ...(useFast ? { speed: 'fast' } : {}), // fast mode: same model, much quicker output
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      betas: useFast ? ['server-side-fallback-2026-07-01', 'fast-mode-2026-02-01'] : ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    let res;
    try { res = await client.beta.messages.create(params); }
    catch (e) {
      // Fast mode busy (its own rate limit) or not enabled on this account: same request at standard speed.
      if (!useFast || !(e instanceof Anthropic.RateLimitError || e instanceof Anthropic.BadRequestError || e instanceof Anthropic.PermissionDeniedError)) throw e;
      if (e instanceof Anthropic.RateLimitError) fastPauseUntil = Date.now() + 60000; else fastOff = true;
      delete params.speed; params.betas = ['server-side-fallback-2026-07-01'];
      res = await client.beta.messages.create(params);
    }
    if (res.stop_reason === 'refusal') return null;
    const out = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    return shape(out, 'Claude Opus 5.5');
  } catch { return null; }
}
const shape = (out, by) => ({ verdict: out.verdict, headline: out.headline, summary: out.summary, good: out.good.slice(0, 3), bad: out.bad.slice(0, 3), why: out.why, narrative: out.narrative, by });

// ---------- speed: two stages ----------
// quick: market data + what Elixir already knows (in memory) → a verdict in a fraction of a second.
// full:  + rug checks and holder concentration (each capped at ~2 s) + Claude's write-up (fast mode).
const findCache = new Map(); // input key -> {at, p}
const slowCache = new Map(); // mint -> {at, p}
const keyOf = input => JSON.stringify([input.mints?.slice(0, 4) || [], String(input.text || '').slice(0, 300), String(input.pageUrl || '').slice(0, 200)]);
function find(input, ctx) {
  const k = keyOf(input), hit = findCache.get(k);
  if (hit && Date.now() - hit.at < 30000) return hit.p;
  const p = findCoin(input, ctx).catch(() => null);
  findCache.set(k, { at: Date.now(), p });
  if (findCache.size > 300) findCache.delete(findCache.keys().next().value);
  return p;
}
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);
/** Rug checks + holders for a coin, started once and shared (also used to pre-warm hot coins). */
function slowChecks(mint, pair, ctx) {
  const hit = slowCache.get(mint);
  if (hit && Date.now() - hit.at < 120000) return hit.p;
  const p = (async () => {
    const pairInfo = pair ? { volume: pair.volume?.h24, marketCap: pair.marketCap ?? pair.fdv, liquidity: pair.liquidity?.usd } : {};
    const holdersP = within(holders(ctx, mint), 1800);                          // in parallel with the rug checks
    const rcP = require('./risk').rugcheck(mint).catch(() => null);             // RugCheck alone: fast, our fallback
    const full = ctx.risk?.assess(mint, pairInfo).catch(() => null);           // RugCheck + first-trades scan (can be slow)
    let risk = await within(full || Promise.resolve(null), 1500);
    if (risk === undefined) {                                                   // too slow: RugCheck alone for now
      const rc = await within(rcP, 900);
      risk = rc ? { flags: [...(rc.mintAuthority ? [{ level: 'high', label: 'Mint authority not revoked' }] : []), ...(rc.freezeAuthority ? [{ level: 'high', label: 'Freeze authority on' }] : []), ...(rc.rugged ? [{ level: 'high', label: 'RugCheck marks it rugged' }] : []), ...(rc.risks || []).map(x => ({ level: x.level === 'danger' ? 'high' : 'medium', label: x.name }))] } : null;
      // the full scan keeps going; when it lands it upgrades the cached answer for next time
      full?.then(async r => { if (r) { const prev = await p; slowCache.set(mint, { at: Date.now(), p: Promise.resolve({ ...prev, risk: r }) }); aiCache.delete(mint); } }); // the write-up is redone with the full scan
    }
    const holdersNow = await holdersP;
    return { risk, holders: holdersNow || null };
  })();
  slowCache.set(mint, { at: Date.now(), p });
  if (slowCache.size > 300) slowCache.delete(slowCache.keys().next().value);
  return p;
}
/** What's already done for this coin (no waiting). */
async function slowIfReady(mint) {
  const hit = slowCache.get(mint);
  if (!hit) return {};
  return (await within(hit.p, 5)) || {};
}

/** Who/what to look for in tweets, and when the coin launched. */
function storyMeta(found, ctx) {
  const ri = ctx.radar?.items?.get(found.mint);
  return { mint: found.mint, sym: found.pair?.baseToken?.symbol || ri?.symbol || null, name: found.pair?.baseToken?.name || ri?.name || null, launch: found.pair?.pairCreatedAt || ri?.createdAt || null };
}

async function quick(input, ctx) {
  const t0 = Date.now();
  const found = await find(input, ctx);
  if (!found) return { found: false, stage: 'full', message: 'No coin found in what you selected. Box a ticker, a CA, or a coin card.' };
  slowChecks(found.mint, found.pair, ctx);             // start the slow part now; the card asks for it next
  const story = require('./story');
  const meta = storyMeta(found, ctx);
  const r = research(found, ctx, { ...(await slowIfReady(found.mint)), story: story.assemble(meta, story.local(meta, ctx), null) });
  return { ...r, stage: 'quick', ms: Date.now() - t0 };
}

/** Stage 2: the rug + holder checks only (no tweets, no AI), so the risk is on screen first. */
async function riskStage(input, ctx) {
  const t0 = Date.now();
  const found = await find(input, ctx);
  if (!found) return { found: false, stage: 'full', message: 'No coin found in what you selected. Box a ticker, a CA, or a coin card.' };
  const r = research(found, ctx, await slowChecks(found.mint, found.pair, ctx));
  return { ...r, stage: 'risk', ms: Date.now() - t0 };
}

const aiCache = new Map();     // mint -> {at, ai}: Claude's write-up for a coin, reused for 2 minutes
const fullInflight = new Map(); // mint -> Promise: a coin being researched right now (prefetch + drop share it)
async function full(input, ctx) {
  const t0 = Date.now(), timing = {};
  const found = await find(input, ctx);
  timing.find = Date.now() - t0;
  if (!found) return { found: false, stage: 'full', message: 'No coin found in what you selected. Box a ticker, a CA, or a coin card.' };
  if (!fullInflight.has(found.mint)) {
    const p = (async () => {
      const story = require('./story');
      const meta = storyMeta(found, ctx);
      const t1 = Date.now();
      const [slow, xs] = await Promise.all([
        slowChecks(found.mint, found.pair, ctx).then(v => { timing.checks = Date.now() - t1; return v; }),
        within(story.xSearch(meta, ctx.tioKey), 2000).then(v => { timing.x = Date.now() - t1; return v; }),
      ]);
      const r = research(found, ctx, { ...slow, story: story.assemble(meta, story.local(meta, ctx), xs || { tweets: [], note: 'X search timed out' }) });
      const hit = aiCache.get(found.mint);
      if (hit && Date.now() - hit.at < 120000) { r.ai = hit.ai; timing.ai = 0; }
      else {
        const t2 = Date.now();
        r.ai = await aiVerdict(ctx.getConfig(), r.facts, r.rules);
        timing.ai = Date.now() - t2;
        if (r.ai) { aiCache.set(found.mint, { at: Date.now(), ai: r.ai }); if (aiCache.size > 300) aiCache.delete(aiCache.keys().next().value); }
      }
      return { ...r, stage: 'full', timing: { ...timing } };
    })().finally(() => fullInflight.delete(found.mint));
    fullInflight.set(found.mint, p);
  }
  return { ...(await fullInflight.get(found.mint)), ms: Date.now() - t0 };
}

/** Pre-warm a coin you'll probably box soon (hot watchlist coins): market data + slow checks, no AI. */
function warm(mint, ctx) {
  pairForMint(mint).then(pair => slowChecks(mint, pair, ctx)).catch(() => {});
}

// Old single-call entry point (full answer)
const lens = (input, ctx) => full(input, ctx);

module.exports = { lens, quick, risk: riskStage, full, warm, findCoin };
