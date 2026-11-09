// SOL price for the status bar: live price + 24h change (DexScreener, every minute) and price history
// for the hover chart (CoinGecko, cached; falls back to the minute samples Elixir took itself).

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const state = { price: null, ch24: null, ch1: null, at: null, samples: [] }; // samples: [[ms, price]] (last 7 days)
const histCache = new Map(); // range -> {at, points}
let timer = null;

async function refresh(send) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`, { signal: AbortSignal.timeout(6000) });
    const pairs = await r.json();
    // The deepest SOL/stable pair is the cleanest price.
    const p = (Array.isArray(pairs) ? pairs : []).filter(x => x.baseToken?.address === SOL_MINT && x.priceUsd && /USDC|USDT/i.test(x.quoteToken?.symbol || ''))
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p) return;
    state.price = Number(p.priceUsd);
    state.ch24 = p.priceChange?.h24 ?? null;
    state.ch1 = p.priceChange?.h1 ?? null;
    state.at = Date.now();
    state.samples.push([state.at, state.price]);
    const cut = Date.now() - 7 * 86400000;
    while (state.samples.length && state.samples[0][0] < cut) state.samples.shift();
    send?.('sol-price', snapshot());
  } catch {}
}

function start(send) {
  if (timer) return;
  refresh(send);
  timer = setInterval(() => refresh(send), 60000);
}

const snapshot = () => ({ price: state.price, ch24: state.ch24, ch1: state.ch1, at: state.at });

/** Price history for '1h' | '1d' | '7d' as [[ms, price]]. */
async function history(range = '1d') {
  const days = range === '7d' ? 7 : 1;
  const hit = histCache.get(range);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.points;
  let points = null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=${days}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) points = ((await r.json()).prices || []).filter(p => Array.isArray(p) && p.length === 2);
  } catch {}
  if (!points?.length) points = state.samples.slice(); // our own minute samples
  if (range === '1h') points = points.filter(p => p[0] >= Date.now() - 3600000);
  if (state.price && state.at) points = [...points.filter(p => p[0] < state.at), [state.at, state.price]];
  histCache.set(range, { at: Date.now(), points });
  return points;
}

module.exports = { start, snapshot, history, refresh };
