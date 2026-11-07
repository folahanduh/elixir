// Rug / bundle / fake-chart checks for a token, plus a memory that learns from past rugs.
//
// Sources:
//   RugCheck (free public API)  – mint/freeze authority, top holders, insider networks, its own risk list
//   Solana RPC (your key)       – first buys: bundled wallets in the creation block, dev buy, dev sold
//   DexScreener pair data       – volume-bot / wash-trading patterns
//   Local memory                – creators and bundle wallets seen in earlier rugs (data/risk-memory.json)

const fs = require('fs');
const path = require('path');

const MEM_PATH = path.join(__dirname, '..', 'data', 'risk-memory.json');
const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
const pct = n => (n == null ? '?' : (Math.round(n * 10) / 10) + '%');

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')); } catch { return { creators: {}, wallets: {}, mints: {} }; }
}

class RiskEngine {
  constructor({ getConfig, demo = false }) {
    this.getConfig = getConfig;
    this.demo = demo;
    this.mem = loadMemory();
    this.cache = new Map(); // mint -> {at, report}
    this.inflight = new Map();
  }

  saveMemory() {
    fs.writeFile(MEM_PATH, JSON.stringify(this.mem, null, 1), () => {});
  }

  memorySummary() {
    const creators = Object.values(this.mem.creators);
    return {
      creators: creators.length,
      rugCreators: creators.filter(c => c.rugs > 0).length,
      wallets: Object.keys(this.mem.wallets).length,
      rugWallets: Object.values(this.mem.wallets).filter(w => w.rugs > 0).length,
      mints: Object.keys(this.mem.mints).length,
      rugs: Object.values(this.mem.mints).filter(m => m.outcome === 'rug').length,
    };
  }

  /** Assess a token. pair = DexScreener-style data we already have (volume, txns, mcap, liquidity). */
  async assess(mint, pair = {}, { maxAgeMs = 120000 } = {}) {
    if (!isAddr(mint) && !this.demo) return null;
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.report;
    if (this.inflight.has(mint)) return this.inflight.get(mint);
    const p = (this.demo ? Promise.resolve(demoReport(mint, pair)) : this.run(mint, pair))
      .then(r => { this.cache.set(mint, { at: Date.now(), report: r }); return r; })
      .finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, p);
    return p;
  }

  async run(mint, pair) {
    const flags = [];
    const add = (level, label, detail = '') => flags.push({ level, label, detail });
    const sources = [];
    let creator = null, holders = null, bundle = null, dev = null, rc = null;

    // 1. RugCheck
    try {
      rc = await rugcheck(mint);
      sources.push('rugcheck');
      creator = rc.creator || null;
      holders = rc.totalHolders ?? null;
      if (rc.mintAuthority) add('high', 'Mint authority not revoked', 'The dev can print more tokens');
      if (rc.freezeAuthority) add('high', 'Freeze authority on', 'The dev can freeze holders so they cannot sell');
      if (rc.rugged) add('high', 'RugCheck marks it rugged');
      if (rc.insiders) add('medium', 'Insider wallet network', 'Linked wallets hold supply (RugCheck graph)');
      for (const r of rc.risks) {
        if (/mint authority|freeze authority/i.test(r.name)) continue; // already covered
        add(r.level === 'danger' ? 'high' : 'medium', r.name, r.description || '');
      }
    } catch (e) { flags.push({ level: 'info', label: 'RugCheck unavailable', detail: e.message }); }

    // 2. First buys from chain: bundles + dev
    const rpc = this.getConfig().keys.solanaRpc;
    if (rpc) {
      try {
        const early = await earlyBuys(rpc, mint);
        sources.push('rpc');
        creator = creator || early.creator;
        bundle = early.bundle;
        dev = early.dev;
        if (bundle.wallets >= 3 || bundle.pct >= 10) add('high', `Bundled launch: ${bundle.wallets} wallets bought ${pct(bundle.pct)} in the creation block`, 'Supply was split across wallets to look organic');
        else if (bundle.wallets >= 2 || bundle.pct >= 5) add('medium', `Possible bundle: ${bundle.wallets} wallets, ${pct(bundle.pct)} in the creation block`);
        if (dev.boughtPct >= 10) add('medium', `Dev bought ${pct(dev.boughtPct)} at launch`);
        if (dev.soldPct != null && dev.boughtPct >= 1 && dev.soldPct >= 50) add('high', `Dev already sold ${pct(dev.soldPct)} of their bag`);
        else if (dev.holdPct != null && dev.holdPct >= 5) add('medium', `Dev still holds ${pct(dev.holdPct)}`);
        if (early.sameSizeBuys >= 4) add('medium', `${early.sameSizeBuys} identical-size buys at launch`, 'Typical of buy bots painting the chart');
      } catch (e) { flags.push({ level: 'info', label: 'On-chain early-buy check failed', detail: e.message }); }
    }

    // 3. Fake chart patterns from market data
    const vol = pair.volume24 ?? pair.volume ?? null;
    if (pair.volQuality === 'botted') add('high', 'Fake volume: tiny matched buys and sells', (pair.volFlags || []).join(', '));
    else if (pair.volQuality === 'mixed') add('medium', 'Partly botted volume', (pair.volFlags || []).join(', '));
    if (vol && holders != null && vol > 100000 && holders < 150) add('high', `$${Math.round(vol / 1000)}K volume but only ${holders} holders`, 'Wash trading paints a chart with no real buyers');

    // 4. Memory of past rugs
    const memHits = this.memoryFlags(creator, bundle?.walletList || []);
    for (const f of memHits) add(f.level, f.label, f.detail);

    return finish({ mint, flags, sources, creator, holders, bundle, dev, top10Pct: rc?.top10Pct ?? null });
  }

  memoryFlags(creator, wallets) {
    const out = [];
    const c = creator && this.mem.creators[creator];
    if (c && c.tokens.length) {
      const rugs = c.rugs || 0;
      if (rugs) out.push({ level: 'high', label: `Creator rugged ${rugs} of ${c.tokens.length} previous tokens`, detail: c.tokens.slice(-3).map(t => '$' + (t.symbol || t.mint.slice(0, 4)) + ' ' + t.outcome).join(', ') });
      else out.push({ level: 'info', label: `Creator launched ${c.tokens.length} token(s) before, none rugged` });
    }
    const bad = wallets.filter(w => this.mem.wallets[w]?.rugs > 0);
    if (bad.length) out.push({ level: 'high', label: `${bad.length} bundle wallet(s) were in past rugs`, detail: bad.slice(0, 3).map(w => w.slice(0, 4) + '…' + w.slice(-4)).join(', ') });
    return out;
  }

  /** Learn: a tracked coin rugged (or held). Remember its creator and its bundle wallets. */
  record(mint, outcome, { symbol, creator, bundleWallets = [], peakMcap, lastMcap } = {}) {
    const prev = this.mem.mints[mint];
    if (prev && prev.outcome === outcome) return;
    this.mem.mints[mint] = { outcome, symbol, at: Date.now(), peakMcap, lastMcap, creator };
    if (creator) {
      const c = this.mem.creators[creator] || (this.mem.creators[creator] = { tokens: [], rugs: 0 });
      const t = c.tokens.find(x => x.mint === mint);
      if (t) { if (t.outcome !== 'rug' && outcome === 'rug') c.rugs++; t.outcome = outcome; }
      else { c.tokens.push({ mint, symbol, outcome, at: Date.now() }); if (outcome === 'rug') c.rugs++; }
    }
    if (outcome === 'rug') for (const w of bundleWallets) {
      const m = this.mem.wallets[w] || (this.mem.wallets[w] = { rugs: 0, seen: 0 });
      m.rugs++; m.seen++; m.last = Date.now();
    }
    this.cache.delete(mint);
    this.saveMemory();
  }

  /** Paste-in memory: lines like "WALLET rug", "MINT rug", "creator WALLET". */
  importLines(text) {
    let n = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const addr = (line.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/) || [])[0];
      if (!addr) continue;
      const isCreator = /creator|dev/i.test(line);
      if (isCreator) {
        const c = this.mem.creators[addr] || (this.mem.creators[addr] = { tokens: [], rugs: 0 });
        c.rugs = Math.max(1, c.rugs);
        if (!c.tokens.length) c.tokens.push({ mint: 'imported', symbol: 'imported', outcome: 'rug', at: Date.now() });
      } else if (/mint|token|ca\b/i.test(line)) {
        this.mem.mints[addr] = { outcome: 'rug', symbol: 'imported', at: Date.now() };
      } else {
        const w = this.mem.wallets[addr] || (this.mem.wallets[addr] = { rugs: 0, seen: 0 });
        w.rugs = Math.max(1, w.rugs); w.imported = true;
      }
      n++;
    }
    this.cache.clear();
    this.saveMemory();
    return n;
  }
}

function finish(r) {
  const w = { high: 30, medium: 12, low: 0, info: 0 };
  const score = Math.min(100, r.flags.reduce((a, f) => a + (w[f.level] || 0), 0));
  const known = r.sources.length > 0;
  r.score = score;
  // One serious flag is enough: a bundle, a dev dump or a known rugger each make it high risk on their own.
  const hasHigh = r.flags.some(f => f.level === 'high'), hasMed = r.flags.some(f => f.level === 'medium');
  r.level = !known && !hasHigh && !hasMed ? 'unknown' : hasHigh ? 'high' : hasMed ? 'medium' : 'low';
  // Lead with the most damning fact: known rugger > bundle > dev dumped > dev can mint/freeze > the rest.
  const order = [/rugged|past rugs/i, /bundle/i, /dev already sold/i, /mint authority|freeze authority/i, /fake volume|holders/i];
  const rank = f => { const i = order.findIndex(re => re.test(f.label)); return i < 0 ? order.length : i; };
  const worst = r.flags.filter(f => f.level === 'high').sort((a, b) => rank(a) - rank(b))[0] || r.flags.filter(f => f.level === 'medium').sort((a, b) => rank(a) - rank(b))[0];
  r.headline = worst?.label || (known ? 'No red flags found' : 'Not checked');
  r.checkedAt = Date.now();
  return r;
}

// ---------- RugCheck ----------
async function rugcheck(mint) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`RugCheck ${res.status}`);
  const j = await res.json();
  const top = Array.isArray(j.topHolders) ? j.topHolders : [];
  const top10Pct = top.length ? top.slice(0, 10).reduce((a, h) => a + (Number(h.pct) || 0), 0) : null;
  return {
    creator: isAddr(j.creator) ? j.creator : null,
    mintAuthority: j.mintAuthority || j.token?.mintAuthority || null,
    freezeAuthority: j.freezeAuthority || j.token?.freezeAuthority || null,
    rugged: Boolean(j.rugged),
    insiders: Boolean(j.graphInsidersDetected),
    totalHolders: Number.isFinite(j.totalHolders) ? j.totalHolders : null,
    top10Pct,
    risks: (Array.isArray(j.risks) ? j.risks : []).map(r => ({ name: String(r.name || ''), level: String(r.level || '').toLowerCase(), description: String(r.description || '') })).filter(r => r.name),
  };
}

// ---------- Solana RPC: first buys ----------
async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || 'RPC error'}`);
  return j.result;
}

/** Oldest transactions of the mint → who bought in the creation block, how much, and the dev. */
async function earlyBuys(rpc, mint) {
  // Walk back to the oldest signatures (new tokens have few pages).
  let before, oldest = [];
  for (let page = 0; page < 6; page++) {
    const sigs = await rpcCall(rpc, 'getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs.length) break;
    oldest = sigs;
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  const first = oldest.filter(s => !s.err).slice(-40).reverse(); // chronological
  if (!first.length) throw new Error('no transactions found');
  const supplyRes = await rpcCall(rpc, 'getTokenSupply', [mint]);
  const supply = Number(supplyRes?.value?.uiAmount) || 1e9;
  const txs = [];
  for (let i = 0; i < first.length; i += 5) {
    const batch = await Promise.all(first.slice(i, i + 5).map(s => rpcCall(rpc, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null)));
    txs.push(...batch);
  }
  const createSlot = first[0].slot;
  const firstTx = txs[0];
  const keyOf = k => (typeof k === 'string' ? k : k.pubkey);
  const creator = firstTx ? keyOf(firstTx.transaction.message.accountKeys[0]) : null;
  const buys = []; // {owner, amount, slot}
  for (const tx of txs) {
    if (!tx || tx.meta?.err) continue;
    const pre = new Map(), post = new Map();
    for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint) pre.set(b.owner, Number(b.uiTokenAmount.uiAmount || 0));
    for (const b of tx.meta.postTokenBalances || []) if (b.mint === mint) post.set(b.owner, Number(b.uiTokenAmount.uiAmount || 0));
    for (const [owner, after] of post) {
      const d = after - (pre.get(owner) || 0);
      if (d > 0 && d < supply * 0.5) buys.push({ owner, amount: d, slot: tx.slot }); // skip curve/pool accounts receiving ~all supply
    }
  }
  const inCreate = buys.filter(b => b.slot === createSlot && b.owner !== creator);
  const bundleWallets = [...new Set(inCreate.map(b => b.owner))];
  const bundlePct = inCreate.reduce((a, b) => a + b.amount, 0) / supply * 100;
  const devBought = buys.filter(b => b.owner === creator).reduce((a, b) => a + b.amount, 0);
  let devHold = null;
  if (creator) {
    try {
      const accts = await rpcCall(rpc, 'getTokenAccountsByOwner', [creator, { mint }, { encoding: 'jsonParsed' }]);
      devHold = (accts?.value || []).reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    } catch {}
  }
  const sizes = new Map();
  for (const b of buys.slice(0, 40)) { const k = Math.round(b.amount / 1000); sizes.set(k, (sizes.get(k) || 0) + 1); }
  return {
    creator,
    bundle: { wallets: bundleWallets.length, pct: Math.round(bundlePct * 10) / 10, walletList: bundleWallets, slot: createSlot },
    dev: {
      boughtPct: Math.round(devBought / supply * 1000) / 10,
      holdPct: devHold == null ? null : Math.round(devHold / supply * 1000) / 10,
      soldPct: devHold == null || !devBought ? null : Math.max(0, Math.round((1 - devHold / devBought) * 100)),
    },
    sameSizeBuys: Math.max(0, ...sizes.values()) >= 2 ? Math.max(...sizes.values()) : 0,
  };
}

// ---------- demo ----------
function demoReport(mint, pair) {
  const h = [...String(mint)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 3);
  const flags = [];
  const add = (level, label, detail = '') => flags.push({ level, label, detail });
  const bundled = /flt|bonk/.test(mint) || h % 4 === 0;
  if (bundled) add('high', `Bundled launch: ${3 + (h % 6)} wallets bought ${12 + (h % 30)}% in the creation block`, 'Supply was split across wallets to look organic');
  if (pair.volQuality === 'botted') add('high', 'Fake volume: tiny matched buys and sells', (pair.volFlags || []).join(', '));
  if (h % 5 === 1) add('high', `Dev already sold ${60 + (h % 40)}% of their bag`);
  if (h % 3 === 1) add('medium', `Dev still holds ${5 + (h % 9)}%`);
  if (/BAGS/.test(mint)) add('high', 'Creator rugged 2 of 3 previous tokens', '(demo memory)');
  return finish({ mint, flags, sources: ['demo'], creator: null, holders: 200 + (h % 2000), bundle: { wallets: bundled ? 3 + (h % 6) : 0, pct: bundled ? 12 + (h % 30) : 0, walletList: [] }, dev: null, top10Pct: null });
}

module.exports = { RiskEngine, earlyBuys, rugcheck };
