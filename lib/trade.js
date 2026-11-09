// Quick buy / sell. Elixir only BUILDS the swap transaction; the user's own wallet (Phantom, Solflare,
// Backpack) signs and sends it after they approve. Elixir never sees or stores a private key.
//
// Route: Jupiter (best price across pump.fun, Raydium, Meteora, Orca…) with a priority fee so it lands fast.
// Brand-new pump.fun / LetsBonk coins that Jupiter can't route yet fall back to PumpPortal's
// local-transaction API (PumpPortal charges a fee per trade; the page says when it's used).

const limit = require('./limit');

const SOL = 'So11111111111111111111111111111111111111112';
const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
const PRIORITY = { fast: { level: 'high', maxLamports: 1_000_000, pumpSol: 0.0005 }, turbo: { level: 'veryHigh', maxLamports: 5_000_000, pumpSol: 0.002 } };

function jupBase() {
  // A Jupiter API key (JUPITER_API_KEY) uses the main API; without one, the free lite API.
  return process.env.JUPITER_API_KEY ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
}
const jupHeaders = () => ({ accept: 'application/json', 'content-type': 'application/json', ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}) });

async function jupiter({ wallet, inputMint, outputMint, amount, slippageBps, priority }) {
  const q = new URL(jupBase() + '/quote');
  Object.entries({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' }).forEach(([k, v]) => q.searchParams.set(k, v));
  const qr = await fetch(q, { headers: jupHeaders(), signal: AbortSignal.timeout(8000) });
  const quote = await qr.json().catch(() => null);
  if (!qr.ok || !quote || quote.error || !quote.outAmount) throw Object.assign(new Error(quote?.error || `Jupiter quote failed (${qr.status})`), { noRoute: true });
  const p = PRIORITY[priority] || PRIORITY.turbo;
  const sr = await fetch(jupBase() + '/swap', {
    method: 'POST', headers: jupHeaders(), signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: p.maxLamports, priorityLevel: p.level } } }),
  });
  const sw = await sr.json().catch(() => null);
  if (!sr.ok || !sw?.swapTransaction) throw new Error(sw?.error || `Jupiter swap failed (${sr.status})`);
  return {
    tx: sw.swapTransaction, via: 'Jupiter', outAmount: quote.outAmount, inAmount: quote.inAmount,
    priceImpactPct: Number(quote.priceImpactPct || 0) * 100, route: (quote.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean).join(' → '),
  };
}

async function pumpPortal({ wallet, mint, side, amountSol, sellPct, slippagePct, priority }) {
  const p = PRIORITY[priority] || PRIORITY.turbo;
  const body = side === 'buy'
    ? { publicKey: wallet, action: 'buy', mint, amount: amountSol, denominatedInSol: 'true', slippage: slippagePct, priorityFee: p.pumpSol, pool: 'auto' }
    : { publicKey: wallet, action: 'sell', mint, amount: `${sellPct}%`, denominatedInSol: 'false', slippage: slippagePct, priorityFee: p.pumpSol, pool: 'auto' };
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (r.status !== 200) throw new Error(`PumpPortal: ${(await r.text().catch(() => '')).slice(0, 140) || 'HTTP ' + r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('PumpPortal returned no transaction');
  return { tx: buf.toString('base64'), via: 'PumpPortal (fee per trade)', priceImpactPct: null, route: 'pump.fun' };
}

/** The wallet's raw balance of one token: {raw, decimals, ui}. */
async function tokenBalance(rpcUrl, wallet, mint) {
  const r = await limit.rpcFetch(rpcUrl, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
  let raw = 0n, decimals = 0, ui = 0;
  for (const a of r?.value || []) {
    const t = a.account?.data?.parsed?.info?.tokenAmount;
    if (!t) continue;
    raw += BigInt(t.amount); decimals = t.decimals; ui += Number(t.uiAmount || 0);
  }
  return { raw, decimals, ui };
}

/**
 * Build a buy or sell for the wallet to sign.
 * opts: {wallet, mint, side:'buy'|'sell', amountSol (buy), pct (sell, 1-100), slippagePct, priority, maxSol, maxImpactPct}
 */
async function build(rpcUrl, o) {
  if (!isAddr(o.wallet) || !isAddr(o.mint)) throw new Error('Bad wallet or coin address');
  if (o.mint === SOL) throw new Error('That is SOL itself');
  const slippagePct = Math.max(0.5, Math.min(50, Number(o.slippagePct) || 15));
  const slippageBps = Math.round(slippagePct * 100);
  const priority = o.priority === 'fast' ? 'fast' : 'turbo';
  if (o.side === 'buy') {
    const amountSol = Number(o.amountSol);
    if (!(amountSol > 0)) throw new Error('Set a buy amount');
    if (amountSol > (Number(o.maxSol) || 5)) throw new Error(`${amountSol} SOL is over your max buy (${o.maxSol || 5} SOL). Change it in the wallet menu.`);
    try {
      const j = await jupiter({ wallet: o.wallet, inputMint: SOL, outputMint: o.mint, amount: Math.round(amountSol * 1e9), slippageBps, priority });
      if (j.priceImpactPct > (Number(o.maxImpactPct) || 35)) throw new Error(`Price impact ${j.priceImpactPct.toFixed(1)}% is too high (max ${o.maxImpactPct || 35}%). Buy less.`);
      return j;
    } catch (e) {
      if (!e.noRoute) throw e;
      return pumpPortal({ wallet: o.wallet, mint: o.mint, side: 'buy', amountSol, slippagePct, priority }); // too new for Jupiter
    }
  }
  const pct = Math.max(1, Math.min(100, Number(o.pct) || 100));
  const bal = await tokenBalance(rpcUrl, o.wallet, o.mint);
  if (bal.raw <= 0n) throw new Error('You don\'t hold this coin');
  const amount = pct === 100 ? bal.raw : (bal.raw * BigInt(Math.round(pct * 100))) / 10000n;
  try {
    return await jupiter({ wallet: o.wallet, inputMint: o.mint, outputMint: SOL, amount, slippageBps, priority });
  } catch (e) {
    if (!e.noRoute) throw e;
    return pumpPortal({ wallet: o.wallet, mint: o.mint, side: 'sell', sellPct: pct, slippagePct, priority });
  }
}

async function status(rpcUrl, sig) {
  const r = await limit.rpcFetch(rpcUrl, 'getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
  const s = r?.value?.[0];
  if (!s) return { state: 'pending' };
  if (s.err) return { state: 'failed', err: JSON.stringify(s.err).slice(0, 160) };
  return { state: s.confirmationStatus === 'processed' ? 'processed' : 'confirmed' };
}

async function balance(rpcUrl, wallet) {
  const r = await limit.rpcFetch(rpcUrl, 'getBalance', [wallet]);
  return (r?.value || 0) / 1e9;
}

// ---------- sending (the wallet builds nothing it can't show you: these only read the chain) ----------
const SYSTEM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

async function blockhash(rpcUrl) {
  const r = await limit.rpcFetch(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r?.value?.blockhash, lastValidBlockHeight: r?.value?.lastValidBlockHeight };
}

/** Is this address a normal wallet you can send to? */
async function recipient(rpcUrl, address) {
  if (!isAddr(address)) return { ok: false, why: 'That isn\'t a Solana address.' };
  const r = await limit.rpcFetch(rpcUrl, 'getAccountInfo', [address, { encoding: 'jsonParsed' }]);
  const a = r?.value;
  if (!a) return { ok: true, fresh: true, note: 'This address has never been used. That\'s normal for a brand-new wallet; double-check you copied it right.' };
  if (a.executable) return { ok: false, why: 'That\'s a program, not a wallet. Funds sent there are usually lost.' };
  if (TOKEN_PROGRAMS.has(a.owner)) {
    const t = a.data?.parsed?.type;
    return { ok: false, why: t === 'mint' ? 'That\'s a coin\'s contract address (CA), not a wallet. Funds sent there are lost.' : 'That\'s a token account, not a wallet address. Send to the wallet that owns it instead.' };
  }
  if (a.owner !== SYSTEM) return { ok: false, why: 'That address belongs to a program (a pool, vault or similar), not a person\'s wallet.' };
  return { ok: true, sol: (a.lamports || 0) / 1e9 };
}

/** The wallet's token accounts for one coin (biggest first) + decimals + which token program. */
async function tokenAccounts(rpcUrl, wallet, mint) {
  if (!isAddr(wallet) || !isAddr(mint)) throw new Error('Bad address');
  const r = await limit.rpcFetch(rpcUrl, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
  const accts = (r?.value || []).map(a => ({ address: a.pubkey, program: a.account.owner, amount: a.account.data?.parsed?.info?.tokenAmount?.amount || '0', decimals: a.account.data?.parsed?.info?.tokenAmount?.decimals ?? 0, ui: Number(a.account.data?.parsed?.info?.tokenAmount?.uiAmount || 0) }))
    .filter(a => BigInt(a.amount) > 0n).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  return { accounts: accts };
}

module.exports = { build, status, balance, tokenBalance, blockhash, recipient, tokenAccounts };
