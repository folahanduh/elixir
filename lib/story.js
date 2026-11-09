// "Why is this coin moving, and is the story real?"
// Pulls the trail of tweets around a coin and judges the narrative:
//   • origin: the tweet/stream moment Elixir caught as a play that this coin was launched for
//   • feed: tweets from your tracked accounts that mention its CA, $TICKER or name (in memory, instant)
//   • x: a live X search (twitterapi.io key) for its CA, $TICKER and plain name, most popular first
// Then: REAL (a real account talked about the subject before the coin existed, or real people discuss the
// subject itself), MANUFACTURED (the coin came first and nearly every mention is a $TICKER / CA post from
// small accounts), or UNCLEAR. Every reason quotes the evidence.

const { tioFetch } = require('./sources');

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMON = new Set('the and for you are was not but all any can had her one our out day get has him his how man new now old see two way who boy did its let put say she too use dog cat sun moon coin token pump doge pepe based king the ai'.split(' '));

/** Does this text talk about the coin? CA, $TICKER, or its (distinctive) name. */
function mentionMatcher(mint, sym, name) {
  const res = [];
  if (sym) res.push(new RegExp(`\\$${esc(sym)}\\b`, 'i'));
  if (name && name.length >= 4 && !COMMON.has(name.toLowerCase())) res.push(new RegExp(`(^|[^A-Za-z0-9])${esc(name).replace(/\s+/g, '\\s+')}([^A-Za-z0-9]|$)`, 'i'));
  return text => { const t = String(text || ''); return t.includes(mint) || res.some(r => r.test(t)); };
}
/** A promo post names the ticker / CA / trading links; an organic one talks about the thing itself. */
function isPromo(text, mint, sym) {
  const t = String(text || '');
  return t.includes(mint) || (sym && new RegExp(`\\$${esc(sym)}\\b`, 'i').test(t)) || /pump\.fun|dexscreener|axiom\.trade|gmgn\.ai|photon|bullx|\bCA\b|contract/i.test(t);
}

/** Instant part: what Elixir already has in memory. */
function local({ mint, sym, name, launch }, ctx) {
  const matches = mentionMatcher(mint, sym, name);
  let origin = null;
  for (const p of ctx.plays?.() || []) {
    const d = (p.deploys || []).find(x => x.address === mint);
    if (!d) continue;
    origin = { author: p.author, source: p.source, text: String(p.text || '').slice(0, 280), url: p.url || null, at: p.tweetAt, afterSec: d.afterTweetSec ?? (launch && p.tweetAt ? Math.round((launch - p.tweetAt) / 1000) : null) };
    break;
  }
  const feed = (ctx.items?.() || []).filter(it => it.source !== 'kol' && matches(it.text)).slice(-40).map(it => ({
    author: it.author, text: String(it.text || '').slice(0, 280), url: it.url || null, at: it.createdAt || it.receivedAt, vip: Boolean(it.vip), tracked: true,
    followers: null, verified: null, promo: isPromo(it.text, mint, sym), via: it.source === 'stream' ? 'stream' : 'feed',
  }));
  // What happened on-chain: your tracked KOL wallets trading it (with the market cap at the time)
  const chain = [];
  const byKol = new Map();
  for (const e of ctx.kols?.events || []) {
    if (e.mint !== mint || (e.side !== 'buy' && e.side !== 'sell')) continue;
    const at = e.blockTime || e.seenAt || null;
    chain.push({ author: e.kol, text: `${e.side === 'buy' ? 'bought' : 'sold'} ${Number(e.sol || 0).toFixed(1)} SOL${e.marketCap ? ` at ${usdS(e.marketCap)} mc` : ''}`, at, via: 'chain', side: e.side, sol: Number(e.sol) || 0, mc: e.marketCap || null, url: e.links?.solscan || null, promo: false });
    const k = byKol.get(e.kol) || { kol: e.kol, bought: 0, sold: 0, boughtSol: 0, soldSol: 0, lastSellAt: 0, lastSellMc: null };
    if (e.side === 'buy') { k.bought += Number(e.tokenAmount) || 0; k.boughtSol += Number(e.sol) || 0; }
    else { k.sold += Number(e.tokenAmount) || 0; k.soldSol += Number(e.sol) || 0; if ((at || 0) >= k.lastSellAt) { k.lastSellAt = at || 0; k.lastSellMc = e.marketCap || null; } }
    byKol.set(e.kol, k);
  }
  for (const e of ctx.whales?.events || []) {
    if (e.mint !== mint || !e.sol) continue;
    chain.push({ author: e.name || e.label || (e.from ? e.from.slice(0, 4) + '…' : 'whale'), text: `${e.kind === 'volume' ? 'whales put' : 'moved'} ${Number(e.sol).toFixed(0)} SOL`, at: e.at || null, via: 'chain', side: 'buy', sol: Number(e.sol) || 0, mc: null, url: e.links?.tx || null, promo: false });
  }
  return { origin, feed, chain, kols: [...byKol.values()] };
}
const usdS = n => (n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));

const xCache = new Map();
const WHY = {
  402: 'your twitterapi.io account is out of credits (HTTP 402). Top it up at twitterapi.io, or add a second key as TWITTERAPI_IO_KEY_2',
  401: 'twitterapi.io rejected the key (HTTP 401). Check it under API keys',
  403: 'twitterapi.io refused the request (HTTP 403)',
  429: 'twitterapi.io is rate-limiting (HTTP 429). It will work again in a moment',
};
/**
 * Live X search: CA, $TICKER and the plain name; popular first. Tries each twitterapi.io key (one request each,
 * stops at the first that works), then the official X API if you have a bearer token.
 * Returns {tweets, ok, note}: ok=false means X couldn't be searched (never "no tweets").
 */
async function xSearch(meta, keys, bearers = []) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length && !bearers.length) return { tweets: [], ok: false, note: 'no-key' };
  const ck = meta.mint, hit = xCache.get(ck);
  if (hit && Date.now() - hit.at < (hit.r.ok ? 5 * 60000 : 20000)) return hit.r;
  let r = null, why = null;
  for (const key of list) {
    r = await tioSearch(meta, key);
    if (r.ok) break;
    why = why || r.why;
  }
  if (!r?.ok) for (const b of bearers) { const x = await xApiSearch(meta, b); if (x.ok) { r = x; break; } }
  if (!r?.ok) r = { tweets: [], ok: false, note: `Couldn't search X: ${why || r?.why || 'no answer'}` };
  xCache.set(ck, { at: Date.now(), r });
  if (xCache.size > 300) xCache.delete(xCache.keys().next().value);
  return r;
}
function queryParts({ mint, sym, name }) {
  const parts = [mint];
  if (sym && sym.length >= 2) parts.push('$' + sym);
  if (name && name.length >= 4 && name.toLowerCase() !== String(sym || '').toLowerCase() && !COMMON.has(name.toLowerCase())) parts.push(`"${name.replace(/"/g, '')}"`);
  return parts;
}
/** The official X API (recent search, last 7 days). Needs a paid tier; free tokens are refused, quietly. */
async function xApiSearch(meta, bearer) {
  try {
    const q = `(${queryParts(meta).join(' OR ')}) -is:retweet`;
    const u = `https://api.twitter.com/2/tweets/search/recent?max_results=20&query=${encodeURIComponent(q)}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,public_metrics,verified`;
    const res = await fetch(u, { headers: { authorization: 'Bearer ' + bearer }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, why: `the X API answered HTTP ${res.status}` };
    const body = await res.json();
    const users = new Map((body.includes?.users || []).map(u2 => [u2.id, u2]));
    return { ok: true, tweets: (body.data || []).map(t => {
      const u2 = users.get(t.author_id) || {};
      return { author: u2.username || 'unknown', followers: u2.public_metrics?.followers_count || 0, verified: Boolean(u2.verified), text: String(t.text || '').slice(0, 280),
        url: `https://x.com/${u2.username || 'i'}/status/${t.id}`, at: Date.parse(t.created_at) || null, likes: t.public_metrics?.like_count || 0, views: 0, promo: isPromo(t.text, meta.mint, meta.sym), via: 'x' };
    }) };
  } catch (e) { return { ok: false, why: 'the X API: ' + e.message }; }
}
async function tioSearch({ mint, sym, name, launch }, key) {
  const parts = queryParts({ mint, sym, name });
  const since = new Date((launch || Date.now()) - 24 * 3600000).toISOString().replace('T', '_').replace(/\.\d+Z$/, '_UTC');
  const q = `(${parts.join(' OR ')}) since:${since}`;
  let r = { tweets: [], ok: false };
  try {
    const res = await tioFetch('https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Top&query=' + encodeURIComponent(q), key);
    if (!res.ok) r = { tweets: [], ok: false, why: WHY[res.status] || `twitterapi.io answered HTTP ${res.status}` };
    else {
      const body = await res.json();
      const list = body.tweets || body.data?.tweets || [];
      r = { ok: true, tweets: list.slice(0, 20).map(t => {
        const text = String(t.text || '');
        return {
          author: t.author?.userName || 'unknown', followers: Number(t.author?.followers ?? t.author?.followersCount ?? 0) || 0, verified: Boolean(t.author?.isBlueVerified || t.author?.isVerified),
          text: text.slice(0, 280), url: t.url || `https://x.com/${t.author?.userName}/status/${t.id}`, at: Date.parse(t.createdAt) || null,
          likes: t.likeCount || 0, views: t.viewCount || 0, promo: isPromo(text, mint, sym), via: 'x',
        };
      }) };
    }
  } catch (e) { r = { tweets: [], ok: false, why: 'twitterapi.io: ' + e.message }; }
  return r;
}

const fmtAgo = min => (Math.abs(min) < 60 ? `${Math.round(Math.abs(min))}m` : Math.abs(min) < 2880 ? `${(Math.abs(min) / 60).toFixed(1)}h` : `${Math.round(Math.abs(min) / 1440)}d`);
const big = t => t.verified || t.followers >= 10000 || t.vip;

/** Put it together and judge the narrative. */
function assemble({ mint, sym, launch, mcNow, ch1, dev, bundle }, loc, xs, ns) {
  const seen = new Set();
  const all = [...loc.feed, ...(xs?.tweets || [])].filter(t => { const k = t.url || t.text; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const t of all) t.vsLaunchMin = launch && t.at ? Math.round((t.at - launch) / 60000) : null; // negative = before launch
  all.sort((a, b) => (a.at || 0) - (b.at || 0));
  const before = all.filter(t => t.vsLaunchMin != null && t.vsLaunchMin < -1);
  const organic = all.filter(t => !t.promo);
  const promoShare = all.length ? (all.length - organic.length) / all.length : 0;
  const reasons = [];
  let verdict = 'unclear';
  // where it started: a tweet/stream Elixir caught, or else the tweet the coin itself links to
  const lk = ns?.linked || null;
  const o = loc.origin || (lk ? { author: lk.author, source: 'link', text: lk.text, url: lk.url, at: lk.at, afterSec: launch && lk.at ? Math.round((launch - lk.at) / 1000) : null } : null);
  const searched = Boolean(xs && xs.ok);
  const searchFailed = Boolean(xs && !xs.ok && xs.note && xs.note !== 'no-key');
  const news = (ns?.items || []).map(n => ({ ...n, vsLaunchMin: launch && n.at ? Math.round((n.at - launch) / 60000) : null }));
  const newsOk = Boolean(ns && ns.ok);
  // ---- on-chain: who sold out, and did it come back? ----
  const chainNotes = [];
  for (const k of loc.kols || []) {
    if (!k.soldSol) continue;
    const allOut = k.bought > 0 ? k.sold >= k.bought * 0.95 : true;
    const back = k.lastSellMc && mcNow ? (mcNow / k.lastSellMc - 1) * 100 : null;
    let t = `${k.kol} ${allOut ? 'sold the whole bag' : 'sold part of his bag'} (${k.soldSol.toFixed(1)} SOL)${k.lastSellMc ? ` at ${usdS(k.lastSellMc)} mc` : ''}`;
    if (back != null) t += back >= 0 ? `; it's back up to ${usdS(mcNow)} (+${Math.round(back)}%) since` : `; it's down to ${usdS(mcNow)} (${Math.round(back)}%) since`;
    chainNotes.push({ t, recovered: back != null && back >= 20 && allOut });
  }
  if (dev && dev.soldPct != null && dev.soldPct >= 90 && dev.boughtPct >= 0.5) {
    const up = ch1 != null && ch1 > 0;
    chainNotes.push({ t: `The dev sold ${dev.soldPct >= 99 ? 'everything' : dev.soldPct + '% of the bag'}${mcNow ? `, and it's still trading at ${usdS(mcNow)}` : ''}${up ? ` (+${Math.round(ch1)}% in the last hour): it's running without the dev now` : ''}`, recovered: up });
  }
  const tw = all;
  for (const c of chainNotes) reasons.push(c.t);
  if (chainNotes.some(c => c.recovered)) { verdict = 'real'; reasons.unshift('Real buyers took the supply after a big holder sold out, and the price came back'); }
  if (o && o.source !== 'link' && (o.afterSec == null || o.afterSec >= -60)) {
    verdict = 'real';
    reasons.push(`It started from @${o.author}'s ${o.source === 'stream' ? 'stream moment' : 'tweet'}${o.afterSec != null ? `, and the coin launched ${fmtAgo(o.afterSec / 60)} after it` : ''}: "${o.text.slice(0, 120)}${o.text.length > 120 ? '…' : ''}"`);
  } else if (o && o.source === 'link') {
    verdict = 'real';
    reasons.push(`The coin was made for @${o.author}'s post${o.afterSec != null && o.afterSec > 0 ? ` (${fmtAgo(o.afterSec / 60)} before launch)` : ''}: "${o.text.slice(0, 120)}${o.text.length > 120 ? '…' : ''}"`);
  }
  // in the news: real-world coverage of the subject (any outlet, crypto press, Reddit)
  const press = news.filter(n => n.via === 'news'), threads = news.filter(n => n.via === 'reddit');
  if (press.length) {
    verdict = 'real';
    const outlets = [...new Set(press.map(n => n.source))];
    const lead = press.slice().sort((a, b) => (a.at || 0) - (b.at || 0)).find(n => n.at) || press[0];
    reasons.push(`In the news: ${lead.source}: "${lead.title.slice(0, 110)}${lead.title.length > 110 ? '…' : ''}"${lead.vsLaunchMin != null ? ` (${lead.vsLaunchMin < -1 ? fmtAgo(lead.vsLaunchMin) + ' before launch' : lead.vsLaunchMin > 1 ? fmtAgo(lead.vsLaunchMin) + ' after launch' : 'at launch'})` : ''}${press.length > 1 ? `, plus ${press.length - 1} more article${press.length > 2 ? 's' : ''}${outlets.filter(x => x !== lead.source).length ? ` (${outlets.filter(x => x !== lead.source).slice(0, 4).join(', ')})` : ''}` : ''}`);
  } else if (threads.length >= 2) reasons.push(`${threads.length} Reddit threads about it (${[...new Set(threads.map(t => t.source))].slice(0, 3).join(', ')})`);
  const bigBefore = before.filter(t => !t.promo && big(t));
  if (bigBefore.length) {
    verdict = 'real';
    const t = bigBefore[0];
    reasons.push(`@${t.author}${t.followers ? ` (${t.followers >= 1000 ? Math.round(t.followers / 1000) + 'K' : t.followers} followers)` : ''} talked about it ${fmtAgo(t.vsLaunchMin)} before the coin existed`);
  }
  const bigOrganic = organic.filter(t => big(t) && !(t.vsLaunchMin < -1));
  if (verdict !== 'real' && bigOrganic.length >= 2) { verdict = 'real'; reasons.push(`${bigOrganic.length} large accounts are talking about the subject itself, not just the ticker`); }
  if (verdict === 'real' && bundle && (bundle.wallets >= 3 || bundle.pct >= 10)) reasons.push(`But the launch was bundled: ${bundle.wallets} wallets took ${bundle.pct}% in the first block, so the early chart wasn't natural`);
  if (verdict !== 'real' && bundle && (bundle.wallets >= 3 || bundle.pct >= 10) && !bigBefore.length) {
    verdict = 'manufactured';
    reasons.unshift(`Bundled launch: ${bundle.wallets} wallets took ${bundle.pct}% in the first block, so the chart was built by the launcher's own wallets`);
  }
  if (verdict !== 'real' && verdict !== 'manufactured') {
    if (all.length >= 3 && !before.length && promoShare >= 0.7) {
      verdict = 'manufactured';
      reasons.push(`Nobody mentioned it before the coin launched; ${Math.round(promoShare * 100)}% of the ${all.length} posts are $${sym || 'ticker'} / CA promos`);
      const small = all.filter(t => t.promo && t.followers && t.followers < 2000).length;
      if (small >= 2) reasons.push(`${small} of the promo posts come from small accounts (under 2K followers)`);
    } else if (!all.length && !o) {
      const where = ns?.searched?.length ? ns.searched.join(', ') : '';
      if (newsOk && !news.length) reasons.push(`No news about it: searched ${where}${ns.subjects?.length ? ` for ${ns.subjects.map(x => `"${x}"`).join(', ')}` : ''}${searched ? ', and X' : ''}`);
      if ((searchFailed || xs?.note === 'no-key') && !newsOk) {
        verdict = chainNotes.length ? verdict : 'unknown';
        reasons.push(searchFailed ? `${xs.note}. The news searches didn't answer either` : 'Only your own feed was checked, and the news searches didn\'t answer');
      } else if (!newsOk && !searchFailed && searched) reasons.push('Searched X: nobody has posted about it yet');
    }
    else if (all.length) reasons.push(`${all.length} post${all.length > 1 ? 's' : ''} found, ${organic.length} about the subject itself, ${before.length} before launch: not enough to call it`);
  }
  if (verdict === 'real' && promoShare >= 0.85 && all.length >= 6) reasons.push('Most chatter now is ticker shilling, though');
  // the timeline: tweets, news and on-chain moves together, in order
  const chainItems = (loc.chain || []).map(c => ({ ...c, vsLaunchMin: launch && c.at ? Math.round((c.at - launch) / 60000) : null }));
  const newsItems = news.map(n => ({ author: n.source, text: n.title, url: n.url, at: n.at, vsLaunchMin: n.vsLaunchMin, via: n.via, promo: false }));
  const linkItem = lk && !loc.origin ? [{ ...lk, vsLaunchMin: launch && lk.at ? Math.round((lk.at - launch) / 60000) : null }] : [];
  const timeline = [...tw, ...chainItems, ...newsItems, ...linkItem].sort((a, b) => (a.at || 0) - (b.at || 0));
  return {
    origin: o, verdict, reasons,
    tweets: timeline.slice(-14).map(t => ({ author: t.author, followers: t.followers, verified: t.verified, vip: t.vip, text: t.text, url: t.url, at: t.at, vsLaunchMin: t.vsLaunchMin, promo: t.promo, likes: t.likes || 0, via: t.via })),
    counts: { total: all.length, before: before.length, organic: organic.length, chain: chainItems.length, news: newsItems.length },
    searched, newsSearched: ns?.searched || [], newsFailed: ns?.failed || [], subjects: ns?.subjects || [],
    // what couldn't be searched, said once and briefly when other sources did answer
    note: searchFailed ? (newsOk ? 'X not searched: ' + xs.note.replace(/^Couldn't search X: /, '').split('. ')[0] : xs.note) : xs?.note === 'no-key' ? 'no-key' : null,
  };
}

module.exports = { local, xSearch, assemble };
