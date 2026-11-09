// Stories from the news, not only X. Where a coin's story can come from:
//   • the coin's own links: the tweet or article it was launched for (pump.fun / DexScreener / Jupiter info),
//     read without any X key (X's public embed service gives a tweet's text and author)
//   • pump.fun's description of the coin, which usually names the subject ("Jensen Huang", "White House")
//   • Google News: every outlet (Reuters, AP, Bloomberg, CNBC, Fox, BBC…), searched per coin
//   • crypto outlets (CoinDesk, Cointelegraph, Decrypt, The Block, Blockworks…): read every 3 minutes,
//     so matching a coin against them is instant
//   • Reddit search
// No keys needed. Every source is optional: a source that fails is skipped and named in the result.

const FEEDS = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['The Block', 'https://www.theblock.co/rss.xml'],
  ['Blockworks', 'https://blockworks.co/feed'],
  ['Bitcoin Magazine', 'https://bitcoinmagazine.com/.rss/full/'],
  ['CryptoSlate', 'https://cryptoslate.com/feed/'],
  ['The Defiant', 'https://thedefiant.io/api/feed'],
  ['Watcher.Guru', 'https://watcher.guru/news/feed'],
];
const UA = { 'user-agent': 'Mozilla/5.0 (Elixir news reader)' };

// ---------- RSS ----------
const unxml = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();
/** RSS / Atom → [{source, title, url, at, text}] */
function parseFeed(xml, sourceName) {
  const out = [];
  for (const m of String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const it = m[0];
    const tag = t => (it.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1];
    let title = unxml(tag('title'));
    const link = unxml(tag('link')) || (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const at = Date.parse(unxml(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date'))) || null;
    let source = sourceName;
    const src = tag('source');
    if (src) { source = unxml(src); title = title.replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); } // Google News: "Title - Reuters"
    if (!title || !/^https?:\/\//.test(link)) continue;
    out.push({ source, title: title.slice(0, 240), url: link, at, text: unxml(tag('description') || tag('summary')).slice(0, 400) });
  }
  return out;
}

// ---------- crypto outlets, read all the time ----------
const recent = new Map(); // url -> item
let started = false;
async function pollFeeds() {
  await Promise.all(FEEDS.map(async ([name, url]) => {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      for (const it of parseFeed(await r.text(), name)) if (!recent.has(it.url)) recent.set(it.url, it);
    } catch {}
  }));
  const cutoff = Date.now() - 3 * 86400000;
  for (const [k, v] of recent) if ((v.at || 0) < cutoff) recent.delete(k);
  while (recent.size > 1500) recent.delete(recent.keys().next().value);
}
function start() {
  if (started) return;
  started = true;
  pollFeeds();
  setInterval(pollFeeds, 3 * 60000).unref();
}

// ---------- what to search for ----------
const COMMON = new Set('the and for you are was not but all any can had her one our out day get has him his how man new now old see two way who did its let put say she too use dog cat sun moon coin token pump doge pepe based king ai inu sol meme cto official real'.split(' '));
/** Words worth searching the news for: the coin's name (split if it's CamelCase), names in its description. */
function subjects({ name, sym, description }) {
  const out = [];
  const add = s => { s = String(s || '').replace(/[^\p{L}\p{N}' .&-]/gu, ' ').replace(/\s+/g, ' ').trim(); if (s.length >= 4 && !COMMON.has(s.toLowerCase()) && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  if (name) {
    const split = String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
    add(split);
  }
  // Capitalised names in the description ("Jensen Huang", "White House", "Elon Musk")
  for (const m of String(description || '').matchAll(/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|of|the|de|van|von)){1,3})\b/g)) add(m[1]);
  if (sym && sym.length >= 4 && !COMMON.has(sym.toLowerCase()) && sym.toLowerCase() !== String(name || '').toLowerCase()) add(sym);
  return out.slice(0, 3);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, terms, mint) => { const t = String(text || ''); return (mint && t.includes(mint)) || terms.some(w => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w).replace(/\s+/g, '\\s+')}([^\\p{L}\\p{N}]|$)`, 'iu').test(t)); };

// ---------- per-coin lookups ----------
async function googleNews(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-US&gl=US&ceid=US:en`, { headers: UA, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('Google News HTTP ' + r.status);
  return parseFeed(await r.text(), 'Google News').slice(0, 8).map(x => ({ ...x, via: 'news' }));
}
async function reddit(q) {
  const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=week&limit=8`, { headers: UA, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('Reddit HTTP ' + r.status);
  const j = await r.json();
  return (j.data?.children || []).map(c => c.data).filter(Boolean).map(d => ({
    source: 'r/' + d.subreddit, title: String(d.title || '').slice(0, 240), url: 'https://www.reddit.com' + d.permalink, at: (d.created_utc || 0) * 1000 || null, score: d.score || 0, via: 'reddit',
  }));
}
/** pump.fun's own record of the coin: description, twitter, website. */
async function pumpMeta(mint) {
  if (!/pump$/.test(mint)) return null;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: UA, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return { description: j.description || '', twitter: j.twitter || '', website: j.website || '', telegram: j.telegram || '' };
  } catch { return null; }
}
/** A tweet's text and author without an X key (X's public embed service). */
async function readTweet(url) {
  try {
    const r = await fetch(`https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url)}`, { headers: UA, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    const html = String(j.html || '');
    const text = unxml((html.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    // the exact time is inside the tweet's ID (X's IDs start with a millisecond timestamp)
    const id = (url.match(/status\/(\d{15,20})/) || [])[1];
    const date = id ? Number((BigInt(id) >> 22n) + 1288834974657n) : null;
    const author = String(j.author_url || '').split('/').pop() || j.author_name || 'unknown';
    return text ? { author, text: text.slice(0, 280), url, at: date, via: 'link', followers: null, verified: null, promo: false } : null;
  } catch { return null; }
}
/** An article's headline. */
async function readArticle(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(2500), redirect: 'follow' });
    if (!r.ok || !/text\/html/.test(r.headers.get('content-type') || '')) return null;
    const html = (await r.text()).slice(0, 300000);
    const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1];
    const title = unxml(og || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const site = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) || [])[1] || new URL(url).hostname.replace(/^www\./, '');
    const at = Date.parse((html.match(/article:published_time["'][^>]+content=["']([^"']+)/i) || [])[1] || '') || null;
    return title ? { source: unxml(site), title: title.slice(0, 240), url, at, via: 'news' } : null;
  } catch { return null; }
}

const cache = new Map();
/**
 * Everything the news says about a coin. meta: {mint, sym, name, links: {twitter, website}}.
 * Returns {items, linked, subjects, searched: [source names that answered], failed: [names that didn't], ok}
 */
async function search(meta) {
  const hit = cache.get(meta.mint);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.r;
  const pm = await pumpMeta(meta.mint);
  const links = { twitter: pm?.twitter || meta.links?.twitter || '', website: pm?.website || meta.links?.website || '' };
  const terms = subjects({ name: meta.name, sym: meta.sym, description: pm?.description });
  const searched = [], failed = [];
  const tryIt = (name, p) => p.then(v => { searched.push(name); return v; }, () => { failed.push(name); return []; });
  const isTweet = /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(links.twitter) ? links.twitter : /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(links.website) ? links.website : null;
  const article = links.website && !isTweet && !/(?:x|twitter|t\.me|telegram|pump\.fun|dexscreener|youtube|tiktok|instagram)\./i.test(links.website) ? links.website : null;
  // the best names to search: real multi-word names first ("Jensen Huang" beats "JENSENHUNG")
  const best = [...terms.filter(t => t.includes(' ')), ...terms.filter(t => !t.includes(' '))];
  const [g1, g2, rd, tweet, art] = await Promise.all([
    best[0] ? tryIt('Google News', googleNews(`"${best[0]}"`)) : [],
    best[1] && best[1].includes(' ') ? tryIt('Google News', googleNews(`"${best[1]}"`)) : [],
    best[0] ? tryIt('Reddit', reddit(`"${best[0]}"`)) : [],
    isTweet ? readTweet(isTweet) : null,
    article ? readArticle(article) : null,
  ]);
  const crypto = terms.length || meta.mint ? [...recent.values()].filter(x => mentions(x.title + ' ' + x.text, terms, meta.mint)).slice(0, 8).map(x => ({ ...x, via: 'news' })) : [];
  if (started) searched.push('crypto news');
  const seen = new Set();
  const items = [...(art ? [art] : []), ...g1, ...g2, ...crypto, ...rd.filter(x => x.score >= 3 || mentions(x.title, terms))]
    .filter(x => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 12);
  const r = { items, linked: tweet, subjects: terms, description: pm?.description || '', searched: [...new Set(searched)], failed: [...new Set(failed)], ok: searched.length > 0 || Boolean(tweet) };
  cache.set(meta.mint, { at: Date.now(), r });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return r;
}
/** Instant: only what's already in memory (crypto outlets read in the background, earlier searches). */
function quickLook(meta) {
  const hit = cache.get(meta.mint);
  if (hit) return hit.r;
  const terms = subjects({ name: meta.name, sym: meta.sym });
  const items = [...recent.values()].filter(x => mentions(x.title + ' ' + x.text, terms, meta.mint)).slice(0, 6).map(x => ({ ...x, via: 'news' }));
  return { items, linked: null, subjects: terms, searched: started ? ['crypto news'] : [], failed: [], ok: started, partial: true };
}

module.exports = { start, search, quickLook, parseFeed, subjects, _recent: recent };
