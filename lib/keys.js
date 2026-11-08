// Finds API keys wherever people put them, under whatever name they used, and says what it found.
//   Files: .env (the real one), plus .env.example / env / .env.txt / .env.local / env.example
//   Lines: KEY=value, KEY = "value", KEY: value, export KEY=value
//   Names: canonical ones, or common variants (HELIUS_API_KEY, TWITTER_API_KEY, CLAUDE_KEY…)
// Keys found outside .env are copied into .env (never uploaded), and .env.example is blanked again.

const fs = require('fs');
const path = require('path');

const FILES = ['.env', '.env.example', 'env', '.env.txt', 'env.txt', '.env.local', 'env.example', '.env.example.local'];
const isBearer = v => /^A{10,}/.test(v) || /^AAAA[\w%-]{60,}$/.test(v);

/** Map whatever name/value someone used to Elixir's name. Returns {name, value, note?} or null. */
function canon(rawName, rawValue) {
  const n = rawName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  let v = rawValue.trim().replace(/^["'`]|["'`]$/g, '').trim();
  if (!v || /^(your|paste|xxx|<|\.\.\.)/i.test(v)) return null;
  const known = ['SOLANA_WS_URL', 'SOLANA_RPC_URL', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'TWITTERAPI_IO_KEY', 'X_BEARER_TOKEN',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'SOLSCAN_API_KEY', 'PORT'];
  const helius = val => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) ? 'wss://mainnet.helius-rpc.com/?api-key=' + val : val.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:'));
  if (/^X_BEARER_TOKEN(_\d+)?$/.test(n) || /^TWITTERAPI_IO_KEY(_\d+)?$/.test(n)) return { name: n, value: v };
  if (known.includes(n)) return { name: n, value: n === 'SOLANA_WS_URL' ? helius(v) : v };
  if (/SOLSCAN/.test(n)) return { name: 'SOLSCAN_API_KEY', value: v };
  if (/HELIUS|SOLANA|RPC/.test(n)) return { name: n.includes('HTTP') ? 'SOLANA_RPC_URL' : 'SOLANA_WS_URL', value: n.includes('HTTP') ? v : helius(v) };
  if (/DEEPGRAM/.test(n)) return { name: 'DEEPGRAM_API_KEY', value: v };
  if (/ANTHROPIC|CLAUDE/.test(n)) return { name: 'ANTHROPIC_API_KEY', value: v };
  if (/TELEGRAM/.test(n)) return { name: /CHAT|ID/.test(n) ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN', value: v };
  if (/DISCORD/.test(n)) return { name: 'DISCORD_WEBHOOK_URL', value: v };
  if (/TWITCH/.test(n)) return { name: /SECRET/.test(n) ? 'TWITCH_CLIENT_SECRET' : 'TWITCH_CLIENT_ID', value: v };
  if (/TWITTER|^X_|_X_|^X$|TWEET/.test(n)) {
    if (isBearer(v)) return { name: 'X_BEARER_TOKEN', value: v };
    if (/SECRET|ACCESS|CONSUMER/.test(n)) return { name: null, value: v, note: `${rawName} looks like an X API secret/access token. Elixir needs the X *Bearer Token* (starts with AAAA…) or a twitterapi.io key` };
    return { name: 'TWITTERAPI_IO_KEY', value: v }; // most "twitter api" keys people paste are twitterapi.io keys
  }
  return { name: null, value: v, note: `${rawName}: not a key Elixir uses` };
}

/**
 * Read every key file, set process.env, return a report:
 * {files:[{file, names}], loaded:{NAME:{from, hint}}, notes:[...]}
 */
function loadKeys(root, log = () => {}) {
  const report = { files: [], loaded: {}, notes: [] };
  const found = []; // [{name, value, file}]
  for (const f of FILES) {
    const p = path.join(root, f);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const names = [];
    for (const line of fs.readFileSync(p, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_ .-]{0,40}?)\s*[=:]\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      names.push(m[1]);
      const c = canon(m[1], m[2]);
      if (!c) continue;
      if (c.note) { report.notes.push(c.note); continue; }
      found.push({ ...c, file: f });
    }
    report.files.push({ file: f, names });
  }
  // Same name more than once (two X keys…): keep both as NAME, NAME_2, NAME_3.
  const taken = new Set();
  const final = [];
  for (const k of found) {
    if (final.some(x => x.value === k.value)) continue;
    let name = k.name;
    if (/^(X_BEARER_TOKEN|TWITTERAPI_IO_KEY)$/.test(name)) for (let i = 2; taken.has(name); i++) name = `${k.name}_${i}`;
    else if (taken.has(name)) continue; // first file wins (.env comes first)
    taken.add(name);
    final.push({ ...k, name });
  }
  for (const k of final) {
    if (!process.env[k.name]) process.env[k.name] = k.value;
    report.loaded[k.name] = { from: k.file, hint: '…' + k.value.slice(-4) };
  }
  // Keep everything in .env (git-ignored) and blank the tracked .env.example so keys can't be pushed.
  const envPath = path.join(root, '.env');
  const have = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const missing = final.filter(k => k.file !== '.env' && !new RegExp(`^\\s*${k.name}\\s*=\\s*\\S`, 'm').test(have));
  if (missing.length) {
    fs.writeFileSync(envPath, (have ? have.replace(/\n*$/, '\n') : '') + missing.map(k => `${k.name}=${k.value}`).join('\n') + '\n', { mode: 0o600 });
    log(`  Copied ${missing.length} key(s) into .env (from ${[...new Set(missing.map(k => k.file))].join(', ')}).`);
  }
  const ex = path.join(root, '.env.example');
  if (found.some(k => k.file === '.env.example')) {
    const seen = new Set();
    const blanked = fs.readFileSync(ex, 'utf8').split(/\r?\n/).map(l => {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*[=:]/);
      if (!m || m[1].toUpperCase() === 'PORT') return l;
      if (seen.has(m[1])) return null; // a second line for the same key was added by hand
      seen.add(m[1]);
      return `${m[1]}=`;
    }).filter(l => l !== null);
    fs.writeFileSync(ex, blanked.join('\n'));
  }
  const show = { TWITTERAPI_IO_KEY: 'twitterapi.io', X_BEARER_TOKEN: 'X API', SOLANA_WS_URL: 'Helius/Solana', DEEPGRAM_API_KEY: 'Deepgram', ANTHROPIC_API_KEY: 'Claude', TELEGRAM_BOT_TOKEN: 'Telegram', DISCORD_WEBHOOK_URL: 'Discord', TWITCH_CLIENT_ID: 'Twitch', SOLSCAN_API_KEY: 'Solscan' };
  const line = Object.entries(show).map(([k, label]) => `${label} ${process.env[k] ? '✓' : '·'}`).join('  ');
  log(`  Keys: ${line}${report.files.length ? `   (read ${report.files.map(f => f.file).join(', ')})` : '   (no .env file found)'}`);
  for (const n of report.notes) log('  Note: ' + n);
  return report;
}

module.exports = { loadKeys, canon };
