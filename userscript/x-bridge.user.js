// ==UserScript==
// @name         Elixir: X bridge
// @namespace    elixir
// @version      1.2
// @description  Forwards tweets you see on x.com (best on an X List of your tracked accounts) to your local Elixir dashboard.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://pro.x.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const SERVER = 'http://localhost:8787'; // change if you set a different port
  const AUTO_LOAD_NEW = true;             // auto-click "Show N posts" while you're near the top

  const sent = new Set();
  let queue = [];
  let total = 0;
  let lastOk = false;

  function post(path, body) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST', url: SERVER + path, data: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' }, timeout: 4000,
        onload: r => { lastOk = r.status === 200; paint(); resolve(lastOk); },
        onerror: () => { lastOk = false; paint(); resolve(false); },
        ontimeout: () => { lastOk = false; paint(); resolve(false); },
      });
    });
  }

  function parse(article) {
    const timeEl = article.querySelector('time[datetime]');
    const link = timeEl && timeEl.closest('a[href*="/status/"]');
    if (!link) return null; // ads and placeholders have no timestamp link
    const m = link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const texts = article.querySelectorAll('[data-testid="tweetText"]');
    let text = texts[0] ? texts[0].innerText : '';
    if (texts[1]) text += '\n\n↪ ' + texts[1].innerText; // quoted tweet
    const social = article.querySelector('[data-testid="socialContext"]');
    if (social && /reposted/i.test(social.innerText)) text = '🔁 ' + social.innerText.trim() + '\n' + text;
    const img = article.querySelector('img[src*="profile_images"]');
    const nameEl = article.querySelector('[data-testid="User-Name"] span');
    if (!text.trim()) {
      const alt = [...article.querySelectorAll('img[alt]')].map(i => i.alt).filter(a => a && a !== 'Image').join(' ');
      if (!alt) return null;
      text = '[media] ' + alt;
    }
    // Live broadcast / Space cards link straight to x.com/i/broadcasts|spaces/… so the radar can auto-transcribe them.
    const links = [...article.querySelectorAll('a[href*="/i/broadcasts/"], a[href*="/i/spaces/"]')].map(a => a.href);
    const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img[src*="pbs.twimg.com/media"]')].map(i => i.src.replace(/name=\w+/, 'name=large'));
    // Like / view counts from the action bar's accessibility labels, e.g. "12K Likes. Like".
    const num = sel => {
      const el = article.querySelector(sel);
      const m = el && (el.getAttribute('aria-label') || '').match(/([\d.,]+)\s*([KMB]?)/i);
      if (!m) return 0;
      return Math.round(parseFloat(m[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1));
    };
    const engagement = { likes: num('[data-testid="like"],[data-testid="unlike"]'), reposts: num('[data-testid="retweet"]'), views: num('a[href$="/analytics"]') };
    return {
      source: 'x', via: 'bridge', id: m[2], author: m[1], links, media, engagement,
      authorName: nameEl ? nameEl.innerText : '', avatar: img ? img.src : '',
      text, url: 'https://x.com' + link.getAttribute('href').split('?')[0],
      createdAt: Date.parse(timeEl.getAttribute('datetime')),
    };
  }

  function scan(root) {
    const arts = (root.matches && root.matches('article')) ? [root] : root.querySelectorAll ? root.querySelectorAll('article') : [];
    for (const a of arts) {
      const t = parse(a);
      if (t && !sent.has(t.id)) { sent.add(t.id); queue.push(t); }
    }
  }

  setInterval(async () => {
    if (!queue.length) return;
    const batch = queue.splice(0, 40);
    if (await post('/api/ingest', batch)) total += batch.length;
    else batch.forEach(t => sent.delete(t.id)); // retry later
  }, 300);

  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
  scan(document);

  // Click X's "Show N posts" pill so new tweets render without you touching the page.
  setInterval(() => {
    if (!AUTO_LOAD_NEW || window.scrollY > 600) return;
    for (const el of document.querySelectorAll('[role="button"], button')) {
      if (/^\s*Show \d+ (new )?posts?\s*$/i.test(el.innerText || '')) { el.click(); break; }
    }
  }, 1500);

  setInterval(() => post('/api/bridge-ping', {}), 30000);
  post('/api/bridge-ping', {});

  // Small status badge, bottom-left.
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99999;font:12px system-ui;padding:4px 9px;border-radius:999px;background:#0a0d12;color:#e6edf3;border:1px solid #1f2833;pointer-events:none;opacity:.9';
  document.body.appendChild(badge);
  const led = document.createElement('span');
  const label = document.createElement('span');
  badge.append(led, label);
  // DOM methods only: x.com may enforce Trusted Types, which blocks innerHTML.
  function paint() {
    led.textContent = '● ';
    led.style.color = lastOk ? '#33e6a0' : '#ff5c7a';
    label.textContent = `Radar ${lastOk ? 'linked' : 'offline'} · ${total} sent`;
  }
  paint();
})();
