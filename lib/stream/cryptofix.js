// Crypto-aware clean-up of speech-to-text. Speech models hear "10 SOL" as "10 sells/souls/sole",
// "pump.fun" as "pump fun", "Solana" as "salana"… These fixes run on every word before anything else
// (highlighting, coin matching, pings) sees the text.

// Words to tell Deepgram to listen for (keyterm prompting, nova-3).
const KEYTERMS = [
  'SOL', 'Solana', 'memecoin', 'memecoins', 'pump.fun', 'PumpSwap', 'Raydium', 'Meteora', 'Jupiter', 'Phantom', 'Axiom', 'GMGN', 'Fomo',
  'Bonk', 'BONK', 'Dogecoin', 'DOGE', 'Pepe', 'WIF', 'ticker', 'CA', 'contract address', 'market cap', 'mcap', 'dev', 'dev wallet',
  'rug', 'rugged', 'rug pull', 'bundle', 'bundled', 'sniper', 'snipers', 'KOL', 'KOLs', 'degen', 'ape', 'aped', 'jeet', 'jeets',
  'bonding curve', 'migrated', 'migration', 'liquidity', 'airdrop', 'whale', 'ATH', 'dip', 'send it', 'bags', 'Bags', 'Float',
  'cook', 'cooking', 'cooked', 'vamp', 'vamped', 'deploy', 'deployed', 'deployer', 'mint', 'X Money', 'Elon', 'Trump', 'Ansem', 'toly',
  // trenches vocabulary and the big words that become coins
  'cabal', 'Nietzschean', 'Odyssean', 'Machiavellian', 'Kafkaesque', 'Sisyphean', 'stoic', 'trenches', 'CTO', 'community takeover',
  'PvP', 'PvE', 'mog', 'mogging', 'copium', 'hopium', 'FUD', 'FOMO', 'LFG', 'WAGMI', 'NGMI', 'GMI', 'ser', 'fren', 'anon', 'based',
  'chad', 'sigma', 'gigabrain', 'midcurve', 'normie', 'LARP', 'larping', 'bagholder', 'exit liquidity', 'volume bot', 'insiders',
  'dev sold', 'sniped', 'smart money', 'narrative', 'meta', 'supercycle', 'god candle', 'liquidation', 'perps', 'longs', 'shorts',
  'Hyperliquid', 'Binance', 'Coinbase', 'pump and dump', 'ponzi', 'cult', 'Wojak', 'Pepe', 'Fartcoin', 'Pnut', 'Moo Deng', 'Chill Guy',
  'Popcat', 'Goatseus', 'SPX6900', 'Murad', 'Cupsey', 'Frank', 'DVCES',
];

const NUM = /^(\d+(\.\d+)?k?|a|half|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|couple|few)$/i;
const SOL_MISHEARD = /^(sells?|souls?|soles?|sole|saul|sal|sow|sold|sols|salt)([.,!?]?)$/i;
const SIMPLE = [
  [/^salana|^solano$|^soulana|^so lana/i, 'Solana'],
  [/^gmg\b|^gm gn$|^gmgen$/i, 'GMGN'],
  [/^axium$|^axion$/i, 'Axiom'],
  [/^jeet's$|^jeats?$/i, 'jeets'],
];

/** Fix a list of Deepgram words ({w, ...}) in place and return it. */
function fixWords(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const bare = String(w.w || '').replace(/[.,!?]$/, '');
    const prev = words[i - 1] ? String(words[i - 1].w).replace(/[.,!?]$/, '') : '';
    // "10 sells", "half a soul", "a couple sole" → SOL (only right after an amount, so "I sold it" is left alone)
    const m = String(w.w || '').match(SOL_MISHEARD);
    if (m && (NUM.test(prev) || /^\d/.test(prev)) && !/^sold$/i.test(bare)) { w.w = 'SOL' + (m[2] || ''); continue; }
    if (m && /^sold$/i.test(bare) && /^\d/.test(prev) && /^(on|in|for|worth|of)$/i.test(String(words[i + 1]?.w || ''))) { w.w = 'SOL' + (m[2] || ''); continue; }
    // "pump fun" → pump.fun
    if (/^pump$/i.test(bare) && /^fun[.,!?]?$/i.test(String(words[i + 1]?.w || ''))) { w.w = 'pump.fun' + (String(words[i + 1].w).match(/[.,!?]$/)?.[0] || ''); words[i + 1].w = ''; continue; }
    for (const [re, to] of SIMPLE) if (re.test(bare)) { w.w = to + (String(w.w).match(/[.,!?]$/)?.[0] || ''); break; }
  }
  return words.filter(w => w.w !== '');
}

/** Same fixes for a plain transcript string. */
function fixText(text) {
  return fixWords(String(text || '').split(/\s+/).filter(Boolean).map(w => ({ w }))).map(x => x.w).join(' ');
}

module.exports = { KEYTERMS: [...new Set(KEYTERMS)], fixWords, fixText };
