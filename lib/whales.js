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
    this.ws = null; this.subs = new Map(); this.pending = new Map(); this.reqId = 1; this.gen = 0;
    this.status = 'starting…';
    this.startT = setTimeout(() => this.restart(), 6000);
    this.timer = setInterval(() => this.expire(), 10 * 60000);
  }

  get cfg() { return { minSol: 25, bigSol: 100, minBuySol: 3, freshMaxTxs: 10, followHours: 48, maxAgeHours: 24, maxDepth: 3, enabled: true, wallets: [], labels: {}, ...(this.getConfig().whales || {}) }; }
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
        this.onAlert?.(ev, `WHALE DEPLOY · ${this.chainText(wallet)} launched ${info?.symbol ? '$' + info.symbol : short(mint)}`, true);
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
        this.onAlert?.(ev, `WHALE BUY · ${this.chainText(wallet)} bought ${info?.symbol ? '$' + info.symbol : short(tr.mint)} (${age}) for ${tr.sol.toFixed(1)} SOL`, true);
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

  push(ev) {
    ev.links = { ...(ev.links || {}), tx: `https://solscan.io/tx/${ev.id}` };
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
}

module.exports = { WhaleWatcher, isWallet };
