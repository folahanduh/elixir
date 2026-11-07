// Reads a Twitch channel's chat anonymously (no login) and spots reaction spikes:
//   funny  chat floods with KEKW / LUL / OMEGALUL / LMAO / 💀 ...
//   hype   message rate jumps well above the channel's normal pace
//   clip   several people ask for a clip
// It also reports the word chat is spamming. That word is often the meme.

const { EventEmitter } = require('events');
const { STOP } = require('../extract');

const LAUGH = /\b(KEKW|KEK|LUL|LULW|OMEGALUL|ICANT|LMAO+|LMFAO|LOL+|ROFL|PepeLaugh|forsenLUL|KEKL|xd+|HA(HA)+H?|haha\w*|dead+|im dead|crying)\b|😂|🤣|💀|😭/i;
const HYPE = /\b(Pog|PogChamp|POGGERS|PagMan|PogU|LETS GO+|LFG|W+|HUGE|NO WAY|WTF|monkaS|EZ)\b|🔥|🚀/i;
const CLIP = /\bclip\s*(it|that|this)?\b/i;
const EMOTE_LIKE = /^(KEKW|KEK|LUL|LULW|OMEGALUL|ICANT|PepeLaugh|Pog|PogChamp|POGGERS|PagMan|PogU|monkaS|Kappa|EZ|W|L|LOL|LMAO|XD|HAHA\w*|\d+)$/i;

class TwitchChat extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.buckets = [];     // per-second {t, msgs, laughs, hype, clip, words:Map}
    this.baseMsgs = null;  // EMA msgs/sec
    this.baseLaugh = null;
    this.cool = { funny: 0, hype: 0, clip: 0 };
    this.closed = false;
    this.retry = 0;
    this.connect();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
      ws.send('JOIN #' + this.channel);
      this.emit('status', 'chat connected');
    };
    ws.onmessage = ev => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const m = line.match(/ PRIVMSG #\S+ :(.*)$/);
        if (m) this.onMsg(m[1]);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.retry++));
    };
  }

  bucket() {
    const t = Math.floor(Date.now() / 1000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.t !== t) { b = { t, msgs: 0, laughs: 0, hype: 0, clip: 0, words: new Map(), samples: [] }; this.buckets.push(b); }
    return b;
  }

  onMsg(text) {
    const b = this.bucket();
    b.msgs++;
    if (LAUGH.test(text)) b.laughs++;
    if (HYPE.test(text)) b.hype++;
    if (CLIP.test(text)) b.clip++;
    if (b.samples.length < 6) b.samples.push(text.slice(0, 80));
    const seen = new Set();
    for (const w of text.split(/\s+/)) {
      const k = w.replace(/[^\w']/g, '');
      if (k.length < 3 || EMOTE_LIKE.test(k) || seen.has(k.toLowerCase())) continue;
      seen.add(k.toLowerCase());
      b.words.set(k.toLowerCase(), (b.words.get(k.toLowerCase()) || 0) + 1);
    }
  }

  tick() {
    const now = Math.floor(Date.now() / 1000);
    this.buckets = this.buckets.filter(b => now - b.t < 120);
    const win = this.buckets.filter(b => now - b.t < 6);
    const sum = k => win.reduce((a, b) => a + b[k], 0);
    const msgs = sum('msgs'), laughs = sum('laughs'), hype = sum('hype'), clip = sum('clip');
    const perSec = msgs / 6, laughPerSec = laughs / 6;

    // Slow-moving baseline of normal chat pace.
    const a = 0.02;
    this.baseMsgs = this.baseMsgs == null ? perSec : this.baseMsgs * (1 - a) + perSec * a;
    this.baseLaugh = this.baseLaugh == null ? laughPerSec : this.baseLaugh * (1 - a) + laughPerSec * a;
    this.emit('rate', { perSec: Math.round(perSec * 10) / 10, laughPerSec: Math.round(laughPerSec * 10) / 10 });

    const words = new Map();
    for (const b of win) for (const [w, n] of b.words) words.set(w, (words.get(w) || 0) + n);
    const spam = [...words].filter(([w, n]) => n >= Math.max(4, msgs * 0.3) && !STOP.has(w)).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([w, n]) => ({ word: w, count: n }));
    const samples = win.flatMap(b => b.samples).slice(-6);
    const fire = (kind, extra) => {
      if (Date.now() - this.cool[kind] < 20000) return;
      this.cool[kind] = Date.now();
      this.emit('reaction', { kind, msgs, laughs, hype, clip, spam, samples, ...extra });
    };
    if (laughs >= Math.max(5, this.baseLaugh * 6 * 4) && laughs / Math.max(1, msgs) >= 0.25) fire('funny');
    if (clip >= 3) fire('clip');
    if (msgs >= Math.max(20, this.baseMsgs * 6 * 3) && hype / Math.max(1, msgs) >= 0.2) fire('hype');
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    try { this.ws?.close(); } catch {}
  }
}

/** Pulls the channel name out of a Twitch URL, or returns null. */
function twitchChannel(url) {
  const m = String(url || '').match(/twitch\.tv\/(?!videos\/)([A-Za-z0-9_]{3,25})/i);
  return m ? m[1] : null;
}

module.exports = { TwitchChat, twitchChannel };
