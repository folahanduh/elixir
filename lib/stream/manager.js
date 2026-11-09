// Runs every live stream session: audio in → transcript → moment scoring → pings.
// Session kinds:
//   url      server pulls the stream itself (Twitch / YouTube / X / Kick link) — best
//   tab      the browser shares a tab's audio and sends it here
//   browser  free fallback: Chrome speech recognition on your mic, text only
//   demo     scripted fake stream for trying the UI

const fs = require('fs');
const path = require('path');
const { DeepgramStream } = require('./deepgram');
const { spawn } = require('child_process');
const bin = require('../bin');
const { UrlCapture, LevelMeter, checkLive, tools, makeClip, resolveId } = require('./capture');
const { resolveProfile } = require('./profile');
const { scanChannel, demoUpcoming } = require('./upcoming');
const { coinsForLine } = require('../coinmatch');
const { TwitchChat, twitchChannel } = require('./twitchchat');
const { StreamJudge } = require('./judge');
const { MomentAnalyzer } = require('./moments');
const { normalize } = require('../extract');

const DIR = path.join(__dirname, '..', '..', 'data', 'streams');
const CLIP_DIR = path.join(__dirname, '..', '..', 'data', 'clips');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(CLIP_DIR, { recursive: true });

/** How to show the stream inside the tracker, and where to open it. */
function embedFor(url, videoId) {
  const u = String(url || '');
  let m;
  if ((m = u.match(/twitch\.tv\/(?!videos\/)([A-Za-z0-9_]{3,25})/i))) return { kind: 'twitch', src: `https://player.twitch.tv/?channel=${m[1]}&parent=localhost&parent=127.0.0.1&muted=true`, open: `https://www.twitch.tv/${m[1]}` };
  if ((m = u.match(/kick\.com\/([A-Za-z0-9_-]+)/i))) return { kind: 'kick', src: `https://player.kick.com/${m[1]}?muted=true`, open: `https://kick.com/${m[1]}` };
  if (/youtu\.?be/i.test(u)) {
    const id = videoId || (u.match(/[?&]v=([\w-]{11})/) || u.match(/youtu\.be\/([\w-]{11})/) || u.match(/\/live\/([\w-]{11})/) || [])[1];
    return { kind: 'youtube', src: id ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=1` : null, open: u };
  }
  if (/(x|twitter)\.com/i.test(u)) return { kind: 'x', src: null, open: u.replace('twitter.com', 'x.com') };
  return u ? { kind: 'web', src: null, open: u } : null;
}

const CRYPTO_KEYTERMS = require('./cryptofix').KEYTERMS; // crypto words Deepgram should listen for
const hhmmss = s => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'stream';

const majority = arr => {
  const c = new Map();
  for (const x of arr) if (x != null) c.set(x, (c.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
};
// Chat / Claude add tags and keywords to a line after the fact; keep them when the line is re-scored.
const mergeTags = (fresh, seg) => [...new Set([...fresh, ...((seg.tags || []).filter(t => ['FUNNY', 'HYPE', 'MEME', 'CRYPTO'].includes(t) && (seg.chatBonus || seg.aiBonus)))])];
const mergeKeywords = (fresh, seg) => fresh.concat((seg.keywords || []).filter(k => (k.kind === 'chat' || k.kind === 'ai') && !fresh.some(f => f.text.toLowerCase() === k.text.toLowerCase())));

function platformOf(url) {
  const u = String(url || '');
  if (/twitch\.tv/i.test(u)) return 'twitch';
  if (/youtu\.?be/i.test(u)) return 'youtube';
  if (/(x|twitter)\.com\/i\/spaces/i.test(u)) return 'x-space';
  if (/(x|twitter)\.com/i.test(u)) return 'x';
  if (/kick\.com/i.test(u)) return 'kick';
  if (/pump\.fun/i.test(u)) return 'pumpfun';
  return u ? 'web' : '';
}

class StreamManager {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig   current config
   * @param {(event:string, data:any) => void} o.send   push to browsers
   * @param {(seg, session) => void} o.onSegment        every final line (server: trends + feed)
   * @param {(seg, session, title, kind) => void} o.onPing   a moment worth a ping
   * @param {(word:string) => Promise<object>} o.lookup  coin check
   * @param {boolean} o.demo
   */
  constructor(o) {
    Object.assign(this, o);
    this.sessions = new Map();
    this.watchState = new Map(); // url -> {live, checkedAt, sid}
    this.levels = {};
    setInterval(() => {
      if (Object.keys(this.levels).length) { this.send('stream-levels', this.levels); this.levels = {}; }
    }, 200);
    this.watchTimer = setInterval(() => this.pollWatched(), 60000);
    this.pauseTimer = setInterval(() => this.tickPauses(), 150);
    setTimeout(() => this.pollWatched(), 3000);
    // Scheduled streams: rescan every 30 min, reminders checked every 30 s.
    this.upcoming = [];
    this.reminded = new Set();
    setTimeout(() => this.scanUpcoming(), 90000); // after start-up has settled
    this.upcomingTimer = setInterval(() => this.scanUpcoming(), 30 * 60000);
    this.remindTimer = setInterval(() => this.remindUpcoming(), 30000);
  }

  get cfg() { return this.getConfig().streams; }

  status() {
    const t = tools();
    const c = this.getConfig();
    return {
      stt: this.demo ? 'demo' : c.keys.deepgram ? 'deepgram' : 'browser-only',
      judge: this.demo ? 'demo' : c.keys.anthropic ? `on (${this.cfg.judge.model})` : 'off',
      tools: t,
      ffmpegHelp: t.ffmpeg ? null : require('../bin').ffmpegHelp(),
      watch: (this.cfg.watch || []).map(w => ({ ...w, ...(this.watchState.get(w.url) || {}), profile: this.profileFor(w.url, w.label) })),
      upcoming: this.upcomingView(),
    };
  }

  /** Cached channel profile for a link; starts resolving it in the background the first time. */
  profileFor(url, label) {
    this.profiles = this.profiles || new Map();
    if (!url) return null;
    if (!this.profiles.has(url)) {
      this.profiles.set(url, null);
      resolveProfile(url, { label, demo: this.demo }).then(p => {
        this.profiles.set(url, p);
        for (const s of this.sessions.values()) if (s.url === url) { s.profile = p; this.send('stream-session', this.meta(s)); }
        this.send('stream-status', this.status());
      }).catch(() => {});
    }
    return this.profiles.get(url);
  }

  snapshot() {
    return {
      status: this.status(),
      sessions: [...this.sessions.values()].map(s => this.meta(s, true)),
    };
  }

  meta(s, withSegs) {
    const m = {
      id: s.id, label: s.label, url: s.url, kind: s.kind, platform: s.platform, status: s.status,
      startedAt: s.startedAt, endedAt: s.endedAt || null, chat: s.chat ? s.chatStatus || 'connecting' : null,
      judge: s.judgeStatus || null, count: s.segs.length, highlights: s.segs.filter(x => x.highlight).length,
      embed: embedFor(s.url, s.videoId), canClip: Boolean(s.ring) || s.kind === 'demo', clips: s.clips,
      speakers: s.speakers, pingSpeakers: s.pingSpeakers, profile: s.profile || null, diarize: s.kind === 'url' || s.kind === 'tab' || s.kind === 'demo',
    };
    if (withSegs) m.segs = s.segs.slice(-400);
    return m;
  }

  // ---------- lifecycle ----------
  start({ url = '', label = '', kind = 'url', lang } = {}) {
    url = String(url).trim();
    if (kind === 'url' && !/^https?:\/\//i.test(url)) throw new Error('Paste a full stream link starting with https://');
    for (const s of this.sessions.values()) {
      if (s.url && s.url === url && !s.endedAt) return this.meta(s); // already running
    }
    // One card per stream: an earlier, stopped session of the same link is replaced (its transcript stays in data/streams).
    if (url) for (const [id, s] of this.sessions) if (s.url === url && s.endedAt) { this.sessions.delete(id); this.send('stream-removed', { id }); }
    const c = this.getConfig();
    if (kind === 'tab' && !c.keys.deepgram && !this.demo) {
      throw new Error('Transcribing tab audio needs a Deepgram key (free credit): add it under API keys. Without one, use "Mic".');
    }
    const platform = platformOf(url);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const name = label || (twitchChannel(url) ? twitchChannel(url) : platform ? platform + ' stream' : 'stream');
    const day = new Date().toISOString().slice(0, 10);
    const s = {
      id, url, kind: this.demo && kind !== 'browser' ? 'demo' : kind, platform, label: name, startedAt: Date.now(),
      status: 'starting', segs: [], analyzer: new MomentAnalyzer(), meter: new LevelMeter(),
      lang: lang || this.cfg.language || 'en', retries: 0, hadAudio: false, lastWatchPing: new Map(),
      logBase: path.join(DIR, `${day}_${slug(name)}_${id}`),
      clips: [], lastAutoClip: 0,
      speakers: {}, pingSpeakers: [], open: null, live: null, lastWordWall: 0, pausing: false,
    };
    if (/youtu\.?be/i.test(url) && !embedFor(url).src) resolveId(url, this.cfg.ytdlpArgs || []).then(v => { if (v) { s.videoId = v; this.send('stream-session', this.meta(s)); } });
    this.sessions.set(id, s);
    s.profile = url ? this.profileFor(url, name) : { platform: kind === 'tab' ? 'tab' : 'mic', name, avatar: null };
    fs.appendFile(s.logBase + '.txt', `# ${name} — ${url || kind} — started ${new Date().toLocaleString()}\n`, () => {});
    this.wire(s);
    this.send('stream-session', this.meta(s));
    return this.meta(s);
  }

  wire(s) {
    const c = this.getConfig();
    // Speech to text
    if ((s.kind === 'url' || s.kind === 'tab') && c.keys.deepgram) {
      // Crypto vocabulary first (it's what gets misheard most), then your keywords and any extra terms.
      const keyterms = [...new Set([...CRYPTO_KEYTERMS, ...(this.cfg.keyterms || []), ...(c.watchlist || [])])];
      s.stt = new DeepgramStream({ apiKey: c.keys.deepgram, language: s.lang, keyterms, model: this.cfg.deepgramModel || 'nova-3', diarize: this.cfg.diarize !== false });
      s.stt.on('status', st => this.setPart(s, 'speech', st));
      s.stt.on('interim', r => this.onInterim(s, r));
      s.stt.on('final', r => this.onFinal(s, r));
    }
    if ((s.kind === 'url' || s.kind === 'tab') && !c.keys.deepgram) this.setPart(s, 'speech', 'off: add a Deepgram key under API keys to get the transcript');
    if (s.kind === 'url') this.startCapture(s);
    if (s.kind === 'tab') this.setStatus(s, 'waiting for tab audio');
    if (s.kind === 'browser') this.setStatus(s, 'listening (browser mic)');
    if (s.kind === 'demo') this.runDemo(s);

    // Twitch chat reactions
    const ch = twitchChannel(s.url);
    if (ch && s.kind !== 'demo') {
      s.chat = new TwitchChat(ch);
      s.chat.on('status', st => { s.chatStatus = st; this.send('stream-session', this.meta(s)); });
      s.chat.on('rate', r => { this.levels[s.id] = { ...(this.levels[s.id] || {}), chat: r }; });
      s.chat.on('reaction', r => this.onChatReaction(s, r));
    }

    // Claude judge
    const j = this.cfg.judge || {};
    if (j.enabled !== false && s.kind !== 'demo') {
      s.judge = new StreamJudge({ apiKey: c.keys.anthropic, model: j.model || 'claude-opus-5-5', effort: j.effort || 'low', everySeconds: j.everySeconds || 8, label: s.label });
      if (s.judge.enabled) {
        s.judge.on('verdict', v => this.onVerdict(s, v));
        s.judge.on('status', st => { s.judgeStatus = st; this.send('stream-session', this.meta(s)); });
        s.judgeStatus = 'on';
      } else s.judgeStatus = 'off: ' + s.judge.reason;
    }
  }

  startCapture(s) {
    const recordPath = this.cfg.recordAudio ? `${s.logBase}_${s.retries}.mp3` : null;
    const clips = this.cfg.clips || {};
    const clipDir = clips.enabled !== false ? path.join(CLIP_DIR, 'ring', `${s.id}_${s.retries}`) : null;
    s.ring = clipDir ? [] : null;
    s.capture = new UrlCapture(s.url, { extraArgs: this.cfg.ytdlpArgs || [], recordPath, clipDir, quality: clips.quality || '480', ringMinutes: clips.ringMinutes || 15 });
    s.capture.on('segment', sg => { s.ring.push(sg); if (s.ring.length > 85) s.ring.shift(); });
    s.capture.on('status', st => this.setPart(s, 'audio', st));
    s.capture.on('pcm', buf => this.onPcm(s, buf));
    s.capture.on('end', reason => {
      if (s.endedAt) return;
      if (s.hadAudio && s.retries < 5) {
        s.retries++;
        this.setPart(s, 'audio', `stream dropped, reconnecting (${s.retries}/5)…`);
        setTimeout(() => !s.endedAt && this.startCapture(s), 8000);
      } else if (!s.hadAudio && !s.ytRefreshed && s.kind === 'url' && !/twitch\.tv/i.test(s.url)) {
        // Couldn't open the stream at all: usually the site changed and yt-dlp is out of date. Get the newest, retry once.
        s.ytRefreshed = true;
        this.setPart(s, 'audio', `couldn't open the stream (${String(reason).slice(0, 120)}). Updating yt-dlp and trying again…`);
        require('../bin').refreshYtdlp().then(ok => {
          if (s.endedAt) return;
          this.setPart(s, 'audio', ok ? 'yt-dlp updated, connecting again…' : 'connecting again…');
          this.startCapture(s);
        });
      } else this.stop(s.id, reason);
    });
  }

  stop(id, reason = 'stopped') {
    const s = this.sessions.get(id);
    if (!s || s.endedAt) return;
    s.endedAt = Date.now();
    this.closeOpen(s);
    s.capture?.stop(); s.stt?.close(); s.chat?.close(); s.judge?.stop();
    if (s.capture?.clipDir) setTimeout(() => fs.rm(s.capture.clipDir, { recursive: true, force: true }, () => {}), 60000);
    clearInterval(s.demoTimer);
    this.setStatus(s, reason);
    const w = this.watchState.get(s.url);
    if (w) { w.live = false; w.sid = null; }
    fs.appendFile(s.logBase + '.txt', `# ended ${new Date().toLocaleString()} (${reason})\n`, () => {});
  }

  remove(id) {
    this.stop(id);
    this.sessions.delete(id);
    this.send('stream-removed', { id });
  }

  setStatus(s, st) {
    s.status = st;
    this.send('stream-session', this.meta(s));
  }
  /** Audio and speech-to-text report separately, so one can't hide the other ("receiving audio" over a dead transcript). */
  setPart(s, part, st) {
    s.parts = { ...(s.parts || {}), [part]: st };
    const a = s.parts.audio, sp = s.parts.speech;
    const audioOk = /receiving|live/i.test(a || '') || s.hadAudio;
    const speechOk = /^listening/.test(sp || '');
    if (audioOk && speechOk) this.setStatus(s, s.heardWords ? 'live' : 'live · listening, no speech heard yet');
    else this.setStatus(s, [a && !(audioOk && /receiving/.test(a)) ? a : audioOk ? 'receiving audio' : a, sp ? 'speech-to-text: ' + sp.replace(/^error: /, '') : null].filter(Boolean).join(' · ') || 'starting');
  }

  // ---------- audio & text in ----------
  onPcm(s, buf) {
    if (s.endedAt) return;
    if (!s.hadAudio) { s.hadAudio = true; this.setPart(s, 'audio', 'receiving audio'); }
    const dbs = s.meter.push(buf);
    if (dbs.length) this.levels[s.id] = { ...(this.levels[s.id] || {}), db: Math.max(...dbs) };
    s.stt?.send(buf);
  }

  /** Text from the browser's own speech recognition (kind 'browser'): no word timings, one speaker. */
  onBrowserText(id, text, final) {
    const s = this.sessions.get(id);
    if (!s || s.endedAt) return;
    if (!final) return this.onInterim(s, { text, words: [] });
    const end = (Date.now() - s.startedAt) / 1000;
    const dur = Math.min(8, text.split(/\s+/).length * 0.35);
    this.onFinal(s, { text, words: [], start: Math.max(0, end - dur), end });
  }

  get pauseSec() { return (this.cfg.pauseMs || 700) / 1000; }
  get mergeSec() { return (this.cfg.mergeGapMs || 2500) / 1000; }

  speakerName(s, sp) {
    if (sp == null) return s.kind === 'browser' ? 'Mic' : '';
    return s.speakers[sp]?.name || `Speaker ${sp + 1}`;
  }

  /** "hello" + 2 s silence + "solana" → "hello … solana". */
  joinWords(words, prevEnd = null) {
    let out = '';
    let last = prevEnd;
    for (const w of words) {
      if (last != null) out += w.s - last >= this.pauseSec ? ' … ' : ' ';
      out += w.w;
      last = w.e;
    }
    return out.trim();
  }

  /** Interim words: rebuild the live line (open sentence + words still being decoded). */
  onInterim(s, r) {
    if (!s.heardWords) { s.heardWords = true; this.setPart(s, 'speech', 'listening'); }
    const words = r.words || [];
    const sp = majority(words.map(w => w.sp));
    const o = s.open && !s.open.seg.closed && (sp == null || s.open.seg.speaker === sp) ? s.open.seg : null;
    let text;
    if (words.length) {
      const joiner = o ? (words[0].s - o.end >= this.pauseSec ? ' … ' : ' ') : '';
      text = (o ? o.text + joiner : '') + this.joinWords(words);
    } else text = (o ? o.text + ' ' : '') + String(r.text || '').trim();
    s.lastWordWall = Date.now();
    s.pausing = false;
    s.live = { speaker: sp ?? o?.speaker ?? null, text };
    this.sendLive(s);
    this.watchCheck(s, text, sp);
  }

  sendLive(s) {
    this.send('stream-live', { id: s.id, speaker: s.live?.speaker ?? null, name: this.speakerName(s, s.live?.speaker), text: s.live?.text || '', pausing: Boolean(s.pausing) });
  }

  /** Watchlist words ping from live words, before the sentence is finished. Works across stutters. */
  watchCheck(s, text, sp) {
    if (sp != null && s.pingSpeakers?.length && !s.pingSpeakers.includes(sp)) return;
    const low = ' ' + text.toLowerCase().replace(/…/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    for (const w of (this.getConfig().watchlist || []).map(normalize)) {
      if (!w || !low.includes(' ' + w + ' ')) continue;
      if (Date.now() - (s.lastWatchPing.get(w) || 0) < 30000) continue;
      s.lastWatchPing.set(w, Date.now());
      const who = this.speakerName(s, sp);
      this.onPing({ id: 'interim-' + Date.now(), text, speaker: sp, keywords: [{ text: w, kind: 'watch' }], tags: ['WATCH'], score: 10, t: Date.now(), offset: (Date.now() - s.startedAt) / 1000 },
        s, `WATCH · ${s.label}${who ? ' · ' + who : ''} said “${w}”`, 'watch');
    }
  }

  /** Finished words. Split by speaker, then grow the open sentence or start a new one. */
  onFinal(s, r) {
    if (!s.heardWords) { s.heardWords = true; this.setPart(s, 'speech', 'listening'); }
    const words = r.words || [];
    if (!words.length) {
      const text = String(r.text || '').trim();
      if (text) this.addRun(s, { sp: null, words: null, text, start: r.start, end: r.end }, r.loud);
      return;
    }
    let run = null;
    for (const w of words) {
      if (!run || run.sp !== (w.sp ?? null)) {
        if (run) this.addRun(s, run, r.loud);
        run = { sp: w.sp ?? null, words: [], start: w.s, end: w.e };
      }
      run.words.push(w);
      run.end = w.e;
    }
    if (run) this.addRun(s, run, r.loud);
  }

  addRun(s, run, loud) {
    const text = run.words ? this.joinWords(run.words) : run.text;
    if (!text) return;
    if (run.sp != null) {
      const isNew = !s.speakers[run.sp];
      const spk = s.speakers[run.sp] || (s.speakers[run.sp] = { name: `Speaker ${run.sp + 1}`, talk: 0 });
      spk.talk += Math.max(0, run.end - run.start);
      // Announce new speakers right away; refresh talk-time shares now and then.
      if (isNew || Date.now() - (s.spkSentAt || 0) > 5000) { s.spkSentAt = Date.now(); this.send('stream-session', this.meta(s)); }
    }
    const o = s.open && !s.open.seg.closed ? s.open.seg : null;
    const gap = o ? run.start - o.end : Infinity;
    const sentenceDone = o && /[.?!]$/.test(o.text) && gap > 1.2;
    let seg;
    if (o && o.speaker === run.sp && gap < this.mergeSec && !sentenceDone) {
      // Same speaker kept going (maybe after a stutter): extend the line in place.
      seg = o;
      seg.text += (gap >= this.pauseSec ? ' … ' : ' ') + text;
      seg.end = run.end;
      if (gap >= this.pauseSec) seg.pauses = (seg.pauses || 0) + 1;
      if (run.words) seg.words.push(...run.words.map(w => ({ w: w.w, s: Math.round(w.s * 100) / 100, c: Math.round((w.c ?? 1) * 100) / 100 })));
    } else {
      if (o) this.closeOpen(s);
      const n = s.segs.length;
      seg = {
        id: `${s.id}-${n}`, sid: s.id, n, speaker: run.sp,
        t: Date.now() - Math.max(0, (run.end - run.start) * 1000),
        offset: run.start, end: run.end, text, pauses: 0,
        words: (run.words || []).map(w => ({ w: w.w, s: Math.round(w.s * 100) / 100, c: Math.round((w.c ?? 1) * 100) / 100 })),
        notes: [], ai: null, chatBonus: 0, aiBonus: 0, pinged: false, pingedKeys: [], closed: false,
      };
      s.segs.push(seg);
      if (s.segs.length > 3000) s.segs.splice(0, 500);
      s.open = { seg };
    }
    seg.speakerName = this.speakerName(s, seg.speaker);
    seg.loud = s.meter.frames.length ? s.meter.stats(seg.offset, seg.end) : (loud || seg.loud || null);
    const c = this.getConfig();
    // Score the whole sentence so far, with the stutter marks taken out ("hello … solana" → "hello solana").
    const a = s.analyzer.analyze({ ...seg, text: seg.text.replace(/\s…\s/g, ' ') }, { watchlist: c.watchlist, ignore: c.ignore }, seg.id);
    Object.assign(seg, { base: a.score, tags: mergeTags(a.tags, seg), keywords: mergeKeywords(a.keywords, seg), reasons: a.reasons, coinCheck: a.coinCheck });
    if (seg.ai?.why && !seg.reasons.includes(seg.ai.why)) seg.reasons.unshift(seg.ai.why);
    this.rescore(seg);
    s.lastWordWall = Date.now();
    s.pausing = false;
    s.live = { speaker: seg.speaker, text: seg.text };
    this.sendLive(s);
    this.send('stream-seg', seg);
    this.checkCoins(s, seg);
    this.maybePing(s, seg);
  }

  /** The speaker stopped (or someone else started): the sentence is final. Log it and hand it on. */
  closeOpen(s) {
    const seg = s.open?.seg;
    s.open = null;
    if (!seg || seg.closed) return;
    seg.closed = true;
    const who = seg.speakerName ? seg.speakerName + ': ' : '';
    fs.appendFile(s.logBase + '.jsonl', JSON.stringify({ ...seg, words: undefined }) + '\n', () => {});
    fs.appendFile(s.logBase + '.txt', `[${new Date(seg.t).toLocaleTimeString()} | ${hhmmss(seg.offset)}] ${who}${seg.text}${seg.tags.length ? '   {' + seg.tags.join(' ') + '}' : ''}\n`, () => {});
    s.judge?.add(seg);
    this.onSegment(seg, s);
    this.send('stream-seg', seg);
    this.matchCoins(s, seg);
    this.checkWalletMention(s, seg);
  }

  /** "Where's the coin I was just in?" → look in the streamer's wallet. */
  checkWalletMention(s, seg) {
    const t = String(seg.text || '');
    const MENTION = /\b(coin|token|one|thing|play)\s+(that\s+)?i\s*('m|am|was|just|'ve)?\s*(just\s+)?(in|bought|aped|apeing|aping|buying|holding|got)\b|\bi\s+(just\s+)?(bought|aped|aped into|sniped|got in(to)?|went in(to)?)\b|\bwhere'?s\s+the\s+(coin|token)\b|\bmy\s+(bag|bags|position)\b|\bwhat\s+i\s*('m|am)\s+(in|holding)\b/i;
    if (!MENTION.test(t)) return;
    if (Date.now() - (s.walletAskedAt || 0) < 20000) return; // one look-up per 20 s per stream
    s.walletAskedAt = Date.now();
    this.onWalletMention?.(s, seg);
  }

  /** Coins named after what was just said ("dog in vest" → $DOGVEST): shown under the line, pinged once. */
  async matchCoins(s, seg) {
    if (this.cfg.coinMatch === false || !seg.text || seg.text.length < 6) return;
    let found = [];
    if (s.kind === 'demo') {
      if (/bleats/i.test(seg.text)) found = [{ phrase: 'sir bleats', coins: [{ mint: 'DemoSirBLEATSxxxxxxxxxxxxxxxxxxxxxxxxxxpump', symbol: 'BLEATS', name: 'Sir Bleats', image: null, marketCap: 48200, ageMin: 6, pad: 'Pump', links: { axiom: 'https://axiom.trade/', gmgn: 'https://gmgn.ai/', dexscreener: 'https://dexscreener.com/' } }] }];
    } else {
      try { found = await coinsForLine(seg.text); } catch { return; }
    }
    if (!found.length) return;
    seg.coinMatches = found;
    if (!seg.tags.includes('COIN')) seg.tags.push('COIN');
    seg.highlight = true;
    this.send('stream-seg', seg);
    s.coinPinged = s.coinPinged || new Map();
    const fresh = found.filter(f => Date.now() - (s.coinPinged.get(f.phrase) || 0) > 10 * 60000);
    if (!fresh.length) return;
    for (const f of fresh) s.coinPinged.set(f.phrase, Date.now());
    this.onCoins?.(seg, s, fresh);
  }

  /** Every 150 ms: show a pause marker after 0.7 s of silence; close the sentence after 2.5 s. */
  tickPauses() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.endedAt || !s.lastWordWall || !s.live) continue;
      const quiet = now - s.lastWordWall;
      if (s.open && !s.open.seg.closed && quiet > this.mergeSec * 1000) {
        this.closeOpen(s);
        s.live = null;
        s.pausing = false;
        this.send('stream-live', { id: s.id, speaker: null, name: '', text: '', pausing: false });
      } else if (!s.pausing && quiet > this.pauseSec * 1000) {
        s.pausing = true;
        this.sendLive(s);
      }
    }
  }

  setSpeaker(id, sp, { name, ping } = {}) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown stream');
    sp = Number(sp);
    const spk = s.speakers[sp] || (s.speakers[sp] = { name: `Speaker ${sp + 1}`, talk: 0 });
    if (typeof name === 'string' && name.trim()) spk.name = name.trim().slice(0, 30);
    if (typeof ping === 'boolean') {
      s.pingSpeakers = (s.pingSpeakers || []).filter(x => x !== sp);
      if (ping) s.pingSpeakers.push(sp);
    }
    for (const seg of s.segs) if (seg.speaker === sp) seg.speakerName = spk.name;
    this.send('stream-session', this.meta(s));
    return this.meta(s);
  }

  rescore(seg) {
    seg.score = seg.base + seg.chatBonus + seg.aiBonus;
    seg.highlight = seg.score >= this.cfg.highlightScore || seg.tags.includes('WATCH');
  }

  async checkCoins(s, seg) {
    const words = [...new Set([...(seg.coinCheck || []), ...((seg.ai?.ticker_ideas) || [])])].slice(0, 4);
    if (!seg.highlight || !words.length) return;
    seg.dex = seg.dex || {};
    await Promise.all(words.filter(w => !seg.dex[w.toLowerCase()]).map(async w => {
      try {
        const r = await this.lookup(w);
        seg.dex[w.toLowerCase()] = { status: r.status, count: r.count, newestAgeMin: r.newestAgeMin, top: r.top.slice(0, 1) };
      } catch (e) { seg.dex[w.toLowerCase()] = { error: e.message }; }
    }));
    this.send('stream-seg', seg);
  }

  maybePing(s, seg) {
    if (seg.speaker != null && s.pingSpeakers?.length && !s.pingSpeakers.includes(seg.speaker)) return; // only chosen speakers
    const keyNow = seg.keywords.filter(k => k.kind === 'coinable' || k.kind === 'watch').map(k => k.text.toLowerCase());
    const fresh = keyNow.filter(k => !(seg.pingedKeys || []).includes(k));
    if (seg.pinged && !fresh.length) return; // a growing sentence pings again only for a new name or watch word
    const watch = seg.tags.includes('WATCH');
    if (!watch && seg.score < this.cfg.pingScore) return;
    seg.pinged = true;
    seg.pingedKeys = [...new Set([...(seg.pingedKeys || []), ...keyNow])];
    // Already pinged from the live (interim) words a moment ago and nothing else stands out: don't ping twice.
    const watchWords = seg.keywords.filter(k => k.kind === 'watch').map(k => normalize(k.text));
    const recent = w => Date.now() - (s.lastWatchPing?.get(w) || 0) < 30000;
    if (watch && seg.score - 10 * watchWords.length < this.cfg.pingScore && watchWords.every(recent)) return;
    const order = ['COINABLE', 'WATCH', 'FUNNY', 'CRYPTO', 'REPEAT', 'LOUD', 'MEMEABLE'];
    const main = order.find(t => seg.tags.includes(t)) || 'MOMENT';
    const kw = seg.keywords.find(k => k.kind === 'coinable' || k.kind === 'watch') || seg.keywords[0];
    const who = this.speakerName(s, seg.speaker);
    const title = `${main} · ${s.label}${who ? ' · ' + who : ''}: ${seg.reasons[0] || main.toLowerCase()}${kw && !(seg.reasons[0] || '').includes(kw.text) ? ` — “${kw.text}”` : ''}`;
    this.onPing(seg, s, title, main === 'FUNNY' ? 'funny' : main === 'COINABLE' ? 'fresh' : 'moment');
    this.autoClip(s, seg, title);
  }

  // ---------- clips ----------
  autoClip(s, seg, title) {
    const c = this.cfg.clips || {};
    if (!c.autoClip || !(s.ring || s.kind === 'demo') || !seg.t) return;
    if (seg.t - s.lastAutoClip < (c.before || 25) * 1000) return; // the previous clip already covers it
    s.lastAutoClip = seg.t;
    this.clip(s.id, { segId: seg.id, title }).catch(e => console.error('[clip]', e.message));
  }

  /** Cut a clip around a moment: "before" seconds ahead of it, "after" seconds past it. Waits for the footage. */
  async clip(id, { segId, at, title } = {}) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown stream');
    if (!s.ring && s.kind !== 'demo') throw new Error('Clips need the link capture (paste the stream link). Tab and mic capture are audio-only.');
    const c = this.cfg.clips || {};
    const seg = segId ? s.segs.find(x => x.id === segId) : null;
    const t = seg ? seg.t : Number(at) || Date.now();
    const from = t - (c.before || 25) * 1000, to = t + (c.after || 8) * 1000;
    const wait = to + 5000 - Date.now(); // let the segment covering the end close
    if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 30000)));
    const file = `${slug(s.label)}_${new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
    const out = path.join(CLIP_DIR, file);
    if (s.kind === 'demo') await demoClip(out);
    else await makeClip(s.ring.filter(sg => sg.end > from && sg.start < to), out);
    const clip = {
      id: file, sid: s.id, label: s.label, at: t, offset: seg ? seg.offset : (t - s.startedAt) / 1000,
      url: '/clips/' + encodeURIComponent(file), segId: seg?.id || null,
      title: title || (seg ? seg.text.slice(0, 80) : 'Clip'), text: seg?.text || '', tags: seg?.tags || [],
    };
    s.clips.unshift(clip);
    if (s.clips.length > 50) s.clips.pop();
    this.send('stream-clip', clip);
    return clip;
  }

  // ---------- extra signals ----------
  onChatReaction(s, r) {
    const now = Date.now();
    // Chat reacts a few seconds after the line, so tag what was said in the last ~15 s.
    const recent = s.segs.filter(x => now - (x.t + (x.end - x.offset) * 1000) < 12000).slice(-2);
    const label = r.kind === 'funny' ? `chat laughing (${r.laughs} in 6s)` : r.kind === 'clip' ? `chat asking for a clip (${r.clip})` : `chat hype (${r.msgs} msgs/6s)`;
    const bonus = r.kind === 'funny' ? 6 : r.kind === 'clip' ? 6 : 3;
    for (const seg of recent) {
      seg.notes.push(label);
      if (r.kind !== 'hype' && !seg.tags.includes('FUNNY')) seg.tags.push('FUNNY');
      if (r.kind === 'hype' && !seg.tags.includes('HYPE')) seg.tags.push('HYPE');
      seg.chatBonus = Math.max(seg.chatBonus, bonus);
      for (const sp of r.spam) if (!seg.keywords.some(k => k.text.toLowerCase() === sp.word)) seg.keywords.push({ text: sp.word, kind: 'chat' });
      this.rescore(seg);
      this.send('stream-seg', seg);
      this.checkCoins(s, seg);
    }
    this.send('stream-chat', { id: s.id, ...r, label });
    const said = recent.map(x => x.text).join(' … ').slice(-160);
    const spam = r.spam.length ? ` · chat spamming “${r.spam[0].word}”` : '';
    if (r.kind !== 'hype' || recent.some(x => x.score >= this.cfg.highlightScore)) {
      const seg = recent[recent.length - 1] || { id: 'chat-' + now, text: said || '(no speech captured)', keywords: [], tags: ['FUNNY'], score: bonus, t: now, offset: (now - s.startedAt) / 1000 };
      if (recent.length) seg.pinged = true;
      this.onPing({ ...seg, text: said || seg.text }, s, `${r.kind === 'hype' ? 'HYPE' : 'FUNNY'} · ${s.label}: ${label}${spam}`, r.kind === 'hype' ? 'trend' : 'funny');
    }
  }

  onVerdict(s, v) {
    const seg = s.segs.find(x => x.id === v.segment_id);
    if (!seg) return;
    seg.ai = { funny: v.funny, meme: v.meme, crypto: v.crypto, ticker_ideas: (v.ticker_ideas || []).slice(0, 3), why: v.why };
    const top = Math.max(v.funny, v.meme, v.crypto);
    seg.aiBonus = top >= 8 ? 6 : top >= 6 ? 3 : 0;
    if (v.funny >= 6 && !seg.tags.includes('FUNNY')) seg.tags.push('FUNNY');
    if (v.meme >= 6 && !seg.tags.includes('MEME')) seg.tags.push('MEME');
    if (v.crypto >= 6 && !seg.tags.includes('CRYPTO')) seg.tags.push('CRYPTO');
    for (const t of seg.ai.ticker_ideas) if (!seg.keywords.some(k => k.text.toLowerCase() === t.toLowerCase())) seg.keywords.push({ text: t, kind: 'ai' });
    if (seg.ai.why && !seg.reasons.includes(seg.ai.why)) seg.reasons.unshift(seg.ai.why);
    this.rescore(seg);
    this.send('stream-seg', seg);
    this.checkCoins(s, seg);
    this.maybePing(s, seg);
  }

  // ---------- upcoming (scheduled) streams ----------
  upcomingView() {
    return (this.upcoming || []).filter(u => u.startAt > Date.now() - 3600000).sort((a, b) => a.startAt - b.startAt)
      .map(u => ({ ...u, profile: this.profileFor(u.channelUrl, u.label) }));
  }

  async scanUpcoming() {
    if (this.scanningUpcoming) return;
    const watch = this.cfg.watch || [];
    if (this.demo) { this.upcoming = demoUpcoming(watch); this.send('stream-upcoming', this.upcomingView()); return; }
    if (!tools().ytdlp) return;
    this.scanningUpcoming = true;
    const found = [];
    for (const w of watch) {
      try { found.push(...await scanChannel(w, this.cfg.ytdlpArgs || [])); } catch {}
    }
    this.scanningUpcoming = false;
    this.upcoming = found;
    this.send('stream-upcoming', this.upcomingView());
  }

  /** Ping once ~15 minutes before a scheduled stream starts. When it goes live, auto-watch takes over. */
  remindUpcoming() {
    const lead = (this.cfg.remindMinutes ?? 15) * 60000;
    for (const u of this.upcoming || []) {
      const left = u.startAt - Date.now();
      if (left > lead || left < -600000 || this.reminded.has(u.id)) continue;
      this.reminded.add(u.id);
      const who = this.profileFor(u.channelUrl, u.label)?.name || u.label || 'Stream';
      const mins = Math.max(0, Math.round(left / 60000));
      this.onPing({ id: 'soon-' + u.id, text: u.title, keywords: [], tags: [], score: 10, t: Date.now(), offset: 0 },
        { label: who, url: u.url, id: 'upcoming' }, `SOON · ${who}: "${u.title}" ${mins ? `starts in ${mins} min` : 'is starting'}`, 'vip');
    }
  }

  // ---------- auto-start ----------
  async pollWatched() {
    if (this.demo) return;
    for (const w of this.cfg.watch || []) {
      if (!w.url) continue;
      const st = this.watchState.get(w.url) || {};
      const active = st.sid && this.sessions.get(st.sid) && !this.sessions.get(st.sid).endedAt;
      if (active) continue;
      const every = /twitch\.tv/i.test(w.url) ? 55000 : 175000; // YouTube channels change slowly: check every ~3 min
      if (st.checkedAt && Date.now() - st.checkedAt < every) continue;
      const live = await checkLive(w.url, this.cfg.ytdlpArgs || []);
      const wasLive = st.live;
      Object.assign(st, { live, checkedAt: Date.now() });
      this.watchState.set(w.url, st);
      if (live && !wasLive) {
        let note = '';
        if (w.auto !== false) {
          try { st.sid = this.start({ url: w.url, label: w.label }).id; st.error = null; } catch (e) { st.error = e.message; note = ` (couldn't start: ${e.message})`; }
          if (!st.error && !this.getConfig().keys.deepgram) note = ' (recording for clips only: add a Deepgram key under API keys to transcribe)';
        }
        this.onPing({ id: 'live-' + Date.now(), text: `${w.label || w.url} just went live${note}`, keywords: [], tags: [], score: 10, t: Date.now(), offset: 0 }, { label: w.label || w.url, url: w.url, id: 'watch' }, `LIVE · ${w.label || w.url} just went live${note}`, 'vip');
      }
    }
    this.send('stream-status', this.status());
  }

  /** Called for every tweet: a tracked account posting an X live broadcast or Space starts capture. */
  fromTweet(item) {
    if (!this.cfg.autoFromTweets) return;
    const blob = [item.text, ...(item.links || [])].join(' ');
    const m = blob.match(/(?:https?:\/\/)?(?:x|twitter)\.com\/i\/(broadcasts|spaces)\/([A-Za-z0-9]+)/i);
    if (!m) return;
    const url = `https://x.com/i/${m[1]}/${m[2]}`;
    try {
      this.start({ url, label: `@${item.author} ${m[1] === 'spaces' ? 'Space' : 'live'}` });
      this.onPing({ id: 'xlive-' + m[2], text: item.text, keywords: [], tags: [], score: 10, t: Date.now(), offset: 0 }, { label: '@' + item.author, url, id: 'x' }, `LIVE · @${item.author} started a ${m[1] === 'spaces' ? 'Space' : 'live stream'}. Now transcribing`, 'vip');
    } catch (e) { console.error('[stream] auto-start failed:', e.message); }
  }

  // ---------- demo ----------
  runDemo(s) {
    // [speaker, words…] ; a number is a pause in ms (a stutter); chat reaction after the line.
    const script = [
      [0, 'alright chat we are live.'],
      [0, 'hello', 2000, 'solana, how are we doing today'],
      [1, 'yo what is up, so my neighbour just got a goat and he named it Sir Bleats'],
      [0, 'hahaha bro what, Sir Bleats, I am dying', { chat: 'funny' }],
      [1, 'somebody clip that'],
      [0, 'I swear if someone makes a', 1500, 'Sir Bleats coin I am buying it'],
      [1, 'the ticker should be', 1200, 'BLEATS', { chat: 'hype' }],
      [0, 'we have a little penguin in the chat too, hi penguin'],
      [1, 'honestly crypto twitter is going to love this'],
    ];
    this.setStatus(s, 'live (demo)');
    let i = 0;
    const audioNow = () => (Date.now() - s.startedAt) / 1000;
    const playLine = () => {
      if (s.endedAt) return;
      const [sp, ...parts] = script[i % script.length];
      const opts = parts.find(p => p && typeof p === 'object') || {};
      // Flatten to a timeline of words and pauses.
      const steps = [];
      for (const p of parts) {
        if (typeof p === 'number') steps.push({ pause: p });
        else if (typeof p === 'string') for (const w of p.split(' ')) steps.push({ w });
      }
      let chunk = [];
      let k = 0;
      const loudNow = /!|[A-Z]{4,}/.test(parts.join(' ')) ? -8 : -24;
      const next = () => {
        if (s.endedAt) return;
        if (k >= steps.length) {
          if (chunk.length) this.onFinal(s, { words: chunk, start: chunk[0].s, end: chunk[chunk.length - 1].e, loud: { avg: loudNow, peak: loudNow + 2, baseline: -24 } });
          const seg = s.open?.seg;
          if (opts.chat) setTimeout(() => this.onChatReaction(s, { kind: opts.chat, msgs: 60, laughs: opts.chat === 'funny' ? 34 : 4, hype: 30, clip: 1, spam: [{ word: 'bleats', count: 12 }], samples: ['KEKW', 'SIR BLEATS LMAO'] }), 2500);
          if (seg && seg.score >= 4 && !seg.ai) setTimeout(() => this.onVerdict(s, {
            segment_id: seg.id, funny: seg.tags.includes('FUNNY') ? 8 : 3, meme: seg.tags.includes('COINABLE') ? 9 : 5, crypto: seg.tags.includes('CRYPTO') ? 7 : 1,
            ticker_ideas: seg.keywords.filter(x => x.kind === 'coinable').map(x => x.text.replace(/\s+/g, '')).slice(0, 2), why: '(demo) named animal the streamers keep riffing on',
          }), 3200);
          i++;
          s.demoTimer = setTimeout(playLine, 900 + Math.random() * 1600);
          return;
        }
        const st = steps[k++];
        if (st.pause) {
          // Deepgram finalises what was said before a pause after ~300 ms of silence.
          if (chunk.length) setTimeout(() => {
            this.onFinal(s, { words: chunk, start: chunk[0].s, end: chunk[chunk.length - 1].e, loud: { avg: loudNow, peak: loudNow + 2, baseline: -24 } });
            chunk = [];
          }, 300);
          this.levels[s.id] = { db: -48, chat: { perSec: 3, laughPerSec: 0.2 } };
          s.demoTimer = setTimeout(next, st.pause);
          return;
        }
        const t0 = audioNow();
        chunk.push({ w: st.w, s: t0, e: t0 + 0.16, c: 0.97, sp });
        this.levels[s.id] = { db: loudNow + Math.random() * 6 - 3, chat: { perSec: opts.chat ? 14 : 3 + Math.random() * 2, laughPerSec: opts.chat === 'funny' ? 6 : 0.3 } };
        this.onInterim(s, { words: chunk.slice() });
        s.demoTimer = setTimeout(next, 170);
      };
      next();
    };
    s.demoTimer = setTimeout(playLine, 600);
  }

}

// Demo streams have no real video: make a short test-pattern clip so the player can be tried.
function demoClip(out) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=f=330:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out]);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error('ffmpeg failed to make the demo clip'))));
    p.on('error', reject);
  });
}

module.exports = { StreamManager, platformOf, embedFor };
