#!/usr/bin/env node
// Elixir — spot tweet plays and live-stream words fast, check if a token exists, jump to GMGN/Axiom.
// One optional dependency (Claude SDK). Node 22+.  Run:  npm start        (demo data:  npm run demo)

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`\n  Elixir needs Node.js 22 or newer (you have ${process.version}).\n  Get the LTS from https://nodejs.org and run it again.\n`);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractCandidates, watchHits, normalize } = require('./lib/extract');
const dex = require('./lib/dex');
const sources = require('./lib/sources');
const { StreamManager } = require('./lib/stream/manager');
const { PlayTracker } = require('./lib/plays');
const { makeEnricher, makeImagePicker } = require('./lib/playai');
const { searchImages } = require('./lib/imagesearch');
const { checkCoin, activePreset } = require('./lib/filters');
const { padsFrom, classify } = require('./lib/launchpads');
const { KolWatcher, isWallet, parseWalletList } = require('./lib/kols');
const { WhaleWatcher } = require('./lib/whales');
const { LaunchRadar } = require('./lib/radar');
const solPrice = require('./lib/solprice');
const { RiskEngine } = require('./lib/risk');
const updater = require('./lib/update');
const kw = require('./lib/keywords');
const limit = require('./lib/limit');

// Never die silently: log crashes to data/elixir.log and keep running.
const crashLog = (kind, e) => {
  const line = `[${new Date().toISOString()}] ${kind}: ${e && e.stack || e}\n`;
  console.error(line.trim());
  try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); fs.appendFileSync(path.join(__dirname, 'data', 'elixir.log'), line); } catch {}
};
process.on('uncaughtException', e => crashLog('crash', e));
process.on('unhandledRejection', e => crashLog('unhandled', e));

const ROOT = __dirname;
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'data', 'feed.jsonl');

// ---------- config ----------
loadDotEnv();
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(ROOT, 'config.example.json'), CONFIG_PATH);
seedPresets();
let cfg = readConfig();

// Built-in accounts and live channels (presets/*.json). Each preset entry is added once: ones you
// remove stay removed, and presets added in later versions still arrive. "presets": false turns it off.
function seedPresets() {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  if (disk.presets === false) return;
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', f), 'utf8')); } catch { return null; } };
  const acc = read('accounts.json'), st = read('streams.json');
  const seeded = { accounts: [], vip: [], streams: [], ...(disk.presetSeeded || {}) };
  const has = (list, h) => list.some(x => String(x).toLowerCase() === h.toLowerCase());
  disk.accounts = disk.accounts || []; disk.vip = disk.vip || [];
  let added = 0, streamsAdded = 0;
  for (const g of acc?.groups || []) for (const h of g.accounts) {
    if (!has(seeded.accounts, h)) { seeded.accounts.push(h); if (!has(disk.accounts, h)) { disk.accounts.push(h); added++; } }
    if (g.vip && !has(seeded.vip, h)) { seeded.vip.push(h); if (!has(disk.vip, h)) disk.vip.push(h); }
  }
  // Presets taken out in later versions (noisy accounts): remove them once from lists they were added to.
  seeded.removed = seeded.removed || [];
  for (const h of acc?.removed || []) {
    if (has(seeded.removed, h) || !has(seeded.accounts, h)) continue;
    seeded.removed.push(h);
    disk.accounts = disk.accounts.filter(a => a.toLowerCase() !== h.toLowerCase());
    disk.vip = disk.vip.filter(a => a.toLowerCase() !== h.toLowerCase());
  }
  // Accounts that ping on every tweet and reply out of the box (presets/accounts.json "ping"): set once.
  seeded.ping = seeded.ping || [];
  disk.accountMeta = disk.accountMeta || {};
  for (const h of acc?.ping || []) {
    const k = h.toLowerCase();
    if (seeded.ping.includes(k)) continue;
    seeded.ping.push(k);
    if (!disk.accountMeta[k]) disk.accountMeta[k] = { ping: true };
    else if (disk.accountMeta[k].ping === undefined && !disk.accountMeta[k].muted) disk.accountMeta[k].ping = true;
  }
  // Built-in KOL / dev wallets (presets/wallets.json): added once, removed ones stay removed.
  const walPreset = read('wallets.json');
  if (walPreset) {
    seeded.wallets = seeded.wallets || [];
    const done = new Set(seeded.wallets);
    disk.kols = disk.kols || {};
    disk.kols.wallets = Array.isArray(disk.kols.wallets) ? disk.kols.wallets : [];
    const have = new Set(disk.kols.wallets.map(w => w.wallet));
    let addedW = 0;
    for (const w of walPreset.wallets || []) {
      if (done.has(w.wallet)) continue;
      seeded.wallets.push(w.wallet);
      if (!have.has(w.wallet)) { disk.kols.wallets.push({ toast: false, groups: [], color: null, ...w }); addedW++; }
    }
    if (addedW) console.log(`  Added ${addedW} preset KOL wallets.`);
  }
  // Default keywords (presets/keywords.json): added once.
  const kwPreset = read('keywords.json');
  if (kwPreset && !seeded.keywords) {
    const OLD = ['doge', 'pepe', 'frog', 'cat', 'hamster', 'penguin', 'grok', 'x money'];
    const oldDemo = Array.isArray(disk.watchlist) && disk.watchlist.length === OLD.length && OLD.every(w => disk.watchlist.includes(w));
    const cur = Array.isArray(disk.keywords) ? disk.keywords : oldDemo ? [] : (disk.watchlist || []).map(w => ({ word: w, match: 'word' }));
    const have = new Set(cur.map(k => String(typeof k === 'string' ? k : k.word).toLowerCase()));
    disk.keywords = [...cur, ...kwPreset.keywords.filter(k => !have.has(k.word))];
    delete disk.watchlist;
    seeded.keywords = true;
  }
  if (kwPreset && !seeded.kwScope && Array.isArray(disk.keywords)) {
    const defaults = new Set(kwPreset.keywords.map(k => k.word));
    disk.keywords = disk.keywords.map(k => (typeof k === 'object' && defaults.has(k.word) && !k.scope ? { ...k, scope: 'tweets' } : k));
    seeded.kwScope = true;
  }
  // The first versions shipped a demo watchlist of generic words (cat, frog, grok…) that pinged constantly.
  // If it's still exactly that list, clear it: your watchlist should only hold words you care about.
  const OLD_DEMO = ['doge', 'pepe', 'frog', 'cat', 'hamster', 'penguin', 'grok', 'x money'];
  if (!seeded.watchlistCleared && Array.isArray(disk.watchlist) && disk.watchlist.length === OLD_DEMO.length && OLD_DEMO.every(w => disk.watchlist.includes(w))) disk.watchlist = [];
  seeded.watchlistCleared = true;
  disk.streams = disk.streams || {}; disk.streams.watch = disk.streams.watch || [];
  seeded.walletNames = seeded.walletNames || [];
  for (const w of st?.watch || []) {
    if (!w.walletName || seeded.walletNames.includes(w.url)) continue;
    seeded.walletNames.push(w.url);
    const mine = disk.streams.watch.find(x => x.url === w.url);
    if (mine && !mine.wallet && !mine.walletName) mine.walletName = w.walletName;
  }
  for (const w of st?.watch || []) {
    if (seeded.streams.includes(w.url)) continue;
    seeded.streams.push(w.url);
    if (!disk.streams.watch.some(x => x.url === w.url)) { disk.streams.watch.push(w); streamsAdded++; }
  }
  disk.presetSeeded = seeded;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2));
  if (added || streamsAdded) console.log(`  Added ${added} preset X accounts and ${streamsAdded} live channels (presets/). Remove any in Settings.`);
}
// Accounts in 'slow' preset groups are polled every 4th cycle to save API credit.
const SLOW = new Set((() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'accounts.json'), 'utf8')).groups.filter(g => g.tier === 'slow').flatMap(g => g.accounts.map(a => a.toLowerCase())); } catch { return []; } })());

// API keys: lib/keys.js finds them in .env (or .env.example / env / .env.txt), under common names too.
var keyReport = { files: [], loaded: {}, notes: [] }; // var: loadDotEnv() runs above this line
function loadDotEnv() {
  keyReport = require('./lib/keys').loadKeys(ROOT, m => console.log(m));
}

function readConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.keys = c.keys || {};
  // Extra keys rotate when one is rate-limited: X_BEARER_TOKEN_2, _3… (or several, comma-separated).
  const many = (name, fromCfg) => [...new Set([process.env[name], ...[2, 3, 4, 5].map(n => process.env[`${name}_${n}`]), fromCfg]
    .flatMap(v => String(v || '').split(',')).map(v => v.trim()).filter(Boolean))];
  c.keys.twitterapiIos = many('TWITTERAPI_IO_KEY', c.keys.twitterapiIo);
  c.keys.xBearers = many('X_BEARER_TOKEN', c.keys.xBearer).map(t => decodeURIComponent(t)); // X shows tokens %-encoded sometimes
  c.keys.twitterapiIo = c.keys.twitterapiIos[0] || '';
  c.keys.xBearer = c.keys.xBearers[0] || '';
  c.telegram = c.telegram || {};
  c.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || c.telegram.botToken || '';
  c.telegram.chatId = process.env.TELEGRAM_CHAT_ID || c.telegram.chatId || '';
  c.keys.deepgram = process.env.DEEPGRAM_API_KEY || c.keys.deepgram || '';
  c.keys.anthropic = process.env.ANTHROPIC_API_KEY || c.keys.anthropic || '';
  // A bare Helius key (UUID) pasted anywhere → proper URLs. (A bare key as the RPC URL broke every wallet lookup.)
  const HELIUS_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const asWs = v => (HELIUS_KEY.test(v) ? 'wss://mainnet.helius-rpc.com/?api-key=' + v : /^(wss?|https?):\/\//i.test(v) ? v.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') : '');
  const asHttp = v => (HELIUS_KEY.test(v) ? 'https://mainnet.helius-rpc.com/?api-key=' + v : /^(wss?|https?):\/\//i.test(v) ? v.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:') : '');
  for (const k of ['SOLANA_WS_URL', 'SOLANA_RPC_URL']) if (process.env[k]) process.env[k] = process.env[k].trim();
  c.keys.solanaWs = asWs(process.env.SOLANA_WS_URL || c.keys.solanaWs || '') || (HELIUS_KEY.test(process.env.SOLANA_RPC_URL || '') ? asWs(process.env.SOLANA_RPC_URL) : '');
  if (c.keys.solanaRpc) c.keys.solanaRpc = asHttp(c.keys.solanaRpc);
  if (process.env.SOLANA_RPC_URL) process.env.SOLANA_RPC_URL = asHttp(process.env.SOLANA_RPC_URL);
  // No key: Solana's free public RPC, so KOL wallets and rug checks work out of the box
  // (rate-limited; a free Helius key is faster and copes with big wallet lists).
  c.keys.solanaPublic = !c.keys.solanaWs && !process.env.SOLANA_RPC_URL && !c.keys.solanaRpc;
  // One pace for all RPC calls: the public RPC allows far less than Helius (set "rpcRps" in config.json for a paid plan).
  limit.setRpcRate(c.keys.solanaPublic ? 3 : Number(c.rpcRps) || 8);
  if (c.keys.solanaPublic) c.keys.solanaWs = 'wss://api.mainnet-beta.solana.com';
  // The HTTP RPC defaults to the same provider as the websocket (wss:// → https://).
  c.keys.solanaRpc = process.env.SOLANA_RPC_URL || c.keys.solanaRpc || c.keys.solanaWs.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  c.discordWebhook = process.env.DISCORD_WEBHOOK_URL || c.discordWebhook || '';
  c.port = Number(process.env.PORT || c.port || 8787);
  // Fill in settings added in newer versions so older config.json files keep working.
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  c.streams = { ...defaults.streams, ...(c.streams || {}), judge: { ...defaults.streams.judge, ...((c.streams || {}).judge || {}) } };
  c.streams.clips = { ...defaults.streams.clips, ...((c.streams || {}).clips || {}) };
  c.plays = { ...defaults.plays, ...(c.plays || {}), ai: { ...defaults.plays.ai, ...((c.plays || {}).ai || {}) } };
  c.kols = { ...defaults.kols, ...(c.kols || {}) };
  c.filters = { ...defaults.filters, ...(c.filters || {}), presets: { ...defaults.filters.presets, ...((c.filters || {}).presets || {}) } };
  c.keywords = kw.normalizeKeywords(Array.isArray(c.keywords) ? c.keywords : c.watchlist || []);
  c.watchlist = c.keywords.filter(k => !k.muted && k.scope !== 'tweets').map(k => k.word); // streams: speech hints + live pings
  c.builtins = { ...kw.DEFAULT_BUILTINS, ...(c.builtins || {}) };
  c.accountMeta = c.accountMeta || {};
  if (DEMO) c.vip = [...new Set([...(c.vip || []), 'memelord_daily', 'frogwatcher'])]; // fictional demo accounts, so demo plays fire
  return c;
}

function publicConfig() {
  return {
    provider: DEMO ? 'demo' : activeProvider(),
    accounts: cfg.accounts, vip: cfg.vip, watchlist: cfg.watchlist, ignore: cfg.ignore,
    pollSeconds: cfg.pollSeconds, chains: cfg.chains, includeReplies: cfg.includeReplies, openBrowser: cfg.openBrowser !== false, lensModel: cfg.lensModel === 'best' ? 'best' : 'fastest',
    links: { fomo: (cfg.links && cfg.links.fomo) || '' }, notify: cfg.notify === 'all' ? 'all' : 'important', keywords: cfg.keywords, trend: cfg.trend, telegram: Boolean(cfg.telegram.botToken && cfg.telegram.chatId), discord: Boolean(cfg.discordWebhook),
    streams: { highlightScore: cfg.streams.highlightScore, pingScore: cfg.streams.pingScore, watch: cfg.streams.watch, language: cfg.streams.language },
    filter: activePreset(cfg),
    keys: keyStatus(),
  };
}

// ---------- API keys (Settings → API keys writes .env; values never go back to the page) ----------
const KEY_ENVS = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'SOLANA_WS_URL', 'SOLANA_RPC_URL', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'TWITTERAPI_IO_KEY', 'X_BEARER_TOKEN', 'X_BEARER_TOKEN_2', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL', 'SOLSCAN_API_KEY'];
function keyStatus() {
  const out = {};
  for (const k of KEY_ENVS) {
    const v = process.env[k] || '';
    out[k] = { set: Boolean(v), hint: v ? '…' + v.slice(-4) : '' };
  }
  if (cfg?.keys?.solanaPublic) out.SOLANA_WS_URL.fallback = 'using free public RPC';
  out._report = { files: keyReport.files.map(f => ({ file: f.file, names: f.names.slice(0, 20) })), notes: keyReport.notes };
  return out;
}
function writeEnv(changes) {
  const p = path.join(ROOT, '.env');
  let lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/)
    : fs.existsSync(path.join(ROOT, '.env.example')) ? fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(changes)) {
    const i = lines.findIndex(l => new RegExp(`^\\s*#?\\s*${k}\\s*=`).test(l));
    const line = `${k}=${v}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
    if (v) process.env[k] = v; else delete process.env[k];
  }
  fs.writeFileSync(p, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}
/** One cheap request per key to show "works" or the provider's error. */
async function testKey(k) {
  const v = process.env[k];
  if (!v) return { ok: null, msg: 'not set' };
  const T = { signal: AbortSignal.timeout(8000) };
  const fail = async r => ({ ok: false, msg: `${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`.trim() });
  try {
    if (k === 'SOLANA_WS_URL' || k === 'SOLANA_RPC_URL') {
      const r = await fetch(cfg.keys.solanaRpc, { ...T, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }) });
      const j = await r.json().catch(() => ({}));
      return j.result ? { ok: true, msg: `connected · slot ${j.result}` } : { ok: false, msg: j.error?.message || `HTTP ${r.status}` };
    }
    if (k === 'SOLSCAN_API_KEY') {
      const r = await fetch('https://pro-api.solscan.io/v2.0/account/metadata?address=So11111111111111111111111111111111111111112', { ...T, headers: { token: v } });
      const j = await r.json().catch(() => ({}));
      return r.ok && j.success !== false ? { ok: true, msg: 'works' } : { ok: false, msg: `${r.status} ${j.errors?.message || j.message || ''}`.trim() + (r.status === 401 || r.status === 403 ? ' · the Pro API needs a paid Solscan plan' : '') };
    }
    if (k === 'DEEPGRAM_API_KEY') { const r = await fetch('https://api.deepgram.com/v1/projects', { ...T, headers: { authorization: 'Token ' + v } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'ANTHROPIC_API_KEY') { const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { ...T, headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'TWITTERAPI_IO_KEY') {
      const r = await sources.tioFetch('https://api.twitterapi.io/twitter/user/info?userName=x', v);
      if (r.ok) return { ok: true, msg: sources.tioGap() >= 4000 ? 'works · free tier (1 request / 5 s)' : 'works' };
      const body = await r.text().catch(() => '');
      if (r.status === 429 && /free-tier/i.test(body)) return { ok: true, msg: 'works · free tier (1 request / 5 s)' };
      return { ok: false, msg: `${r.status} ${body.slice(0, 120)}` };
    }
    if (k === 'X_BEARER_TOKEN' || k === 'X_BEARER_TOKEN_2') { const r = await fetch('https://api.x.com/2/users/by/username/x', { ...T, headers: { authorization: 'Bearer ' + v } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'DISCORD_WEBHOOK_URL') {
      if (!DISCORD_RE.test(v)) return { ok: false, msg: 'should start with https://discord.com/api/webhooks/' };
      const r = await fetch(v, T); const j = await r.json().catch(() => ({})); return r.ok ? { ok: true, msg: 'posts as ' + (j.name || 'webhook') } : fail(r);
    }
    if (k === 'TELEGRAM_BOT_TOKEN') { const r = await fetch(`https://api.telegram.org/bot${v}/getMe`, T); const j = await r.json().catch(() => ({})); return j.ok ? { ok: true, msg: '@' + j.result.username } : { ok: false, msg: j.description || `HTTP ${r.status}` }; }
    return { ok: null, msg: 'saved' };
  } catch (e) { return { ok: false, msg: e.name === 'TimeoutError' ? 'no answer in 8 s' : e.message === 'fetch failed' ? "couldn't reach the provider (internet, VPN or firewall?)" : e.message }; }
}

function activeProvider() {
  if (cfg.provider === 'twitterapi.io' && cfg.keys.twitterapiIo) return 'twitterapi.io';
  if (cfg.provider === 'x-api' && cfg.keys.xBearer) return 'x-api';
  if (cfg.provider === 'auto' || !cfg.provider) {
    if (cfg.keys.twitterapiIo) return 'twitterapi.io';
    if (cfg.keys.xBearer) return 'x-api';
  }
  return 'bridge-only';
}

// ---------- state ----------
const items = [];            // newest last
const seen = new Set();
const mentions = new Map();  // word -> [{t, itemId, source}]
const lastTrendAlert = new Map();
const clients = new Set();
const status = { lastPollAt: null, lastPollError: null, polls: 0, bridgeLastSeen: null };

function send(event, data) {
  const json = JSON.stringify(data);
  const named = `event: ${event}\ndata: ${json}\n\n`;
  const mux = `data: {"e":${JSON.stringify(event)},"d":${json}}\n\n`; // one stream shared by every Elixir window
  for (const res of clients) res.write(res.mux ? mux : named);
}
const helloPayload = () => ({ version: VERSION, config: publicConfig(), status: statusPayload(), items: items.slice(-150), trends: trendsSnapshot(), streams: streams.snapshot(), plays: plays.list(), playStats: plays.stats(), kols: kols.snapshot(), whales: whales.snapshot(), radar: radar.snapshot(), solPrice: solPrice.snapshot(), riskMemory: risk.memorySummary() });

// Same word looked up again within a minute: reuse the answer. Max 4 lookups at a time.
const lookupCache = new Map();
function cachedLookup(word) {
  const k = word.toLowerCase();
  const hit = lookupCache.get(k);
  if (hit && Date.now() - hit.t < 60000) return hit.p;
  const p = limit.dex(() => dex.lookup(word, { chains: cfg.chains, demo: DEMO }));
  lookupCache.set(k, { t: Date.now(), p });
  p.catch(() => lookupCache.delete(k));
  if (lookupCache.size > 2000) lookupCache.delete(lookupCache.keys().next().value);
  return p;
}

const lastItemForWord = new Map();
let trendsTimer = null, trendsAt = 0;
function scheduleTrends() {
  if (trendsTimer) return;
  trendsTimer = setTimeout(() => {
    trendsTimer = null; trendsAt = Date.now();
    const snap = trendsSnapshot();
    const now = Date.now();
    for (const t of snap) {
      if (t.last5 < cfg.trend.minMentions || t.authors < cfg.trend.minAuthors) continue;
      const prev = lastTrendAlert.get(t.word) || 0;
      const item = lastItemForWord.get(t.word);
      if (item && !item.stale && now - prev > cfg.trend.cooldownMinutes * 60000) {
        lastTrendAlert.set(t.word, now);
        alert({ kind: 'trend', title: `“${t.word}” spiking — ${t.last5} mentions / 5m`, item, word: t.word });
      }
    }
    send('trends', snap);
  }, Math.max(0, 2000 - (Date.now() - trendsAt)));
}

function trendsSnapshot() {
  const now = Date.now();
  const win = cfg.trend.windowMinutes * 60000;
  const out = [];
  for (const [word, arr] of mentions) {
    const recent = arr.filter(m => now - m.t <= win);
    if (!recent.length) { mentions.delete(word); continue; }
    mentions.set(word, recent);
    const last5 = recent.filter(m => now - m.t <= 5 * 60000).length;
    out.push({
      word,
      count: recent.length,
      last5,
      sources: [...new Set(recent.map(m => m.source))],
      authors: new Set(recent.map(m => m.author)).size,
      lastAt: recent[recent.length - 1].t,
    });
  }
  return out.sort((a, b) => b.last5 - a.last5 || b.count - a.count || b.lastAt - a.lastAt).slice(0, 30);
}

// ---------- pipeline ----------
const safeUrl = u => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');

async function ingest(raw) {
  const text = String(raw.text || '').trim();
  if (!text) return null;
  const source = ['x', 'stream', 'manual'].includes(raw.source) ? raw.source : 'manual';
  const id = String(raw.id || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  if (seen.has(id)) return null;
  seen.add(id);
  if (seen.size > 20000) seen.delete(seen.values().next().value);

  const receivedAt = Date.now();
  const author = String(raw.author || (source === 'stream' ? (raw.label || 'stream') : 'you')).replace(/^@/, '');
  const createdAt = raw.createdAt ? Number(raw.createdAt) || Date.parse(raw.createdAt) || null : null;
  const ageSec = createdAt ? (receivedAt - createdAt) / 1000 : 0;

  const candidates = extractCandidates(text, {
    watchlist: cfg.watchlist, ignore: cfg.ignore, max: source === 'stream' ? 5 : 6,
  });
  const vip = source === 'x' && cfg.vip.map(v => v.toLowerCase()).includes(author.toLowerCase());
  // Tweets: only coin-shaped words count — $TICKERs, "quoted names", names after "named / RIP / justice for…",
  // and your keywords. Plain capitalised words (places, people in the news) were just noise.
  {
    const strong = c => c.watch || c.reasons.some(r => r === 'cashtag' || r === 'quoted' || r === 'pattern' || r === 'watchlist');
    candidates.splice(0, candidates.length, ...candidates.filter(strong));
  }
  const kwHits = kw.keywordHits(text, cfg.keywords.filter(k => (source === 'stream' ? k.scope !== 'tweets' : k.scope !== 'streams')));
  const muted = Boolean(cfg.accountMeta[author.toLowerCase()]?.muted);
  const watch = muted ? [] : kwHits.filter(k => !k.muted).map(k => k.word);

  const item = {
    id, source, author, authorName: String(raw.authorName || ''), avatar: safeUrl(raw.avatar),
    text, url: safeUrl(raw.url), createdAt, receivedAt,
    latencyMs: createdAt ? Math.max(0, receivedAt - createdAt) : null,
    vip, watch, candidates, via: raw.via || source, muted,
    kw: kwHits.map(k => ({ word: k.word, color: k.color })),
    stale: ageSec > cfg.alertMaxAgeSeconds,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 8).map(String) : undefined,
    replyTo: raw.replyTo ? String(raw.replyTo).replace(/^@/, '').slice(0, 30) : null,
    links: Array.isArray(raw.links) ? raw.links.slice(0, 10).map(String) : undefined,
    media: Array.isArray(raw.media) ? raw.media.map(safeUrl).filter(Boolean).slice(0, 4) : [],
    engagement: raw.engagement && typeof raw.engagement === 'object'
      ? { likes: Number(raw.engagement.likes) || 0, reposts: Number(raw.engagement.reposts) || 0, views: Number(raw.engagement.views) || 0 } : undefined,
  };
  const quiet = raw.noAlert === true; // stream moments: the stream manager sends its own pings

  items.push(item);
  if (items.length > 400) items.shift();
  fs.appendFile(LOG_PATH, JSON.stringify(item) + '\n', () => {});

  for (const c of quiet ? [] : candidates) { // stream lines are already counted by the stream manager
    if (source === 'stream' && c.score < 2 && !c.watch) continue; // stream chatter: only meaningful words trend
    const arr = mentions.get(c.word) || [];
    arr.push({ t: receivedAt, itemId: id, source, author });
    mentions.set(c.word, arr);
  }

  send('item', item);

  // Alerts: VIP tweets and watchlist hits fire immediately — before any market lookup.
  if (source === 'x' && !item.stale) streams.fromTweet(item);
  if (!quiet && !item.stale && !muted && (vip || watch.length)) {
    const why = [vip && `VIP @${author}`, watch.length && `keyword: ${watch.join(', ')}`].filter(Boolean).join(' · ');
    alert({ kind: watch.length ? 'watch' : 'vip', title: why, item });
  }
  // Accounts set to "ping on every tweet" (Settings → Accounts, the bell): every tweet and reply makes a noise.
  if (!quiet && !item.stale && !muted && source === 'x' && cfg.accountMeta[author.toLowerCase()]?.ping) {
    alert({ kind: 'vip', title: item.replyTo ? `REPLY · @${author} replied to @${item.replyTo}` : `TWEET · @${author}`, item, important: true });
  }
  // Built-in detectors (Settings → Keywords): a tracked account posting a $TICKER or a "quoted name".
  if (!quiet && !item.stale && !muted && source === 'x') {
    const tick = cfg.builtins.cashtag && candidates.find(c => c.reasons.includes('cashtag') && !MAJORS.has(c.word.toLowerCase()));
    const quote = cfg.builtins.quoted && candidates.find(c => c.reasons.includes('quoted'));
    if (tick) alert({ kind: 'watch', title: `$TICKER · @${author} posted ${tick.display}`, item, word: tick.word, important: true });
    else if (quote) alert({ kind: 'watch', title: `QUOTED · @${author}: “${quote.display}”`, item, word: quote.word, important: true });
  }

  // Trend spikes: recomputed at most every 2 s (a burst of tweets used to recompute it for each one).
  if (!quiet) for (const c of candidates) lastItemForWord.set(c.word, item);
  scheduleTrends();

  // Market check for the strongest candidates. Backfilled/old tweets are shown but not looked up
  // (hundreds at once on start-up used to flood DexScreener and freeze everything).
  const toCheck = item.stale ? [] : candidates.filter(c => c.watch || c.score >= (source === 'stream' ? 3 : 2)).slice(0, 3);
  const dexResults = {};
  await Promise.all(toCheck.map(async c => {
    try {
      const r = await cachedLookup(c.display.replace(/^[$#]/, ''));
      dexResults[c.word] = r;
      item.dex = item.dex || {};
      item.dex[c.word] = r;
      send('dex', { ...r, itemId: id, word: c.word });
      if (!quiet && !item.stale && (vip || c.watch) && r.status !== 'exists') {
        alert({
          kind: r.status === 'fresh' ? 'fresh' : 'open',
          title: r.status === 'fresh'
            ? `“${c.word}” — token launched ${r.newestAgeMin}m ago`
            : `“${c.word}” — no token yet`,
          item, word: c.word, dex: r,
        });
      }
    } catch (e) {
      send('dex', { itemId: id, word: c.word, error: e.message });
      console.error('[dex]', c.word, e.message);
    }
  }));
  if (!quiet) plays.consider(item, dexResults);
  return item;
}

// ---------- live streams ----------
const streams = new StreamManager({
  getConfig: () => cfg,
  send,
  demo: DEMO,
  lookup: word => cachedLookup(word),
  onSegment(seg, session) {
    // Every spoken line feeds Hot words; highlighted lines also go into the main feed.
    for (const k of seg.keywords) {
      if (k.kind === 'funny' || k.kind === 'crypto') continue;
      const w = normalize(k.text);
      const arr = mentions.get(w) || [];
      arr.push({ t: Date.now(), itemId: seg.id, source: 'stream', author: session.label });
      mentions.set(w, arr);
    }
    if (seg.highlight) {
      ingest({ source: 'stream', id: 'seg-' + seg.id, author: session.label, text: seg.text, url: session.url, createdAt: seg.t, tags: seg.tags, noAlert: true, via: 'stream' })
        .then(item => { if (item && session.kind !== 'demo') plays.considerStream(item, seg, session); })
        .catch(() => {});
    }
  },
  // A streamer said something there's a coin for: ping, put it in the feed, and track it as a play.
  onCoins(seg, session, found) {
    const c = found[0].coins[0];
    const mc = c.marketCap ? ` · $${c.marketCap >= 1e6 ? (c.marketCap / 1e6).toFixed(2) + 'M' : Math.round(c.marketCap / 1000) + 'K'}` : '';
    const item = { id: 'seg-' + seg.id, source: 'stream', author: session.label, text: seg.text, url: session.url || '' };
    alert({ kind: 'fresh', title: `LIVE COIN · ${session.label} said “${found[0].phrase}” → $${c.symbol}${mc}`, item, word: found[0].phrase, streamId: session.id, segId: seg.id, tags: ['WATCH'], important: true });
    if (session.kind === 'demo') return;
    ingest({ source: 'stream', id: 'seg-' + seg.id, author: session.label, text: seg.text, url: session.url, createdAt: seg.t, tags: seg.tags, noAlert: true, via: 'stream' })
      .then(it => plays.considerStream(it || items.find(x => x.id === 'seg-' + seg.id), { ...seg, pinged: true, keywords: [...(seg.keywords || []), ...found.map(f => ({ text: f.phrase, kind: 'coinable' }))] }, session))
      .catch(() => {});
  },
  async onWalletMention(seg, session) {
    const link = (cfg.streams.watch || []).find(x => x.url && x.url === session.url) || {};
    const wallets = kols.walletsFor({ address: link.wallet, name: link.walletName, names: [session.label, session.profile?.name, session.profile?.handle] });
    if (!wallets.length) {
      seg.walletNote = `Said they're in a coin. Link ${session.profile?.name || session.label}'s wallet (Streams → Auto-watch → wallet) to see which one.`;
      streams.send('stream-seg', seg);
      return;
    }
    let buys = [];
    try { buys = await kols.recentBuysMany(wallets); } catch {}
    const coins = [];
    for (const b of buys) {
      let info = null;
      try { info = await dex.tokenInfo(b.mint); } catch {}
      coins.push({
        mint: b.mint, symbol: info?.symbol || b.mint.slice(0, 5), name: info?.name || '', image: info?.image || null, marketCap: info?.marketCap ?? null,
        ageMin: b.at ? Math.round((Date.now() - b.at) / 60000) : null, sol: b.sol, pad: info?.dexId || '', bought: true,
        links: { axiom: `https://axiom.trade/meme/${info?.pairAddress || b.mint}`, gmgn: `https://gmgn.ai/sol/token/${b.mint}`, dexscreener: `https://dexscreener.com/solana/${b.mint}`, tx: b.sig ? `https://solscan.io/tx/${b.sig}` : null },
      });
    }
    seg.walletCoins = coins;
    seg.walletNote = coins.length ? '' : `No buys from ${session.label}'s wallet in the last 2 hours.`;
    if (coins.length && !seg.tags.includes('COIN')) seg.tags.push('COIN');
    if (coins.length) seg.highlight = true;
    streams.send('stream-seg', seg);
    if (coins.length) {
      const c = coins[0];
      const mc = c.marketCap ? ` · $${c.marketCap >= 1e6 ? (c.marketCap / 1e6).toFixed(2) + 'M' : Math.round(c.marketCap / 1000) + 'K'}` : '';
      alert({ kind: 'fresh', title: `WALLET · ${session.label} is in $${c.symbol}${mc}${c.sol ? ` (${c.sol.toFixed(2)} SOL, ${c.ageMin}m ago)` : ''}`, item: { id: 'seg-' + seg.id, source: 'stream', author: session.label, text: seg.text, url: session.url || '' }, streamId: session.id, segId: seg.id, tags: ['WATCH'], important: true });
    }
  },
  onPing(seg, session, title, kind) {
    const item = { id: 'seg-' + seg.id, source: 'stream', author: session.label, text: seg.text, url: session.url || '' };
    alert({ kind, title, item, word: (seg.keywords || []).find(k => k.kind === 'coinable' || k.kind === 'watch' || k.kind === 'ai')?.text, streamId: session.id, segId: seg.id, tags: seg.tags });
  },
});

// ---------- plays ----------
const plays = new PlayTracker({
  getConfig: () => cfg,
  send,
  demo: DEMO,
  search: term => dex.searchPairs(term),
  onAlert(play, title) {
    alert({ kind: 'vip', title, item: { id: play.itemId, source: play.source, author: play.author, text: play.text, url: play.url }, playId: play.id });
  },
});
const risk = new RiskEngine({ getConfig: () => cfg, demo: DEMO });
plays.risk = risk;
plays.enrich = makeEnricher({ getConfig: () => cfg, getStats: () => plays.stats() });
plays.searchImages = q => searchImages(q, { searchPairs: term => dex.searchPairs(term, 60000), demo: DEMO });
plays.imagePicker = makeImagePicker({ getConfig: () => cfg });
plays.onAiName = (p, names) => {
  if (!cfg.builtins.ai || !names.length) return;
  alert({ kind: 'watch', title: `AI NAME · @${p.author}'s tweet → ${names.slice(0, 3).map(n => '$' + n).join(', ')}`, item: { id: p.itemId, source: p.source, author: p.author, text: p.text, url: p.url }, important: true });
};
// A coin from a stream line hit a milestone: clip the moment it was said (if it's still in the 15-min buffer).
plays.onMilestone = (p, d, mc) => {
  if (!p.streamRef || p._t.clipped) return;
  p._t.clipped = true;
  streams.clip(p.streamRef.sid, { segId: p.streamRef.segId, title: `$${d.symbol} hit ${Math.round(mc / 1000)}K` }).catch(() => {});
};

// ---------- KOL wallets ----------
const kols = new KolWatcher({
  getConfig: () => cfg,
  send,
  demo: DEMO,
  tokenInfo: mint => dex.tokenInfo(mint),
  onAlert(ev, title, kind = 'vip') {
    alert({ kind, title, item: { id: 'kol-' + ev.id, source: 'kol', author: ev.kol, text: `${ev.side || ''} ${ev.symbol ? '$' + ev.symbol : ev.mint || ''} ${ev.sol ? ev.sol.toFixed(2) + ' SOL' : ''}`.trim(), url: ev.links?.gmgn || '' } });
  },
});

// ---------- Whales: money moving into fresh wallets before a launch ----------
const whales = new WhaleWatcher({
  getConfig: () => cfg,
  send,
  tokenInfo: mint => dex.tokenInfo(mint),
  kolList: () => cfg.kols?.wallets || [],
  onAlert(ev, title, important) {
    alert({ kind: 'whale', title, important, item: { id: 'whale-' + ev.id + '-' + ev.kind, source: 'whale', author: (ev.chain?.[0]?.name) || 'whale', text: title, url: ev.links?.gmgn || ev.links?.tx || '' } });
  },
});
kols.onOther = (wallet, sig, logs) => whales.fromKol(wallet, sig, logs);
kols.onBuy = ev => whales.kolBuy(ev).catch(() => {});

// The mascot's research context (shared by /api/lens and the pre-warming of hot coins)
const lensCtx = () => ({ getConfig: () => cfg, radar, risk, kols, whales, rpc: cfg.keys.solanaRpc ? (m, p) => whales.rpc(m, p) : null,
  items: () => items, plays: () => plays.list(), tioKey: cfg.keys.twitterapiIo || '', tioKeys: cfg.keys.twitterapiIos || [], xBearers: cfg.keys.xBearers || [] });

// ---------- Launch radar: big money into brand-new coins (live watchlist next to the bubble map) ----------
const radar = new LaunchRadar({
  getConfig: () => cfg,
  send,
  demo: DEMO,
  onAlert(it, title, important) {
    // Hot coin: get the mascot's checks ready now, so boxing it answers instantly
    try { require('./lib/lens').warm(it.mint, lensCtx()); } catch {}
    alert({ kind: 'radar', title, important, item: { id: 'radar-' + it.mint + '-' + title.slice(0, 14), source: 'radar', author: it.symbol ? '$' + it.symbol : 'launch', text: title, url: `https://axiom.trade/meme/${it.mint}` } });
  },
});

/**
 * Which alerts are worth a ping (sound, pop-up, phone). Everything else is listed silently in Alerts.
 * Important = your watchlist words, coins actually launching or running, KOL clusters, streams going live.
 */
function isImportant(a) {
  if (cfg.notify === 'all') return true;
  const t = String(a.title || '');
  if (/^Test alert/.test(t)) return true;
  if (/^(LIVE|SOON|KOL CLUSTER|BACK ONLINE|FILTER PASS|WHALE BUY|WHALE DEPLOY|WHALE VOLUME|LAUNCH VOLUME|BIG POOL) ·/.test(t)) return true;
  if (/^DEPLOY · 1st /.test(t)) return true;                       // the first coin for a play
  if (/^\d+(K|M) · /.test(t)) return !/^20K/.test(t) || /stream/.test(t); // mcap milestones (20K only for stream coins)
  if (a.streamId) return (a.tags || []).includes('WATCH');          // stream lines: only your watchlist words
  if (a.kind === 'watch') return true;                              // a tweet hit your watchlist
  if (a.kind === 'fresh') {                                         // a coin launched *because of* this tweet
    const tweetAge = a.item?.createdAt ? (Date.now() - a.item.createdAt) / 60000 : 0;
    return a.dex?.newestAgeMin != null && a.dex.newestAgeMin <= tweetAge + 1;
  }
  if (a.kind === 'vip' && /watchlist/.test(t)) return true;
  return false;                                                     // plain VIP tweets, single KOL buys, trends, risk notes
}

function alert(a) {
  a.important = cfg.accountMeta[String(a.item?.author || '').toLowerCase()]?.muted ? false : (a.important ?? isImportant(a));
  const payload = { ...a, at: Date.now(), itemId: a.item.id };
  delete payload.item;
  payload.author = a.item.author;
  payload.source = a.item.source;
  payload.text = a.item.text.slice(0, 280);
  payload.url = a.item.url;
  send('alert', payload);
  if (!a.important || !phoneBudget()) return; // phone/Discord: important only, at most 6 a minute
  telegram(a).catch(e => console.error('[telegram]', e.message));
  discord(a).catch(e => console.error('[discord]', e.message));
}

const DISCORD_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;
const phoneTimes = [];
function phoneBudget() {
  const now = Date.now();
  while (phoneTimes.length && now - phoneTimes[0] > 60000) phoneTimes.shift();
  if (phoneTimes.length >= 6) return false;
  phoneTimes.push(now);
  return true;
}

async function discord(a) {
  const url = cfg.discordWebhook;
  if (!url || !DISCORD_RE.test(url)) return;
  const top = a.dex?.top?.[0];
  const src = a.item.source === 'stream' ? 'Stream' : a.item.source === 'kol' ? 'Wallet' : 'X';
  const lines = [`**${a.title}**`, `${src} @${a.item.author}: ${a.item.text.slice(0, 300)}`];
  if (a.item.url) lines.push(a.item.url);
  if (top) lines.push(`${top.symbol} · mcap $${Math.round(top.marketCap || 0).toLocaleString()} · ${top.links.gmgn || top.links.dexscreener}`);
  await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // flags 4 = no link previews; no @mentions ever
    body: JSON.stringify({ username: 'Elixir', content: lines.join('\n').slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 }),
    signal: AbortSignal.timeout(5000),
  });
}

async function telegram(a) {
  const { botToken, chatId } = cfg.telegram;
  if (!botToken || !chatId) return;
  const esc = s => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const lines = [`<b>${esc(a.title)}</b>`, `${a.item.source === 'stream' ? 'Stream' : 'X'} @${esc(a.item.author)}: ${esc(a.item.text.slice(0, 300))}`];
  if (a.item.url) lines.push(a.item.url);
  const top = a.dex?.top?.[0];
  if (top) lines.push(`${top.symbol} · mcap $${Math.round(top.marketCap || 0).toLocaleString()} · ${top.links.gmgn || top.links.dexscreener}`);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5000),
  });
}

// ---------- polling ----------
let pollTimer = null, pollCycle = 0;
const lastPolled = {};
async function pollLoop() {
  clearTimeout(pollTimer);
  const provider = activeProvider();
  if (DEMO || provider === 'bridge-only' || !cfg.accounts.length) {
    pollTimer = setTimeout(pollLoop, 5000);
    return;
  }
  const started = Date.now();
  try {
    const fn = provider === 'twitterapi.io' ? sources.pollTwitterApiIo : sources.pollXApi;
    // Fast tier every cycle; slow tier (KOLs, celebrities…) every 4th. Only ask for tweets since the tier's last poll.
    pollCycle++;
    const fast = cfg.accounts.filter(a => !SLOW.has(a.toLowerCase())), slow = cfg.accounts.filter(a => SLOW.has(a.toLowerCase()));
    const rounds = [['fast', fast]];
    if (slow.length && pollCycle % 4 === 1) rounds.push(['slow', slow]);
    for (const [tier, accounts] of rounds) {
      if (!accounts.length) continue;
      // First poll backfills the last 2 hours so the feed isn't empty; after that, since the last poll (30 s overlap).
      const sinceMs = (lastPolled[tier] || Date.now() - (cfg.backfillMinutes ?? 120) * 60000) - 30000;
      const tierStart = Date.now();
      try {
        const r = await fn(cfg, accounts, t => ingest({ ...t, via: provider }), { sinceMs });
        status.lastPollWarn = r?.errors?.length ? r.errors[0] : null;
      } catch (e) {
        // Both kinds of key set: if one provider fails (out of credit, rate limit), use the other this round.
        const other = provider === 'twitterapi.io' ? (cfg.xApiFallback === true && cfg.keys.xBearer && 'x-api') : (cfg.keys.twitterapiIo && 'twitterapi.io');
        if (!other) throw e;
        await (other === 'x-api' ? sources.pollXApi : sources.pollTwitterApiIo)(cfg, accounts, t => ingest({ ...t, via: other }), { sinceMs });
      }
      lastPolled[tier] = tierStart;
    }
    if (status.lastPollError) console.log('  Tweets are coming in again.');
    status.lastPollError = null;
  } catch (e) {
    // Print an error once (and again only if it changes or 10 minutes pass), not every cycle.
    if (e.message !== status.lastPollError || Date.now() - (status.lastPollLoggedAt || 0) > 600000) {
      console.error('[poll]', e.message);
      status.lastPollLoggedAt = Date.now();
    }
    status.lastPollError = e.message;
  }
  status.lastPollAt = Date.now();
  status.polls++;
  send('status', statusPayload());
  // A rejected key or no credit won't fix itself: try again in 5 minutes (saving a key retries at once).
  const keyProblem = /\((401|402|403)\)|out of credit|rejected/i.test(status.lastPollError || '');
  const wait = keyProblem ? 300000 : Math.max(1000, cfg.pollSeconds * 1000 - (Date.now() - started));
  pollTimer = setTimeout(pollLoop, wait);
}

function statusPayload() {
  return { ...status, provider: DEMO ? 'demo' : activeProvider(), clients: clients.size };
}

// Big established coins: a $BTC / $ETH mention isn't a play.
const MAJORS = new Set('btc eth sol bnb xrp usdt usdc doge ada trx ton avax link dot sui hype ltc bch shib xlm hbar near apt arb op pol matic uni aave'.split(' '));

// ---------- Settings page: accounts & keywords ----------
const PRESET_GROUPS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'accounts.json'), 'utf8')).groups; } catch { return []; } })();
const groupOf = new Map(PRESET_GROUPS.flatMap(g => g.accounts.map(a => [a.toLowerCase(), g])));
function saveDisk(mutate) {
  const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  mutate(disk);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2));
  cfg = readConfig();
  send('config', publicConfig());
}
const handlesFrom = v => [...new Set((Array.isArray(v) ? v.join(' ') : String(v || '')).replace(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\//gi, ' ')
  .split(/[\s,;|"'\[\]{}()]+/).map(h => h.replace(/^@/, '').replace(/\/.*$/, '')).filter(h => /^[A-Za-z0-9_]{1,15}$/.test(h)))];

function accountsApi(b) {
  const lc = s => String(s).toLowerCase();
  const op = b.op || 'list';
  if (op === 'add' || op === 'remove' || op === 'set' || op === 'group') {
    saveDisk(d => {
      d.accounts = d.accounts || []; d.vip = d.vip || []; d.accountMeta = d.accountMeta || {};
      const has = (l, h) => l.some(x => lc(x) === lc(h));
      if (op === 'add') for (const h of handlesFrom(b.handles)) if (!has(d.accounts, h)) d.accounts.push(h);
      if (op === 'remove') { const rm = new Set(handlesFrom(b.handles).map(lc)); d.accounts = d.accounts.filter(a => !rm.has(lc(a))); d.vip = d.vip.filter(a => !rm.has(lc(a))); }
      if (op === 'group') {
        const g = PRESET_GROUPS.find(x => x.id === b.id);
        if (g) {
          if (b.on) for (const h of g.accounts) { if (!has(d.accounts, h)) d.accounts.push(h); }
          else { const rm = new Set(g.accounts.map(lc)); d.accounts = d.accounts.filter(a => !rm.has(lc(a))); }
        }
      }
      if (op === 'set' && b.handle) {
        const h = String(b.handle);
        if ('vip' in b) d.vip = b.vip ? (has(d.vip, h) ? d.vip : [...d.vip, h]) : d.vip.filter(a => lc(a) !== lc(h));
        const m = { ...(d.accountMeta[lc(h)] || {}) };
        for (const k of ['muted', 'pinned', 'ping']) if (k in b) m[k] = Boolean(b[k]);
        if ('note' in b) m.note = String(b.note || '').slice(0, 200);
        d.accountMeta[lc(h)] = m;
      }
    });
    pollLoop();
  }
  const vip = new Set(cfg.vip.map(lc));
  const accounts = cfg.accounts.map(h => {
    const g = groupOf.get(lc(h)), m = cfg.accountMeta[lc(h)] || {};
    return { handle: h, group: g?.label || null, groupId: g?.id || null, preset: Boolean(g), vip: vip.has(lc(h)), muted: Boolean(m.muted), pinned: Boolean(m.pinned), ping: Boolean(m.ping), note: m.note || '' };
  });
  const on = new Set(cfg.accounts.map(lc));
  const groups = PRESET_GROUPS.map(g => ({ id: g.id, label: g.label, tier: g.tier, total: g.accounts.length, active: g.accounts.filter(a => on.has(lc(a))).length }));
  return { accounts, groups };
}

function keywordsApi(b) {
  const op = b.op || 'list';
  if (op !== 'list') {
    saveDisk(d => {
      let list = kw.normalizeKeywords(Array.isArray(d.keywords) ? d.keywords : d.watchlist || []);
      const word = kw.norm(b.word);
      if (op === 'add' && word && b.scope) b.scope = ['tweets', 'streams'].includes(b.scope) ? b.scope : 'both';
      if (op === 'add' && word) {
        const words = String(b.word).split(/[\n,]+/).map(kw.norm).filter(Boolean); // paste several at once
        words.forEach((w, i) => { if (!list.some(k => k.word === w)) list.push({ word: w, match: b.match === 'partial' ? 'partial' : 'word', scope: b.scope || 'both', color: i === 0 ? b.color : kw.PALETTE[(list.length) % kw.PALETTE.length] }); });
      }
      if (op === 'remove') list = list.filter(k => k.word !== word);
      if (op === 'update') list = list.map(k => (k.word === word ? { ...k, ...b.patch, word: kw.norm(b.patch?.word || k.word) } : k));
      if (op === 'builtin' && ['cashtag', 'quoted', 'ai'].includes(b.key)) d.builtins = { ...kw.DEFAULT_BUILTINS, ...(d.builtins || {}), [b.key]: Boolean(b.on) };
      d.keywords = kw.normalizeKeywords(list);
      delete d.watchlist;
    });
  }
  return { keywords: cfg.keywords, builtins: cfg.builtins, palette: kw.PALETTE };
}

// ---------- auto-update ----------
let VERSION = null, updating = false;
updater.current().then(v => { VERSION = v; });
// A stream someone is talking on right now holds an update back (a restart would cut the transcript),
// but never for more than 30 minutes.
const busyStreams = () => [...streams.sessions.values()].some(s => !s.endedAt && s.kind !== 'demo' && Date.now() - (s.lastWordsAt || 0) < 120000);
let pendingSince = 0;
const JUST_UPDATED = path.join(ROOT, 'data', '.just-updated');
let checking = null; // one check at a time, however many windows refresh together
function autoUpdate(reason, opts = {}) {
  if (checking && !opts.force) return checking;
  const p = autoUpdateOnce(reason, opts);
  checking = p;
  p.finally(() => { if (checking === p) checking = null; });
  return p;
}
async function autoUpdateOnce(reason, { force = false } = {}) {
  if (DEMO || process.env.CI || cfg.autoUpdate === false) return { off: true };
  if (updating) return { updating: true };
  const st = await updater.check({ fresh: force });
  if (!st.behind) { pendingSince = 0; return st; }
  pendingSince = pendingSince || Date.now();
  if (busyStreams() && !force && Date.now() - pendingSince < 30 * 60000) return { ...st, waiting: 'a stream is being transcribed' };
  updating = true;
  console.log(`  New version found (${reason}). Installing…`);
  const r = await updater.apply();
  if (!r.ok) { updating = false; console.log('  Update skipped: ' + r.msg); return { ...st, failed: r.msg }; }
  console.log('  ' + r.msg + '. Restarting…');
  send('updating', { to: String(st.latest || '').slice(0, 7) });
  try { fs.writeFileSync(JUST_UPDATED, String(Date.now())); } catch {} // the restart skips its own update check
  setTimeout(restartAfterUpdate, 400);
  return { ...st, updating: true };
}
function restartAfterUpdate() {
  for (const c of clients) { try { c.end(); } catch {} }
  server.close();
  // start.sh / start.bat relaunch on exit code 75; a plain `node server.js` relaunches itself.
  if (process.env.ELIXIR_SUPERVISED === '1') return setTimeout(() => process.exit(75), 200);
  try { require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit', cwd: ROOT }); } catch {}
  setTimeout(() => {
    require('child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', cwd: ROOT, env: { ...process.env, NO_OPEN: '1' } });
    process.exit(0);
  }, 300);
}

// ---------- http ----------
const MIME = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Websites you visit must not be able to drive Elixir on your PC (change keys, read the feed).
// Only Elixir's own pages (and, for a few endpoints, browser extensions: the Elixir mascot and the
// X bridge) may call the API. DNS-rebinding is blocked by only answering to localhost host names.
const EXT_OK = new Set(['/api/lens', '/api/ingest', '/api/bridge-ping', '/api/ping', '/api/ext-version']);
/** The extension version in this Elixir folder (read fresh: Elixir's updates bring new extension files). */
function extVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version || null; } catch { return null; } }
function allowed(req, url) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\]|penguin\.linux\.test)(:\d+)?$/.test(host)) return false; // penguin.linux.test = Chromebook's Linux
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET') return true; // no Origin = not a browser page (curl, the server itself)
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|penguin\.linux\.test)(:\d+)?$/i.test(origin)) return true;
  return /^(chrome|moz|safari-web)-extension:\/\//i.test(origin) && EXT_OK.has(url.pathname);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!allowed(req, url)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Elixir only answers its own pages.'); }
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.mux = url.searchParams.get('mux') === '1';
      const hello = JSON.stringify(helloPayload());
      res.write(res.mux ? `data: {"e":"hello","d":${hello}}\n\n` : `event: hello\ndata: ${hello}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const ctype = String(req.headers['content-type'] || '');
      // Raw tab audio from the stream monitor page (16 kHz mono PCM).
      const audio = url.pathname.match(/^\/api\/streams\/([\w-]+)\/audio$/);
      if (audio) {
        // Octet-stream also forces a CORS preflight, which is never approved, so other sites can't post here.
        if (!ctype.includes('application/octet-stream')) return json(res, 415, { error: 'audio only' });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const s = streams.sessions.get(audio[1]);
        if (!s || s.endedAt) return json(res, 410, { error: 'session ended' });
        streams.onPcm(s, Buffer.concat(chunks));
        return json(res, 200, { ok: true });
      }
      // JSON-only so other websites can't post here without a CORS preflight (which we never approve).
      if (!ctype.includes('application/json')) return json(res, 415, { error: 'json only' });
      const body = await readBody(req);

      if (url.pathname === '/api/ingest') {
        const list = Array.isArray(body) ? body : [body];
        if (list.some(b => b.via === 'bridge')) { status.bridgeLastSeen = Date.now(); send('status', statusPayload()); }
        const out = [];
        for (const b of list.slice(0, 50)) {
          const it = await ingest(b);
          if (it) out.push(it.id);
        }
        return json(res, 200, { ok: true, accepted: out.length });
      }

      if (url.pathname === '/api/bridge-ping') {
        status.bridgeLastSeen = Date.now();
        send('status', statusPayload());
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/lookup') {
        const r = await dex.lookup(String(body.word || '').slice(0, 30), { chains: cfg.chains, demo: DEMO });
        // Annotate each coin with the active filter preset (DVCES by default).
        const preset = activePreset(cfg), pads = padsFrom(cfg);
        const top = r.top.map(t => {
          const pad = classify({ chainId: t.chain, dexId: t.dex, labels: t.labels, baseToken: { address: t.address } }, pads);
          const f = preset && pad ? checkCoin({ createdAt: t.createdAt, marketCap: t.marketCap, volume: t.volume24, dexId: t.dex, labels: t.labels }, pads[pad], preset) : null;
          return { ...t, pad: pad ? pads[pad].label : null, filter: f && { preset: preset.label, pass: f.pass, column: f.column, checks: f.checks } };
        });
        return json(res, 200, { ...r, top });
      }

      if (url.pathname === '/api/config') {
        const clean = list => {
          const text = Array.isArray(list) ? list.join(' ') : String(list || '');
          const out = [];
          // x.com/handle or twitter.com/handle links, then @handles and bare words
          for (const m of text.matchAll(/(?:x|twitter)\.com\/(?!i\/|home|search|intent|share)([A-Za-z0-9_]{1,15})/gi)) out.push(m[1]);
          const rest = text.replace(/https?:\/\/\S+/g, ' ');
          for (const w of rest.split(/[\s,;|"'\[\]{}()]+/)) { const h = w.replace(/^@/, ''); if (/^[A-Za-z0-9_]{1,15}$/.test(h)) out.push(h); }
          const seen = new Set();
          return out.filter(h => { const k = h.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        };
        const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        for (const k of ['accounts', 'vip']) if (k in body) disk[k] = clean(body[k]);
        for (const k of ['ignore']) if (k in body) {
          disk[k] = [...new Set((Array.isArray(body[k]) ? body[k] : String(body[k]).split(/[\n,]+/)).map(s => normalize(String(s).trim())).filter(Boolean))];
        }
        if ('pollSeconds' in body) disk.pollSeconds = Math.max(2, Math.min(300, Number(body.pollSeconds) || 10));
        if ('includeReplies' in body) disk.includeReplies = Boolean(body.includeReplies);
        if ('openBrowser' in body) disk.openBrowser = Boolean(body.openBrowser);
        if ('lensModel' in body) disk.lensModel = body.lensModel === 'best' ? 'best' : 'fastest';
        if ('notify' in body) disk.notify = body.notify === 'all' ? 'all' : 'important';
        if ('chains' in body) disk.chains = clean(body.chains);
        if (body.filter && typeof body.filter === 'object') {
          const n = (v, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
          const f = body.filter, cur = activePreset(cfg) || {};
          disk.filters = disk.filters || {};
          disk.filters.active = 'custom';
          disk.filters.presets = { ...(disk.filters.presets || {}), custom: {
            label: String(f.label || cur.label || 'My filter').slice(0, 20),
            newPairs: { maxAgeMin: n(f.npAge, cur.newPairs?.maxAgeMin), minVolume: n(f.npVol, cur.newPairs?.minVolume) },
            finalStretch: { maxAgeMin: n(f.fsAge, cur.finalStretch?.maxAgeMin), minMcap: n(f.fsMcap, cur.finalStretch?.minMcap), minVolume: n(f.fsVol, cur.finalStretch?.minVolume) },
            graduated: { minFeesSol: n(f.grFees, cur.graduated?.minFeesSol) },
          } };
        }
        if (body.filterReset) disk.filters = { ...(disk.filters || {}), active: 'dvces' };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2));
        cfg = readConfig();
        send('config', publicConfig());
        pollLoop();
        return json(res, 200, publicConfig());
      }

      if (url.pathname === '/api/snapshot') return json(res, 200, helloPayload()); // pop-out windows joining the shared stream
      if (url.pathname === '/api/accounts') return json(res, 200, accountsApi(body));
      if (url.pathname === '/api/keywords') return json(res, 200, keywordsApi(body));

      if (url.pathname === '/api/tweets/test') {
        // One real fetch for a few big accounts over the last day: shows tweets or the exact error.
        const provider = activeProvider();
        if (provider === 'bridge-only') return json(res, 200, { ok: false, provider, error: 'No twitterapi.io or X key is loaded. Add one above and press Save keys.' });
        const fn = provider === 'twitterapi.io' ? sources.pollTwitterApiIo : sources.pollXApi;
        const got = [];
        try {
          await fn(cfg, ['elonmusk', 'WatcherGuru', 'cz_binance'], t => { got.push(t); ingest({ ...t, via: provider }); }, { sinceMs: Date.now() - 86400000 });
          return json(res, 200, { ok: true, provider, count: got.length, sample: got.slice(0, 3).map(t => ({ author: t.author, text: t.text.slice(0, 120) })) });
        } catch (e) { return json(res, 200, { ok: false, provider, error: e.message }); }
      }

      if (url.pathname === '/api/update') {
        const r = body.apply ? await autoUpdate('page refresh', { force: Boolean(body.force) }) : await updater.check();
        return json(res, 200, { ...r, version: VERSION, auto: cfg.autoUpdate !== false });
      }

      if (url.pathname === '/api/keys') {
        const changes = {};
        for (const [k, v] of Object.entries(body.values || {})) {
          if (!KEY_ENVS.includes(k)) continue;
          let val = String(v ?? '').trim();
          // Helius: accept the bare API key (a UUID) or the https:// RPC link, not just the wss:// URL.
          if (k === 'SOLANA_WS_URL' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) val = 'wss://mainnet.helius-rpc.com/?api-key=' + val;
          if (k === 'SOLANA_WS_URL') val = val.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
          if (k === 'SOLANA_RPC_URL') val = require('./lib/keys').rpcUrl(val);
          if (/[\r\n]/.test(val) || val.length > 600) return json(res, 400, { error: `${k} looks wrong (too long or has line breaks)` });
          changes[k] = val;
        }
        for (const k of body.clear || []) if (KEY_ENVS.includes(k)) changes[k] = '';
        if (Object.keys(changes).length) {
          writeEnv(changes);
          cfg = readConfig();
          kols.restart();
          pollLoop();
          send('config', publicConfig());
          send('stream-status', streams.status());
        }
        const tests = {};
        await Promise.all((body.test || Object.keys(changes)).filter(k => KEY_ENVS.includes(k) && k !== 'TELEGRAM_CHAT_ID').map(async k => { tests[k] = await testKey(k); }));
        return json(res, 200, { keys: keyStatus(), tests });
      }

      if (url.pathname === '/api/risk') {
        const mint = String(body.mint || '').trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && !DEMO) return json(res, 400, { error: 'Paste a token address (mint)' });
        try { return json(res, 200, await risk.assess(mint, body.pair || {}, { maxAgeMs: 30000 })); } catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (url.pathname === '/api/risk/import') {
        const n = risk.importLines(String(body.text || '').slice(0, 200000));
        send('risk-memory', risk.memorySummary());
        return json(res, 200, { imported: n, memory: risk.memorySummary() });
      }
      if (url.pathname === '/api/risk/memory') return json(res, 200, risk.memorySummary());

      if (url.pathname === '/api/kols' || url.pathname === '/api/kols/import') {
        const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        disk.kols = { ...(disk.kols || {}) };
        const tidy = w => ({
          wallet: String(w.wallet || '').trim(),
          name: String(w.name || '').trim().slice(0, 40),
          emoji: String(w.emoji || '').slice(0, 16),
          toast: w.toast !== false,
          color: /^#[0-9a-f]{6}$/i.test(w.color || '') ? w.color : null,
          groups: Array.isArray(w.groups) ? w.groups.map(String).slice(0, 5) : [],
        });
        const finish = list => list.filter(w => isWallet(w.wallet))
          .map(w => ({ ...w, name: w.name || w.wallet.slice(0, 4) + '…' + w.wallet.slice(-4) })).slice(0, 5000);
        let imported = null;
        if (url.pathname === '/api/kols/import') {
          // Axiom export (JSON objects, batch headers and all) or plain "emoji name address" lines.
          const parsed = parseWalletList(String(body.text || ''));
          const merged = new Map(body.replace ? [] : (disk.kols.wallets || []).map(w => [w.wallet, w]));
          for (const w of parsed) merged.set(w.wallet, { ...(merged.get(w.wallet) || {}), ...w });
          disk.kols.wallets = finish([...merged.values()].map(tidy));
          imported = parsed.length;
        } else if (Array.isArray(body.wallets)) {
          // Edits from the panel keep fields the textarea doesn't show (alerts, colour, groups).
          const prev = new Map((disk.kols.wallets || []).map(w => [w.wallet, w]));
          disk.kols.wallets = finish(body.wallets.map(w => tidy({ ...(prev.get(String(w.wallet || '').trim()) || {}), ...w })));
        }
        if ('enabled' in body) disk.kols.enabled = Boolean(body.enabled);
        if ('dormantDays' in body) disk.kols.dormantDays = Math.max(1, Math.min(365, Number(body.dormantDays) || 30));
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2));
        cfg = readConfig();
        kols.restart();
        return json(res, 200, { ...kols.snapshot(), imported, list: cfg.kols.wallets || [] });
      }
      if (url.pathname === '/api/whales') {
        // ops: add {text} ("name address" lines), remove {wallet}, label {wallet,name}, settings {...}
        const op = String(body.op || 'list');
        if (op !== 'list') {
          saveDisk(disk => {
            const wh = disk.whales = { ...(disk.whales || {}) };
            wh.wallets = Array.isArray(wh.wallets) ? wh.wallets : [];
            if (op === 'add') {
              for (const line of String(body.text || '').split(/[\r\n]+/)) {
                const parts = line.trim().split(/[\s,]+/).filter(Boolean);
                const wallet = parts.find(p => isWallet(p));
                if (!wallet || wh.wallets.some(w => w.wallet === wallet)) continue;
                wh.wallets.push({ wallet, name: parts.filter(p => p !== wallet).join(' ').slice(0, 40) || wallet.slice(0, 4) + '…' + wallet.slice(-4) });
              }
            }
            if (op === 'remove') wh.wallets = wh.wallets.filter(w => w.wallet !== body.wallet);
            if (op === 'label' && isWallet(body.wallet)) { wh.labels = { ...(wh.labels || {}) }; if (body.name) wh.labels[body.wallet] = String(body.name).slice(0, 40); else delete wh.labels[body.wallet]; }
            if (op === 'settings') {
              const num = (k, lo, hi) => { if (k in body) wh[k] = Math.max(lo, Math.min(hi, Number(body[k]) || lo)); };
              num('minSol', 1, 100000); num('bigSol', 1, 1000000); num('minBuySol', 0.1, 10000); num('volumeSol', 5, 100000); num('maxAgeHours', 1, 720); num('followHours', 1, 720);
              if ('enabled' in body) wh.enabled = Boolean(body.enabled);
              if ('watchKols' in body) wh.watchKols = Boolean(body.watchKols);
            }
          });
          cfg = readConfig();
          whales.restart();
        }
        return json(res, 200, { ...whales.snapshot(), settings: whales.cfg, labels: whales.cfg.labels || {} });
      }
      // ---- quick buy / sell: Elixir builds the swap, the user's wallet signs it (no private keys here) ----
      if (url.pathname.startsWith('/api/trade/')) {
        const trade = require('./lib/trade');
        const rpcUrl = cfg.keys.solanaRpc;
        if (!rpcUrl) return json(res, 400, { error: 'Add a Solana RPC (Helius) in API keys first' });
        try {
          if (url.pathname === '/api/trade/build') return json(res, 200, await trade.build(rpcUrl, body));
          if (url.pathname === '/api/trade/status') return json(res, 200, await trade.status(rpcUrl, String(body.sig || '')));
          if (url.pathname === '/api/trade/blockhash') return json(res, 200, await trade.blockhash(rpcUrl));
          if (url.pathname === '/api/trade/recipient') return json(res, 200, await trade.recipient(rpcUrl, String(body.address || '').trim()));
          if (url.pathname === '/api/trade/token-accounts') return json(res, 200, await trade.tokenAccounts(rpcUrl, String(body.wallet || ''), String(body.mint || '')));
          if (url.pathname === '/api/trade/balance') return json(res, 200, { sol: await trade.balance(rpcUrl, String(body.wallet || '')) });
          if (url.pathname === '/api/trade/positions') {
            const mints = (Array.isArray(body.mints) ? body.mints : []).filter(m => isWallet(m)).slice(0, 30);
            const out = await Promise.all(mints.map(async m => {
              const b = await trade.tokenBalance(rpcUrl, String(body.wallet || ''), m).catch(() => null);
              const info = await dex.tokenInfo(m).catch(() => null);
              return { mint: m, ui: b ? b.ui : 0, symbol: info?.symbol || null, marketCap: info?.marketCap ?? null };
            }));
            return json(res, 200, { positions: out.filter(p => p.ui > 0) });
          }
        } catch (e) { return json(res, 400, { error: e.message }); }
        return json(res, 404, { error: 'not found' });
      }
      // The mascot: research the coin in whatever the user boxed or highlighted
      if (url.pathname === '/api/ext-version') return json(res, 200, { version: extVersion() });
      if (url.pathname === '/api/lens') {
        const input = { text: String(body.text || '').slice(0, 4000), mints: (Array.isArray(body.mints) ? body.mints : []).map(String).filter(m => isWallet(m)).slice(0, 10) };
        try {
          input.pageUrl = /^https?:\/\//.test(String(body.pageUrl || '')) ? String(body.pageUrl).slice(0, 300) : '';
          input.pageTitle = String(body.pageTitle || '').slice(0, 200);
          // stage "quick": an answer in a fraction of a second; "full": + rug/holder checks and the AI write-up
          const L = require('./lib/lens');
          const out = await (body.stage === 'quick' ? L.quick : body.stage === 'risk' ? L.risk : L.full)(input, { ...lensCtx(), pageUrl: input.pageUrl });
          return json(res, 200, { ...out, ai: out.ai || null, aiAvailable: Boolean(cfg.keys.anthropic), extVersion: extVersion() });
        } catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (url.pathname === '/api/sol') {
        const range = ['1h', '1d', '7d'].includes(body.range) ? body.range : '1d';
        return json(res, 200, { ...solPrice.snapshot(), range, points: await solPrice.history(range) });
      }
      if (url.pathname === '/api/radar') {
        if (body.mint) return json(res, 200, radar.get(String(body.mint)) || { error: 'not on the watchlist any more' });
        if (body.op === 'settings') {
          saveDisk(disk => {
            const r = disk.radar = { ...(disk.radar || {}) };
            const num = (k, lo, hi) => { if (k in body) r[k] = Math.max(lo, Math.min(hi, Number(body[k]) || lo)); };
            num('minBuySol', 0.1, 1000); num('watchSol', 1, 100000); num('alertSol', 1, 100000); num('devSol', 0.1, 10000); num('windowMin', 1, 30); num('poolUsd', 1000, 1e9); num('poolVolUsd', 1000, 1e9);
            if ('enabled' in body) r.enabled = Boolean(body.enabled);
          });
          cfg = readConfig();
          if ('enabled' in body) radar.restart();
        }
        return json(res, 200, radar.snapshot());
      }
      if (url.pathname === '/api/whales/map') {
        const m = String(body.q || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
        if (!m) return json(res, 400, { error: 'Paste a coin (CA) or a wallet address' });
        if (!cfg.keys.solanaRpc) return json(res, 400, { error: 'Add a Solana RPC (Helius) in API keys first' });
        try {
          const top = Math.max(20, Math.min(150, Number(body.top) || 80));
          const progress = p => send('whale-map-progress', p);
          // A coin (has a token supply) → holder map; a wallet → its connections.
          let isMint = body.kind === 'coin';
          if (!body.kind) { try { isMint = Boolean((await whales.rpc('getTokenSupply', [m[0]]))?.value); } catch {} }
          if (!isMint) return json(res, 200, await whales.mapWallet(m[0], { progress }));
          const job = whales.mapCoin(m[0], { top, progress, onPartial: r => send('whale-map-partial', r) });
          // Hover on the watchlist: start mapping now, answer straight away.
          if (body.prefetch) { job.catch(() => {}); return json(res, 200, { started: true, partial: whales.partialMap(m[0], top) }); }
          return json(res, 200, { type: 'coin', ...(await job) });
        } catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (url.pathname === '/api/whales/history') {
        const w = String(body.wallet || '');
        if (!isWallet(w)) return json(res, 400, { error: 'bad wallet' });
        if (!cfg.keys.solanaRpc) return json(res, 400, { error: 'Add a Solana RPC (Helius) in API keys first' });
        try { return json(res, 200, await whales.walletHistory(w, { before: body.before ? String(body.before) : null, limit: Math.max(5, Math.min(50, Number(body.limit) || 20)) })); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (url.pathname === '/api/whales/trace') {
        const q = String(body.q || '').trim().replace(/^https?:\/\/\S+\/(?=[1-9A-HJ-NP-Za-km-z]{32,44})/, '').replace(/[?#].*$/, '');
        if (!isWallet(q)) return json(res, 400, { error: 'Paste a Solana wallet or coin address' });
        if (!cfg.keys.solanaRpc) return json(res, 400, { error: 'Add a Solana RPC (Helius) in API keys first' });
        try {
          // A coin (mint) or a wallet? A mint has token supply.
          let isMint = Boolean(body.coin);
          if (!body.wallet && !isMint) { try { const s = await whales.rpc('getTokenSupply', [q]); isMint = Boolean(s?.value); } catch {} }
          return json(res, 200, isMint ? { type: 'coin', ...(await whales.traceCoin(q)) } : { type: 'wallet', ...(await whales.traceWallet(q)) });
        } catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (url.pathname === '/api/kols/list') return json(res, 200, { list: cfg.kols.wallets || [], enabled: cfg.kols.enabled !== false });

      if (url.pathname === '/api/plays/track') {
        const it = items.find(i => i.id === String(body.itemId));
        if (!it) return json(res, 404, { error: 'That item is no longer in the feed' });
        return json(res, 200, plays.view(plays.track(it, { reason: 'manual' })));
      }
      if (url.pathname === '/api/plays/untrack') { plays.untrack(String(body.id)); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/plays/stats') return json(res, 200, plays.stats());
      if (url.pathname === '/api/streams/clip') {
        try { return json(res, 200, await streams.clip(String(body.id), { segId: body.segId, at: body.at })); } catch (e) { return json(res, 400, { error: e.message }); }
      }

      if (url.pathname === '/api/streams/start') {
        try { return json(res, 200, streams.start(body)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/streams/speaker') {
        try { return json(res, 200, streams.setSpeaker(String(body.id), body.speaker, { name: body.name, ping: typeof body.ping === 'boolean' ? body.ping : undefined })); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/streams/stop') { streams.stop(String(body.id)); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/streams/player-audio') {
        try { return json(res, 200, streams.usePlayerAudio(String(body.id), body.off !== true)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/streams/remove') { streams.remove(String(body.id)); return json(res, 200, { ok: true }); }
      const textRoute = url.pathname.match(/^\/api\/streams\/([\w-]+)\/text$/);
      if (textRoute) { streams.onBrowserText(textRoute[1], String(body.text || '').slice(0, 2000), Boolean(body.final)); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/streams/settings') {
        const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        disk.streams = { ...(disk.streams || {}) };
        if (Array.isArray(body.watch)) {
          disk.streams.watch = body.watch
            .filter(w => /^https:\/\/\S+$/i.test(String(w.url || '')))
            .map(w => ({ url: String(w.url).trim(), label: String(w.label || '').slice(0, 40), auto: w.auto !== false, ...(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(w.wallet || '')) ? { wallet: String(w.wallet) } : {}), ...(w.walletName ? { walletName: String(w.walletName).slice(0, 30) } : {}) }))
            .slice(0, 30);
        }
        for (const k of ['highlightScore', 'pingScore']) if (k in body) disk.streams[k] = Math.max(1, Math.min(30, Number(body[k]) || 4));
        if ('language' in body) disk.streams.language = String(body.language).slice(0, 10);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2));
        cfg = readConfig();
        send('config', publicConfig());
        streams.pollWatched();
        return json(res, 200, { ok: true, status: streams.status() });
      }

      if (url.pathname === '/api/watch-check') {
        return json(res, 200, { hits: watchHits(body.text || '', cfg.watchlist) });
      }

      if (url.pathname === '/api/test-alert') {
        const it = { id: 'test', source: 'manual', author: 'elixir', text: 'Test alert — if you see this, alerts work.', url: '' };
        alert({ kind: 'watch', title: 'Test alert', item: it });
        return json(res, 200, { ok: true, telegram: Boolean(cfg.telegram.botToken && cfg.telegram.chatId) });
      }
      return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && url.pathname === '/api/ping') return json(res, 200, { t: Date.now() });
    if (req.method === 'GET' && url.pathname.startsWith('/img/coin/')) {
      // Coin pictures: whichever source works (given link, IPFS gateways, pump.fun, DexScreener, GeckoTerminal), cached on disk.
      const mint = url.pathname.slice(10);
      const hint = url.searchParams.get('u') || radar.items.get(mint)?.image || '';
      const got = await require('./lib/images').coinImage(mint, hint, m => dex.tokenInfo(m)).catch(() => null);
      if (!got) { res.writeHead(404, { 'cache-control': 'max-age=60' }); return res.end(); }
      res.writeHead(200, { 'content-type': got.type, 'cache-control': 'max-age=604800', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
      return res.end(got.buf);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/avatars/')) {
      const name = decodeURIComponent(url.pathname.slice(9));
      if (!/^[\w-]+\.(png|jpg|webp|gif|svg|ico|img)$/.test(name)) return json(res, 400, { error: 'bad name' });
      const file = path.join(ROOT, 'data', 'avatars', name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(name).slice(1);
      // SVG avatars come from third parties: serve with a CSP so any script inside can't run.
      res.writeHead(200, { 'content-type': { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon' }[ext] || 'application/octet-stream', 'cache-control': 'max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/clips/')) {
      const name = decodeURIComponent(url.pathname.slice(7));
      if (!/^[\w.-]+\.mp4$/.test(name)) return json(res, 400, { error: 'bad clip name' });
      const file = path.join(ROOT, 'data', 'clips', name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const size = fs.statSync(file).size;
      const range = String(req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
      if (range) { // video players seek with Range requests
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': size });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(ROOT, 'public', rel));
      if (!file.startsWith(path.join(ROOT, 'public'))) return json(res, 403, { error: 'forbidden' });
      if (url.pathname === '/x-bridge.user.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(ROOT, 'userscript', 'x-bridge.user.js')));
      }
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    json(res, 405, { error: 'method' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

setInterval(() => send('trends', trendsSnapshot()), 5000);

server.listen(cfg.port, '127.0.0.1', () => {
  const p = DEMO ? 'demo' : activeProvider();
  console.log(`\n  Elixir → http://localhost:${cfg.port}   (tweet source: ${p})`);
  if (p === 'bridge-only') console.log('  No API key set — tweets come from the X browser bridge (userscript) or manual paste. See README.');
  console.log(`  Tracking ${cfg.accounts.length} accounts, ${cfg.watchlist.length} watch words. Ctrl+C to stop.\n`);
  // Open the page in the default browser. Off with: Settings → "Open my browser when Elixir starts",
  // NO_OPEN=1 (in .env or the shell), or ./start.sh --no-open. Never on a server / in CI.
  if (cfg.openBrowser !== false && process.env.NO_OPEN !== '1' && !process.argv.includes('--no-open') && !process.env.CI) {
    const url = `http://localhost:${cfg.port}`;
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
  if (!process.env.CI) solPrice.start(send);
  if (!process.env.CI && !DEMO) require('./lib/news').start(); // crypto outlets, read every 3 minutes
  require('./lib/stream/capture').refreshTools();
  if (!DEMO && !process.env.CI) require('./lib/bin').ensureTools().then(() => require('./lib/stream/capture').refreshTools());
  // Right after an update there's nothing new to fetch: skip the start check.
  let fresh = false;
  try { fresh = Date.now() - Number(fs.readFileSync(JUST_UPDATED, 'utf8')) < 5 * 60000; fs.unlinkSync(JUST_UPDATED); } catch {}
  if (!fresh) setTimeout(() => autoUpdate('start').catch(() => {}), 3000);
  // and every 3 minutes while it runs, so a page left open still gets new versions
  setInterval(() => autoUpdate('timer').catch(() => {}), 3 * 60000).unref();
  if (DEMO) {
    if (process.env.DEMO_TWEETS !== '0') sources.startDemo(t => ingest({ ...t, via: 'demo' }));
    streams.start({ label: 'Demo streamer', kind: 'demo', url: 'https://www.twitch.tv/demo_streamer' });
  }
  pollLoop();
});
