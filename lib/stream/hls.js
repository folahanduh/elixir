// Live HLS reader. yt-dlp only finds the stream's playlist URL; Node then fetches the segments and
// writes them into ffmpeg's stdin. This avoids yt-dlp needing a system ffmpeg for live streams, avoids
// static ffmpeg builds that can't resolve hostnames, and is faster: it starts at the live edge and, on
// Twitch, also takes the low-latency "prefetch" segments (the same trick streamlink uses).

const { spawn } = require('child_process');
const bin = require('../bin');
const limit = require('../limit');

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** yt-dlp -g: the playlist URL for the chosen format (first line). */
function resolveUrl(url, format, extraArgs = []) {
  return limit.ytdlp(() => new Promise(resolve => {
    let out = '', err = '', p;
    try { p = spawn(bin.ytdlp(), ['-q', '--no-warnings', '-g', '-f', format, ...extraArgs, url]); } catch (e) { return resolve({ error: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 40000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); resolve({ error: e.message }); });
    p.on('close', code => {
      clearTimeout(t);
      const first = out.split('\n').map(s => s.trim()).find(Boolean);
      resolve(code === 0 && first ? { url: first } : { error: (err.trim().split('\n').pop() || `yt-dlp exited ${code}`).replace(/^ERROR:\s*/, '') });
    });
  }));
}

/** Parse a media playlist. Returns {segments:[url], target, ended, map, encrypted}. Master playlists return {variants}. */
function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const info = lines[i];
      const uri = lines.slice(i + 1).find(l => l && !l.startsWith('#'));
      if (!uri) continue;
      const res = info.match(/RESOLUTION=\d+x(\d+)/);
      variants.push({ url: new URL(uri, base).href, height: res ? Number(res[1]) : 0, audioOnly: /audio_only|VIDEO="audio_only"/i.test(info) || !res, bw: Number((info.match(/BANDWIDTH=(\d+)/) || [])[1]) || 0 });
    }
    return { variants };
  }
  const out = { segments: [], target: 2, ended: lines.includes('#EXT-X-ENDLIST'), map: null, encrypted: false };
  let skipNext = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) out.target = Number(l.split(':')[1]) || 2;
    else if (l.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(l)) out.encrypted = true;
    else if (l.startsWith('#EXT-X-MAP:')) { const m = l.match(/URI="([^"]+)"/); if (m) out.map = new URL(m[1], base).href; }
    else if (l.startsWith('#EXTINF:')) skipNext = /amazon|stitched|twitch-ad/i.test(l); // Twitch ad breaks
    else if (l.startsWith('#EXT-X-TWITCH-PREFETCH:')) out.segments.push(new URL(l.slice(23), base).href); // low-latency
    else if (l && !l.startsWith('#')) { if (!skipNext) out.segments.push(new URL(l, base).href); skipNext = false; }
  }
  return out;
}

async function get(url, ms = 10000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r;
}

/**
 * Pump a live HLS stream into a writable (ffmpeg stdin) until stopped or the stream ends.
 * @param {object} o {playlist, out, stopped():bool, wantVideo, height, onStatus(msg)}
 * Throws on unrecoverable errors (the caller re-resolves the URL and retries).
 */
async function pumpHls({ playlist, out, stopped, wantVideo, height = 480, onStatus = () => {} }) {
  let url = playlist;
  const seen = new Set();
  let first = true, fails = 0, mapSent = false, wrote = 0;
  while (!stopped()) {
    let pl;
    try {
      pl = parsePlaylist(await (await get(url)).text(), url);
      fails = 0;
    } catch (e) {
      if (e.status === 403 || e.status === 404 || ++fails >= 5) throw new Error(`stream playlist ${e.message}`);
      await sleep(1500);
      continue;
    }
    if (pl.variants) { // master playlist: pick a variant
      const v = pl.variants;
      const pick = wantVideo
        ? v.filter(x => !x.audioOnly && x.height && x.height <= height).sort((a, b) => b.height - a.height)[0] || v.filter(x => !x.audioOnly).sort((a, b) => a.height - b.height)[0]
        : v.find(x => x.audioOnly) || v.slice().sort((a, b) => a.bw - b.bw)[0];
      if (!pick) throw new Error('no playable variant');
      url = pick.url;
      continue;
    }
    if (pl.encrypted) throw new Error('encrypted stream');
    if (pl.map && !mapSent) { out.write(Buffer.from(await (await get(pl.map)).arrayBuffer())); mapSent = true; }
    // Start at the live edge, not minutes behind.
    const segs = first ? pl.segments.slice(-3) : pl.segments;
    if (first) { first = false; for (const s of pl.segments.slice(0, -3)) seen.add(s); }
    for (const s of segs) {
      if (stopped()) return;
      if (seen.has(s)) continue;
      seen.add(s);
      try {
        const buf = Buffer.from(await (await get(s, 15000)).arrayBuffer());
        if (!out.write(buf)) await new Promise(r => out.once('drain', r));
        if (!wrote++) onStatus('receiving stream');
      } catch { /* a missed segment is a short gap, not a reason to stop */ }
    }
    if (seen.size > 400) { const keep = [...seen].slice(-200); seen.clear(); keep.forEach(x => seen.add(x)); }
    if (pl.ended) return;
    await sleep(Math.max(400, pl.target * 400)); // poll well inside one segment length
  }
}

module.exports = { resolveUrl, parsePlaylist, pumpHls };
