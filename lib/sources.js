// Tweet sources. Each poller calls onTweet(item) for every tweet it sees.
// item = { source, id, author, authorName, avatar, text, url, createdAt }

function chunkAccounts(accounts, maxLen = 420) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const a of accounts) {
    const part = `from:${a}`;
    if (cur.length && len + part.length + 4 > maxLen) { chunks.push(cur); cur = []; len = 0; }
    cur.push(a);
    len += part.length + 4;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Several keys per provider: when one is rate-limited or rejected, rest it and use the next.
const cooldown = new Map(); // key -> rested until (ms)
async function withKeys(keys, doFetch) {
  const now = Date.now();
  const ready = keys.filter(k => (cooldown.get(k) || 0) <= now);
  let last = null;
  for (const key of ready.length ? ready : keys) {
    const res = await doFetch(key);
    if (res.status === 429 || res.status === 401 || res.status === 402 || res.status === 403) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      cooldown.set(key, reset > now ? reset : now + (res.status === 429 ? 60000 : 600000));
      last = res;
      continue;
    }
    return res;
  }
  return last;
}

function parseTime(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ---- twitterapi.io --------------------------------------------------------
// Twitter search dates: since:YYYY-MM-DD_HH:MM:SS_UTC
const sinceStr = ms => new Date(ms).toISOString().replace('T', '_').replace(/\.\d+Z$/, '_UTC');
let sinceRejected = false; // if the provider ever rejects the date filter, keep working without it

async function pollTwitterApiIo(cfg, accounts, onTweet, { sinceMs } = {}) {
  const keys = cfg.keys.twitterapiIos;
  const errors = [];
  let okGroups = 0, got = 0;
  for (const group of chunkAccounts(accounts)) {
    let base = '(' + group.map(a => `from:${a}`).join(' OR ') + ')';
    if (!cfg.includeReplies) base += ' -filter:replies';
    try {
      let cursor = '', useSince = Boolean(sinceMs) && !sinceRejected;
      for (let pages = 0; pages < 5;) { // busy window: follow a few pages so nothing is dropped
        // Only tweets since the last poll: twitterapi.io bills per tweet returned, so don't re-fetch old ones.
        const q = useSince ? `${base} since:${sinceStr(sinceMs)}` : base;
        const url = 'https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=' + encodeURIComponent(q) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const res = await withKeys(keys, key => fetch(url, { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(10000) }));
        if (!res.ok) {
          const msg = (await res.text()).slice(0, 200);
          if (res.status === 400 && useSince) { sinceRejected = true; useSince = false; continue; }
          throw new Error(explain('twitterapi.io', res.status, msg));
        }
        const body = await res.json();
        if (body.status === 'error') throw new Error('twitterapi.io: ' + (body.msg || body.message || 'error'));
        const tweets = body.tweets || body.data?.tweets || [];
        for (const t of tweets) {
          const createdAt = parseTime(t.createdAt);
          if (sinceMs && createdAt && createdAt < sinceMs) continue;
          const quoted = t.quoted_tweet?.text ? `\n\n↪ ${t.quoted_tweet.author?.userName ? '@' + t.quoted_tweet.author.userName + ': ' : ''}${t.quoted_tweet.text}` : '';
          onTweet({
            source: 'x',
            id: String(t.id),
            author: t.author?.userName || 'unknown',
            authorName: t.author?.name || '',
            avatar: t.author?.profilePicture || '',
            text: (t.text || '') + quoted,
            url: t.url || `https://x.com/${t.author?.userName}/status/${t.id}`,
            createdAt,
            links: (t.entities?.urls || []).map(u => u.expanded_url || u.url).filter(Boolean),
            media: (t.extendedEntities?.media || t.entities?.media || []).map(m => m.media_url_https).filter(Boolean),
            engagement: { likes: t.likeCount || 0, reposts: t.retweetCount || 0, views: t.viewCount || 0 },
          });
          got++;
        }
        cursor = body.has_next_page && body.next_cursor ? body.next_cursor : '';
        pages++;
        if (!cursor) break;
      }
      okGroups++;
    } catch (e) { errors.push(e.message); }
  }
  if (!okGroups && errors.length) throw new Error(errors[0]);
  return { got, errors };
}

/** Provider errors in plain words. */
function explain(provider, status, body) {
  const b = String(body || '');
  if (status === 401) return `${provider}: the key was rejected (401). Check it under API keys.`;
  if (status === 402 || /credit|balance|insufficient/i.test(b)) return `${provider}: out of credit (${status}). Top up your account.`;
  if (status === 403 && provider === 'X API') return 'X API: this key can\'t search tweets (403). The free X tier has no search: use twitterapi.io, or an X Basic/Pro plan. Also check you pasted the Bearer Token, not the API key.';
  if (status === 403) return `${provider}: access denied (403). ${b.slice(0, 120)}`;
  if (status === 429) return `${provider}: rate limited (429). It retries automatically; add a second key to rotate.`;
  return `${provider} ${status}: ${b.slice(0, 160)}`;
}

// ---- Official X API v2 ----------------------------------------------------
const sinceIds = new Map();
async function pollXApi(cfg, accounts, onTweet) {
  const tokens = cfg.keys.xBearers;
  for (const group of chunkAccounts(accounts, 480)) {
    const gkey = group.join(',');
    let q = '(' + group.map(a => `from:${a}`).join(' OR ') + ')';
    if (!cfg.includeReplies) q += ' -is:reply';
    const params = new URLSearchParams({
      query: q,
      max_results: '10',
      'tweet.fields': 'created_at,author_id,entities',
      expansions: 'author_id',
      'user.fields': 'username,name,profile_image_url',
    });
    if (sinceIds.get(gkey)) params.set('since_id', sinceIds.get(gkey));
    const res = await withKeys(tokens, token => fetch('https://api.x.com/2/tweets/search/recent?' + params, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    }));
    if (!res.ok) throw new Error(explain('X API', res.status, await res.text()));
    const body = await res.json();
    const users = new Map((body.includes?.users || []).map(u => [u.id, u]));
    if (body.meta?.newest_id) sinceIds.set(gkey, body.meta.newest_id);
    for (const t of body.data || []) {
      const u = users.get(t.author_id) || {};
      onTweet({
        source: 'x',
        id: String(t.id),
        author: u.username || t.author_id,
        authorName: u.name || '',
        avatar: u.profile_image_url || '',
        text: t.text,
        url: `https://x.com/${u.username || 'i'}/status/${t.id}`,
        createdAt: parseTime(t.created_at),
        links: (t.entities?.urls || []).map(x => x.expanded_url || x.url).filter(Boolean),
      });
    }
  }
}

// ---- Demo -----------------------------------------------------------------
const DEMO_AUTHORS = ['ct_whale_alerts', 'memelord_daily', 'frogwatcher', 'news_but_fast', 'onchain_oracle'];
const DEMO_TEXT = [
  'just adopted a hamster named Biscuit and honestly he runs the house now',
  'the "Quantum Toaster" is the most unhinged product I have ever seen lmao',
  '$GLORP looking spicy, devs are cooking',
  'BREAKING: city council votes to rename the bridge "Doge Crossing"',
  'Biscuit has escaped the cage again. send help',
  'my grandma just discovered memecoins and bought something called Wobble',
  'who else is watching the Moon Penguin livestream rn',
  'Quantum Toaster sold out in 4 minutes. The future is toast',
  'I will only respond to people who call me Captain Crumb from now on',
  'gm. the frog has spoken. #RibbitSeason',
];
function startDemo(onTweet) {
  let i = 0;
  const tick = () => {
    const text = DEMO_TEXT[i % DEMO_TEXT.length];
    const author = DEMO_AUTHORS[(i * 7) % DEMO_AUTHORS.length];
    const id = 'demo' + Date.now() + i;
    onTweet({
      source: 'x', id, author, authorName: author.replace(/_/g, ' '),
      avatar: '', text, url: `https://x.com/${author}/status/${id}`,
      createdAt: Date.now() - Math.floor(Math.random() * 2500),
    });
    i++;
    setTimeout(tick, 3500 + Math.random() * 3500);
  };
  setTimeout(tick, 800);
}

module.exports = { pollTwitterApiIo, pollXApi, startDemo, explain };
