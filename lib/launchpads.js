// Works out which launchpad a DexScreener pair came from. Only the launchpads in config count:
// pairs on anything else (OTC-desk style pools, random AMMs) are ignored by the play tracker.
// Matching order: mint address suffix → DexScreener dexId → pair labels.

// `curve` marks pairs still on the bonding curve (anything else on that pad counts as graduated).
const DEFAULTS = {
  pump: { label: 'Pump', color: '#33e6a0', suffixes: ['pump'], dexIds: ['pumpfun', 'pumpswap'], labels: [], startMcap: 4000, curve: { dexIds: ['pumpfun'], labels: [] } },
  float: { label: 'Float', color: '#6cb6ff', suffixes: [], dexIds: ['float'], labels: ['float'], startMcap: 20000, curve: { dexIds: [], labels: [] } },
  bags: { label: 'Bags', color: '#ffcc4d', suffixes: ['BAGS'], dexIds: ['bags'], labels: [], startMcap: null, curve: { dexIds: [], labels: ['DBC'] } },
  raydium: { label: 'Raydium', color: '#c38bff', suffixes: ['bonk'], dexIds: ['raydium'], labels: [], startMcap: null, curve: { dexIds: [], labels: ['LaunchLab'] } },
};

function padsFrom(cfg) {
  const user = (cfg && cfg.plays && cfg.plays.launchpads) || {};
  const out = {};
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...user })) out[k] = { ...(DEFAULTS[k] || {}), ...v, key: k };
  return out;
}

/** @returns {string|null} launchpad key, or null when the pair isn't on a tracked launchpad */
function classify(pair, pads) {
  if (!pair || pair.chainId !== 'solana') return null;
  const addr = pair.baseToken?.address || '';
  const dexId = String(pair.dexId || '').toLowerCase();
  const labels = (pair.labels || []).map(l => String(l).toLowerCase());
  for (const p of Object.values(pads)) if ((p.suffixes || []).some(s => s && addr.endsWith(s))) return p.key;
  for (const p of Object.values(pads)) if ((p.dexIds || []).includes(dexId)) return p.key;
  for (const p of Object.values(pads)) if ((p.labels || []).some(l => labels.includes(String(l).toLowerCase()))) return p.key;
  return null;
}

/** Pairs must be quoted in SOL or USDC; other quote tokens are the unpopular side-pairings. */
function goodQuote(pair) {
  const q = String(pair.quoteToken?.symbol || '').toUpperCase();
  return q === 'SOL' || q === 'WSOL' || q === 'USDC';
}

module.exports = { padsFrom, classify, goodQuote, DEFAULTS };
