// Optional: Claude looks at a play (tweet text + its image, if any) and suggests likely tickers,
// what the coin image will probably be, and how the play could get vamped and what meta it pairs with.
// One call per play. Needs ANTHROPIC_API_KEY + the SDK; otherwise the rule-based ideas are used.

let Anthropic = null;
try { const mod = require('@anthropic-ai/sdk'); Anthropic = mod.Anthropic || mod.default || mod; } catch {}

const SYSTEM = `You help a Solana memecoin trader react to "Twitter plays": a tweet (or stream moment) that coins get launched about within seconds. Launches that count are on Pump (pump.fun), Float, Bags and Raydium. Most volume currently goes through Pump and Float. Float launches start at about $20k market cap and frequently vamp (relaunch a copy of) coins that started on Pump; traders often fade those Float vamps.

Given the tweet, any coins already deployed for it, and the trader's notes and history, return:
- tickers: the most likely tickers deployers will use, best first. Short, no $ sign, taken from the wording, names or image of the tweet.
- image_ideas: what the coin's image will most likely be (e.g. the exact photo in the tweet, a crop of it, a screenshot of the tweet, a cartoon of the subject).
- vamps: how the play is likely to get vamped if it runs, best first. For each, give the coin name and ticker, the angle (why people would launch it), what existing memecoin or meta it pairs with in narrative terms, and which launchpad it's most likely to appear on. Ignore OTC-desk style side pairings; those are unpopular.
- narrative: one sentence on why this could run, or why it probably won't.
Be concrete and short. Base everything on what is actually in the tweet.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tickers', 'image_ideas', 'vamps', 'narrative'],
  properties: {
    tickers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ticker', 'why'], properties: { ticker: { type: 'string' }, why: { type: 'string' } } } },
    image_ideas: { type: 'array', items: { type: 'string' } },
    vamps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'ticker', 'angle', 'pairs_with', 'launchpad'],
        properties: { name: { type: 'string' }, ticker: { type: 'string' }, angle: { type: 'string' }, pairs_with: { type: 'string' }, launchpad: { type: 'string' } },
      },
    },
    narrative: { type: 'string' },
  },
};

function makeEnricher({ getConfig, getStats }) {
  return async function enrich(play) {
    const cfg = getConfig();
    const key = cfg.keys.anthropic;
    const j = cfg.plays.ai || {};
    if (!Anthropic || !key || j.enabled === false) return null;
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 45000 });
    const stats = getStats();
    const notes = (cfg.plays.notes || []).map(n => '- ' + n).join('\n');
    const history = stats.plays
      ? `Across ${stats.plays} past plays, the top real-volume coin was on: ${Object.entries(stats.padWins).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}. By deploy order it was the ${Object.entries(stats.orderWins).map(([k, v]) => `${k} ${v.pct}%`).join(', ')}. A vamp won ${stats.vampWinPct}% of the time.`
      : 'No play history yet.';
    const deploys = play.deploys.length
      ? play.deploys.map(d => `${d.orderLabel}: $${d.symbol} "${d.name}" on ${d.padLabel}, +${d.afterTweetSec}s after the tweet, mcap ${Math.round(d.marketCap || 0)}, est. real volume ${d.vol.real}`).join('\n')
      : 'None found yet.';
    const content = [];
    for (const url of (play.media || []).slice(0, 2)) if (/^https:\/\//.test(url)) content.push({ type: 'image', source: { type: 'url', url } });
    content.push({ type: 'text', text: `Tweet by @${play.author}:\n"""${play.text}"""\n\nCoins already deployed for it:\n${deploys}\n\nTrader's notes:\n${notes || '(none)'}\n\nHistory: ${history}` });

    const params = {
      model: j.model || 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: j.effort || 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    };
    // If a safety classifier declines, the API retries on the recommended fallback model.
    if (/^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(params.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    let res;
    try {
      res = await client.beta.messages.create(params);
    } catch (e) {
      // A tweet image that can't be fetched shouldn't sink the whole request: retry text-only.
      if (e instanceof Anthropic.BadRequestError && content.length > 1) {
        params.messages = [{ role: 'user', content: content.filter(c => c.type === 'text') }];
        res = await client.beta.messages.create(params);
      } else throw e;
    }
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const out = JSON.parse(text);
    return {
      tickers: out.tickers.slice(0, 6).map(t => ({ ticker: t.ticker.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12), why: t.why })),
      images: out.image_ideas.slice(0, 4),
      vamps: out.vamps.slice(0, 5).map(v => ({ name: v.name, ticker: v.ticker.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12), angle: v.angle, pairsWith: v.pairs_with, launchpad: v.launchpad })),
      narrative: out.narrative,
    };
  };
}

// Claude looks at the candidate images (tweet photo, top deploys, same-name coins, the subject, meme
// templates) and says which one deployers will most likely use, and what the image will look like.
function makeImagePicker({ getConfig }) {
  return async function pick(play, cands) {
    const cfg = getConfig();
    const key = cfg.keys.anthropic;
    const j = cfg.plays.ai || {};
    if (!Anthropic || !key || j.enabled === false) return null;
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 45000 });
    const content = [{ type: 'text', text: `Tweet by @${play.author}:\n"""${play.text}"""\n\nCandidate images follow, numbered from 0.` }];
    cands.forEach((c, i) => {
      content.push({ type: 'text', text: `#${i} — ${c.from}: ${c.label}` });
      content.push({ type: 'image', source: { type: 'url', url: c.image } });
    });
    content.push({ type: 'text', text: 'Which candidate is the coin image most likely to be, or be based on? Describe the image a deployer would most likely use in one sentence.' });
    const params = {
      model: j.model || 'claude-opus-5-5',
      max_tokens: 2000,
      output_config: { effort: j.effort || 'low', format: { type: 'json_schema', schema: {
        type: 'object', additionalProperties: false, required: ['index', 'why', 'description'],
        properties: { index: { type: 'integer', description: 'Number of the most likely candidate' }, why: { type: 'string' }, description: { type: 'string' } },
      } } },
      system: 'You help a Solana memecoin trader predict the image a new memecoin will use. Deployers usually reuse the tweet photo, the image of the first coin that ran, or the most recognisable picture of the subject. Be brief and concrete.',
      messages: [{ role: 'user', content }],
    };
    if (/^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(params.model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === 'refusal') return null;
    const out = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    if (!Number.isInteger(out.index) || out.index < 0 || out.index >= cands.length) return null;
    return { index: out.index, why: out.why, description: out.description };
  };
}

module.exports = { makeEnricher, makeImagePicker };
