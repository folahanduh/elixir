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

module.exports = { limiter, ytdlp, dex, rpc };
