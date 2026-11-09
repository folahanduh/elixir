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
  return { origin, feed };
}

const xCache = new Map();
/** Live X search: CA, $TICKER and the plain name; popular first. One request (free-tier friendly). */
async function xSearch({ mint, sym, name, launch }, key) {
  if (!key) return { tweets: [], note: 'no-key' };
  const ck = mint, hit = xCache.get(ck);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.r;
  const parts = [mint];
  if (sym && sym.length >= 2) parts.push('$' + sym);
  if (name && name.length >= 4 && name.toLowerCase() !== String(sym || '').toLowerCase() && !COMMON.has(name.toLowerCase())) parts.push(`"${name.replace(/"/g, '')}"`);
  const since = new Date((launch || Date.now()) - 24 * 3600000).toISOString().replace('T', '_').replace(/\.\d+Z$/, '_UTC');
  const q = `(${parts.join(' OR ')}) since:${since}`;
  let r = { tweets: [] };
  try {
    const res = await tioFetch('https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Top&query=' + encodeURIComponent(q), key);
    if (!res.ok) r = { tweets: [], note: `X search: HTTP ${res.status}` };
    else {
      const body = await res.json();
      const list = body.tweets || body.data?.tweets || [];
      r = { tweets: list.slice(0, 20).map(t => {
        const text = String(t.text || '');
        return {
          author: t.author?.userName || 'unknown', followers: Number(t.author?.followers ?? t.author?.followersCount ?? 0) || 0, verified: Boolean(t.author?.isBlueVerified || t.author?.isVerified),
          text: text.slice(0, 280), url: t.url || `https://x.com/${t.author?.userName}/status/${t.id}`, at: Date.parse(t.createdAt) || null,
          likes: t.likeCount || 0, views: t.viewCount || 0, promo: isPromo(text, mint, sym), via: 'x',
        };
      }) };
    }
  } catch (e) { r = { tweets: [], note: 'X search failed: ' + e.message }; }
  xCache.set(ck, { at: Date.now(), r });
  if (xCache.size > 300) xCache.delete(xCache.keys().next().value);
  return r;
}

const fmtAgo = min => (Math.abs(min) < 60 ? `${Math.round(Math.abs(min))}m` : Math.abs(min) < 2880 ? `${(Math.abs(min) / 60).toFixed(1)}h` : `${Math.round(Math.abs(min) / 1440)}d`);
const big = t => t.verified || t.followers >= 10000 || t.vip;

/** Put it together and judge the narrative. */
function assemble({ mint, sym, launch }, loc, xs) {
  const seen = new Set();
  const all = [...loc.feed, ...(xs?.tweets || [])].filter(t => { const k = t.url || t.text; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const t of all) t.vsLaunchMin = launch && t.at ? Math.round((t.at - launch) / 60000) : null; // negative = before launch
  all.sort((a, b) => (a.at || 0) - (b.at || 0));
  const before = all.filter(t => t.vsLaunchMin != null && t.vsLaunchMin < -1);
  const organic = all.filter(t => !t.promo);
  const promoShare = all.length ? (all.length - organic.length) / all.length : 0;
  const reasons = [];
  let verdict = 'unclear';
  const o = loc.origin;
  if (o && (o.afterSec == null || o.afterSec >= -60)) {
    verdict = 'real';
    reasons.push(`It started from @${o.author}'s ${o.source === 'stream' ? 'stream moment' : 'tweet'}${o.afterSec != null ? `, and the coin launched ${fmtAgo(o.afterSec / 60)} after it` : ''}: "${o.text.slice(0, 120)}${o.text.length > 120 ? '…' : ''}"`);
  }
  const bigBefore = before.filter(t => !t.promo && big(t));
  if (bigBefore.length) {
    verdict = 'real';
    const t = bigBefore[0];
    reasons.push(`@${t.author}${t.followers ? ` (${t.followers >= 1000 ? Math.round(t.followers / 1000) + 'K' : t.followers} followers)` : ''} talked about it ${fmtAgo(t.vsLaunchMin)} before the coin existed`);
  }
  const bigOrganic = organic.filter(t => big(t) && !(t.vsLaunchMin < -1));
  if (verdict !== 'real' && bigOrganic.length >= 2) { verdict = 'real'; reasons.push(`${bigOrganic.length} large accounts are talking about the subject itself, not just the ticker`); }
  if (verdict !== 'real') {
    if (all.length >= 3 && !before.length && promoShare >= 0.7) {
      verdict = 'manufactured';
      reasons.push(`Nobody mentioned it before the coin launched; ${Math.round(promoShare * 100)}% of the ${all.length} posts are $${sym || 'ticker'} / CA promos`);
      const small = all.filter(t => t.promo && t.followers && t.followers < 2000).length;
      if (small >= 2) reasons.push(`${small} of the promo posts come from small accounts (under 2K followers)`);
    } else if (!all.length && !o) reasons.push(xs?.note === 'no-key' ? 'No tweets about it in your feed (add a twitterapi.io key so Elixir can search all of X)' : 'No tweets about it found yet');
    else if (all.length) reasons.push(`${all.length} post${all.length > 1 ? 's' : ''} found, ${organic.length} about the subject itself, ${before.length} before launch: not enough to call it`);
  }
  if (verdict === 'real' && promoShare >= 0.85 && all.length >= 6) reasons.push('Most chatter now is ticker shilling, though');
  return {
    origin: o, verdict, reasons,
    tweets: all.slice(-12).map(t => ({ author: t.author, followers: t.followers, verified: t.verified, vip: t.vip, text: t.text, url: t.url, at: t.at, vsLaunchMin: t.vsLaunchMin, promo: t.promo, likes: t.likes || 0, via: t.via })),
    counts: { total: all.length, before: before.length, organic: organic.length },
    searched: Boolean(xs && xs.note !== 'no-key'), note: xs?.note || null,
  };
}

module.exports = { local, xSearch, assemble };
