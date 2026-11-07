// Pulls audio from a live stream URL (Twitch, YouTube, X broadcasts/Spaces, Kick and more)
// and turns it into 16 kHz mono PCM. Also measures loudness so shouting can be flagged.
//   Twitch with streamlink installed:  streamlink --twitch-low-latency → ffmpeg
//   Everything else:                   yt-dlp → ffmpeg

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const bin = require('../bin');
const limit = require('../limit');
const { resolveUrl, pumpHls } = require('./hls');

// Are ffmpeg / yt-dlp / streamlink usable? Checked in the background and cached, so a page load never
// waits on them (yt-dlp takes a second or more just to start). ffmpeg takes -version, the others --version.
const hasAsync = (cmd, flag = '--version') => new Promise(resolve => {
  let p;
  try { p = spawn(cmd, [flag], { stdio: 'ignore' }); } catch { return resolve(false); }
  const t = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 15000);
  p.on('error', () => { clearTimeout(t); resolve(false); });
  p.on('close', code => { clearTimeout(t); resolve(code === 0); });
});
let toolCache = { ffmpeg: false, ytdlp: false, streamlink: false }, toolsAt = 0, toolsJob = null;
function refreshTools() {
  if (toolsJob) return toolsJob;
  toolsJob = Promise.all([hasAsync(bin.ffmpeg(), '-version'), hasAsync(bin.ytdlp()), hasAsync(bin.streamlink())])
    .then(([ffmpeg, ytdlp, streamlink]) => { toolCache = { ffmpeg, ytdlp, streamlink }; toolsAt = Date.now(); toolsJob = null; return toolCache; });
  return toolsJob;
}
function tools() {
  // Re-check every 20 s while something is missing (yt-dlp may still be downloading on first run).
  if (!toolsAt || ((!toolCache.ffmpeg || !toolCache.ytdlp) && Date.now() - toolsAt > 20000)) refreshTools();
  return toolCache;
}

/** Tracks loudness in 100 ms frames, keyed by audio time, so each transcript line can be scored. */
class LevelMeter {
  constructor() {
    this.frames = [];    // {s: audioSec, db}
    this.carry = Buffer.alloc(0);
    this.samples = 0;
  }
  push(buf) {
    let data = this.carry.length ? Buffer.concat([this.carry, buf]) : buf;
    const FRAME = 1600 * 2; // 100 ms
    let off = 0;
    const out = [];
    for (; off + FRAME <= data.length; off += FRAME) {
      let sum = 0;
      for (let i = off; i < off + FRAME; i += 2) { const v = data.readInt16LE(i) / 32768; sum += v * v; }
      const db = 10 * Math.log10(sum / 1600 + 1e-10);
      const s = this.samples / 16000;
      this.samples += 1600;
      this.frames.push({ s, db });
      out.push(db);
    }
    this.carry = data.subarray(off);
    if (this.frames.length > 6000) this.frames.splice(0, this.frames.length - 6000); // last 10 min
    return out;
  }
  /** Average, peak and 60-second baseline (median of voiced frames) for a time range. */
  stats(start, end) {
    const inRange = this.frames.filter(f => f.s >= start - 0.05 && f.s <= end + 0.05);
    if (!inRange.length) return null;
    const recent = this.frames.filter(f => f.s >= end - 60 && f.s < start && f.db > -50).map(f => f.db).sort((a, b) => a - b);
    const baseline = recent.length > 50 ? recent[Math.floor(recent.length / 2)] : null;
    const peak = Math.max(...inRange.map(f => f.db));
    const avg = inRange.reduce((a, f) => a + f.db, 0) / inRange.length;
    return { avg: Math.round(avg * 10) / 10, peak: Math.round(peak * 10) / 10, baseline: baseline == null ? null : Math.round(baseline * 10) / 10 };
  }
}

/**
 * Spawns the downloader + ffmpeg pipeline for a URL. Emits 'pcm' (Buffer), 'status', 'end', 'segment'.
 * With clipDir set, it also pulls low-res video and keeps a rolling ring of 4-second segments
 * (about 6 minutes) on disk, so any moment can be cut into a clip afterwards.
 */
class UrlCapture extends EventEmitter {
  constructor(url, { extraArgs = [], recordPath = null, clipDir = null, quality = '480', ringMinutes = 15 } = {}) {
    super();
    this.url = url;
    this.wrap = Math.max(30, Math.ceil((ringMinutes * 60) / 4)); // 4 s segments kept for clips
    this.procs = [];
    this.stopped = false;
    this.clipDir = clipDir;
    // First check of the tools may still be running: wait for it rather than wrongly saying "not installed".
    if (!toolsAt) { refreshTools().then(() => { if (!this.stopped) this.init(url, { extraArgs, recordPath, clipDir, quality }); }); return; }
    this.init(url, { extraArgs, recordPath, clipDir, quality });
  }

  init(url, { extraArgs, recordPath, clipDir, quality }) {
    const t = tools();
    if (!t.ffmpeg) { setImmediate(() => this.fail(bin.ffmpegHelp())); return; }
    const twitch = /twitch\.tv\//i.test(url);
    const h = Number(quality) || 480;
    if (!t.ytdlp && !(twitch && t.streamlink)) { setImmediate(() => this.fail('yt-dlp is not installed (see README → Streams)')); return; }
    // Low latency: don't buffer input, and push every audio packet straight to speech-to-text.
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '256000', '-analyzeduration', '1000000', '-i', 'pipe:0',
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-flush_packets', '1', '-f', 's16le', 'pipe:1'];
    if (recordPath) ffArgs.push('-map', '0:a:0', '-vn', '-ac', '1', '-b:a', '64k', recordPath);
    if (clipDir) {
      fs.mkdirSync(clipDir, { recursive: true });
      this.listPath = path.join(clipDir, 'segments.csv');
      try { fs.unlinkSync(this.listPath); } catch {}
      ffArgs.push('-map', '0:v:0?', '-map', '0:a:0', '-c', 'copy', '-f', 'segment', '-segment_time', '4',
        '-segment_wrap', String(this.wrap || 225), '-reset_timestamps', '1', '-segment_list', this.listPath, '-segment_list_type', 'csv',
        path.join(clipDir, 'seg%03d.ts'));
      this.listSize = 0;
      this.listTimer = setInterval(() => this.readSegments(), 1000);
    }
    const ff = spawn(bin.ffmpeg(), ffArgs);
    this.procs = [ff];
    ff.stdin.on('error', () => {});
    let errText = '';
    const note = m => { this.reason = m; errText = (errText + '\n' + m).slice(-400); };
    ff.stderr.on('data', d => { errText = (errText + d).slice(-400); });

    const pipeProc = dl => {
      this.procs.push(dl);
      dl.stdout.pipe(ff.stdin);
      dl.stdout.on('error', () => {});
      dl.stderr.on('data', d => { errText = (errText + d).slice(-400); });
    };
    const ytPipe = () => {
      const f = clipDir ? `best[height<=${h}]/bestvideo[height<=${h}]+bestaudio/best/worst` : 'audio_only/bestaudio/worst';
      const args = ['-q', '--no-warnings', '--no-part', '-f', f, ...extraArgs, '-o', '-', url];
      if (bin.ffmpeg() !== 'ffmpeg') args.unshift('--ffmpeg-location', bin.ffmpeg());
      pipeProc(spawn(bin.ytdlp(), args));
    };
    if (twitch && t.streamlink) {
      const q = clipDir ? `${h}p,${h}p30,360p,worst` : 'audio_only,worst';
      pipeProc(spawn(bin.streamlink(), ['--twitch-low-latency', '--twitch-disable-ads', '--stdout', '--loglevel', 'error', url, q]));
    } else {
      // Live streams: yt-dlp finds the playlist, Node fetches the segments (no system ffmpeg needed, lower delay).
      this.procs.push({ kill: () => { this.stopped = true; } });
      (async () => {
        const fmt = clipDir ? `best[height<=${h}]/best/worst` : 'audio_only/worst';
        const r = await resolveUrl(url, fmt, extraArgs);
        if (this.stopped) return;
        if (r.error) { note(r.error); ff.stdin.end(); return; }
        if (!/\.m3u8|m3u8|hls/i.test(r.url)) { ytPipe(); return; } // not HLS: let yt-dlp stream it
        try {
          await pumpHls({ playlist: r.url, out: ff.stdin, stopped: () => this.stopped, wantVideo: Boolean(clipDir), height: h });
          note('stream ended');
        } catch (e) {
          if (/encrypted/.test(e.message)) { ytPipe(); return; }
          note(e.message);
        }
        if (!this.stopped) ff.stdin.end();
      })().catch(e => { note(e.message); try { ff.stdin.end(); } catch {} });
    }
    let gotAudio = false;
    ff.stdout.on('data', buf => {
      if (!gotAudio) { gotAudio = true; this.emit('status', 'receiving audio'); }
      this.emit('pcm', buf);
    });
    setImmediate(() => !gotAudio && this.emit('status', 'connecting to stream'));
    ff.on('close', code => {
      clearInterval(this.listTimer);
      if (this.stopped) return;
      const msg = this.reason || errText.trim().split('\n').pop() || `audio pipeline exited (${code})`;
      this.emit('end', gotAudio ? 'stream ended' : msg);
    });
  }

  /** New lines in ffmpeg's segment list = finished segments. Stamp each with the wall-clock time it closed. */
  readSegments() {
    let st;
    try { st = fs.statSync(this.listPath); } catch { return; }
    if (st.size <= this.listSize) return;
    const fd = fs.openSync(this.listPath, 'r');
    const buf = Buffer.alloc(st.size - this.listSize);
    fs.readSync(fd, buf, 0, buf.length, this.listSize);
    fs.closeSync(fd);
    this.listSize = st.size;
    for (const line of buf.toString().split('\n')) {
      const [file, start, end] = line.trim().split(',');
      if (!file || !end) continue;
      const dur = Math.max(0.5, Number(end) - Number(start));
      this.emit('segment', { file: path.join(this.clipDir, file), dur, end: Date.now(), start: Date.now() - dur * 1000 });
    }
  }

  fail(msg) { this.emit('end', msg); }
  stop() {
    this.stopped = true;
    clearInterval(this.listTimer);
    for (const p of this.procs) { try { p.kill('SIGTERM'); } catch {} }
  }
}

/** Cuts a clip out of ring segments: copies them first (the ring overwrites), then joins into an MP4. */
function makeClip(segments, outPath) {
  return new Promise((resolve, reject) => {
    if (!segments.length) return reject(new Error('No video buffered for that moment yet'));
    const tmp = segments.map((sg, i) => {
      const p = outPath.replace(/\.mp4$/, `.part${i}.ts`);
      fs.copyFileSync(sg.file, p);
      return p;
    });
    const cleanup = () => tmp.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    const run = (args, cb) => {
      const p = spawn(bin.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'concat:' + tmp.join('|'), ...args, outPath]);
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('close', code => cb(code, err));
    };
    // Fast path: copy streams. If the codecs don't fit MP4, re-encode.
    run(['-c', 'copy', '-movflags', '+faststart'], code => {
      if (code === 0) { cleanup(); return resolve(outPath); }
      run(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'], (code2, err2) => {
        cleanup();
        code2 === 0 ? resolve(outPath) : reject(new Error('ffmpeg could not make the clip: ' + err2.trim().split('\n').pop()));
      });
    });
  });
}

/** Video id for embedding a YouTube live (works for /@channel/live links too). */
function resolveId(url, extraArgs = []) {
  return new Promise(resolve => {
    if (!tools().ytdlp) return resolve(null);
    const p = spawn(bin.ytdlp(), ['-q', '--no-warnings', '--skip-download', '--print', 'id', ...extraArgs, url]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 25000);
    p.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out.trim().split('\n')[0] || null : null); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** Is a channel live right now? Uses yt-dlp's is_live field. Resolves true or false, never throws. */
function checkLive(url, extraArgs = []) {
  return limit.ytdlp(() => new Promise(resolve => {
    if (!tools().ytdlp) return resolve(false);
    const p = spawn(bin.ytdlp(), ['-q', '--no-warnings', '--skip-download', '--print', 'is_live', ...extraArgs, url]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 25000);
    p.on('close', code => { clearTimeout(timer); resolve(code === 0 && /true/i.test(out)); });
    p.on('error', () => { clearTimeout(timer); resolve(false); });
  }));
}

module.exports = { UrlCapture, LevelMeter, checkLive, tools, refreshTools, makeClip, resolveId };
