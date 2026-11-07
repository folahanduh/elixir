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
const { RiskEngine } = require('./lib/risk');

const ROOT = __dirname;
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'data', 'feed.jsonl');

// ---------- config ----------
loadDotEnv();
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(ROOT, 'config.example.json'), CONFIG_PATH);
let cfg = readConfig();

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function readConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.keys = c.keys || {};
  c.keys.twitterapiIo = process.env.TWITTERAPI_IO_KEY || c.keys.twitterapiIo || '';
  c.keys.xBearer = process.env.X_BEARER_TOKEN || c.keys.xBearer || '';
  c.telegram = c.telegram || {};
  c.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || c.telegram.botToken || '';
  c.telegram.chatId = process.env.TELEGRAM_CHAT_ID || c.telegram.chatId || '';
  c.keys.deepgram = process.env.DEEPGRAM_API_KEY || c.keys.deepgram || '';
  c.keys.anthropic = process.env.ANTHROPIC_API_KEY || c.keys.anthropic || '';
  c.keys.solanaWs = process.env.SOLANA_WS_URL || c.keys.solanaWs || '';
  // No key: Solana's free public RPC, so KOL wallets and rug checks work out of the box
  // (rate-limited; a free Helius key is faster and copes with big wallet lists).
  c.keys.solanaPublic = !c.keys.solanaWs && !process.env.SOLANA_RPC_URL && !c.keys.solanaRpc;
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
  if (DEMO) c.vip = [...new Set([...(c.vip || []), 'memelord_daily', 'frogwatcher'])]; // fictional demo accounts, so demo plays fire
  return c;
}

function publicConfig() {
  return {
    provider: DEMO ? 'demo' : activeProvider(),
    accounts: cfg.accounts, vip: cfg.vip, watchlist: cfg.watchlist, ignore: cfg.ignore,
    pollSeconds: cfg.pollSeconds, chains: cfg.chains, includeReplies: cfg.includeReplies,
    trend: cfg.trend, telegram: Boolean(cfg.telegram.botToken && cfg.telegram.chatId), discord: Boolean(cfg.discordWebhook),
    streams: { highlightScore: cfg.streams.highlightScore, pingScore: cfg.streams.pingScore, watch: cfg.streams.watch, language: cfg.streams.language },
    filter: activePreset(cfg),
    keys: keyStatus(),
  };
}

// ---------- API keys (Settings → API keys writes .env; values never go back to the page) ----------
const KEY_ENVS = ['SOLANA_WS_URL', 'SOLANA_RPC_URL', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'TWITTERAPI_IO_KEY', 'X_BEARER_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL'];
function keyStatus() {
  const out = {};
  for (const k of KEY_ENVS) {
    const v = process.env[k] || '';
    out[k] = { set: Boolean(v), hint: v ? '…' + v.slice(-4) : '' };
  }
  if (cfg?.keys?.solanaPublic) out.SOLANA_WS_URL.fallback = 'using free public RPC';
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
    if (k === 'DEEPGRAM_API_KEY') { const r = await fetch('https://api.deepgram.com/v1/projects', { ...T, headers: { authorization: 'Token ' + v } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'ANTHROPIC_API_KEY') { const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { ...T, headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'TWITTERAPI_IO_KEY') { const r = await fetch('https://api.twitterapi.io/twitter/user/info?userName=x', { ...T, headers: { 'X-API-Key': v } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
    if (k === 'X_BEARER_TOKEN') { const r = await fetch('https://api.x.com/2/users/by/username/x', { ...T, headers: { authorization: 'Bearer ' + v } }); return r.ok ? { ok: true, msg: 'works' } : fail(r); }
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
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
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
  const watch = candidates.filter(c => c.watch).map(c => c.word);

  const item = {
    id, source, author, authorName: String(raw.authorName || ''), avatar: safeUrl(raw.avatar),
    text, url: safeUrl(raw.url), createdAt, receivedAt,
    latencyMs: createdAt ? Math.max(0, receivedAt - createdAt) : null,
    vip, watch, candidates, via: raw.via || source,
    stale: ageSec > cfg.alertMaxAgeSeconds,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 8).map(String) : undefined,
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
  if (!quiet && !item.stale && (vip || watch.length)) {
    const why = [vip && `VIP @${author}`, watch.length && `watchlist: ${watch.join(', ')}`].filter(Boolean).join(' · ');
    alert({ kind: vip ? 'vip' : 'watch', title: why, item });
  }

  // Trend spikes.
  const now = Date.now();
  for (const t of trendsSnapshot()) {
    if (t.last5 >= cfg.trend.minMentions && t.authors >= cfg.trend.minAuthors) {
      const prev = lastTrendAlert.get(t.word) || 0;
      if (!quiet && now - prev > cfg.trend.cooldownMinutes * 60000 && candidates.some(c => c.word === t.word)) {
        lastTrendAlert.set(t.word, now);
        alert({ kind: 'trend', title: `“${t.word}” spiking — ${t.last5} mentions / 5m`, item, word: t.word });
      }
    }
  }
  send('trends', trendsSnapshot());

  // Market check for the strongest candidates.
  const toCheck = candidates.filter(c => c.watch || c.score >= (source === 'stream' ? 3 : 2)).slice(0, 3);
  const dexResults = {};
  await Promise.all(toCheck.map(async c => {
    try {
      const r = await dex.lookup(c.display.replace(/^[$#]/, ''), { chains: cfg.chains, demo: DEMO });
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
  lookup: word => dex.lookup(word, { chains: cfg.chains, demo: DEMO }),
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
      ingest({ source: 'stream', id: 'seg-' + seg.id, author: session.label, text: seg.text, url: session.url, createdAt: seg.t, tags: seg.tags, noAlert: true, via: 'stream' });
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

function alert(a) {
  const payload = { ...a, at: Date.now(), itemId: a.item.id };
  delete payload.item;
  payload.author = a.item.author;
  payload.source = a.item.source;
  payload.text = a.item.text.slice(0, 280);
  payload.url = a.item.url;
  send('alert', payload);
  telegram(a).catch(e => console.error('[telegram]', e.message));
  discord(a).catch(e => console.error('[discord]', e.message));
}

const DISCORD_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;
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
let pollTimer = null;
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
    await fn(cfg, cfg.accounts, t => ingest({ ...t, via: provider }));
    status.lastPollError = null;
  } catch (e) {
    status.lastPollError = e.message;
    console.error('[poll]', e.message);
  }
  status.lastPollAt = Date.now();
  status.polls++;
  send('status', statusPayload());
  const wait = Math.max(1000, cfg.pollSeconds * 1000 - (Date.now() - started));
  pollTimer = setTimeout(pollLoop, wait);
}

function statusPayload() {
  return { ...status, provider: DEMO ? 'demo' : activeProvider(), clients: clients.size };
}

// ---------- http ----------
const MIME = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ config: publicConfig(), status: statusPayload(), items: items.slice(-150), trends: trendsSnapshot(), streams: streams.snapshot(), plays: plays.list(), playStats: plays.stats(), kols: kols.snapshot(), riskMemory: risk.memorySummary() })}\n\n`);
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
        const clean = list => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,]+/))
          .map(s => String(s).trim().replace(/^@/, '')).filter(Boolean))];
        const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        for (const k of ['accounts', 'vip']) if (k in body) disk[k] = clean(body[k]);
        for (const k of ['watchlist', 'ignore']) if (k in body) {
          disk[k] = [...new Set((Array.isArray(body[k]) ? body[k] : String(body[k]).split(/[\n,]+/)).map(s => normalize(String(s).trim())).filter(Boolean))];
        }
        if ('pollSeconds' in body) disk.pollSeconds = Math.max(2, Math.min(300, Number(body.pollSeconds) || 10));
        if ('includeReplies' in body) disk.includeReplies = Boolean(body.includeReplies);
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

      if (url.pathname === '/api/keys') {
        const changes = {};
        for (const [k, v] of Object.entries(body.values || {})) {
          if (!KEY_ENVS.includes(k)) continue;
          const val = String(v ?? '').trim();
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
      if (url.pathname === '/api/streams/remove') { streams.remove(String(body.id)); return json(res, 200, { ok: true }); }
      const textRoute = url.pathname.match(/^\/api\/streams\/([\w-]+)\/text$/);
      if (textRoute) { streams.onBrowserText(textRoute[1], String(body.text || '').slice(0, 2000), Boolean(body.final)); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/streams/settings') {
        const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        disk.streams = { ...(disk.streams || {}) };
        if (Array.isArray(body.watch)) {
          disk.streams.watch = body.watch
            .filter(w => /^https:\/\/\S+$/i.test(String(w.url || '')))
            .map(w => ({ url: String(w.url).trim(), label: String(w.label || '').slice(0, 40), auto: w.auto !== false }))
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
  // Open the page in the default browser (skip with NO_OPEN=1, e.g. on a server or in CI).
  if (process.env.NO_OPEN !== '1' && !process.env.CI) {
    const url = `http://localhost:${cfg.port}`;
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
  if (!DEMO && !process.env.CI) require('./lib/bin').ensureTools();
  if (DEMO) {
    if (process.env.DEMO_TWEETS !== '0') sources.startDemo(t => ingest({ ...t, via: 'demo' }));
    streams.start({ label: 'Demo streamer', kind: 'demo', url: 'https://www.twitch.tv/demo_streamer' });
  }
  pollLoop();
});
