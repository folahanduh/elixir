// Launch radar: big money going into brand-new coins, live.
//
// What it catches:
//   • A dev opening a coin with a big buy of their own (pump.fun / LetsBonk create).
//   • Big buys piling into a coin in its first minutes. Small buys (under `minBuySol`) are ignored,
//     so a swarm of $100 buys never counts; only real size does.
//   • A new Meteora / Raydium / other pool opened with big liquidity (the "$50K into a fresh CA" case),
//     or doing big volume in its first minutes.
// Every coin that crosses the watch bar goes on the live watchlist with its current name, image, dev,
// CA and the wallets that put the money in. Crossing the alert bar fires a LAUNCH VOLUME / BIG POOL ping.
//
// Sources (free, no key):
//   • PumpPortal data websocket (pump.fun + LetsBonk launches and their trades). One connection:
//     new-coin events, plus trade events only for coins in their first few minutes.
//   • GeckoTerminal "new pools" (all Solana DEXes), polled every 30 s within its rate limit.
// Light on purpose: JSON events only, no RPC calls, capped subscriptions, throttled UI updates.

const PUMPPORTAL = 'wss://pumpportal.fun/api/data';
const GT_NEW = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,dex&page=';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN = 60000;

class LaunchRadar {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {(e:string, d:any) => void} o.send
   * @param {(item:object, title:string, important:boolean) => void} o.onAlert
   * @param {boolean} o.demo
   */
  constructor(o) {
    Object.assign(this, o);
    this.items = new Map();      // mint -> item
    this.byCurve = new Map();    // bonding-curve address -> mint (Axiom links to a coin on the curve use it)
    this.subs = new Set();       // mints subscribed for trades
    this.pendingSub = new Set(); this.pendingUnsub = new Set();
    this.solUsd = null;
    this.status = 'starting…';
    this.gen = 0;
    this.dirty = new Set();
    this.startT = setTimeout(() => this.restart(), o.demo ? 500 : 5000);
    this.timers = [
      setInterval(() => this.flush(), 1000),          // batched UI updates + (un)subscribes
      setInterval(() => this.sweep(), 30 * 1000),     // drop coins that didn't make the list
      setInterval(() => this.pollPools(), 30 * 1000), // GeckoTerminal new pools
      setInterval(() => this.price(), 5 * MIN),
    ];
  }

  get cfg() {
    return { enabled: true, minBuySol: 3, watchSol: 30, alertSol: 100, devSol: 10, windowMin: 5, poolUsd: 50000, poolVolUsd: 100000, ...(this.getConfig().radar || {}) };
  }

  restart() {
    clearTimeout(this.startT);
    this.gen++;
    try { this.ws?.close(); } catch {}
    this.ws = null; this.subs.clear();
    if (!this.cfg.enabled) return this.setStatus('off');
    if (this.demo) return this.runDemo();
    this.connect(this.gen);
    this.price();
    this.pollPools();
  }
  setStatus(s) { this.status = s; this.send('radar-status', { status: s, solUsd: this.solUsd }); }

  // ---------- PumpPortal ----------
  connect(gen, retry = 0) {
    if (gen !== this.gen) return;
    let ws;
    try { ws = new WebSocket(this.cfg.pumpportalWs || PUMPPORTAL); } catch (e) { return this.setStatus('launch feed unavailable: ' + e.message); }
    this.ws = ws;
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // re-subscribe coins still in their first minutes
      const keep = [...this.items.values()].filter(i => i.source === 'launch' && Date.now() - i.createdAt < this.cfg.windowMin * MIN).map(i => i.mint);
      this.subs.clear();
      if (keep.length) { ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: keep })); keep.forEach(m => this.subs.add(m)); }
      this.setStatus('live · watching new launches');
    };
    ws.onmessage = m => {
      let d; try { d = JSON.parse(String(m.data)); } catch { return; }
      if (!d || !d.mint) return;
      if (d.txType === 'create') this.onCreate(d);
      else if (d.txType === 'buy' || d.txType === 'sell') this.onTrade(d);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (gen !== this.gen) return;
      this.setStatus('launch feed reconnecting…');
      setTimeout(() => this.connect(gen, retry + 1), Math.min(30000, 2000 * 2 ** retry));
    };
  }

  mintForCurve(addr) { return this.byCurve.get(addr) || null; }

  item(mint, base = {}) {
    let it = this.items.get(mint);
    if (!it) {
      it = { mint, name: null, symbol: null, image: null, pad: null, source: 'launch', createdAt: Date.now(), dev: null, devSol: 0,
        buyers: new Map(), bigSol: 0, bigBuys: 0, buySol: 0, sellSol: 0, trades: 0, mcSol: null, mcUsd: null, liqUsd: null, vol5mUsd: null,
        watch: false, level: 0, poolAlerted: false, lastAt: Date.now(), ...base };
      this.items.set(mint, it);
    }
    return it;
  }

  onCreate(d) {
    const c = this.cfg;
    const it = this.item(d.mint, { name: d.name || null, symbol: d.symbol || null, uri: d.uri || null, pad: d.pool === 'bonk' ? 'LetsBonk' : 'Pump', dev: d.traderPublicKey || null, createSig: d.signature || null });
    it.devSol = Number(d.solAmount) || 0;
    if (d.bondingCurveKey) { it.curve = d.bondingCurveKey; this.byCurve.set(d.bondingCurveKey, d.mint); if (this.byCurve.size > 50000) this.byCurve.delete(this.byCurve.keys().next().value); }
    it.mcSol = Number(d.marketCapSol) || null;
    // The dev's own opening buy is the first big buy when it's big enough.
    if (it.dev && it.devSol >= c.minBuySol && !it.buyers.has(it.dev)) {
      it.buyers.set(it.dev, { wallet: it.dev, sol: it.devSol, buys: 1, first: Date.now(), dev: true });
      it.bigSol += it.devSol; it.bigBuys++;
    }
    // Follow its trades through the first minutes (the window where launch money shows up).
    if (!this.subs.has(d.mint)) { this.pendingSub.add(d.mint); this.subs.add(d.mint); }
    if (it.devSol >= c.devSol) this.promote(it, 'dev');
    this.check(it);
  }

  onTrade(d) {
    const it = this.items.get(d.mint) || this.item(d.mint, { pad: d.pool === 'bonk' ? 'LetsBonk' : 'Pump' });
    const sol = Number(d.solAmount) || 0;
    it.trades++; it.lastAt = Date.now();
    it.mcSol = Number(d.marketCapSol) || it.mcSol;
    if (d.txType === 'buy') {
      it.buySol += sol;
      if (sol >= this.cfg.minBuySol && Date.now() - it.createdAt <= this.cfg.windowMin * MIN) {
        const w = d.traderPublicKey || '?';
        const b = it.buyers.get(w) || { wallet: w, sol: 0, buys: 0, first: Date.now(), dev: w === it.dev };
        b.sol += sol; b.buys++;
        it.buyers.set(w, b);
        it.bigSol += sol; it.bigBuys++;
      }
    } else it.sellSol += sol;
    this.check(it);
  }

  /** Watch bar and alert bar. */
  check(it) {
    const c = this.cfg;
    const inSol = it.bigSol;
    it.inSol = inSol;
    if (!it.watch && (inSol >= c.watchSol || it.devSol >= c.devSol)) this.promote(it, 'volume');
    const levels = [1, 2, 5, 10].map(x => x * c.alertSol);
    const hit = levels.filter(l => inSol >= l).pop();
    if (hit && hit > it.level && Date.now() - it.createdAt <= (c.windowMin + 1) * MIN) {
      it.level = hit; it.hot = true;
      this.promote(it, 'volume');
      const age = Math.max(0, Math.round((Date.now() - it.createdAt) / 60000));
      const usd = this.solUsd ? ` (~$${fmt(inSol * this.solUsd)})` : '';
      const name = it.symbol ? `$${it.symbol}${it.name && it.name !== it.symbol ? ' · ' + it.name : ''}` : 'a new coin';
      this.onAlert?.(this.view(it), `LAUNCH VOLUME · ${name} took ${Math.round(inSol)} SOL${usd} from ${it.buyers.size || 1} big wallet${it.buyers.size === 1 ? '' : 's'} in its first ${age || 1}m${it.devSol >= 1 ? ` (dev ${it.devSol.toFixed(1)} SOL)` : ''} · ${it.pad || ''} · CA ${it.mint}`, true);
    }
    this.dirty.add(it.mint);
  }

  promote(it, why) {
    if (!it.watch) { it.watch = true; it.watchedAt = Date.now(); it.why = why; this.meta(it); }
    this.dirty.add(it.mint);
  }

  /** Image + socials from the coin's metadata (only for watchlisted coins). */
  async meta(it) {
    if (!it.uri || it.image) return;
    try {
      const url = it.uri.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/');
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const j = await r.json();
      it.image = typeof j.image === 'string' ? j.image : null;
      it.twitter = typeof j.twitter === 'string' ? j.twitter : null;
      it.website = typeof j.website === 'string' ? j.website : null;
      it.description = typeof j.description === 'string' ? j.description.slice(0, 200) : null;
      this.dirty.add(it.mint);
    } catch {}
  }

  // ---------- GeckoTerminal new pools (Meteora, Raydium, …) ----------
  async pollPools() {
    if (!this.cfg.enabled || this.demo || this.polling) return;
    this.polling = true;
    try {
      for (const page of [1, 2]) {
        const r = await fetch(GT_NEW + page, { headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) break;
        const j = await r.json();
        const inc = new Map((j.included || []).map(x => [x.type + ':' + x.id, x.attributes || {}]));
        for (const p of j.data || []) {
          const a = p.attributes || {};
          const baseId = p.relationships?.base_token?.data?.id || '';
          const mint = baseId.replace(/^solana_/, '');
          if (!mint || mint === SOL_MINT) continue;
          const created = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
          if (!created || Date.now() - created > 60 * MIN) continue;
          const liq = Number(a.reserve_in_usd) || 0, vol5 = Number(a.volume_usd?.m5) || 0;
          const dexId = p.relationships?.dex?.data?.id || '';
          const dexName = inc.get('dex:' + dexId)?.name || dexId;
          const tok = inc.get('token:' + baseId) || {};
          const c = this.cfg;
          if (liq < c.poolUsd / 2 && vol5 < c.poolVolUsd / 2 && !this.items.get(mint)?.watch) continue;
          const it = this.item(mint, { source: 'pool', createdAt: created });
          Object.assign(it, { liqUsd: liq, vol5mUsd: vol5, pool: a.address, pad: it.pad || dexName, name: it.name || tok.name || null, symbol: it.symbol || tok.symbol || null,
            image: it.image || (tok.image_url && tok.image_url !== 'missing.png' ? tok.image_url : null), mcUsd: Number(a.market_cap_usd || a.fdv_usd) || null, buyersCount: a.transactions?.m5?.buyers ?? null, lastAt: Date.now() });
          this.promote(it, 'pool');
          const label = it.symbol ? '$' + it.symbol : 'a new coin';
          if (liq >= c.poolUsd && !it.poolAlerted) {
            it.poolAlerted = true; it.hot = true;
            this.onAlert?.(this.view(it), `BIG POOL · ${label} opened on ${dexName} with $${fmt(liq)} liquidity, ${Math.round((Date.now() - created) / 60000)}m old · CA ${mint}`, true);
          }
          if (vol5 >= c.poolVolUsd && !it.volAlerted) {
            it.volAlerted = true; it.hot = true;
            this.onAlert?.(this.view(it), `LAUNCH VOLUME · ${label} did $${fmt(vol5)} in 5 min on ${dexName} (${it.buyersCount ?? '?'} buyers) · CA ${mint}`, true);
          }
          this.dirty.add(mint);
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch {} finally { this.polling = false; }
  }

  async price() {
    const shared = require('./solprice').snapshot();
    if (shared.price) { this.solUsd = shared.price; return; }
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`, { signal: AbortSignal.timeout(6000) });
      const pairs = await r.json();
      const p = (Array.isArray(pairs) ? pairs : []).filter(x => x.baseToken?.address === SOL_MINT && x.priceUsd).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (p) this.solUsd = Number(p.priceUsd);
    } catch {}
  }

  // ---------- housekeeping ----------
  flush() {
    if (this.ws?.readyState === 1) {
      if (this.pendingSub.size) { this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.pendingSub] })); this.pendingSub.clear(); }
      if (this.pendingUnsub.size) { this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [...this.pendingUnsub] })); this.pendingUnsub.clear(); }
    }
    for (const m of this.dirty) { const it = this.items.get(m); if (it?.watch) this.send('radar', this.view(it)); }
    this.dirty.clear();
  }
  sweep() {
    const c = this.cfg, now = Date.now();
    for (const [m, it] of this.items) {
      const young = now - it.createdAt <= c.windowMin * MIN;
      // Past the launch window: stop following its trades, forget it unless it made the list.
      if (!young && this.subs.has(m)) { this.subs.delete(m); this.pendingUnsub.add(m); }
      if (!young && !it.watch) this.items.delete(m);
      else if (it.watch && now - (it.watchedAt || it.createdAt) > 6 * 60 * MIN) this.items.delete(m);
    }
    // Keep the list a sane size
    const watched = [...this.items.values()].filter(i => i.watch).sort((a, b) => b.watchedAt - a.watchedAt);
    for (const it of watched.slice(200)) this.items.delete(it.mint);
    // Too many trade subscriptions (a launch storm): drop the oldest
    if (this.subs.size > 500) for (const m of [...this.subs].slice(0, this.subs.size - 500)) { this.subs.delete(m); this.pendingUnsub.add(m); }
  }

  /** What the page shows for one coin. */
  view(it, full = false) {
    const buyers = [...it.buyers.values()].sort((a, b) => b.sol - a.sol);
    return {
      mint: it.mint, name: it.name, symbol: it.symbol, image: it.image, pad: it.pad, source: it.source, createdAt: it.createdAt,
      dev: it.dev, devSol: it.devSol, inSol: it.inSol ?? 0, bigBuys: it.bigBuys, buySol: it.buySol, sellSol: it.sellSol, trades: it.trades,
      wallets: it.buyers.size, mcSol: it.mcSol, mcUsd: it.mcUsd || (it.mcSol && this.solUsd ? it.mcSol * this.solUsd : null),
      liqUsd: it.liqUsd, vol5mUsd: it.vol5mUsd, buyersCount: it.buyersCount ?? null, hot: Boolean(it.hot), level: it.level, why: it.why,
      twitter: it.twitter || null, website: it.website || null, description: it.description || null, solUsd: this.solUsd,
      buyers: (full ? buyers : buyers.slice(0, 8)).map(b => ({ wallet: b.wallet, sol: b.sol, buys: b.buys, dev: b.dev, first: b.first })),
      lastAt: it.lastAt,
    };
  }
  snapshot() {
    return { status: this.status, solUsd: this.solUsd, settings: this.cfg,
      items: [...this.items.values()].filter(i => i.watch).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 100).map(i => this.view(i)) };
  }
  get(mint) { const it = this.items.get(mint); return it ? this.view(it, true) : null; }

  // ---------- demo ----------
  runDemo() {
    this.setStatus('demo');
    this.solUsd = 180;
    const W = n => ('Demo' + String(n).padStart(4, '0') + 'xKXtg2CW87d97TXJSDpbD5jBkheTqA83').replace(/[0OIl]/g, 'x');
    const coins = [['GOATKING', 'Goat King', 18], ['NEXTPRES', 'Next President', 2], ['CHAOS', 'Chaos Dog', 40]];
    coins.forEach(([sym, name, dev], i) => setTimeout(() => {
      const mint = ('Demo' + sym.padEnd(8, 'x') + 'mint' + i + 'pumpQf8z2W9xYc4hT5aR3kLmN').replace(/[0OIl]/g, 'x'); // valid base58
      this.onCreate({ mint, txType: 'create', name, symbol: sym, traderPublicKey: W(i), solAmount: dev, marketCapSol: 32, pool: 'pump' });
      let k = 0;
      const t = setInterval(() => {
        if (++k > 14) return clearInterval(t);
        this.onTrade({ mint, txType: 'buy', traderPublicKey: W(10 + (k % 7) + i * 10), solAmount: 3 + Math.random() * (i === 2 ? 22 : 6), marketCapSol: 40 + k * 9, pool: 'pump' });
      }, 900 + i * 300);
    }, 1500 + i * 2500));
  }
}

const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

module.exports = { LaunchRadar };
