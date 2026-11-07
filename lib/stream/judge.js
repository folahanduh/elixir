// Optional: Claude reads the transcript in small batches and rates how funny and how
// meme/coin-worthy each line is, plus ticker ideas. Keyword rules can't tell a real joke
// from someone just saying "haha", so this is what makes the FUNNY tag more reliable.
// Needs ANTHROPIC_API_KEY and the SDK (npm install). Turns itself off if either is missing.

const { EventEmitter } = require('events');

let Anthropic = null;
try {
  const mod = require('@anthropic-ai/sdk');
  Anthropic = mod.Anthropic || mod.default || mod;
} catch { /* SDK not installed: judge stays disabled */ }

const SYSTEM = `You watch live streams for a memecoin trader. Memecoins are often launched within minutes of a big streamer or public figure saying something funny, naming something, or riffing on a phrase. The trader wants to be pinged about exactly those moments, and not about ordinary chatter.

You get recent transcript lines from one live stream (speech-to-text, so expect small errors and no punctuation). Some lines carry notes such as "chat laughing" when the stream's live chat reacted. For each NEW line, score it:
- funny (0-10): is this a genuinely funny, absurd or viral-clip moment? Laughter words alone are not enough. Chat reacting is strong evidence.
- meme (0-10): could this become a memecoin narrative? High scores go to: something or someone being given a name, a new nickname, a catchy or repeated catchphrase, an animal or object at the centre of a funny moment, the speaker suggesting a coin or ticker, or a reference to an existing meme.
- crypto (0-10): how directly the line is about crypto, coins, tokens or markets.

Be strict: most lines are ordinary and should score 0-3. Use 7+ only when you would actually want the trader's phone to buzz. Only include lines that score 4 or more on at least one of the three. For each line you include, give up to 3 short ticker_ideas (single words or very short names, no $ sign, taken from what was said) and a "why" of at most 15 words. Return an empty list when nothing stands out.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moments'],
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segment_id', 'funny', 'meme', 'crypto', 'ticker_ideas', 'why'],
        properties: {
          segment_id: { type: 'string', description: 'The id in square brackets of the line being scored' },
          funny: { type: 'integer', description: '0-10' },
          meme: { type: 'integer', description: '0-10' },
          crypto: { type: 'integer', description: '0-10' },
          ticker_ideas: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
        },
      },
    },
  },
};

const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };

class StreamJudge extends EventEmitter {
  constructor({ apiKey, model, effort = 'low', everySeconds = 8, label }) {
    super();
    this.enabled = Boolean(Anthropic && apiKey);
    this.reason = !Anthropic ? 'SDK not installed (run npm install)' : !apiKey ? 'no ANTHROPIC_API_KEY' : '';
    if (!this.enabled) return;
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30000 });
    this.model = model;
    this.effort = effort;
    this.label = label;
    this.queue = [];
    this.context = [];
    this.busy = false;
    this.timer = setInterval(() => this.flush(), everySeconds * 1000);
  }

  add(seg) { if (this.enabled) this.queue.push(seg); }

  async flush() {
    if (this.busy || !this.queue.length) return;
    const batch = this.queue.splice(0, 25);
    const words = batch.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    if (words < 6) { this.queue.unshift(...batch); return; }
    this.busy = true;
    const line = s => `[${s.id}] (${fmt(s.offset)}) ${s.text}${s.notes?.length ? '   <' + s.notes.join(', ') + '>' : ''}`;
    const content = `Stream: ${this.label}\n\nEarlier lines (context only, already scored):\n${this.context.map(line).join('\n') || '(none)'}\n\nNEW lines to score:\n${batch.map(line).join('\n')}`;
    try {
      const params = {
        model: this.model,
        max_tokens: 4000,
        output_config: { effort: this.effort, format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      };
      // Server-side fallback: if a safety classifier declines, the API retries on the recommended model.
      if (/^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(this.model)) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      const res = await this.client.beta.messages.create(params);
      if (res.stop_reason === 'refusal') throw new Error('declined');
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const parsed = JSON.parse(text);
      const ids = new Set(batch.map(s => s.id));
      for (const m of parsed.moments || []) if (ids.has(m.segment_id)) this.emit('verdict', m);
      this.emit('status', 'ok');
    } catch (e) {
      let msg = e.message;
      if (Anthropic && e instanceof Anthropic.AuthenticationError) { msg = 'Anthropic API key rejected'; this.stop(); }
      else if (Anthropic && e instanceof Anthropic.RateLimitError) msg = 'rate limited, will retry';
      this.emit('status', 'error: ' + msg);
    } finally {
      this.context = this.context.concat(batch).slice(-20);
      this.busy = false;
    }
  }

  stop() { clearInterval(this.timer); this.enabled = false; }
}

module.exports = { StreamJudge };
