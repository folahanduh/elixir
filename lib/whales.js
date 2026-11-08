// Whale tracker: follow the money before a coin launches.
//
// The pattern behind most big launches: a whale (or the team) moves SOL into a brand-new wallet,
// and that wallet deploys the coin or buys it in the first minutes. So:
//   1. Watch whale wallets live (your list, plus the KOL wallets already streaming).
//   2. A big SOL transfer to a FRESH wallet (almost no history) → that wallet is followed for 48 h,
//      and so is anything it funds in turn (up to 3 hops).
//   3. A followed wallet buying a very new coin, or deploying one → ping, with the money trail.
// Plus on-demand tracing: who funded this wallet (hop by hop), and who the early buyers of a coin
// were and where their money came from (shared funders = one group buying through many wallets).
//
// Data: your Solana RPC (Helius) for everything; Solscan (optional key) adds name labels
// ("Binance", "Coinbase"…) and finds the first funder of old wallets in one call.

const fs = require('fs');
const path = require('path');
const limit = require('./limit');

const DATA = path.join(__dirname, '..', 'data', 'whales.json');
const STABLES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const SYSTEM = '11111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const isWallet = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
const HOUR = 3600000;

class WhaleWatcher {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {(e:string, d:any) => void} o.send
   * @param {(mint:string) => Promise<object|null>} o.tokenInfo
   * @param {(ev:object, title:string, important:boolean) => void} o.onAlert
   * @param {() => object[]} o.kolList  tracked KOL wallets (for names)
   */
  constructor(o) {
    Object.assign(this, o);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
    this.children = new Map(Object.entries(saved.children || {})); // wallet -> {parent, root, depth, since, sol}
    this.events = saved.events || [];
    this.traceCache = new Map();
    this.labelCache = new Map();
    this.inflight = 0;
    this.volume = new Map(); // mint -> {sol, wallets: Map(wallet -> sol), first, last, level}
    this.ws = null; this.subs = new Map(); this.pending = new Map(); this.reqId = 1; this.gen = 0;
    this.status = 'starting…';
    this.startT = setTimeout(() => this.restart(), 6000);
    this.timer = setInterval(() => this.expire(), 10 * 60000);
  }

  get cfg() { return { minSol: 25, bigSol: 100, minBuySol: 3, volumeSol: 50, freshMaxTxs: 10, followHours: 48, maxAgeHours: 24, maxDepth: 3, enabled: true, wallets: [], labels: {}, ...(this.getConfig().whales || {}) }; }
  get keys() { return this.getConfig().keys || {}; }
  whales() { return (this.cfg.wallets || []).filter(w => isWallet(w.wallet)); }

  // ---------- names ----------
  /** A readable name for a wallet: your whale list, your labels, KOL names, Solscan's label. */
  nameOf(w) {
    const wh = this.whales().find(x => x.wallet === w);
    if (wh) return wh.name || short(w);
    if (this.cfg.labels?.[w]) return this.cfg.labels[w];
    const k = (this.kolList?.() || []).find(x => x.wallet === w);
    if (k) return k.name;
    const sl = this.labelCache.get(w);
    if (sl?.label) return sl.label;
    const c = this.children.get(w);
    if (c) return `fresh ${short(w)}`;
    return short(w);
  }
  known(w) { return Boolean(this.whales().some(x => x.wallet === w) || this.cfg.labels?.[w] || (this.kolList?.() || []).some(x => x.wallet === w) || this.labelCache.get(w)?.label); }

  // ---------- RPC / Solscan ----------
  async rpc(method, params) {
    const url = this.keys.solanaRpc;
    if (!url) throw new Error('no Solana RPC');
    const r = await limit.rpc(() => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(x => x.json()));
    if (r.error) throw new Error(r.error.message || 'RPC error');
    return r.result;
  }
  tx(sig) { return this.rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); }

  async solscan(pathq) {
    const key = process.env.SOLSCAN_API_KEY;
    if (!key) return null;
    try {
      const r = await fetch('https://pro-api.solscan.io/v2.0' + pathq, { headers: { token: key, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      return j.success === false ? null : j.data ?? null;
    } catch { return null; }
  }
  /** Solscan's label and first funder for a wallet (cached). */
  async meta(w) {
    if (this.labelCache.has(w)) return this.labelCache.get(w);
    const d = await this.solscan(`/account/metadata?address=${w}`);
    const m = d ? { label: d.account_label || null, tags: d.account_tags || [], funder: d.funded_by?.funded_by || null, fundTx: d.funded_by?.tx_hash || null, fundAt: d.funded_by?.block_time ? d.funded_by.block_time * 1000 : null } : {};
    this.labelCache.set(w, m);
    if (this.labelCache.size > 5000) this.labelCache.delete(this.labelCache.keys().next().value);
    return m;
  }

  // ---------- reading a transaction ----------
  /** SOL transfers (system program, top-level and inner) in a parsed transaction. */
  static transfers(tx) {
    const out = [];
    const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions || [])];
    for (const ix of ixs) {
      if ((ix.program === 'system' || ix.programId === SYSTEM) && /^transfer/.test(ix.parsed?.type || '')) {
        const i = ix.parsed.info || {};
        if (i.source && i.destination && i.lamports) out.push({ from: i.source, to: i.destination, sol: i.lamports / 1e9 });
      }
    }
    return out;
  }
  /** Token bought/sold by `wallet` in this transaction, and SOL spent. */
  static trade(tx, wallet) {
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    const wi = keys.indexOf(wallet);
    const sol = wi >= 0 ? (tx.meta.preBalances[wi] - tx.meta.postBalances[wi]) / 1e9 : 0;
    const bal = arr => { const m = new Map(); for (const b of arr || []) if (b.owner === wallet) m.set(b.mint, Number(b.uiTokenAmount.uiAmount || 0)); return m; };
    const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
    let best = null;
    for (const mint of new Set([...pre.keys(), ...post.keys()])) {
      if (STABLES.has(mint)) continue;
      const d = (post.get(mint) || 0) - (pre.get(mint) || 0);
      if (d && (!best || Math.abs(d) > Math.abs(best.d))) best = { mint, d };
    }
    return best ? { mint: best.mint, side: best.d > 0 ? 'buy' : 'sell', sol: Math.abs(sol) } : null;
  }
  /** A coin created in this transaction (pump.fun create, or any new SPL mint). */
  static created(tx) {
    const logs = (tx.meta?.logMessages || []).join('\n');
    const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions || [])];
    const init = ixs.find(ix => /^initializeMint/.test(ix.parsed?.type || ''));
    if (init?.parsed?.info?.mint) return init.parsed.info.mint;
    if (logs.includes(PUMP) && /Instruction: Create\b/.test(logs)) {
      const m = (tx.meta.postTokenBalances || []).find(b => !STABLES.has(b.mint));
      return m?.mint || null;
    }
    return null;
  }

  // ---------- live ----------
  restart() {
    clearTimeout(this.startT);
    this.gen++;
    try { this.ws?.close(); } catch {}
    this.ws = null; this.subs.clear(); this.pending.clear();
    if (!this.cfg.enabled) return this.setStatus('off');
    if (!this.keys.solanaWs) return this.setStatus('add a Solana RPC in API keys');
    const list = this.watchList();
    if (!list.length) return this.setStatus('add whale wallets (KOL wallets are watched for transfers too)');
    this.connect(this.keys.solanaWs, this.gen);
  }
  /** Your whales + the fresh wallets they funded (newest first), capped. */
  watchList() {
    const out = this.whales().map(w => w.wallet);
    const kids = [...this.children.entries()].sort((a, b) => b[1].since - a[1].since).map(([w]) => w);
    return [...new Set([...out, ...kids])].slice(0, 250);
  }
  connect(url, gen, retry = 0) {
    if (gen !== this.gen) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { retry = 0; for (const w of this.watchList()) this.sub(w); this.setStatus(`live · ${this.whales().length} whales · ${this.children.size} followed`); };
    ws.onmessage = m => {
      let j; try { j = JSON.parse(String(m.data)); } catch { return; }
      if (j.id && this.pending.has(j.id)) { if (j.result != null) this.subs.set(j.result, this.pending.get(j.id)); this.pending.delete(j.id); return; }
      if (j.method === 'logsNotification') {
        const w = this.subs.get(j.params?.subscription), v = j.params?.result?.value;
        if (w && v && !v.err) this.inspect(w, v.signature, v.logs || []);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (gen !== this.gen) return; this.setStatus('reconnecting'); setTimeout(() => this.connect(url, gen, retry + 1), Math.min(15000, 1000 * 2 ** retry)); };
  }
  sub(w) {
    if (!this.ws || this.ws.readyState !== 1 || [...this.subs.values(), ...this.pending.values()].includes(w)) return;
    const id = this.reqId++;
    this.pending.set(id, w);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [w] }, { commitment: 'confirmed' }] }));
  }
  setStatus(s) { this.status = s; this.send('whale-status', { status: s, whales: this.whales().length, followed: this.children.size }); }

  /** From the KOL watcher: a KOL wallet's transaction that wasn't a swap (maybe a SOL transfer). */
  fromKol(wallet, sig, logs) {
    if (!this.cfg.enabled || this.cfg.watchKols === false) return;
    const progs = new Set(logs.map(l => l.match(/^Program (\w{32,44}) invoke/)?.[1]).filter(Boolean));
    progs.delete('ComputeBudget111111111111111111111111111111');
    if (progs.size === 1 && progs.has(SYSTEM)) this.inspect(wallet, sig, logs); // a plain SOL transfer
  }

  /** One transaction from a watched wallet: funding, early buy or a deploy. */
  async inspect(wallet, sig, logs) {
    if (this.events.some(e => e.id === sig) || this.inflight >= 20) return; // never pile up work
    this.inflight++;
    try {
      let tx = null;
      for (let i = 0; i < 4 && !tx; i++) { await new Promise(r => setTimeout(r, i ? 1200 : 300)); try { tx = await this.tx(sig); } catch {} }
      if (!tx?.meta || tx.meta.err) return;
      const at = tx.blockTime ? tx.blockTime * 1000 : Date.now();
      const c = this.cfg;

      // 1) Big SOL out to a fresh wallet → follow it
      for (const t of WhaleWatcher.transfers(tx)) {
        if (t.from !== wallet || t.sol < c.minSol || t.to === wallet || this.known(t.to)) continue;
        const parent = this.children.get(wallet);
        const depth = parent ? parent.depth + 1 : 1;
        if (depth > c.maxDepth) continue;
        let n = 99;
        try { n = (await this.rpc('getSignaturesForAddress', [t.to, { limit: c.freshMaxTxs + 1 }])).length; } catch {}
        if (n > c.freshMaxTxs) continue; // an exchange deposit or an old wallet, not a fresh one
        const root = parent ? parent.root : wallet;
        this.children.set(t.to, { parent: wallet, root, depth, since: at, sol: t.sol });
        this.sub(t.to);
        const ev = this.push({ id: sig, kind: 'fund', at, sol: t.sol, from: wallet, to: t.to, chain: this.chain(t.to) });
        this.onAlert?.(ev, `WHALE · ${this.nameOf(root)}${depth > 1 ? ` (via ${depth - 1} hop${depth > 2 ? 's' : ''})` : ''} sent ${t.sol.toFixed(0)} SOL to a fresh wallet ${short(t.to)}`, t.sol >= c.bigSol);
        this.save();
      }

      // 2) A coin deployed by a whale or a wallet a whale funded
      const mint = WhaleWatcher.created(tx);
      if (mint && (this.children.has(wallet) || this.whales().some(w => w.wallet === wallet))) {
        const info = await this.tokenInfo(mint).catch(() => null);
        const ev = this.push({ id: sig, kind: 'deploy', at, from: wallet, mint, ...this.coin(mint, info), chain: this.chain(wallet) });
        this.onAlert?.(ev, `WHALE DEPLOY · ${this.chainText(wallet)} launched ${info?.symbol ? '$' + info.symbol : short(mint)} · CA ${mint}`, true);
        return;
      }

      // 3) An early buy: a very new coin (or one with no market yet)
      const tr = WhaleWatcher.trade(tx, wallet);
      if (tr && tr.side === 'buy' && tr.sol >= c.minBuySol) {
        const info = await this.tokenInfo(tr.mint).catch(() => null);
        const ageH = info?.createdAt ? (Date.now() - info.createdAt) / HOUR : null;
        if (ageH != null && ageH > c.maxAgeHours) return; // an established coin: not what we're hunting
        const ev = this.push({ id: sig, kind: 'buy', at, from: wallet, sol: tr.sol, mint: tr.mint, ...this.coin(tr.mint, info), chain: this.chain(wallet) });
        const age = ageH == null ? 'no market yet' : ageH < 1 ? `${Math.round(ageH * 60)}m old` : `${ageH.toFixed(1)}h old`;
        this.onAlert?.(ev, `WHALE BUY · ${this.chainText(wallet)} bought ${info?.symbol ? '$' + info.symbol : short(tr.mint)} (${age}) for ${tr.sol.toFixed(1)} SOL · CA ${tr.mint}`, true);
        this.addVolume(tr.mint, wallet, tr.sol, info, ageH, 'whale');
      }
    } finally { this.inflight--; }
  }

  coin(mint, info) {
    return {
      symbol: info?.symbol || null, name: info?.name || null, marketCap: info?.marketCap ?? null, pairCreatedAt: info?.createdAt || null, image: info?.image || null,
      links: { gmgn: `https://gmgn.ai/sol/token/${mint}`, axiom: `https://axiom.trade/meme/${info?.pairAddress || mint}`, solscan: `https://solscan.io/token/${mint}`, dexscreener: `https://dexscreener.com/solana/${mint}` },
    };
  }
  /** whale → hop → hop → wallet, with names. */
  chain(w) {
    const out = [];
    let cur = w;
    for (let i = 0; i < 6 && cur; i++) { out.unshift({ wallet: cur, name: this.nameOf(cur) }); cur = this.children.get(cur)?.parent; }
    return out;
  }
  chainText(w) { return this.chain(w).map(x => x.name).join(' → '); }

  /** A KOL wallet bought (from the KOL watcher): counts toward whale volume when the coin is brand new. */
  async kolBuy(ev) {
    const c = this.cfg;
    if (!c.enabled || !ev.mint || !(ev.sol >= c.minBuySol)) return;
    const info = await this.tokenInfo(ev.mint).catch(() => null);
    const ageH = info?.createdAt ? (Date.now() - info.createdAt) / HOUR : null;
    if (ageH != null && ageH > Math.min(c.maxAgeHours, 6)) return;
    this.addVolume(ev.mint, ev.wallet, ev.sol, info, ageH, 'kol');
  }

  /**
   * Big money into one brand-new coin from tracked wallets (whales, whale-funded wallets, KOLs), summed over
   * 30 minutes. Crossing 50 / 100 / 250 / 500 SOL (scaled by your setting) → WHALE VOLUME with the CA.
   */
  addVolume(mint, wallet, sol, info, ageH, via) {
    const now = Date.now(), c = this.cfg;
    for (const [m, v] of this.volume) if (now - v.last > 30 * 60000) this.volume.delete(m);
    const v = this.volume.get(mint) || { sol: 0, wallets: new Map(), first: now, last: now, level: 0 };
    v.sol += sol; v.last = now;
    v.wallets.set(wallet, (v.wallets.get(wallet) || 0) + sol);
    this.volume.set(mint, v);
    const levels = [1, 2, 5, 10].map(x => x * c.volumeSol);
    const hit = levels.filter(l => v.sol >= l).pop();
    if (!hit || hit <= v.level) return;
    v.level = hit;
    const wallets = [...v.wallets.entries()].sort((a, b) => b[1] - a[1]).map(([w, s]) => ({ wallet: w, name: this.nameOf(w), sol: s }));
    const age = ageH == null ? 'no market yet' : ageH < 1 ? `${Math.round(ageH * 60)}m old` : `${ageH.toFixed(1)}h old`;
    const ev = this.push({ id: `vol-${mint}-${hit}`, kind: 'volume', at: now, sol: v.sol, mint, wallets, via, since: v.first, ...this.coin(mint, info) });
    this.onAlert?.(ev, `WHALE VOLUME · ${v.sol.toFixed(0)} SOL from ${wallets.length} tracked wallet${wallets.length > 1 ? 's' : ''} into ${info?.symbol ? '$' + info.symbol : 'a new coin'} (${age}) · CA ${mint}`, true);
  }

  push(ev) {
    if (ev.kind !== 'volume') ev.links = { ...(ev.links || {}), tx: `https://solscan.io/tx/${ev.id}` };
    this.events.unshift(ev);
    if (this.events.length > 300) this.events.length = 300;
    this.send('whale', ev);
    this.save();
    return ev;
  }
  expire() {
    const cut = Date.now() - this.cfg.followHours * HOUR;
    let n = 0;
    for (const [w, c] of this.children) if (c.since < cut) { this.children.delete(w); n++; }
    if (n) { this.save(); this.restart(); }
  }
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify({ children: Object.fromEntries(this.children), events: this.events.slice(0, 200) })); } catch {}
    }, 1500);
  }
  snapshot() { return { status: this.status, whales: this.whales(), followed: this.children.size, events: this.events.slice(0, 100), solscan: Boolean(process.env.SOLSCAN_API_KEY) }; }

  // ---------- tracing ----------
  /** Who first sent this wallet SOL. Solscan answers in one call; otherwise read its oldest transactions. */
  async funderOf(w) {
    const m = await this.meta(w);
    if (m.funder) return { funder: m.funder, tx: m.fundTx, at: m.fundAt, via: 'solscan' };
    // Walk back to the oldest signatures (fresh wallets: one page; old ones: give up after 3 pages).
    let before = null, oldest = [];
    for (let page = 0; page < 3; page++) {
      const sigs = await this.rpc('getSignaturesForAddress', [w, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!sigs?.length) break;
      oldest = sigs;
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
      if (page === 2) return { funder: null, old: true };
    }
    for (const s of oldest.slice(-12).reverse()) {
      if (s.err) continue;
      const tx = await this.tx(s.signature).catch(() => null);
      if (!tx?.meta) continue;
      const t = WhaleWatcher.transfers(tx).filter(x => x.to === w && x.sol >= 0.01).sort((a, b) => b.sol - a.sol)[0];
      if (t) return { funder: t.from, tx: s.signature, at: s.blockTime ? s.blockTime * 1000 : null, sol: t.sol, via: 'rpc' };
    }
    return { funder: null };
  }

  /** Money trail for a wallet: funder, funder's funder… stopping at a named wallet (exchange, KOL, whale). */
  async traceWallet(w, hops = 4) {
    const key = 'w:' + w;
    const hit = this.traceCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60000) return hit.r;
    const steps = [];
    let cur = w;
    for (let i = 0; i < hops && cur; i++) {
      const m = await this.meta(cur);
      let txs = null;
      try { txs = (await this.rpc('getSignaturesForAddress', [cur, { limit: 50 }])).length; } catch {}
      const step = { wallet: cur, name: this.nameOf(cur), label: m.label || null, tags: m.tags || [], known: this.known(cur), txs: txs >= 50 ? '50+' : txs };
      steps.push(step);
      if (i > 0 && step.known) break; // reached an exchange / KOL / whale you know
      const f = await this.funderOf(cur).catch(() => ({ funder: null }));
      Object.assign(step, { fundedBy: f.funder, fundTx: f.tx || null, fundAt: f.at || null, fundSol: f.sol || null, oldWallet: Boolean(f.old) });
      if (!f.funder || steps.some(s => s.wallet === f.funder)) break;
      cur = f.funder;
    }
    const r = { wallet: w, steps };
    this.traceCache.set(key, { at: Date.now(), r });
    return r;
  }

  /**
   * The first buyers of a coin, biggest first, and where their money came from. Buyers that share a
   * funder are one group (team / insiders / a bundle); a funder that's a known whale is the signal.
   */
  async traceCoin(mint, { buyers = 8 } = {}) {
    const key = 'c:' + mint;
    const hit = this.traceCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.r;
    let before = null, sigs = [];
    for (let page = 0; page < 3; page++) {
      const s = await this.rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!s?.length) break;
      sigs = s;
      if (s.length < 1000) break;
      before = s[s.length - 1].signature;
    }
    const first = sigs.filter(s => !s.err).slice(-60).reverse(); // the earliest transactions
    const by = new Map();
    let creator = null, createdAt = null;
    for (const s of first) {
      const tx = await this.tx(s.signature).catch(() => null);
      if (!tx?.meta) continue;
      if (!creator && WhaleWatcher.created(tx) === mint) { creator = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))[0]; createdAt = tx.blockTime * 1000; }
      for (const b of tx.meta.postTokenBalances || []) {
        if (b.mint !== mint || !b.owner) continue;
        const tr = WhaleWatcher.trade(tx, b.owner);
        if (!tr || tr.side !== 'buy' || tr.mint !== mint || tr.sol <= 0) continue;
        const o = by.get(b.owner) || { wallet: b.owner, sol: 0, firstAt: tx.blockTime * 1000, buys: 0 };
        o.sol += tr.sol; o.buys++;
        by.set(b.owner, o);
      }
    }
    const top = [...by.values()].sort((a, b) => b.sol - a.sol).slice(0, buyers);
    await Promise.all(top.map(async b => {
      const f = await this.funderOf(b.wallet).catch(() => ({}));
      Object.assign(b, { name: this.nameOf(b.wallet), known: this.known(b.wallet), fundedBy: f.funder || null, funderName: f.funder ? this.nameOf(f.funder) : null, funderKnown: f.funder ? this.known(f.funder) : false, fresh: null });
      try { b.fresh = (await this.rpc('getSignaturesForAddress', [b.wallet, { limit: 30 }])).length < 30; } catch {}
    }));
    // Group buyers by shared funder (and the creator's funder)
    const groups = new Map();
    for (const b of top) if (b.fundedBy) groups.set(b.fundedBy, [...(groups.get(b.fundedBy) || []), b.wallet]);
    const shared = [...groups.entries()].filter(([, ws]) => ws.length >= 2).map(([funder, wallets]) => ({ funder, name: this.nameOf(funder), wallets }));
    const r = { mint, creator, creatorName: creator ? this.nameOf(creator) : null, createdAt, txsRead: first.length, buyers: top, shared };
    this.traceCache.set(key, { at: Date.now(), r });
    return r;
  }

  // ---------- bubble map ----------
  /** Light first-funder lookup for the map: Solscan if set, else one signature page + the 3 oldest transactions. */
  async quickFunder(w) {
    const m = await this.meta(w);
    const sigs = await this.rpc('getSignaturesForAddress', [w, { limit: 1000 }]).catch(() => null);
    const txs = sigs?.length || 0;
    const firstSeen = sigs?.length && sigs.length < 1000 ? (sigs[sigs.length - 1].blockTime || 0) * 1000 || null : null;
    const lastSeen = sigs?.[0]?.blockTime ? sigs[0].blockTime * 1000 : null;
    if (m.funder) return { funder: m.funder, sol: null, at: m.fundAt, tx: m.fundTx, txs, firstSeen, lastSeen };
    if (!sigs?.length || sigs.length >= 1000) return { funder: null, txs, firstSeen, lastSeen };
    for (const s of sigs.slice(-3).reverse()) {
      if (s.err) continue;
      const tx = await this.tx(s.signature).catch(() => null);
      if (!tx?.meta) continue;
      const t = WhaleWatcher.transfers(tx).filter(x => x.to === w && x.sol >= 0.01).sort((a, b) => b.sol - a.sol)[0];
      if (t) return { funder: t.from, sol: t.sol, at: s.blockTime ? s.blockTime * 1000 : null, tx: s.signature, txs, firstSeen, lastSeen };
    }
    return { funder: null, txs, firstSeen, lastSeen };
  }

  /**
   * Bubble map for a coin: the top holders as bubbles (size = share of supply), joined when they're
   * connected: one funded the other, the same wallet funded both, the token moved between them, or they
   * bought in the same transaction (a bundle). Connected holders form a cluster with a combined %.
   */
  async mapCoin(mint, { top = 80, progress = () => {} } = {}) {
    const key = 'm:' + mint + ':' + top;
    const hit = this.traceCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.r;
    const step = (s, done, total) => progress({ mint, step: s, done, total });

    step('Reading supply and holders', 0, 0);
    const sup = await this.rpc('getTokenSupply', [mint]);
    const decimals = sup?.value?.decimals ?? 6;
    const supply = Number(sup?.value?.amount || 0);
    if (!supply) throw new Error('Not a token (no supply). Paste the coin address (CA).');

    // Holders: the exact top 20, plus as many accounts as Helius' token-account index returns (memecoins: usually all).
    const byOwner = new Map();
    const addAcc = (owner, amount) => { if (owner && amount > 0) byOwner.set(owner, (byOwner.get(owner) || 0) + amount); };
    let partial = false, indexed = false;
    try {
      for (let page = 1; page <= 10; page++) {
        const r = await this.rpc('getTokenAccounts', { mint, page, limit: 1000, options: { showZeroBalance: false } });
        const accs = r?.token_accounts || [];
        indexed = true;
        for (const a of accs) addAcc(a.owner, Number(a.amount || 0));
        if (accs.length < 1000) break;
        if (page === 10) partial = true;
      }
    } catch { /* not Helius: top 20 only */ }
    if (!indexed) {
      const largest = (await this.rpc('getTokenLargestAccounts', [mint]))?.value || [];
      const infos = (await this.rpc('getMultipleAccounts', [largest.map(a => a.address), { encoding: 'jsonParsed' }]))?.value || [];
      largest.forEach((a, i) => addAcc(infos[i]?.data?.parsed?.info?.owner, Number(a.amount || 0)));
      partial = true;
    }
    const holderCount = byOwner.size;
    let holders = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([wallet, amount], i) => ({ id: wallet, wallet, amount, pct: (amount / supply) * 100, rank: i + 1, kind: 'holder' }));

    // Pools, bonding curves and other program accounts aren't people: shown, never clustered.
    step('Spotting pools and contracts', 0, holders.length);
    for (let i = 0; i < holders.length; i += 100) {
      const chunk = holders.slice(i, i + 100);
      const infos = (await this.rpc('getMultipleAccounts', [chunk.map(h => h.wallet), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => null))?.value || [];
      chunk.forEach((h, j) => {
        const owner = infos[j]?.owner;
        h.solBalance = infos[j] ? infos[j].lamports / 1e9 : 0;
        if (owner && owner !== SYSTEM) { h.kind = 'contract'; h.program = owner; h.label = owner === PUMP ? 'pump.fun curve' : 'pool / program'; }
      });
    }
    const AMM_AUTH = new Set(['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1']); // Raydium AMM authority
    for (const h of holders) if (AMM_AUTH.has(h.wallet)) { h.kind = 'contract'; h.label = 'Raydium pool'; }
    const people = holders.filter(h => h.kind === 'holder');
    const isHolder = new Set(people.map(h => h.wallet));
    const links = new Map(); // "a|b" -> {a, b, type, sol}
    const link = (a, b, type, extra = {}) => {
      if (!a || !b || a === b) return;
      const k = [a, b].sort().join('|');
      const prev = links.get(k);
      const rank = { bundle: 3, token: 2, sol: 2, funded: 1 };
      if (!prev || rank[type] > rank[prev.type]) links.set(k, { a, b, type, ...extra });
    };

    // 1) Funders
    let done = 0;
    const funders = new Map(); // wallet -> funder
    for (let i = 0; i < people.length; i += 8) {
      await Promise.all(people.slice(i, i + 8).map(async h => {
        const f = await this.quickFunder(h.wallet).catch(() => ({}));
        if (f.funder) funders.set(h.wallet, f.funder);
        Object.assign(h, { fundedBy: f.funder || null, fundSol: f.sol ?? null, fundedAt: f.at || null, fundTx: f.tx || null, txs: f.txs >= 1000 ? '1000+' : f.txs ?? null, firstSeen: f.firstSeen || null, lastSeen: f.lastSeen || null });
        if (f.txs != null) h.fresh = f.txs <= 15;
        done++;
      }));
      step('Finding who funded each holder', done, people.length);
    }
    const fundedCount = new Map();
    for (const f of funders.values()) fundedCount.set(f, (fundedCount.get(f) || 0) + 1);
    // A shared funder only counts if it's a private wallet: exchanges and services fund thousands of unrelated
    // people (everyone who withdrew from Binance isn't one group). Busy (1000+ txs) or exchange-named → ignored.
    const CEX = /binance|coinbase|okx|bybit|kraken|kucoin|gate\.?io|mexc|bitget|htx|huobi|crypto\.com|exchange|cex|hot ?wallet|bridge|wormhole|jupiter|relay|fixedfloat|changenow|swap/i;
    const service = new Set(), hubTxs = new Map();
    await Promise.all([...fundedCount.entries()].filter(([f, n]) => n >= 2 && !isHolder.has(f)).map(async ([f]) => {
      const m = await this.meta(f);
      const label = [this.nameOf(f), m.label, ...(m.tags || [])].join(' ');
      if (CEX.test(label)) { service.add(f); return; }
      try { const n = (await this.rpc('getSignaturesForAddress', [f, { limit: 1000 }])).length; hubTxs.set(f, n); if (n >= 1000) service.add(f); } catch {}
    }));
    const hubs = new Map();
    for (const [w, f] of funders) {
      if (service.has(f)) continue;
      if (isHolder.has(f)) link(f, w, 'funded');                       // a holder funded another holder
      else if (fundedCount.get(f) >= 2) {                                 // one wallet funded several holders
        if (!hubs.has(f)) hubs.set(f, { id: f, wallet: f, kind: 'hub', pct: 0, funds: fundedCount.get(f), txs: hubTxs.get(f) ?? null, sent: 0 });
        hubs.get(f).sent += people.find(h => h.wallet === w)?.fundSol || 0;
        link(f, w, 'funded');
      }
    }

    // 2) The coin's earliest transactions: same-transaction buys (bundles), token and SOL moving between holders
    step('Reading the first trades', 0, 0);
    let before = null, sigs = [];
    for (let page = 0; page < 3; page++) {
      const s = await this.rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]).catch(() => null);
      if (!s?.length) break;
      sigs = s;
      if (s.length < 1000) break;
      before = s[s.length - 1].signature;
    }
    const reachedStart = sigs.length > 0 && sigs.length < 1000;
    let createdAt = reachedStart && sigs[sigs.length - 1].blockTime ? sigs[sigs.length - 1].blockTime * 1000 : null;
    const early = sigs.filter(s => !s.err).slice(-100).reverse();
    const holderBy = new Map(people.map(h => [h.wallet, h]));
    done = 0;
    for (let i = 0; i < early.length; i += 6) {
      const txs = await Promise.all(early.slice(i, i + 6).map(s => this.tx(s.signature).catch(() => null)));
      for (const tx of txs) {
        if (!tx?.meta) continue;
        const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
        const pre = new Map((tx.meta.preTokenBalances || []).filter(b => b.mint === mint).map(b => [b.accountIndex, b]));
        const post = (tx.meta.postTokenBalances || []).filter(b => b.mint === mint);
        const ownerOfAcc = new Map(post.map(b => [keys[b.accountIndex], b.owner]));
        for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint) ownerOfAcc.set(keys[b.accountIndex], b.owner);
        const gainers = [], losers = [];
        for (const b of post) {
          const d = Number(b.uiTokenAmount.amount) - Number(pre.get(b.accountIndex)?.uiTokenAmount.amount || 0);
          if (d > 0 && isHolder.has(b.owner)) gainers.push(b.owner);
          if (d < 0 && isHolder.has(b.owner)) losers.push(b.owner);
        }
        const g = [...new Set(gainers)];
        for (const o of g) {
          const h = holderBy.get(o);
          if (h && !h.firstBuyAt && tx.blockTime) { h.firstBuyAt = tx.blockTime * 1000; h.firstBuySol = WhaleWatcher.trade(tx, o)?.sol || null; }
        }
        if (g.length >= 2) for (let x = 1; x < g.length; x++) link(g[0], g[x], 'bundle');            // bought in one transaction
        for (const l of new Set(losers)) for (const w of g) link(l, w, 'token');                       // token handed over
        for (const t of WhaleWatcher.transfers(tx)) if (isHolder.has(t.from) && isHolder.has(t.to) && t.sol >= 0.05) link(t.from, t.to, 'sol', { sol: t.sol });
      }
      done += txs.length;
      step('Reading the first trades', done, early.length);
    }

    // 3) Clusters (union-find over the links)
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const n of [...people, ...hubs.values()]) parent.set(n.wallet, n.wallet);
    for (const l of links.values()) if (parent.has(l.a) && parent.has(l.b)) parent.set(find(l.a), find(l.b));
    const groups = new Map();
    for (const h of people) { const r = find(h.wallet); groups.set(r, [...(groups.get(r) || []), h]); }
    const clusters = [...groups.entries()].filter(([, hs]) => hs.length >= 2)
      .map(([root, hs]) => ({ wallets: hs.map(h => h.wallet), pct: hs.reduce((n, h) => n + h.pct, 0), hubs: [...hubs.values()].filter(x => find(x.wallet) === root).map(x => x.wallet) }))
      .sort((a, b) => b.pct - a.pct).map((c, i) => ({ id: i + 1, ...c }));
    const clusterOf = new Map();
    for (const c of clusters) { for (const w of c.wallets) clusterOf.set(w, c.id); for (const w of c.hubs) clusterOf.set(w, c.id); }

    // Names (your labels, KOLs, whales, Solscan when the key is set)
    const info = await this.tokenInfo?.(mint).catch(() => null);
    if (!createdAt && info?.createdAt) createdAt = info.createdAt;
    // Pre-funded: the wallet got its SOL in the 3 days before launch (or minutes after) and then bought.
    for (const h of people) {
      if (h.fundedAt && createdAt && h.fundedAt <= createdAt + 15 * 60000 && createdAt - h.fundedAt <= 72 * HOUR) {
        h.preFunded = true; h.fundedBeforeLaunchMin = Math.round((createdAt - h.fundedAt) / 60000);
      }
      if (h.firstBuyAt && createdAt) h.boughtAfterLaunchSec = Math.round((h.firstBuyAt - createdAt) / 1000);
    }
    const nodes = [...holders, ...hubs.values()].map(n => ({ ...n, name: this.nameOf(n.wallet), known: this.known(n.wallet), cluster: clusterOf.get(n.wallet) || null, funderName: n.fundedBy ? this.nameOf(n.fundedBy) : null }));
    const usedLinks = [...links.values()].filter(l => nodes.some(n => n.id === l.a) && nodes.some(n => n.id === l.b));
    const r = {
      mint, symbol: info?.symbol || null, name: info?.name || null, image: info?.image || null, marketCap: info?.marketCap ?? null,
      decimals, supply, holderCount, partial, shown: holders.length, nodes, links: usedLinks, clusters,
      clusteredPct: clusters.reduce((n, c) => n + c.pct, 0), createdAt,
      preFundedPct: people.filter(h => h.preFunded).reduce((n, h) => n + h.pct, 0), preFundedCount: people.filter(h => h.preFunded).length, contractPct: holders.filter(h => h.kind === 'contract').reduce((n, h) => n + h.pct, 0),
      at: Date.now(),
    };
    this.traceCache.set(key, { at: Date.now(), r });
    return r;
  }

  // ---------- wallet connections ----------
  /** Balance, program owner and tx count for a set of wallets. */
  async walletFacts(ws) {
    const out = new Map();
    for (let i = 0; i < ws.length; i += 100) {
      const chunk = ws.slice(i, i + 100);
      const infos = (await this.rpc('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => null))?.value || [];
      chunk.forEach((w, j) => out.set(w, { solBalance: infos[j] ? infos[j].lamports / 1e9 : 0, program: infos[j]?.owner && infos[j].owner !== SYSTEM ? infos[j].owner : null }));
    }
    await Promise.all(ws.map(async w => {
      try {
        const s = await this.rpc('getSignaturesForAddress', [w, { limit: 100 }]);
        const f = out.get(w) || {};
        f.txs = s.length >= 100 ? '100+' : s.length; f.fresh = s.length <= 15;
        f.lastSeen = s[0]?.blockTime ? s[0].blockTime * 1000 : null;
        if (s.length < 100 && s.length) f.firstSeen = (s[s.length - 1].blockTime || 0) * 1000 || null;
        out.set(w, f);
      } catch {}
    }));
    return out;
  }

  /**
   * Everything one wallet is connected to: who funded it (and who funded them), who it sent SOL or tokens
   * to, who sent it SOL, and the coins it bought lately. Bubble size = SOL moved with the wallet.
   */
  async mapWallet(w, { progress = () => {} } = {}) {
    const key = 'mw:' + w;
    const hit = this.traceCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.r;
    const step = (s, done, total) => progress({ mint: w, step: s, done, total });
    const nodes = new Map(), links = new Map();
    const node = (id, o = {}) => { const n = nodes.get(id) || { id, wallet: id, vol: 0 }; Object.assign(n, o); nodes.set(id, n); return n; };
    const link = (a, b, type, sol = 0, at = null, extra = {}) => {
      const k = a + '>' + b + ':' + type;
      const l = links.get(k) || { a, b, type, sol: 0, count: 0, first: at, last: at, ...extra };
      l.sol += sol; l.count++; if (at) { l.first = Math.min(l.first || at, at); l.last = Math.max(l.last || at, at); }
      links.set(k, l);
    };
    node(w, { role: 'center' });

    // Upstream: the funding trail (up to 3 hops)
    step('Following the money in', 0, 3);
    let cur = w;
    for (let i = 0; i < 3 && cur; i++) {
      const f = await this.funderOf(cur).catch(() => ({}));
      if (!f.funder || nodes.has(f.funder) && nodes.get(f.funder).role !== 'center' && i > 0) break;
      node(f.funder, { role: nodes.get(f.funder)?.role || 'funder', hop: i + 1 });
      node(cur, { fundedBy: f.funder, fundSol: f.sol ?? null, fundedAt: f.at || null, fundTx: f.tx || null });
      link(f.funder, cur, 'funded', f.sol || 0, f.at || null, { firstFunding: true });
      nodes.get(f.funder).vol += f.sol || 0;
      step('Following the money in', i + 1, 3);
      if (this.known(f.funder)) break; // reached an exchange / KOL / whale you know
      cur = f.funder;
    }

    // Recent activity: SOL and token transfers, and coins bought
    const sigs = await this.rpc('getSignaturesForAddress', [w, { limit: 100 }]).catch(() => []);
    const recent = sigs.filter(s => !s.err).slice(0, 60);
    const buys = [];
    let done = 0;
    for (let i = 0; i < recent.length; i += 6) {
      const txs = await Promise.all(recent.slice(i, i + 6).map(s => this.tx(s.signature).catch(() => null)));
      for (const tx of txs) {
        if (!tx?.meta) continue;
        const at = tx.blockTime ? tx.blockTime * 1000 : null;
        for (const t of WhaleWatcher.transfers(tx)) {
          if (t.sol < 0.01) continue;
          if (t.from === w && t.to !== w) { node(t.to, { role: nodes.get(t.to)?.role || 'out' }).vol += t.sol; link(w, t.to, 'sol', t.sol, at); }
          if (t.to === w && t.from !== w) { node(t.from, { role: nodes.get(t.from)?.role || 'in' }).vol += t.sol; link(t.from, w, 'sol', t.sol, at); }
        }
        // Tokens handed to / received from another wallet (not a swap with a pool)
        const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
        const delta = new Map();
        for (const b of tx.meta.postTokenBalances || []) delta.set(b.owner + '|' + b.mint, Number(b.uiTokenAmount.uiAmount || 0));
        for (const b of tx.meta.preTokenBalances || []) delta.set(b.owner + '|' + b.mint, (delta.get(b.owner + '|' + b.mint) || 0) - Number(b.uiTokenAmount.uiAmount || 0));
        const mine = [...delta.entries()].filter(([k, d]) => k.startsWith(w + '|') && d && !STABLES.has(k.split('|')[1]));
        const tr = WhaleWatcher.trade(tx, w);
        const swapped = tr && tr.sol > 0.001 && Math.abs((tx.meta.preBalances[keys.indexOf(w)] || 0) - (tx.meta.postBalances[keys.indexOf(w)] || 0)) > 5e6;
        if (tr && tr.side === 'buy' && swapped) buys.push({ mint: tr.mint, sol: tr.sol, at, sig: tx.transaction.signatures?.[0] });
        else for (const [k, d] of mine) {
          const mint = k.split('|')[1];
          const other = [...delta.entries()].find(([k2, d2]) => k2.endsWith('|' + mint) && !k2.startsWith(w + '|') && Math.sign(d2) === -Math.sign(d));
          const o = other?.[0].split('|')[0];
          if (!o) continue;
          node(o, { role: nodes.get(o)?.role || (d < 0 ? 'out' : 'in') });
          if (d < 0) link(w, o, 'token', 0, at, { mint }); else link(o, w, 'token', 0, at, { mint });
        }
      }
      done += txs.length;
      step('Reading recent transactions', done, recent.length);
    }

    // Keep the biggest counterparties, then look them up
    const keep = new Set([w, ...[...nodes.values()].filter(n => n.role === 'funder').map(n => n.id)]);
    [...nodes.values()].filter(n => !keep.has(n.id)).sort((a, b) => b.vol - a.vol).slice(0, 30).forEach(n => keep.add(n.id));
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    step('Looking up the connected wallets', 0, nodes.size);
    const facts = await this.walletFacts([...nodes.keys()]);
    await Promise.all([...nodes.keys()].map(id => this.meta(id).catch(() => null)));
    for (const n of nodes.values()) Object.assign(n, facts.get(n.id) || {}, { name: this.nameOf(n.id), known: this.known(n.id), label: this.labelCache.get(n.id)?.label || null });
    // What the center funded that then went on to fund others = one operation
    const ls = [...links.values()].filter(l => nodes.has(l.a) && nodes.has(l.b));
    for (const n of nodes.values()) n.links = ls.filter(l => l.a === n.id || l.b === n.id).length;

    // Recent buys with names (newest first, one per coin)
    const seen = new Set(), bought = [];
    for (const b of buys.sort((a, b) => (b.at || 0) - (a.at || 0))) { if (seen.has(b.mint)) continue; seen.add(b.mint); bought.push(b); if (bought.length >= 8) break; }
    await Promise.all(bought.map(async b => { const i = await this.tokenInfo(b.mint).catch(() => null); Object.assign(b, { symbol: i?.symbol || null, name: i?.name || null, marketCap: i?.marketCap ?? null, image: i?.image || null }); }));

    const r = { type: 'wallet', wallet: w, name: this.nameOf(w), nodes: [...nodes.values()], links: ls, buys: bought, txsRead: recent.length, at: Date.now() };
    this.traceCache.set(key, { at: Date.now(), r });
    return r;
  }
}

module.exports = { WhaleWatcher, isWallet };
