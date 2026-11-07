// Scores each transcript line from a live stream. It looks for:
//   CRYPTO    talk about coins, tokens, pumps, tickers
//   COINABLE  a name that could become a ticker ("call him Sir Gallops", "penguin coin")
//   FUNNY     laughter and reaction phrases ("I'm dying", "clip that")
//   LOUD      the speaker gets loud or shouts (from the real audio level)
//   REPEAT    a word or phrase the speaker keeps coming back to
//   MEMEABLE  animals and objects that memecoins are often named after
//   WATCH     your watchlist
// Twitch chat reactions and the optional Claude judge add more tags later (see manager.js).

const { extractCandidates, normalize, STOP, CT_NOISE } = require('../extract');

const CRYPTO_STRONG = ['memecoin', 'memecoins', 'meme coin', 'meme coins', 'crypto', 'cryptocurrency', 'dogecoin', 'bitcoin',
  'token', 'tokens', 'ticker', 'contract address', 'pump fun', 'pump.fun', 'pumpfun', 'solana', 'airdrop', 'make a coin',
  'launch a coin', 'launch a token', 'make a token', 'shitcoin', 'shitcoins', 'altcoin', 'market cap', 'rug pull', 'x money'];
const CRYPTO_WEAK = ['coin', 'coins', 'moon', 'mooning', 'pump', 'pumping', 'chart', 'wallet', 'bullish', 'bearish', 'hodl',
  'whale', 'degen', 'degens', 'rug', 'rugged', 'lambo', 'doge', 'pepe', 'shib', 'bonk', 'eth', 'ethereum', 'btc', 'xrp', 'nft',
  'nfts', 'blockchain', 'binance', 'coinbase', 'satoshi', 'sats', 'mcap', 'diamond hands', 'paper hands', 'buy the dip',
  'to the moon', 'all time high', 'send it', 'holders', 'dex', 'phantom', 'gmgn', 'axiom'];
const FUNNY_PHRASES = ["i'm dying", 'im dying', 'i am dying', 'i am crying', 'i am weak', "i'm crying", 'im crying', "that's hilarious", 'thats hilarious', 'so funny',
  "that's so funny", 'bro what', 'what the hell', 'what the fuck', 'are you serious', 'oh my god', 'oh my gosh', 'no way',
  'chat is this real', "i can't breathe", 'i cant breathe', 'bruh', "that's crazy", 'thats crazy', "that's insane",
  'yo what', 'wait what', 'stop it', 'shut up', 'dead ass', "i'm weak", 'im weak'];
const CLIP_PHRASES = ['clip that', 'clip it', 'somebody clip', 'someone clip', 'clip this', 'clipped'];
const LAUGH_RE = /\b(?:(?:ha){2,}h?|haha\w*|hehe\w*|lol|lmao|lmfao|rofl)\b|\[(?:laugh|laughter|laughs|laughing)\]|\((?:laugh|laughter|laughs|laughing)\)/gi;
const MEMEABLE = new Set(`dog dogs puppy cat cats kitten frog frogs penguin hamster monkey ape goat horse duck bird fish bear bull pig
rat mouse chicken cow shark whale dolphin owl wolf fox lion tiger capybara raccoon otter sloth hippo seal turtle snail crab
bunny rabbit squirrel giraffe zebra panda koala llama alpaca camel moose deer gorilla chimp parrot pigeon goose eagle
banana pizza burger taco toast cheese potato nugget pickle donut cookie robot alien wizard goblin gremlin cowboy pirate
ninja grandma grandpa baby boss king queen`.split(/\s+/));
const FILLER = new Set(['it', 'him', 'her', 'this', 'that', 'them', 'my', 'his', 'our', 'the', 'a', 'an', 'little', 'new', 'lil', 'big', 'your', 'their', 'is', 'was']);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = list => new RegExp('(?<![a-z0-9])(' + list.map(esc).sort((a, b) => b.length - a.length).join('|') + ')(?![a-z0-9])', 'gi');
const CRYPTO_STRONG_RE = phraseRe(CRYPTO_STRONG);
const CRYPTO_WEAK_RE = phraseRe(CRYPTO_WEAK);
const FUNNY_RE = phraseRe(FUNNY_PHRASES);
const CLIP_RE = phraseRe(CLIP_PHRASES);

const isContent = w => w && w.length >= 3 && !STOP.has(w) && !CT_NOISE.has(w) && !FILLER.has(w);

/** Names that someone gives a thing, or explicitly pairs with "coin"/"token". */
function coinables(text) {
  const out = [];
  const words = text.split(/\s+/).map(w => w.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9']+$/g, '')).filter(Boolean);
  const low = words.map(w => w.toLowerCase());
  for (let i = 0; i < words.length; i++) {
    const w = low[i];
    // "call him X", "named X", "his name is X", "introducing X", "meet X"
    const naming = /^(call|calls|called|calling|name|named|names|naming|nickname|nicknamed|introducing|meet)$/.test(w)
      || (w === 'is' && low[i - 1] === 'name');
    if (naming) {
      let j = i + 1;
      while (j < words.length && FILLER.has(low[j]) && j < i + 4) j++;
      const name = [];
      while (j < words.length && name.length < 2 && !STOP.has(low[j]) && !CT_NOISE.has(low[j]) && /^[A-Za-z][\w']+$/.test(words[j])) {
        name.push(words[j]);
        if (!/^[A-Z]/.test(words[j + 1] || '')) break; // only keep going for Capitalised Multi Word names
        j++;
      }
      if (name.length) out.push({ text: name.join(' '), why: `named “${name.join(' ')}”`, pts: 7 });
    }
    // "penguin coin", "sir gallops token", "dollar sign penguin", "ticker penguin"
    if ((w === 'coin' || w === 'token') && i > 0) {
      const prev = low[i - 1];
      if (isContent(prev) && !['meme', 'bit', 'doge', 'flip', 'gold', 'silver', 'this', 'that', 'shit'].includes(prev)) {
        const two = i > 1 && isContent(low[i - 2]) ? words[i - 2] + ' ' + words[i - 1] : words[i - 1];
        out.push({ text: two, why: `said “${two} ${w}”`, pts: 8 });
      }
    }
    if ((w === 'ticker' || (w === 'sign' && low[i - 1] === 'dollar')) && words[i + 1]) {
      let j = i + 1;
      if (low[j] === 'is' || low[j] === 'should') j++;
      if (low[j] === 'be') j++;
      if (words[j] && isContent(low[j])) out.push({ text: words[j], why: `ticker “${words[j]}”`, pts: 9 });
    }
  }
  return out;
}

class MomentAnalyzer {
  constructor(opts = {}) {
    this.opts = opts;
    this.history = []; // [{t, grams:Set}]
  }

  analyze(seg, { watchlist = [], ignore = [] } = {}, key = null) {
    const text = seg.text;
    const low = ' ' + text.toLowerCase() + ' ';
    const tags = new Set();
    const keywords = []; // {text, kind}
    const reasons = [];
    let score = 0;
    const kw = (t, kind) => { if (!keywords.some(k => k.text.toLowerCase() === t.toLowerCase())) keywords.push({ text: t, kind }); };

    // Watchlist
    const lowClean = ' ' + text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ') + ' ';
    for (const w of watchlist.map(normalize)) {
      if (w && lowClean.includes(' ' + w + ' ')) { tags.add('WATCH'); score += 10; kw(w, 'watch'); reasons.push(`watchlist “${w}”`); }
    }

    // Crypto talk
    let strong = 0, weak = 0;
    for (const m of text.matchAll(CRYPTO_STRONG_RE)) { strong++; kw(m[1], 'crypto'); }
    for (const m of text.matchAll(CRYPTO_WEAK_RE)) { weak++; kw(m[1], 'crypto'); }
    if (strong || weak >= 2) {
      tags.add('CRYPTO');
      score += Math.min(8, strong * 5 + weak * 2);
      reasons.push('crypto talk');
    } else if (weak) score += 1;

    // Names that could become a ticker
    for (const c of coinables(text)) {
      if (ignore.map(normalize).includes(normalize(c.text))) continue;
      tags.add('COINABLE');
      score += c.pts;
      kw(c.text, 'coinable');
      reasons.push(c.why);
    }

    // Funny / clip-worthy
    const laughs = (text.match(LAUGH_RE) || []).length;
    const funny = [...text.matchAll(FUNNY_RE)].map(m => m[1]);
    const clip = [...text.matchAll(CLIP_RE)].map(m => m[1]);
    if (laughs || funny.length || clip.length) {
      tags.add('FUNNY');
      score += Math.min(8, laughs * 3 + funny.length * 3 + clip.length * 6);
      funny.concat(clip).forEach(f => kw(f, 'funny'));
      reasons.push(clip.length ? 'asked for a clip' : laughs ? 'laughing' : 'reaction');
    }

    // Loud / shouting, measured from the real audio
    if (seg.loud && seg.loud.baseline != null) {
      const over = seg.loud.peak - seg.loud.baseline;
      if (over >= 12) { tags.add('LOUD'); score += 4; reasons.push(`shouting (+${Math.round(over)} dB)`); }
      else if (over >= 7) { tags.add('LOUD'); score += 2; reasons.push(`louder (+${Math.round(over)} dB)`); }
    }
    if (/!{2,}/.test(text) || /\b[A-Z]{4,}\b/.test(text.replace(/\b(?:BTC|ETH|NFT|USA|LMAO|LMFAO)\b/g, ''))) score += 1;

    // Ticker-shaped words and memeable nouns
    const cands = extractCandidates(text, { watchlist, ignore, max: 8 });
    for (const c of cands) {
      if (MEMEABLE.has(c.word) || MEMEABLE.has(c.word.replace(/s$/, ''))) {
        tags.add('MEMEABLE'); score += 2; kw(c.display.replace(/^[$#]/, ''), 'meme');
      } else if (c.score >= 3 && !c.reasons.includes('watchlist')) {
        kw(c.display.replace(/^[$#]/, ''), 'name');
        score += 1;
      }
    }

    // Catchphrases: a content word or 2-3 word phrase repeated 3+ times in 5 minutes.
    const toks = text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const grams = new Set();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const g = toks.slice(i, i + n);
        if (!g.every(isContent)) continue; // "sir bleats" yes, "boss is impossible" no
        if (n === 1 && !(MEMEABLE.has(g[0]) || cands.some(c => c.word === g[0] && c.score >= 2))) continue;
        grams.add(g.join(' '));
      }
    }
    const now = seg.t || Date.now();
    this.history = this.history.filter(h => now - h.t < 5 * 60000 && (key == null || h.key !== key));
    for (const g of grams) {
      const n = this.history.filter(h => h.grams.has(g)).length + 1;
      const covered = !g.includes(' ') && [...grams].some(o => o.includes(' ') && o.split(' ').includes(g));
      if ((n === 3 || n === 6) && !covered) {
        tags.add('REPEAT'); score += 4; kw(g, 'repeat');
        reasons.push(`keeps saying “${g}” (${n}× in 5m)`);
      }
    }
    this.history.push({ t: now, grams, key });

    // Drop single words already covered by a longer keyword ("Gallops" inside "Sir Gallops").
    for (let i = keywords.length - 1; i >= 0; i--) {
      const k = keywords[i].text.toLowerCase();
      if (!k.includes(' ') && keywords.some(o => o !== keywords[i] && o.text.includes(' ') && o.text.toLowerCase().split(' ').includes(k))) keywords.splice(i, 1);
    }

    // Coin-check targets: coinable names first, then watch words, then strong names.
    const coinCheck = [
      ...keywords.filter(k => k.kind === 'coinable'),
      ...keywords.filter(k => k.kind === 'watch' || k.kind === 'repeat' || k.kind === 'meme'),
      ...keywords.filter(k => k.kind === 'name'),
    ].map(k => k.text).filter((v, i, a) => a.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i).slice(0, 3);

    return { score, tags: [...tags], keywords, reasons, coinCheck };
  }
}

module.exports = { MomentAnalyzer, coinables };
