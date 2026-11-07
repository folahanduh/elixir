// Who is this stream? Resolves the channel's display name, handle and official profile picture
// (YouTube channel avatar, Twitch/X profile picture, Kick profile pic, a news site's logo) and
// caches the image under data/avatars so the page loads it locally.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bin = require('../bin');

const DIR = path.join(__dirname, '..', '..', 'data', 'avatars');
const INDEX = path.join(DIR, 'index.json');
const TTL = 7 * 86400000;
fs.mkdirSync(DIR, { recursive: true });
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
const saveIndex = () => fs.writeFile(INDEX, JSON.stringify(index), () => {});
const inflight = new Map();

// News and media sites: proper names for the favicon fallback.
const NEWS = {
  'coindesk.com': 'CoinDesk', 'cointelegraph.com': 'Cointelegraph', 'theblock.co': 'The Block', 'decrypt.co': 'Decrypt',
  'bloomberg.com': 'Bloomberg', 'cnbc.com': 'CNBC', 'reuters.com': 'Reuters', 'foxnews.com': 'Fox News', 'cnn.com': 'CNN',
  'bbc.co.uk': 'BBC', 'bbc.com': 'BBC', 'nytimes.com': 'The New York Times', 'wsj.com': 'The Wall Street Journal',
  'apnews.com': 'AP News', 'skynews.com': 'Sky News', 'news.sky.com': 'Sky News', 'c-span.org': 'C-SPAN', 'whitehouse.gov': 'The White House',
  'pump.fun': 'pump.fun', 'rumble.com': 'Rumble', 'kick.com': 'Kick', 'tiktok.com': 'TikTok', 'spacex.com': 'SpaceX',
};

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60) || 'x';

function ytdlp(args, timeoutMs = 20000) {
  return new Promise(resolve => {
    let out = '';
    let p;
    try { p = spawn(bin.ytdlp(), ['-q', '--no-warnings', ...args]); } catch { return resolve(null); }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 5e6) p.kill(); });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', code => { clearTimeout(t); resolve(code === 0 ? out : null); });
  });
}

/** Download an image into data/avatars; returns the local /avatars/... path or null. */
async function cacheImage(src, key) {
  if (!src || !/^https:\/\//i.test(src)) return null;
  try {
    const r = await fetch(src, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 elixir' } });
    const type = String(r.headers.get('content-type') || '');
    if (!r.ok || !/^image\//.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3e6) return null;
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' }[type.split(';')[0]] || 'img';
    const file = `${slug(key)}.${ext}`;
    fs.writeFileSync(path.join(DIR, file), buf);
    return '/avatars/' + file;
  } catch { return null; }
}

function parse(url, hint = {}) {
  let u;
  try { u = new URL(url); } catch { return { platform: hint.platform || 'local', name: hint.label || 'Stream' }; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  if (/twitch\.tv$/.test(host)) return { platform: 'twitch', handle: (seg[0] || '').toLowerCase(), link: `https://twitch.tv/${seg[0] || ''}` };
  if (/kick\.com$/.test(host)) return { platform: 'kick', handle: (seg[0] || '').toLowerCase(), link: `https://kick.com/${seg[0] || ''}` };
  if (/(^|\.)youtube\.com$|youtu\.be$/.test(host)) {
    const h = seg.find(s => s.startsWith('@'));
    return { platform: 'youtube', handle: h ? h.slice(1) : null, channelId: seg[0] === 'channel' ? seg[1] : null };
  }
  if (/^(x|twitter)\.com$/.test(host)) {
    // x.com/<user>/... has the handle in the path; /i/broadcasts and /i/spaces don't, so use the tweet author.
    const user = seg[0] && seg[0] !== 'i' ? seg[0] : (hint.author || String(hint.label || '').match(/@(\w{1,15})/)?.[1] || null);
    return { platform: 'x', handle: user, link: user ? `https://x.com/${user}` : url };
  }
  if (/pump\.fun$/.test(host)) return { platform: 'pumpfun', mint: seg[0] === 'coin' ? seg[1] : seg[0], link: url };
  const site = Object.keys(NEWS).find(d => host === d || host.endsWith('.' + d));
  return { platform: 'web', host, name: site ? NEWS[site] : host, link: `${u.protocol}//${u.host}` };
}

async function lookup(p, url) {
  const out = { platform: p.platform, name: p.name || p.handle || null, handle: p.handle || null, link: p.link || url, avatar: null };
  let remote = null;
  if (p.platform === 'twitch' && p.handle) {
    remote = `https://unavatar.io/twitch/${encodeURIComponent(p.handle)}?fallback=false`;
  } else if (p.platform === 'x' && p.handle) {
    out.name = '@' + p.handle;
    remote = `https://unavatar.io/x/${encodeURIComponent(p.handle)}?fallback=false`;
  } else if (p.platform === 'kick' && p.handle) {
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(p.handle)}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      const j = await r.json();
      out.name = j.user?.username || p.handle;
      remote = j.user?.profile_pic || j.user?.profilepic || null;
    } catch {}
  } else if (p.platform === 'youtube') {
    // The video page gives the channel; the channel page carries the avatar thumbnail.
    let channelUrl = p.channelId ? `https://www.youtube.com/channel/${p.channelId}` : p.handle ? `https://www.youtube.com/@${p.handle}` : null;
    const meta = await ytdlp(['--skip-download', '--playlist-items', '1', '--print', '%(channel)s\t%(uploader_id)s\t%(channel_url)s', url]);
    if (meta) {
      const [ch, up, cu] = meta.trim().split('\n')[0].split('\t');
      if (ch && ch !== 'NA') out.name = ch;
      if (up && up !== 'NA') out.handle = up.replace(/^@/, '');
      if (cu && cu !== 'NA') channelUrl = cu;
    }
    if (channelUrl) {
      out.link = channelUrl;
      const j = await ytdlp(['--flat-playlist', '--playlist-items', '0', '-J', channelUrl]);
      try {
        const d = JSON.parse(j);
        out.name = out.name || d.channel || d.uploader;
        const th = d.thumbnails || [];
        remote = (th.find(t => t.id === 'avatar_uncropped') || th.find(t => /avatar/.test(t.id || '')))?.url || null;
      } catch {}
    }
    if (!remote && out.handle) remote = `https://unavatar.io/youtube/${encodeURIComponent(out.handle)}?fallback=false`;
  } else if (p.platform === 'pumpfun' && p.mint) {
    try {
      const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(p.mint)}`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      out.name = j.symbol ? '$' + j.symbol : j.name || 'pump.fun stream';
      remote = j.image_uri || null;
    } catch {}
  } else if (p.platform === 'web' && p.host) {
    remote = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(p.host)}&sz=128`;
  }
  out.avatar = await cacheImage(remote, `${p.platform}_${out.handle || p.handle || p.host || p.mint || 'x'}`);
  return out;
}

/**
 * @param {string} url  stream or channel link
 * @param {{label?:string, author?:string, demo?:boolean}} hint
 * @returns {Promise<{platform, name, handle, link, avatar}>}  avatar is a local /avatars/... path or null (page shows initials)
 */
async function resolveProfile(url, hint = {}) {
  const p = parse(url, hint);
  if (hint.demo || p.platform === 'local') return { platform: p.platform, name: hint.label || p.handle || 'Stream', handle: p.handle || null, link: url || null, avatar: null };
  const key = `${p.platform}:${p.handle || p.channelId || p.host || p.mint || url}`;
  const hit = index[key];
  if (hit && Date.now() - hit.at < (hit.avatar ? TTL : 3600000) && (!hit.avatar || fs.existsSync(path.join(DIR, path.basename(hit.avatar))))) return hit.profile; // no picture → retry hourly
  if (inflight.has(key)) return inflight.get(key);
  const job = lookup(p, url).catch(() => ({ platform: p.platform, name: p.name || p.handle, handle: p.handle, link: url, avatar: null }))
    .then(profile => {
      profile.name = profile.name || hint.label || 'Stream';
      index[key] = { at: Date.now(), avatar: profile.avatar, profile };
      saveIndex();
      inflight.delete(key);
      return profile;
    });
  inflight.set(key, job);
  return job;
}

module.exports = { resolveProfile, AVATAR_DIR: DIR, parseSource: parse };
