// Upcoming livestreams: reads each auto-watched YouTube channel's scheduled streams (the "Upcoming"
// entries on its Live tab) with yt-dlp. Channels schedule these in advance (FOMC press conferences,
// White House addresses, SpaceX launches, NVIDIA keynotes), so you see them coming and get a reminder.

const { spawn } = require('child_process');
const bin = require('../bin');

function run(args, timeoutMs = 45000) {
  return new Promise(resolve => {
    let out = '', p;
    try { p = spawn(bin.ytdlp(), ['-q', '--no-warnings', ...args]); } catch { return resolve(null); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 2e6) p.kill(); });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => { clearTimeout(t); resolve(out); }); // upcoming videos exit non-zero but still print
  });
}

/** https://www.youtube.com/@Name/live → https://www.youtube.com/@Name (YouTube only, else null) */
function channelBase(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/i);
  return m ? `https://www.youtube.com/${m[1]}` : null;
}

const FIELDS = '%(id)s\t%(live_status)s\t%(release_timestamp)s\t%(title)s';
const parse = out => String(out || '').split('\n').map(l => l.split('\t')).filter(p => p.length >= 4 && p[0] && p[0] !== 'NA')
  .map(([id, status, ts, ...title]) => ({ id, status, startAt: /^\d+$/.test(ts) ? Number(ts) * 1000 : null, title: title.join('\t').trim() }));

/** Scheduled streams for one watched channel: [{id, title, startAt, url}] */
async function scanChannel(w, extraArgs = []) {
  const base = channelBase(w.url);
  if (!base) return [];
  const listed = parse(await run(['--flat-playlist', '--playlist-items', '1:8', '--print', FIELDS, ...extraArgs, base + '/streams']));
  const found = listed.filter(e => e.status === 'is_upcoming' && e.startAt);
  // Flat listings don't always carry the status: check the newest few entries one by one.
  for (const e of listed.filter(e => !['is_upcoming', 'was_live', 'not_live', 'post_live'].includes(e.status)).slice(0, 3)) {
    const [v] = parse(await run(['--skip-download', '--ignore-no-formats-error', '--no-playlist', '--print', FIELDS, ...extraArgs, `https://www.youtube.com/watch?v=${e.id}`], 30000));
    if (v && v.status === 'is_upcoming' && v.startAt) found.push(v);
  }
  const now = Date.now();
  return found.filter(e => e.startAt > now - 3600000 && e.startAt < now + 60 * 86400000)
    .map(e => ({ id: e.id, title: e.title, startAt: e.startAt, url: `https://www.youtube.com/watch?v=${e.id}`, channelUrl: w.url, label: w.label || '' }));
}

function demoUpcoming(watch) {
  const now = Date.now();
  const pick = (re, fallback) => (watch.find(w => re.test(w.url)) || { url: fallback, label: '' });
  return [
    { id: 'demo-spacex', title: 'Starship Flight Test', startAt: now + 14 * 60000, url: 'https://www.youtube.com/@SpaceX', ...((w) => ({ channelUrl: w.url, label: w.label || 'SpaceX' }))(pick(/SpaceX/i, 'https://www.youtube.com/@SpaceX/live')) },
    { id: 'demo-fomc', title: 'FOMC Press Conference', startAt: now + 26 * 3600000, url: 'https://www.youtube.com/@federalreserve', ...((w) => ({ channelUrl: w.url, label: w.label || 'Federal Reserve' }))(pick(/federalreserve/i, 'https://www.youtube.com/@federalreserve/live')) },
    { id: 'demo-nvda', title: 'NVIDIA GTC Keynote', startAt: now + 4 * 86400000, url: 'https://www.youtube.com/@NVIDIA', ...((w) => ({ channelUrl: w.url, label: w.label || 'NVIDIA' }))(pick(/NVIDIA/i, 'https://www.youtube.com/@NVIDIA/live')) },
  ];
}

module.exports = { scanChannel, channelBase, demoUpcoming };
