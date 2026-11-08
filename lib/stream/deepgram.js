const { fixWords, fixText } = require('./cryptofix');
// Live speech-to-text over Deepgram's streaming WebSocket. You get word-level timestamps,
// interim words within roughly 300 ms, and finished lines at each pause.
// Input: 16 kHz mono 16-bit PCM buffers. Uses Node's built-in WebSocket (Node 22+).

const { EventEmitter } = require('events');

class DeepgramStream extends EventEmitter {
  constructor({ apiKey, language = 'en', keyterms = [], model = 'nova-3', diarize = true }) {
    super();
    this.apiKey = apiKey;
    this.language = language;
    this.keyterms = keyterms;
    this.model = model;
    this.diarize = diarize;
    this.ws = null;
    this.closed = false;
    this.sentBytes = 0;       // total audio sent over all connections
    this.connBaseSec = 0;     // audio seconds sent before the current connection opened
    this.pending = [];        // audio queued while (re)connecting
    this.lastSend = 0;
    this.retry = 0;
    this.connect();
    this.keepAlive = setInterval(() => {
      if (this.ws?.readyState === 1 && Date.now() - this.lastSend > 4000) this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 4000);
  }

  url() {
    const p = new URLSearchParams({
      model: this.model, language: this.language, encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300',
      utterance_end_ms: '1000', vad_events: 'true',
    });
    // Speaker separation: every word comes back tagged with a speaker number.
    if (this.diarize) p.set('diarize', 'true');
    // Keyterm prompting makes the model hear your watchlist and coin names correctly (English, nova-3).
    if (this.model.startsWith('nova-3')) for (const k of this.keyterms.slice(0, 160)) p.append('keyterm', k); // Deepgram allows ~500 tokens of keyterms
    return 'wss://api.deepgram.com/v1/listen?' + p;
  }

  connect() {
    if (this.closed) return;
    this.connBaseSec = this.sentBytes / 32000;
    const ws = new WebSocket(this.url(), ['token', this.apiKey]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.emit('status', 'listening');
      for (const b of this.pending.splice(0)) this.send(b);
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt?.transcript) return;
        const base = this.connBaseSec;
        const words = fixWords((alt.words || []).map(w => ({
          w: w.punctuated_word || w.word, s: base + w.start, e: base + w.end, c: w.confidence, sp: Number.isInteger(w.speaker) ? w.speaker : null,
        })));
        const start = base + (msg.start || 0);
        const end = start + (msg.duration || 0);
        this.emit(msg.is_final ? 'final' : 'interim', { text: fixText(alt.transcript), words, start, end, confidence: alt.confidence });
      } else if (msg.type === 'SpeechStarted') {
        this.emit('speech');
      }
    };
    ws.onerror = () => {};
    ws.onclose = ev => {
      if (this.closed) return;
      const authFail = ev.code === 1008 || /auth|401|credential/i.test(ev.reason || '');
      this.emit('status', authFail ? 'error: Deepgram rejected the API key' : `reconnecting (${ev.code})`);
      if (authFail) return;
      const wait = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  send(buf) {
    if (this.closed) return;
    if (this.ws?.readyState === 1) {
      this.ws.send(buf);
      this.sentBytes += buf.length;
      this.lastSend = Date.now();
    } else {
      this.pending.push(buf);
      if (this.pending.length > 200) this.pending.shift(); // keep at most ~20 s while offline
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAlive);
    try { this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
    setTimeout(() => { try { this.ws?.close(); } catch {} }, 1500);
  }
}

module.exports = { DeepgramStream };
