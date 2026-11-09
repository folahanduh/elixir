// Tiny concurrency limiter: run(fn) waits for a free slot. Keeps heavy work (yt-dlp processes,
// DexScreener lookups, RPC calls) from all starting at once and freezing the computer.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Shared limits
const ytdlp = limiter(2);   // yt-dlp is a Python program: two at a time is plenty
const dex = limiter(4);     // DexScreener allows ~300 req/min
const rpc = limiter(6);     // Solana RPC getTransaction lookups

// One pace for every Solana RPC call in Elixir (wallet checks, KOL trades, bubble maps, rug checks), so together
// they stay under the provider's limit (Helius free: 10 calls/s). When the RPC still says "too many requests",
// the pace drops and the call is retried; it creeps back up once things are calm.
let target = 8, pace = 8, nextAt = 0;
function setRpcRate(n) { target = Math.max(1, Number(n) || 8); pace = Math.min(pace, target) || target; }
setInterval(() => { if (pace < target) pace = Math.min(target, pace + 0.5); }, 5000).unref?.();
function rpcGate() {
  const now = Date.now(), at = Math.max(now, nextAt);
  nextAt = at + 1000 / pace;
  return at > now ? new Promise(r => setTimeout(r, at - now)) : Promise.resolve();
}
const isRateLimit = (status, j) => status === 429 || j?.error?.code === 429 || j?.error?.code === -32429 || /too many requests|rate.?limit/i.test(j?.error?.message || '');
/** A JSON-RPC call to the Solana RPC: paced, retried with back-off when rate-limited. Returns `result`. */
async function rpcFetch(url, method, params, timeoutMs = 10000) {
  for (let attempt = 0; ; attempt++) {
    await rpcGate();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    let j = null; try { j = await res.json(); } catch {}
    if (isRateLimit(res.status, j)) {
      pace = Math.max(1, pace * 0.6);
      if (attempt >= 4) throw new Error('Solana RPC is rate-limiting (too many requests). Try again in a moment.');
      await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    if (!j) throw new Error(`RPC HTTP ${res.status}`);
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result;
  }
}

module.exports = { limiter, ytdlp, dex, rpc, rpcFetch, setRpcRate };
