// KOL wallet tracker. Streams each wallet's transactions from a Solana RPC websocket at
// "processed" commitment: you see a swap within ~0.5 s of it landing in a block, before it
// is confirmed and usually seconds before GMGN/Axiom show it. Solana has no public mempool,
// so nothing earlier than this is visible without private validator access.
//
// Stage 1 (processed): from the logs alone → which KOL, which venue, buy/sell when the program logs it.
// Stage 2 (confirmed): fetch the transaction → token, SOL size, then DexScreener → symbol, mcap, links.
//
// Dormant wallets (no transaction in `dormantDays`, default 30) are hidden and not streamed.
// They're re-checked in the background; when one moves again you get a BACK ONLINE alert and
// it's streamed live from then on. Subscriptions are spread over several sockets for big lists.

const fs = require('fs');
const limit = require('./limit');
const path = require('path');

const PROGRAMS = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Raydium LaunchLab',
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': 'Meteora DBC',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora DAMM',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
};
const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const isWallet = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
const ACT_PATH = path.join(__dirname, '..', 'data', 'kol-activity.json');
const DAY = 86400000;

/**
 * Parse a wallet list: an Axiom-style export (JSON objects with trackedWalletAddress, name, emoji,
 * alertsOnToast, highlightColor, groups — batch headers and all), or plain lines "emoji name address".
 */
function parseWalletList(text) {
  const out = new Map();
  const add = w => { if (isWallet(w.wallet)) out.set(w.wallet, { ...(out.get(w.wallet) || {}), ...w }); };
  const objs = String(text).match(/\{[^{}]*"trackedWalletAddress"[^{}]*\}/g) || [];
  for (const raw of objs) {
    try {
      const o = JSON.parse(raw);
      // Only fields present in this entry, so a later duplicate doesn't wipe earlier settings.
      const w = { wallet: String(o.trackedWalletAddress).trim() };
      if (o.name) w.name = String(o.name).trim().slice(0, 40);
      if ('emoji' in o) w.emoji = String(o.emoji || '').slice(0, 16);
      if ('alertsOnToast' in o) w.toast = o.alertsOnToast !== false;
      if (/^#[0-9a-f]{6}$/i.test(o.highlightColor || '')) w.color = o.highlightColor;
      if (Array.isArray(o.groups)) w.groups = o.groups.map(String).slice(0, 5);
      add(w);
    } catch {}
  }
  if (!objs.length) {
    for (const line of String(text).split(/\r?\n/)) {
      const parts = line.trim().split(/[\s,]+/).filter(Boolean);
      const wallet = parts.find(isWallet);
      if (!wallet) continue;
      const rest = parts.filter(p => p !== wallet);
      const emoji = rest[0] && !/[A-Za-z0-9]/.test(rest[0]) ? rest.shift() : '';
      add({ wallet, name: rest.join(' ').slice(0, 40), emoji, toast: true });
    }
  }
  return [...out.values()].map(w => ({ emoji: '', toast: true, color: null, groups: [], ...w, name: w.name || w.wallet.slice(0, 4) + '…' + w.wallet.slice(-4) }));
}

class KolWatcher {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {(e:string, d:any) => void} o.send
   * @param {(mint:string) => Promise<object|null>} o.tokenInfo  DexScreener info for a mint
   * @param {(ev:object, title:string, kind?:string) => void} o.onAlert
   * @param {boolean} o.demo
   */
  constructor(o) {
    Object.assign(this, o);
    this.sockets = [];        // [{ws, url, subs: Map(subId -> kol), pending: Map(reqId -> kol), list}]
    this.events = [];         // newest first
    this.buys = new Map();    // mint -> [{kol, t}]
    this.status = 'off';
    this.reqId = 1;
    this.gen = 0;             // restart generation, so old sockets don't reconnect
    try { this.activity = JSON.parse(fs.readFileSync(ACT_PATH, 'utf8')); } catch { this.activity = {}; }
    this.restart();
    this.timers = [
      setInterval(() => this.pollDormant(), 60 * 1000),     // checks a slice of dormant wallets each minute
      setInterval(() => this.rescan(), 6 * 3600 * 1000),    // re-sorts active vs dormant every 6 h
    ];
  }

  get cfg() { return this.getConfig().kols || {}; }
  // Solana's public RPC allows ~40 calls per 10 s per method, so go slower there.
  get onPublic() { return Boolean(this.getConfig().keys.solanaPublic); }
  rps() { return Math.max(1, this.onPublic ? Math.min(3, this.cfg.scanRps || 3) : this.cfg.scanRps || 5); }
  get dormantMs() { return (this.cfg.dormantDays || 30) * DAY; }
  list() { return (this.cfg.wallets || []).filter(k => isWallet(k.wallet)); }
  byWallet(w) { return this.list().find(k => k.wallet === w); }

  isActive(k) {
    const a = this.activity[k.wallet];
    if (!a || a.lastActiveAt == null) return !a?.checkedAt; // not scanned yet → treat as active until we know
    return Date.now() - a.lastActiveAt < this.dormantMs;
  }

  counts() {
    const all = this.list();
    const active = all.filter(k => this.isActive(k)).length;
    const scanned = all.filter(k => this.activity[k.wallet]?.checkedAt).length;
    return { wallets: all.length, active, dormant: all.length - active, scanned };
  }

  snapshot() {
    return {
      status: this.status, ...this.counts(), enabled: this.cfg.enabled !== false,
      events: this.events.slice(0, 60),
      dormantList: this.list().filter(k => !this.isActive(k)).slice(0, 2000)
        .map(k => ({ name: k.name, emoji: k.emoji || '', wallet: k.wallet, lastActiveAt: this.activity[k.wallet]?.lastActiveAt ?? null })),
    };
  }

  setStatus(s) { this.status = s; this.send('kol-status', { status: s, ...this.counts() }); }

  saveActivity() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => fs.writeFile(ACT_PATH, JSON.stringify(this.activity), () => {}), 1500);
  }

  restart() {
    this.gen++;
    clearTimeout(this.demoTimer);
    for (const s of this.sockets) { try { s.ws.close(); } catch {} }
    this.sockets = [];
    if (this.cfg.enabled === false) return this.setStatus('off');
    if (this.demo) { this.setStatus('demo'); this.runDemo(); return; }
    const url = this.getConfig().keys.solanaWs;
    if (!url) return this.setStatus('add a Solana RPC in API keys');
    if (!this.list().length) return this.setStatus('no wallets added');
    this.connectAll(url);
    this.scanActivity(); // fills in last-activity for unscanned wallets, then re-sorts
  }

  // ---------- websockets ----------
  connectAll(url) {
    const active = this.list().filter(k => this.isActive(k));
    const per = Math.max(20, this.cfg.subsPerSocket || 250);
    for (let i = 0; i < active.length; i += per) this.openSocket(url, active.slice(i, i + per), this.gen);
    this.setStatus(active.length ? `connecting · ${active.length} live wallets` : 'all wallets dormant');
  }

  openSocket(url, list, gen, retry = 0) {
    if (gen !== this.gen) return;
    const s = { url, list, subs: new Map(), pending: new Map(), ws: new WebSocket(url) };
    this.sockets.push(s);
    s.ws.onopen = () => {
      retry = 0;
      for (const k of list) this.subscribe(s, k);
      this.setStatus(`live · ${this.counts().active} active · ${this.counts().dormant} dormant${this.onPublic ? ' · public RPC' : ''}`);
    };
    s.ws.onmessage = ev => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && s.pending.has(m.id)) {
        if (m.result != null) s.subs.set(m.result, s.pending.get(m.id));
        s.pending.delete(m.id);
        return;
      }
      if (m.method === 'logsNotification') {
        const kol = s.subs.get(m.params?.subscription);
        const v = m.params?.result?.value;
        if (kol && v && !v.err) this.onLogs(kol, v.signature, v.logs || [], m.params.result.context?.slot);
      }
    };
    s.ws.onerror = () => {};
    s.ws.onclose = () => {
      this.sockets = this.sockets.filter(x => x !== s);
      if (gen !== this.gen) return;
      this.setStatus('reconnecting');
      setTimeout(() => this.openSocket(url, s.list, gen, retry + 1), Math.min(15000, 1000 * 2 ** retry));
    };
  }

  subscribe(s, k) {
    const id = this.reqId++;
    s.pending.set(id, k);
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [k.wallet] }, { commitment: 'processed' }] }));
  }

  /** Add one wallet to a live socket (used when a dormant wallet comes back). */
  addLive(k) {
    const per = Math.max(20, this.cfg.subsPerSocket || 250);
    const s = this.sockets.find(x => x.ws.readyState === 1 && x.list.length < per);
    if (s) { s.list.push(k); this.subscribe(s, k); }
    else if (this.getConfig().keys.solanaWs) this.openSocket(this.getConfig().keys.solanaWs, [k], this.gen);
  }

  // ---------- activity: active vs dormant ----------
  async rpc(method, params) {
    const res = await fetch(this.getConfig().keys.solanaRpc, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result;
  }

  async lastActivity(wallet) {
    const sigs = await this.rpc('getSignaturesForAddress', [wallet, { limit: 1 }]);
    const s = sigs?.[0];
    return s ? { sig: s.signature, at: s.blockTime ? s.blockTime * 1000 : Date.now() } : null;
  }

  /** First pass: find each wallet's last transaction (throttled), then move dormant ones off the sockets. */
  async scanActivity() {
    if (this.scanning || !this.getConfig().keys.solanaRpc) return;
    this.scanning = true;
    const gen = this.gen;
    const todo = this.list().filter(k => !this.activity[k.wallet]?.checkedAt);
    const rps = this.rps();
    let done = 0;
    for (const k of todo) {
      if (gen !== this.gen) break;
      try {
        const last = await this.lastActivity(k.wallet);
        this.activity[k.wallet] = { lastActiveAt: last ? last.at : null, lastSig: last?.sig || null, checkedAt: Date.now() };
      } catch { /* retry next scan */ }
      done++;
      if (done % 25 === 0) this.setStatus(`checking wallet activity ${done}/${todo.length}`);
      await new Promise(r => setTimeout(r, 1000 / rps));
    }
    this.scanning = false;
    this.saveActivity();
    if (todo.length && gen === this.gen) this.restart(); // re-split: only active wallets stay on sockets
  }

  rescan() {
    // Wallets that went quiet for a month drop off the live sockets on the next restart.
    const before = this.sockets.reduce((n, s) => n + s.list.length, 0);
    if (before !== this.counts().active) this.restart();
  }

  /** Check a slice of dormant wallets; any new transaction = BACK ONLINE. A full pass every ~10 min. */
  async pollDormant() {
    if (this.demo || this.polling || !this.getConfig().keys.solanaRpc || this.cfg.enabled === false) return;
    const dormant = this.list().filter(k => !this.isActive(k));
    if (!dormant.length) return;
    this.polling = true;
    const slice = Math.ceil(dormant.length / 10);
    this.pollIdx = (this.pollIdx || 0) % dormant.length;
    const batch = dormant.slice(this.pollIdx, this.pollIdx + slice);
    this.pollIdx += slice;
    for (const k of batch) {
      try {
        const a = this.activity[k.wallet] || {};
        const last = await this.lastActivity(k.wallet);
        if (last && last.sig !== a.lastSig && (a.lastActiveAt == null || last.at > a.lastActiveAt)) {
          this.backOnline(k, a.lastActiveAt, last);
        } else {
          this.activity[k.wallet] = { ...a, checkedAt: Date.now() };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000 / this.rps()));
    }
    this.saveActivity();
    this.polling = false;
  }

  backOnline(k, prevAt, last) {
    const quietDays = prevAt ? Math.round((last.at - prevAt) / DAY) : null;
    this.activity[k.wallet] = { lastActiveAt: last.at, lastSig: last.sig, checkedAt: Date.now() };
    this.saveActivity();
    this.addLive(k);
    const ev = { id: last.sig, kol: k.name, emoji: k.emoji || '', color: k.color || null, wallet: k.wallet, venue: 'wallet', side: null, stage: 'processed', seenAt: Date.now(), back: { quietDays } };
    this.push(ev);
    this.onAlert?.(ev, `BACK ONLINE · ${k.emoji ? k.emoji + ' ' : ''}${k.name} moved again${quietDays != null ? ` after ${quietDays} days quiet` : ' (first transaction seen)'}`, 'back');
    this.resolve(ev, { keepIfNoTrade: true });
  }

  /**
   * Coins this wallet bought recently, newest first: [{mint, sol, at, sig}].
   * Uses trades the watcher already saw, then reads the wallet's latest transactions from the RPC.
   */
  async recentBuys(wallet, { withinMin = 120, max = 3 } = {}) {
    const since = Date.now() - withinMin * 60000;
    const out = new Map();
    for (const e of this.events) {
      if (e.wallet === wallet && e.side === 'buy' && e.mint && (e.blockTime || e.seenAt) >= since && !out.has(e.mint)) out.set(e.mint, { mint: e.mint, sol: e.sol, at: e.blockTime || e.seenAt, sig: e.id });
    }
    if (out.size < max && this.getConfig().keys.solanaRpc) {
      let sigs = [];
      try { sigs = await limit.rpc(() => this.rpc('getSignaturesForAddress', [wallet, { limit: 15 }])); } catch {}
      for (const s of sigs || []) {
        if (out.size >= max) break;
        if (s.err || (s.blockTime && s.blockTime * 1000 < since)) continue;
        let tx = null;
        try { tx = await limit.rpc(() => this.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])); } catch {}
        if (!tx?.meta) continue;
        const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
        const wi = keys.indexOf(wallet);
        const sol = wi >= 0 ? (tx.meta.preBalances[wi] - tx.meta.postBalances[wi]) / 1e9 : 0;
        const bal = arr => { const m = new Map(); for (const b of arr || []) if (b.owner === wallet) m.set(b.mint, Number(b.uiTokenAmount.uiAmount || 0)); return m; };
        const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
        for (const mint of post.keys()) {
          if (STABLES.has(mint) || out.has(mint)) continue;
          if ((post.get(mint) || 0) > (pre.get(mint) || 0)) out.set(mint, { mint, sol: sol > 0 ? sol : null, at: (s.blockTime || tx.blockTime || 0) * 1000, sig: s.signature });
        }
      }
    }
    return [...out.values()].sort((a, b) => b.at - a.at).slice(0, max);
  }

  /** Find a tracked wallet by name ("DVCES" → the KOL entry named DVCES). */
  walletNamed(...names) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = names.map(norm).filter(n => n.length >= 3);
    const list = this.list();
    // exact name first ("DVCES"), then a name that contains it ("DVCES main", "dvces 🎤")
    return (list.find(k => want.includes(norm(k.name))) || list.find(k => want.some(w => w.length >= 4 && norm(k.name).includes(w))))?.wallet || null;
  }

  /** Stage 1: straight from the logs, before the transaction is confirmed. */
  onLogs(kol, sig, logs, slot) {
    if (this.events.some(e => e.id === sig)) return;
    const a = this.activity[kol.wallet] || {};
    this.activity[kol.wallet] = { ...a, lastActiveAt: Date.now(), lastSig: sig, checkedAt: Date.now() };
    this.saveActivity();
    const programs = new Set();
    for (const l of logs) { const m = l.match(/^Program (\w{32,44}) invoke/); if (m && PROGRAMS[m[1]]) programs.add(PROGRAMS[m[1]]); }
    if (!programs.size) return; // not a swap on a venue we know (transfers, staking, …)
    const text = logs.join('\n');
    const side = /Instruction: Buy\b/.test(text) ? 'buy' : /Instruction: Sell\b/.test(text) ? 'sell' : null;
    const ev = { id: sig, kol: kol.name, emoji: kol.emoji || '', color: kol.color || null, wallet: kol.wallet, venue: [...programs].join(' → '), side, stage: 'processed', seenAt: Date.now(), slot };
    this.push(ev);
    this.resolve(ev);
  }

  /** Stage 2: confirmed transaction → token, size, market data. */
  async resolve(ev, { keepIfNoTrade = false } = {}) {
    const rpc = this.getConfig().keys.solanaRpc;
    if (!rpc) return;
    let tx = null;
    for (let i = 0; i < 20 && !tx; i++) {
      await new Promise(r => setTimeout(r, i ? 700 : 400));
      try { tx = await limit.rpc(() => this.rpc('getTransaction', [ev.id, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])); } catch {}
    }
    if (!tx) { this.update(ev, { stage: 'unconfirmed' }); return; }
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    const wi = keys.indexOf(ev.wallet);
    const solDelta = wi >= 0 ? (tx.meta.postBalances[wi] - tx.meta.preBalances[wi]) / 1e9 : 0;
    const bal = arr => {
      const out = new Map();
      for (const b of arr || []) if (b.owner === ev.wallet) out.set(b.mint, Number(b.uiTokenAmount.uiAmount || 0));
      return out;
    };
    const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
    let best = null;
    for (const mint of new Set([...pre.keys(), ...post.keys()])) {
      if (STABLES.has(mint)) continue;
      const d = (post.get(mint) || 0) - (pre.get(mint) || 0);
      if (d && (!best || Math.abs(d) > Math.abs(best.d))) best = { mint, d };
    }
    if (!best) {
      // Not a trade. A back-online wallet still shows (e.g. it received SOL), anything else is dropped.
      if (keepIfNoTrade) this.update(ev, { stage: 'confirmed', side: solDelta > 0 ? 'recv' : 'send', sol: Math.abs(solDelta), links: { solscan: `https://solscan.io/tx/${ev.id}` } });
      else this.drop(ev);
      return;
    }
    const side = best.d > 0 ? 'buy' : 'sell';
    const patch = {
      stage: 'confirmed', side, mint: best.mint, tokenAmount: Math.abs(best.d), sol: Math.abs(solDelta),
      blockTime: tx.blockTime ? tx.blockTime * 1000 : null, confirmedAt: Date.now(),
      links: { gmgn: `https://gmgn.ai/sol/token/${best.mint}`, solscan: `https://solscan.io/tx/${ev.id}` },
    };
    try {
      const info = await this.tokenInfo(best.mint);
      if (info) Object.assign(patch, { symbol: info.symbol, name: info.name, marketCap: info.marketCap, links: { ...patch.links, axiom: info.pairAddress ? `https://axiom.trade/meme/${info.pairAddress}` : null } });
    } catch {}
    this.update(ev, patch);
    if (side === 'buy') this.cluster(ev);
  }

  /** Several KOLs buying the same coin close together is the signal worth a ping. */
  cluster(ev) {
    const now = Date.now(), win = (this.cfg.clusterMinutes || 15) * 60000;
    const arr = (this.buys.get(ev.mint) || []).filter(b => now - b.t < win);
    if (!arr.some(b => b.kol === ev.kol)) arr.push({ kol: ev.kol, t: now });
    this.buys.set(ev.mint, arr);
    ev.clusterCount = arr.length;
    ev.clusterKols = arr.map(b => b.kol);
    this.send('kol', ev);
    const k = this.byWallet(ev.wallet);
    const label = `${ev.emoji ? ev.emoji + ' ' : ''}${ev.kol}`;
    if (arr.length >= (this.cfg.clusterMin || 2)) {
      this.onAlert?.(ev, `KOL CLUSTER · ${arr.length} KOLs bought $${ev.symbol || ev.mint.slice(0, 6)} in ${this.cfg.clusterMinutes || 15}m: ${ev.clusterKols.join(', ')}`);
    } else if (k?.toast || (this.cfg.alertOn || []).includes(ev.kol)) {
      this.onAlert?.(ev, `KOL BUY · ${label} bought $${ev.symbol || ev.mint.slice(0, 6)} for ${ev.sol.toFixed(2)} SOL`);
    }
  }

  push(ev) {
    this.events.unshift(ev);
    if (this.events.length > 300) this.events.pop();
    this.send('kol', ev);
  }
  update(ev, patch) { Object.assign(ev, patch); this.send('kol', ev); }
  drop(ev) { this.events = this.events.filter(e => e !== ev); this.send('kol-drop', { id: ev.id }); }

  // ---------- demo ----------
  runDemo() {
    const kols = [['Kaiven', '👻'], ['NATE', '〽️'], ['piem', '🐿️'], ['mr frog', '🍗']];
    const coins = [['SIRBLEATS', 52000], ['QUANTUM', 96000], ['CRUMB', 31000], ['PENGUIN', 18800]];
    const venues = ['Pump', 'PumpSwap', 'Jupiter → PumpSwap', 'Meteora DBC'];
    let i = 0;
    const tick = () => {
      const [kol, emoji] = kols[(i * 3) % kols.length];
      const [sym, mcap] = coins[(i * 7 + (i % 2)) % coins.length];
      const side = i % 4 === 3 ? 'sell' : 'buy';
      const venue = venues[i % venues.length];
      const ev = { id: 'demo' + Date.now() + i, kol, emoji, wallet: 'Demo' + kol, venue, side: venue === 'Pump' || venue === 'PumpSwap' ? side : null, stage: 'processed', seenAt: Date.now() };
      if (i === 5) { // a dormant wallet comes back
        ev.kol = 'THE LION'; ev.emoji = '🍕'; ev.back = { quietDays: 43 };
        this.onAlert?.(ev, `BACK ONLINE · 🍕 THE LION moved again after 43 days quiet`, 'back');
      }
      this.push(ev);
      setTimeout(() => {
        const mint = 'Demo' + sym + 'xxxxxxxxxxxxxxxxpump';
        this.update(ev, {
          stage: 'confirmed', side, mint, symbol: sym, name: sym, marketCap: mcap * (0.8 + Math.random() * 0.5), sol: Math.round((0.5 + Math.random() * 9) * 100) / 100,
          tokenAmount: 1e6, blockTime: ev.seenAt - 300, confirmedAt: Date.now(),
          links: { gmgn: `https://gmgn.ai/sol/token/${mint}`, solscan: 'https://solscan.io/', axiom: null },
        });
        if (side === 'buy') this.cluster(ev);
      }, 900 + Math.random() * 600);
      i++;
      this.demoTimer = setTimeout(tick, 4000 + Math.random() * 5000);
    };
    this.demoTimer = setTimeout(tick, 1500);
  }
}

module.exports = { KolWatcher, isWallet, parseWalletList, PROGRAMS };
