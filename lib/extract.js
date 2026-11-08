// Pulls "play" candidates out of a tweet or a chunk of stream transcript.
// A candidate is a word or short phrase that could plausibly become a ticker.

const STOP = new Set(`
a about above after again against all almost also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from
further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's
i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once
only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than
that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those
through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's
which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself
yourselves just like get got gonna wanna yeah yes yep okay ok really actually right now new one two three first last
good great much many make made going go goes went come came see saw know think thought say said says want need way
thing things people time times day days year years today tomorrow yesterday week still even back well also every
lot lots maybe sure look looking take took give gave tell told keep let put use used work working thank thanks
please next big little long high low best better world life man men woman women guy guys someone something anything
nothing everything everyone anyone kind sort part point case fact hand place end show shows start started stop try
trying call called feel feels felt mean means meant seem seems around always never ever though without within upon
via per vs etc lol lmao omg wow haha yeah hey hi hello bro dude amp rt https http www com co
else another whatever watching watched watch saying doing getting making coming taking seeing seen done gone learned
learn talk talking tell telling told looks looked wants wanted needs needed literally honestly basically probably
definitely already soon later ago since ready real true false free full sure yet again once enough quite rather
able guess hope love hate glad sorry funny crazy wild insane huge tiny nice cool bad worse worst top
will shall may might must can could would should
`.split(/\s+/).filter(Boolean));

// Words that crypto twitter says constantly and that are never a fresh play on their own.
const CT_NOISE = new Set(`
crypto coin coins token tokens chart charts pump pumps dump buy sell sold bought price market markets bullish bearish
moon gm gn wagmi ngmi lfg ser fren anon degen degens wallet wallets holders holder chain onchain solana sol eth btc
bitcoin ethereum memecoin memecoins meme memes trade trading trader traders send sending sent ca dev devs launch launched
`.split(/\s+/).filter(Boolean));

const URL_RE = /https?:\/\/\S+/g;
const MENTION_RE = /@[A-Za-z0-9_]{1,15}/g;

function normalize(w) {
  return w.toLowerCase().replace(/^[$#]/, '').replace(/'s$/, '');
}

// Phrases that turn the next words into a coin name: "justice for peanut", "RIP Harambe", "a dog named Biscuit",
// "introducing Grok 5", "meet Moo Deng", "long live the king", "free Pnut".
const TRIGGER = /\b(justice for|rest in peace|r\.?i\.?p\.?|named|called|introducing|meet|say hello to|say hi to|long live|free)\s+((?:@?[A-Za-z0-9$][\w'’-]*)(?:\s+[A-Za-z0-9][\w'’-]*){0,3})/gi;
const SMALL = new Set(['the', 'a', 'an', 'our', 'my', 'his', 'her', 'their', 'this', 'that']);
function patternNames(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TRIGGER)) {
    const trig = m[1].toLowerCase().replace(/\./g, '');
    const words = [];
    for (const w of m[2].split(/\s+/)) {
      const lw = w.toLowerCase().replace(/['’]s$/, '');
      if (!words.length && SMALL.has(lw)) continue;          // "named the …" → skip "the"
      if (words.length && (STOP.has(lw) || SMALL.has(lw))) break; // stop at the first filler word
      words.push(w.replace(/['’]s$/, '').replace(/^@/, ''));
      if (words.length >= 3) break;
    }
    const phrase = words.join(' ');
    if (phrase.length >= 2 && !STOP.has(phrase.toLowerCase())) out.push({ phrase, trigger: trig === 'rest in peace' ? 'rip' : trig });
  }
  return out;
}

/**
 * @param {string} text
 * @param {{watchlist?: string[], ignore?: string[], max?: number}} opts
 * @returns {{word: string, display: string, score: number, reasons: string[], watch: boolean}[]}
 */
function extractCandidates(text, opts = {}) {
  const watch = new Set((opts.watchlist || []).map(normalize));
  const ignore = new Set((opts.ignore || []).map(normalize));
  const max = opts.max ?? 6;
  const found = new Map();
  for (const p of patternNames(text)) {
    const word = normalize(p.phrase);
    if (!word || ignore.has(word)) continue;
    found.set(word, { word, display: p.phrase, score: 9, reasons: ['pattern', 'pattern:' + p.trigger], watch: false });
  }

  const add = (raw, display, pts, reason) => {
    const word = normalize(raw);
    if (!word || word.length < 2 || word.length > 24) return;
    if (ignore.has(word)) return;
    let c = found.get(word);
    if (!c) {
      c = { word, display, score: 0, reasons: [], watch: false };
      found.set(word, c);
    }
    c.score += pts;
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
  };

  const clean = String(text || '').replace(URL_RE, ' ').replace(MENTION_RE, ' ');

  // Explicit tickers and hashtags are the strongest signal.
  for (const m of clean.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g)) add(m[1], '$' + m[1].toUpperCase(), 6, 'cashtag');
  for (const m of clean.matchAll(/#([A-Za-z][A-Za-z0-9_]{1,23})\b/g)) add(m[1], '#' + m[1], 3, 'hashtag');

  // Quoted phrases ("dogefather mode") often become coin names.
  for (const m of clean.matchAll(/["“]([^"”]{3,28})["”]/g)) {
    const phrase = m[1].trim();
    const words = phrase.split(/\s+/);
    if (words.length >= 1 && words.length <= 3 && !words.every(w => STOP.has(w.toLowerCase()))) {
      add(phrase, phrase, 3, 'quoted');
    }
  }

  // Walk word by word, tracking sentence starts so we only reward mid-sentence capitals.
  const tokens = clean.split(/(\s+)/);
  let sentenceStart = true;
  let capRun = [];
  const flushRun = () => {
    if (capRun.length >= 2 && capRun.length <= 3) {
      const phrase = capRun.join(' ');
      add(phrase, phrase, 4, 'name');
    }
    capRun = [];
  };

  for (const tok of tokens) {
    if (!tok.trim()) continue;
    const endsSentence = /[.!?…]["')\]]*$/.test(tok);
    const core = tok.replace(/^[^A-Za-z0-9$#]+|[^A-Za-z0-9']+$/g, '');
    if (!core || core.startsWith('$') || core.startsWith('#')) {
      flushRun();
      sentenceStart = endsSentence || sentenceStart;
      continue;
    }
    const lower = core.toLowerCase();
    const isWord = /^[A-Za-z][A-Za-z0-9']{1,23}$/.test(core);
    if (!isWord) { flushRun(); sentenceStart = endsSentence; continue; }

    const stop = STOP.has(lower) || STOP.has(lower.replace(/'s$/, ''));
    const noise = CT_NOISE.has(lower);
    const allCaps = /^[A-Z]{2,8}$/.test(core) && core !== 'I';
    const capital = /^[A-Z][a-z]/.test(core);

    if (watch.has(normalize(core))) add(core, core, 10, 'watchlist');

    if (!stop && !noise && core.length >= 3) {
      let pts = 1;
      const reasons = [];
      if (allCaps) { pts += 2; reasons.push('caps'); }
      else if (capital && !sentenceStart) { pts += 2; reasons.push('proper'); }
      if (/(.)\1\1/.test(lower) || /[0-9]/.test(lower)) pts += 0; // keep "brrr", "420" neutral
      add(core, allCaps ? core : (capital ? core : lower), pts, reasons[0] || 'word');
    }

    if ((capital || allCaps) && !stop && !noise) {
      capRun.push(core);
      if (/[,:;.!?…)\]"”]$/.test(tok)) flushRun(); // punctuation ends a name
    } else flushRun();

    sentenceStart = endsSentence;
  }
  flushRun();

  // Watchlist phrases (multi-word) are matched against the whole text.
  const lowerText = ' ' + clean.toLowerCase().replace(/[^a-z0-9$#' ]+/g, ' ') + ' ';
  for (const w of watch) {
    if (w.includes(' ') && lowerText.includes(' ' + w + ' ')) add(w, w, 10, 'watchlist');
  }

  for (const c of found.values()) c.watch = c.reasons.includes('watchlist');

  return [...found.values()]
    .sort((a, b) => b.score - a.score || b.word.length - a.word.length)
    .slice(0, max);
}

/** Fast check used on live (interim) speech: only reports watchlist words. */
function watchHits(text, watchlist) {
  const lowerText = ' ' + String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ') + ' ';
  return (watchlist || []).map(normalize).filter(w => w && lowerText.includes(' ' + w + ' '));
}

module.exports = { extractCandidates, watchHits, normalize, patternNames, STOP, CT_NOISE };
