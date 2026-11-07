// Play tracker. When a big tweet (or stream moment) lands, it:
//   1. finds every coin deployed for it on the tracked launchpads (Pump, Float, Bags, Raydium)
//   2. orders them 1st / 2nd / 3rd by deploy time and ranks them by estimated REAL volume
//   3. suggests likely tickers and coin images, plus a "vamp watch" section
//   4. logs how each play ends, so the Playbook learns which launchpad and deploy slot usually wins

const fs = require('fs');
const path = require('path');
const { padsFrom, classify, goodQuote } = require('./launchpads');
const { normalize, STOP } = require('./extract');
const { checkCoin, activePreset } = require('./filters');

const DATA = path.join(__dirname, '..', 'data');
const SNAP_LOG = path.join(DATA, 'plays.jsonl');
const OUTCOME_LOG = path.join(DATA, 'play-outcomes.jsonl');

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

// Memecoin metas a narrative can "pair" with. Keyed by words that might appear in the tweet.
const META = [
  { keys: ['dog', 'dogs', 'puppy', 'doge', 'shiba', 'pup', 'woof'], meta: 'dog meta', coins: ['DOGE', 'WIF', 'BONK', 'SHIB'] },
  { keys: ['cat', 'cats', 'kitten', 'kitty', 'meow'], meta: 'cat meta', coins: ['POPCAT', 'MEW', 'MOG'] },
  { keys: ['frog', 'frogs', 'pepe', 'toad'], meta: 'frog meta', coins: ['PEPE', 'BRETT'] },
  { keys: ['goat', 'goats'], meta: 'goat / AI-agent meta', coins: ['GOAT'] },
  { keys: ['hippo', 'moodeng'], meta: 'zoo-animal meta', coins: ['MOODENG'] },
  { keys: ['penguin', 'penguins', 'pengu'], meta: 'penguin meta', coins: ['PENGU'] },
  { keys: ['monkey', 'ape', 'apes', 'chimp', 'gorilla'], meta: 'ape meta', coins: ['APE'] },
  { keys: ['ai', 'agent', 'agents', 'gpt', 'claude', 'robot', 'bot', 'grok'], meta: 'AI meta', coins: ['GOAT', 'AI16Z', 'GROK'] },
  { keys: ['elon', 'musk', 'tesla', 'spacex', 'mars', 'rocket', 'starship', 'x', 'grok'], meta: 'Elon / X meta', coins: ['DOGE', 'GROK'] },
  { keys: ['trump', 'maga', 'president', 'america', 'usa'], meta: 'Trump / political meta', coins: ['TRUMP', 'MAGA'] },
  { keys: ['hamster', 'capybara', 'raccoon', 'squirrel', 'rat', 'mouse'], meta: 'small-animal meta', coins: ['CAPY'] },
  { keys: ['coin', 'money', 'payments', 'bank'], meta: 'payments / X Money meta', coins: [] },
];
const ANIMALS = new Set('dog puppy cat kitten frog penguin hamster monkey ape goat horse duck bird fish bear bull pig rat mouse chicken cow shark whale dolphin owl wolf fox lion tiger capybara raccoon otter sloth hippo seal turtle snail crab bunny rabbit squirrel giraffe panda koala llama alpaca'.split(' '));

/** Estimated real volume: discounts volume that looks botted or washed. */
function realVolume(p) {
  const raw = p.volume?.h24 ?? 0;
  const t = p.txns?.h24 || {};
  const buys = t.buys || 0, sells = t.sells || 0, trades = buys + sells;
  const liq = p.liquidity?.usd || 0;
  const mcap = p.marketCap ?? p.fdv ?? 0;
  const flags = [];
  if (!raw) return { raw: 0, real: 0, factor: 1, quality: 'no volume', flags, trades, buys, sells };
  if (!trades) return { raw, real: raw * 0.5, factor: 0.5, quality: 'unknown', flags: ['no trade counts'], trades, buys, sells };
  let f = 1;
  const avg = raw / trades;
  if (trades < 40 && raw > 20000) { f *= 0.3; flags.push('few trades, big volume'); }
  if (liq > 0 && avg > liq * 0.2) { f *= 0.4; flags.push('trades huge vs liquidity'); }
  const balance = Math.min(buys, sells) / Math.max(buys, sells, 1);
  if (trades > 300 && avg < 25 && balance > 0.9) { f *= 0.35; flags.push('tiny matched buys/sells (volume bot)'); }
  else if (trades > 300 && avg < 12) { f *= 0.6; flags.push('micro trades'); }
  if (mcap > 0 && raw / mcap > 40) { f *= 0.6; flags.push('volume ≫ market cap'); }
  return {
    raw, real: Math.round(raw * f), factor: Math.round(f * 100) / 100,
    quality: f >= 0.8 ? 'organic' : f >= 0.4 ? 'mixed' : 'botted', flags, trades, buys, sells, avgTrade: Math.round(avg),
  };
}

/** Rule-based ticker, image and vamp ideas. Claude improves these when a key is set (playai.js). */
function ruleIdeas(play, deploys = []) {
  const terms = play.terms;
  const text = play.text.toLowerCase();
  const words = new Set(text.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/));
  const tickers = [];
  const addT = (t, why) => {
    t = String(t).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (t.length >= 2 && t.length <= 10 && !tickers.some(x => x.ticker === t)) tickers.push({ ticker: t, why });
  };
  const marketPick = [...deploys].sort((a, b) => b.vol.real - a.vol.real)[0];
  if (marketPick) addT(marketPick.symbol, 'what the top real-volume deploy is using');
  for (const m of play.text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) addT(m[1], 'cashtag in the tweet');
  for (const t of terms) {
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length === 1) addT(parts[0], 'key word');
    else {
      if (squash(t).length <= 10) addT(t, 'full name squashed');
      addT(parts[parts.length - 1], 'last word of the name');
      if (parts.length >= 3) addT(parts.map(p => p[0]).join(''), 'initials');
    }
  }

  const subject = terms.find(t => ANIMALS.has(squash(t))) || [...words].find(w => ANIMALS.has(w)) || terms[0] || 'the subject';
  const images = [];
  if (play.media?.length) images.push('The photo from the tweet itself. Most first deploys use it as-is or tightly cropped.');
  else images.push('A screenshot of the tweet. This is the go-to when the tweet is text-only.');
  images.push(`A simple cartoon / MS-Paint style ${subject}${terms[0] && terms[0] !== subject ? ` named “${terms[0]}”` : ''} on a plain background.`);
  if (play.author) images.push(`@${play.author}'s profile photo edited with the ${subject} (author-linked version).`);

  const name = terms[0] || subject;
  const T = (tickers[0] && tickers[0].ticker) || squash(name).toUpperCase().slice(0, 10);
  const metas = META.filter(m => m.keys.some(k => words.has(k) || terms.some(t => squash(t) === k)));
  const pairs = metas.length ? metas.map(m => `${m.meta}${m.coins.length ? ' (' + m.coins.map(c => '$' + c).join(', ') + ')' : ''}`).join(' · ') : 'no established meta, so it trades on the tweet alone';
  const isAnimal = ANIMALS.has(squash(subject));
  // Keep prefixes/suffixes visible when the base ticker is long (tickers max out around 10 chars).
  const fit = (pre, suf = '') => (pre + T.slice(0, Math.max(2, 10 - pre.length - suf.length)) + suf).toUpperCase();
  const vamps = [
    { name, ticker: T, angle: 'Same name and ticker relaunched on another pad. Float commonly vamps Pump coins (starts at ~$20k mcap) and is often faded.', pairsWith: `the ${deploys[0] ? deploys[0].padLabel : 'Pump'} OG`, launchpad: 'Float' },
    isAnimal
      ? { name: `Baby ${name}`, ticker: fit('B'), angle: 'Family spin-off of the original animal', pairsWith: pairs, launchpad: 'Pump' }
      : { name: `${name} CEO`, ticker: fit('', 'CEO'), angle: 'Role or character spin-off', pairsWith: pairs, launchpad: 'Pump' },
    play.author ? { name: `${play.author}'s ${isAnimal ? subject : name}`, ticker: fit(play.author.replace(/[^a-z]/gi, '').slice(0, 4)), angle: 'Ties the coin to the person who tweeted it', pairsWith: pairs, launchpad: 'Pump' } : null,
    { name: `Real ${name}`, ticker: fit('REAL'), angle: '"Real one" vamp that shows up when the first deploys get dumped', pairsWith: `the top ${name} deploy`, launchpad: 'Bags / Pump' },
  ].filter(Boolean);
  return { tickers: tickers.slice(0, 6), images, vamps, narrative: metas.length ? `Fits the ${metas.map(m => m.meta).join(' + ')}` : '', source: 'rules' };
}

class PlayTracker {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {(e:string, d:any) => void} o.send
   * @param {(term:string) => Promise<object[]>} o.search   raw DexScreener pairs
   * @param {(play:object) => Promise<object|null>} [o.enrich] Claude ideas
   * @param {(play:object, title:string) => void} [o.onAlert]
   * @param {boolean} o.demo
   */
  constructor(o) {
    Object.assign(this, o);
    this.plays = new Map(); // id -> play
    this.timer = setInterval(() => this.tick(), 1000);
  }

  get cfg() { return this.getConfig().plays; }

  list() { return [...this.plays.values()].map(p => this.view(p)); }

  view(p) {
    const { _t, ...rest } = p;
    return rest;
  }

  /** Start tracking a play for a feed item. Returns the play. */
  track(item, { reason = 'manual', terms: given = null, streamRef = null } = {}) {
    const existing = [...this.plays.values()].find(p => p.itemId === item.id);
    if (existing) return existing;
    const terms = given ? [...new Set(given.map(t => String(t).replace(/^[$#]/, '').trim()).filter(t => t && !STOP.has(t.toLowerCase())))].slice(0, 4) : [...new Set((item.candidates || [])
      .filter(c => c.watch || c.score >= 2 || c.reasons.includes('cashtag') || c.reasons.includes('quoted'))
      .map(c => c.display.replace(/^[$#]/, ''))
      .filter(t => !STOP.has(t.toLowerCase())))].slice(0, 4);
    if (!terms.length && item.candidates?.[0]) terms.push(item.candidates[0].display.replace(/^[$#]/, ''));
    // "Sir" from "Sir Woofington" is noise; "Woofington" on its own is a real ticker candidate.
    for (let i = terms.length - 1; i >= 0; i--) {
      const t = terms[i];
      if (!t.includes(' ') && t.length < 5 && terms.some(o => o.includes(' ') && o.toLowerCase().split(/\s+/).includes(t.toLowerCase()))) terms.splice(i, 1);
    }
    const play = {
      id: 'play-' + item.id, itemId: item.id, source: item.source, author: item.author, text: item.text, url: item.url,
      media: item.media || [], tweetAt: item.createdAt || item.receivedAt, startedAt: Date.now(), reason,
      terms, status: 'tracking', deploys: [], preexisting: [], ideas: null, aiIdeas: null, polls: 0, lastPollAt: null,
      streamRef,
      _t: { snaps: new Set(), nextPoll: 0, enrichAsked: false, risk: {}, peaks: {}, riskAlerted: false, ms: {} },
    };
    play.ideas = ruleIdeas(play);
    this.plays.set(play.id, play);
    this.send('play', this.view(play));
    this.poll(play);
    this.findImages(play);
    return play;
  }

  /** Search coins, memes, animals and chains for what the coin image could be. */
  async findImages(p) {
    if (!this.searchImages) return;
    const words = p.text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/);
    const subject = p.terms.find(t => ANIMALS.has(squash(t))) || words.find(w => ANIMALS.has(w)) || null;
    try {
      p.images = { ...(await this.searchImages({ terms: p.terms, subject, text: p.text })), subject, at: Date.now() };
      this.send('play', this.view(p));
    } catch (e) { p.images = { groups: [], errors: [e.message], at: Date.now() }; }
    // Second pass once deploys exist: let Claude look at the real candidates and pick.
    setTimeout(() => this.pickImage(p), this.demo ? 8000 : 45000);
  }

  async pickImage(p) {
    if (!this.imagePicker || p.status !== 'tracking') return;
    const cands = [];
    for (const u of p.media || []) cands.push({ from: 'tweet photo', label: 'Tweet photo', image: u });
    for (const d of [...p.deploys].sort((a, b) => b.vol.real - a.vol.real).slice(0, 3)) if (d.image) cands.push({ from: `${d.orderLabel} deploy`, label: '$' + d.symbol, image: d.image });
    for (const g of p.images?.groups || []) for (const it of g.items.slice(0, 2)) cands.push({ from: g.title, label: it.label, image: it.image });
    const usable = cands.filter(c => /^https:\/\//.test(c.image)).slice(0, 8);
    if (usable.length < 2) return;
    try {
      const r = await this.imagePicker(p, usable);
      if (r) { p.imagePick = { ...r, candidate: usable[r.index] || null }; this.send('play', this.view(p)); }
    } catch (e) { p.imagePickError = e.message; }
  }

  untrack(id) {
    const p = this.plays.get(id);
    if (!p) return;
    this.finish(p, 'stopped');
    this.plays.delete(id);
    this.send('play-removed', { id });
  }

  /** Auto-play rule for tweets. Called after the feed's own coin checks. */
  consider(item, dexResults) {
    if (item.source !== 'x' || item.stale || !this.cfg.auto) return;
    let score = 0;
    const why = [];
    // A VIP tweet alone isn't a play (big accounts tweet all day). It needs coins deploying,
    // huge engagement or a watchlist hit on top.
    if (item.vip) { score += 3; why.push('VIP'); }
    if (item.watch?.length) { score += 2; why.push('watchlist'); }
    const eng = item.engagement || {};
    if ((eng.views || 0) >= 1e6 || (eng.likes || 0) >= 20000) { score += 3; why.push('huge engagement'); }
    else if ((eng.likes || 0) >= 5000) { score += 2; why.push('big engagement'); }
    const fresh = Object.values(dexResults || {}).filter(r => r && r.status === 'fresh');
    if (fresh.length) { score += 3; why.push('coins already deploying'); }
    if (score >= this.cfg.autoScore) {
      // Keep the board readable: drop the oldest finished auto-plays beyond 15.
      const autos = [...this.plays.values()].filter(p => p.reason !== 'manual');
      if (autos.length >= 15) { const old = autos.find(p => p.status !== 'tracking') || autos[0]; this.untrack(old.id); }
      const play = this.track(item, { reason: why.join(' + ') || 'auto' });
      this.onAlert?.(play, `PLAY · @${item.author}: ${why.join(' + ')}`);
    }
  }

  /**
   * A coin-able line said on a live stream (e.g. DV naming something on stream): track it like a tweet play,
   * so its 1st/2nd/3rd deploys get ranked and you hear when one runs (20k, 50k…).
   */
  considerStream(item, seg, session) {
    if (!this.cfg.auto || !seg) return null;
    const kws = seg.keywords || [];
    const coinable = kws.filter(k => k.kind === 'coinable' || k.kind === 'watch' || k.kind === 'ai').map(k => k.text);
    const ideas = seg.ai?.ticker_ideas || [];
    if (!coinable.length && !ideas.length) return null;
    let score = 0;
    const why = [];
    if (coinable.length) { score += 3; why.push('coin-able line'); }
    if (seg.pinged) { score += 2; why.push('pinged'); }
    if (kws.some(k => k.kind === 'watch')) { score += 2; why.push('watchlist'); }
    if (ideas.length) { score += 1; why.push('Claude ticker idea'); }
    if (Object.values(seg.dex || {}).some(r => r && r.status === 'fresh')) { score += 3; why.push('coins already deploying'); }
    if (score < this.cfg.autoScore) return null;
    const autos = [...this.plays.values()].filter(p => p.reason !== 'manual');
    if (autos.length >= 25) { const old = autos.find(p => p.status !== 'tracking') || autos[0]; this.untrack(old.id); }
    return this.track(item, { reason: 'stream: ' + why.join(' + '), terms: [...coinable, ...ideas], streamRef: { sid: session.id, segId: seg.id } });
  }

  async tick() {
    const now = Date.now();
    for (const p of this.plays.values()) {
      if (p.status !== 'tracking') continue;
      const ageMin = (now - p.tweetAt) / 60000;
      if (ageMin > this.cfg.trackMinutes) { this.finish(p, 'done'); continue; }
      if (now >= p._t.nextPoll) this.poll(p);
      for (const m of [15, 60, 180]) if (ageMin >= m && !p._t.snaps.has(m)) { p._t.snaps.add(m); this.snapshot(p, m); }
    }
  }

  async poll(p) {
    const ageMin = (Date.now() - p.tweetAt) / 60000;
    const speed = this.demo ? Math.max(1, Number(process.env.DEMO_SPEED) || 1) : 1; // demo walkthroughs run faster
    p._t.nextPoll = Date.now() + Math.max(1500, (ageMin < 30 ? 15000 : 60000) / speed);
    const pads = padsFrom(this.getConfig());
    const searchTerms = [...new Set([...p.terms, ...((p.aiIdeas?.tickers || []).map(t => t.ticker).slice(0, 2))])].slice(0, 5);
    const all = [];
    for (const term of searchTerms) {
      try {
        const pairs = this.demo ? demoPairs(term, p.tweetAt) : await this.search(term);
        all.push(...pairs.map(x => ({ ...x, _term: term })));
      } catch (e) { p.error = e.message; }
    }
    const byMint = new Map();
    for (const pair of all) {
      const pad = classify(pair, pads);
      if (!pad || !goodQuote(pair)) continue; // only Pump / Float / Bags / Raydium, SOL or USDC quoted
      const sym = squash(pair.baseToken?.symbol), name = squash(pair.baseToken?.name);
      const match = p.terms.concat((p.aiIdeas?.tickers || []).map(t => t.ticker)).some(t => {
        const q = squash(t);
        return q.length >= 2 && (sym === q || name === q || (q.length >= 4 && (sym.includes(q) || name.includes(q))) || (sym.length >= 4 && q.includes(sym)));
      });
      if (!match) continue;
      const mint = pair.baseToken.address;
      const prev = byMint.get(mint);
      if (prev && (prev.liquidity?.usd || 0) >= (pair.liquidity?.usd || 0)) continue;
      byMint.set(mint, { ...pair, _pad: pad });
    }
    const deploys = [], pre = [];
    for (const pair of byMint.values()) {
      const pad = pads[pair._pad];
      const d = {
        address: pair.baseToken.address, pairAddress: pair.pairAddress, symbol: pair.baseToken.symbol, name: pair.baseToken.name,
        pad: pair._pad, padLabel: pad.label, padColor: pad.color, dexId: pair.dexId, labels: pair.labels || [],
        createdAt: pair.pairCreatedAt || null,
        afterTweetSec: pair.pairCreatedAt ? Math.round((pair.pairCreatedAt - p.tweetAt) / 1000) : null,
        marketCap: pair.marketCap ?? pair.fdv ?? null, liquidityUsd: pair.liquidity?.usd ?? null,
        change5m: pair.priceChange?.m5 ?? null, change1h: pair.priceChange?.h1 ?? null,
        vol: realVolume(pair), image: pair.info?.imageUrl || null,
        links: {
          gmgn: `https://gmgn.ai/sol/token/${pair.baseToken.address}`,
          axiom: `https://axiom.trade/meme/${pair.pairAddress}`,
          dexscreener: pair.url,
          pumpfun: pair._pad === 'pump' ? `https://pump.fun/coin/${pair.baseToken.address}` : null,
        },
        flags: [],
      };
      // Deployed after the tweet (2-minute allowance for clock drift) → a deploy for this play.
      if (d.createdAt && d.createdAt >= p.tweetAt - 120000) deploys.push(d); else pre.push(d);
    }
    // Rug / bundle / fake-chart checks (cached per coin) and rug detection from the price peak.
    for (const d of deploys) {
      const pk = p._t.peaks[d.address] || (p._t.peaks[d.address] = { mcap: 0, liq: 0 });
      pk.mcap = Math.max(pk.mcap, d.marketCap || 0);
      pk.liq = Math.max(pk.liq, d.liquidityUsd || 0);
      d.peakMcap = pk.mcap;
      const rk = p._t.risk[d.address];
      if (rk) d.risk = rk;
      if (this.risk && (!rk || Date.now() - rk.checkedAt > (this.demo ? 20000 : 120000))) {
        this.risk.assess(d.address, { volume24: d.vol.raw, volQuality: d.vol.quality, volFlags: d.vol.flags })
          .then(r => { if (r) { p._t.risk[d.address] = r; d.risk = r; this.send('play', this.view(p)); } })
          .catch(() => {});
      }
      const dropped = pk.mcap >= 20000 && (d.marketCap || 0) <= pk.mcap * 0.15;
      const pulled = pk.liq >= 5000 && (d.liquidityUsd || 0) <= pk.liq * 0.1;
      if ((dropped || pulled) && !p._t.peaks[d.address].rugged) {
        pk.rugged = { at: Date.now(), dropPct: Math.round((1 - (d.marketCap || 0) / pk.mcap) * 100), pulled };
        this.risk?.record(d.address, 'rug', { symbol: d.symbol, creator: d.risk?.creator, bundleWallets: d.risk?.bundle?.walletList || [], peakMcap: pk.mcap, lastMcap: d.marketCap });
        if (this.risk) this.send('risk-memory', this.risk.memorySummary());
        this.onAlert?.(p, `RUG · $${d.symbol} on ${d.padLabel} is down ${pk.rugged.dropPct}% from its peak${pulled ? ', liquidity pulled' : ''}. Creator and bundle wallets saved to memory`);
      }
      if (pk.rugged) d.rugged = pk.rugged;
    }

    // Run every coin through the active filter preset (e.g. DVCES's Pulse filters).
    const preset = activePreset(this.getConfig());
    for (const d of deploys.concat(pre)) {
      if (!preset) break;
      const r = checkCoin({ createdAt: d.createdAt, marketCap: d.marketCap, volume: d.vol.raw, feesSol: null, dexId: d.dexId, labels: d.labels }, pads[d.pad], preset);
      const prev = p.deploys.find(x => x.address === d.address)?.filter;
      d.filter = {
        preset: preset.label, pass: r.pass, stage: r.stage, column: r.column, checks: r.checks,
        // Sticky: remember the first time (and column) it passed, since New Pairs only lasts 5 minutes.
        passedAt: prev?.passedAt || (r.pass ? Date.now() : null), passedColumn: prev?.passedColumn || (r.pass ? r.column : null),
      };
    }
    deploys.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    deploys.forEach((d, i) => { d.order = i + 1; d.orderLabel = ordinal(i + 1); });
    // Vamps: the same name showing up again after an earlier deploy, especially on a different pad.
    for (const d of deploys) {
      const earlier = deploys.find(e => e.order < d.order && (squash(e.symbol) === squash(d.symbol) || squash(e.name) === squash(d.name)));
      if (earlier) {
        d.vampOf = { symbol: earlier.symbol, pad: earlier.padLabel, order: earlier.order };
        d.flags.push(d.pad !== earlier.pad ? `VAMP of the ${earlier.orderLabel} (${earlier.padLabel})` : 'copy');
        if (d.pad === 'float' && earlier.pad === 'pump') d.flags.push('Float vamping a Pump coin');
      }
      if (d.order === 1) d.flags.push('OG');
    }
    const ranked = [...deploys].sort((a, b) => b.vol.real - a.vol.real);
    ranked.forEach((d, i) => { d.rank = i + 1; });
    const newDeploys = deploys.filter(d => !p.deploys.some(x => x.address === d.address));
    const newlyPassed = deploys.filter(d => d.filter?.passedAt && !p.deploys.find(x => x.address === d.address)?.filter?.passedAt);
    p.deploys = deploys;
    p.preexisting = pre.sort((a, b) => b.vol.real - a.vol.real).slice(0, 3);
    p.winner = ranked[0]?.address || null;
    p.polls++; p.lastPollAt = Date.now();
    p.ideas = ruleIdeas(p, deploys);
    if (newDeploys.length && p.polls > 1) {
      const d = newDeploys[0];
      this.onAlert?.(p, `DEPLOY · ${d.orderLabel} for ${p.source === 'stream' ? p.author + "'s stream" : '@' + p.author + "'s play"}: $${d.symbol} on ${d.padLabel}${d.vampOf ? ' (vamp)' : ''}`);
    }
    // Market-cap milestones: ping when a deploy crosses 20k / 50k / 100k / 250k / 1M (once each).
    const MS = this.cfg.milestones || [20000, 50000, 100000, 250000, 1000000];
    for (const d of deploys) {
      const mc = d.marketCap || 0;
      const hit = MS.filter(m => mc >= m).pop();
      const prev = p._t.ms[d.address];
      if (prev === undefined && p.polls <= 1) { p._t.ms[d.address] = hit || 0; continue; } // already there when first seen: no stale ping
      if (hit && hit > (prev || 0) && !p._t.peaks[d.address]?.rugged) {
        p._t.ms[d.address] = hit;
        const k = hit >= 1e6 ? (hit / 1e6) + 'M' : (hit / 1e3) + 'K';
        const from = p.source === 'stream' ? `${p.author}'s stream` : `@${p.author}'s play`;
        this.onAlert?.(p, `${k} · $${d.symbol} (${d.orderLabel}, ${d.padLabel}) from ${from} just hit $${k} mcap`);
        this.onMilestone?.(p, d, hit);
      } else if (prev === undefined) p._t.ms[d.address] = hit || 0;
    }
    const topCoin = ranked[0];
    if (topCoin?.risk?.level === 'high' && !p._t.riskAlerted) {
      p._t.riskAlerted = true;
      this.onAlert?.(p, `RISK · top coin $${topCoin.symbol} for ${p.source === 'stream' ? p.author + "'s stream" : '@' + p.author + "'s play"}: ${topCoin.risk.headline}`);
    }
    for (const d of newlyPassed.slice(0, 2)) {
      this.onAlert?.(p, `FILTER PASS · $${d.symbol} (${d.orderLabel}, ${d.padLabel}) passed the ${d.filter.preset} ${d.filter.passedColumn} filter`);
    }
    if (!p._t.enrichAsked && this.enrich) {
      p._t.enrichAsked = true;
      this.enrich(p).then(ai => {
        if (!ai) return;
        p.aiIdeas = { ...ai, source: 'claude' };
        this.send('play', this.view(p));
      }).catch(e => { p.aiError = e.message; });
    }
    this.send('play', this.view(p));
  }

  snapshot(p, minutes) {
    const rec = {
      playId: p.id, author: p.author, text: p.text.slice(0, 200), tweetAt: p.tweetAt, minutes, at: Date.now(),
      deploys: p.deploys.map(d => ({ symbol: d.symbol, pad: d.pad, order: d.order, rank: d.rank, realVol: d.vol.real, rawVol: d.vol.raw, mcap: d.marketCap, vamp: Boolean(d.vampOf), afterTweetSec: d.afterTweetSec })),
    };
    fs.appendFile(SNAP_LOG, JSON.stringify(rec) + '\n', () => {});
  }

  finish(p, status) {
    if (p.status !== 'tracking') return;
    p.status = status;
    for (const d of p.deploys) {
      if (d.rugged || !d.peakMcap) continue;
      if ((d.marketCap || 0) >= d.peakMcap * 0.5) this.risk?.record(d.address, 'held', { symbol: d.symbol, creator: d.risk?.creator, peakMcap: d.peakMcap, lastMcap: d.marketCap });
    }
    if (p.deploys.length) {
      const w = [...p.deploys].sort((a, b) => b.vol.real - a.vol.real)[0];
      const floatVamps = p.deploys.filter(d => d.pad === 'float' && d.vampOf && d.vampOf.pad === 'Pump');
      const outcome = {
        playId: p.id, author: p.author, at: Date.now(), minutesTracked: Math.round((Date.now() - p.tweetAt) / 60000),
        deploys: p.deploys.length, pads: [...new Set(p.deploys.map(d => d.pad))],
        winner: { symbol: w.symbol, pad: w.pad, order: w.order, realVol: w.vol.real, mcap: w.marketCap, vamp: Boolean(w.vampOf) },
        floatVamps: floatVamps.length, floatVampWon: floatVamps.some(d => d.address === w.address),
      };
      fs.appendFile(OUTCOME_LOG, JSON.stringify(outcome) + '\n', () => {});
    }
    this.send('play', this.view(p));
  }

  /** What past plays say: which pad and which deploy slot usually ends up with the most real volume. */
  stats() {
    let rows = [];
    try { rows = fs.readFileSync(OUTCOME_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
    const n = rows.length;
    const padWins = {}, orderWins = {};
    let floatVampPlays = 0, floatVampWins = 0, vampWins = 0;
    for (const r of rows) {
      padWins[r.winner.pad] = (padWins[r.winner.pad] || 0) + 1;
      const o = r.winner.order >= 4 ? '4th+' : ordinal(r.winner.order);
      orderWins[o] = (orderWins[o] || 0) + 1;
      if (r.floatVamps) { floatVampPlays++; if (r.floatVampWon) floatVampWins++; }
      if (r.winner.vamp) vampWins++;
    }
    const pct = x => (n ? Math.round((x / n) * 100) : 0);
    return {
      plays: n,
      padWins: Object.fromEntries(Object.entries(padWins).map(([k, v]) => [k, { wins: v, pct: pct(v) }])),
      orderWins: Object.fromEntries(Object.entries(orderWins).map(([k, v]) => [k, { wins: v, pct: pct(v) }])),
      vampWinPct: pct(vampWins),
      floatVamp: { plays: floatVampPlays, won: floatVampWins },
      notes: this.cfg.notes || [],
    };
  }
}

// ---------- demo market data: deploys appear one by one after the tweet ----------
function demoPairs(term, tweetAt) {
  const speed = Math.max(1, Number(process.env.DEMO_SPEED) || 1);
  const h = [...term].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
  const sym = term.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  const plan = [
    { pad: 'pump', suffix: 'pump', dex: 'pumpfun', delay: 25 + (h % 20), vol: 1, sym, name: term },
    { pad: 'float', suffix: 'flt', dex: 'float', delay: 70 + (h % 30), vol: 0.35, sym, name: term },
    { pad: 'pump', suffix: 'pump', dex: 'pumpfun', delay: 110, vol: 0.5, sym: sym.slice(0, 5), name: term, bot: true },
    { pad: 'bags', suffix: 'BAGS', dex: 'meteora', delay: 160, vol: 0.2, sym: 'REAL' + sym.slice(0, 6), name: 'Real ' + term },
    { pad: 'raydium', suffix: 'bonk', dex: 'raydium', delay: 230, vol: 0.15, sym, name: term },
  ];
  const now = Date.now();
  return plan.filter(x => tweetAt + (x.delay / speed) * 1000 <= now).map((x, i) => {
    const mins = ((now - tweetAt) * speed - x.delay * 1000) / 60000;
    const vol = Math.round((40000 + (h % 30000)) * x.vol * Math.min(12, 0.6 + mins));
    const trades = x.bot ? Math.round(vol / 9) : Math.round(vol / 140);
    const mcap = Math.round((x.pad === 'float' ? 20000 : 6000) + vol * (x.bot ? 0.08 : 0.55));
    // Demo: the Bags "Real …" copy rugs a while after launch.
    const rugNow = x.pad === 'bags' && mins > 6;
    const mcapNow = rugNow ? Math.round(mcap * 0.06) : mcap;
    const graduated = x.pad === 'pump' && mcap > 69000;
    return {
      chainId: 'solana', dexId: graduated ? 'pumpswap' : x.dex, url: `https://dexscreener.com/solana/demo${h}${i}`, pairAddress: `Demo${h}${i}Pair`,
      labels: x.pad === 'bags' ? ['DBC'] : x.pad === 'raydium' ? ['LaunchLab'] : [],
      baseToken: { address: `Demo${h}${i}xxxxxxxxxxxxxx${x.suffix}`, name: x.name, symbol: x.sym },
      quoteToken: { symbol: 'SOL' },
      marketCap: mcapNow, liquidity: { usd: Math.round(mcapNow / 6) },
      volume: { h24: vol, h1: vol, m5: Math.round(vol / 8) },
      txns: { h24: { buys: Math.round(trades * (x.bot ? 0.5 : 0.58)), sells: Math.round(trades * (x.bot ? 0.5 : 0.42)) } },
      priceChange: { m5: (h % 40) - 10, h1: (h % 90) - 5 },
      pairCreatedAt: tweetAt + (x.delay / speed) * 1000,
    };
  });
}

module.exports = { PlayTracker, realVolume, ruleIdeas, demoPairs };
