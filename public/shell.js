// App shell shared by both pages: left sidebar (live streams + plays with their pictures, feature nav),
// bottom status bar (server latency, sources), and one shared server-event connection.
(() => {
  window.nrES = window.nrES || new EventSource('/api/events');
  const es = window.nrES;
  const page = document.body.dataset.page || 'feed';
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => n == null ? '' : '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
  const store = { get: (k, d) => { try { return localStorage.getItem('nr.' + k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('nr.' + k, v); } catch {} } };

  // ---- avatars: real channel picture when we have one, otherwise initials; small platform mark in the corner ----
  const PLAT = { twitch: ['TW', '#9147ff'], youtube: ['YT', '#ff3b3b'], x: ['X', '#e9eaee'], 'x-space': ['X', '#e9eaee'], kick: ['K', '#53fc18'], pumpfun: ['P', '#5fd38d'], web: ['N', '#80838f'], tab: ['T', '#80838f'], mic: ['M', '#80838f'] };
  const hue = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  window.srcAvatar = (profile, label, size = 32) => {
    const p = profile || {};
    const name = p.name || label || '?';
    const init = name.replace(/^[@$]/, '').slice(0, 2).toUpperCase();
    const mark = PLAT[p.platform];
    const img = p.avatar ? `<img src="${h(p.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<span class="sav" style="--s:${size}px;--h:${hue(name)}" title="${h(name)}${p.handle ? ' (@' + h(p.handle) + ')' : ''}"><i>${h(init)}</i>${img}${mark ? `<em style="--pc:${mark[1]}">${mark[0]}</em>` : ''}</span>`;
  };
  window.srcName = (profile, label) => (profile && profile.name) || label || 'Stream';

  const mark = '<img src="/logo.svg" width="24" height="24" alt="">';
  const ico = {
    feed: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    streams: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    plays: '<path d="M4 18 9 12l4 3 7-9"/><path d="M15 6h5v5"/>',
    kols: '<path d="M3 7h18v11H3z"/><path d="M16 12h5M3 7l3-3h12l3 3"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
    side: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  };
  const svg = (k, s = 16) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico[k]}</svg>`;

  // ---- sidebar ----
  const sb = document.createElement('aside');
  sb.className = 'sb';
  sb.innerHTML = `
    <div class="sb-brand"><span class="sb-mark">${mark}</span><b>Elixir</b><span class="sb-ver">v1.4</span><button class="sb-fold" title="Collapse sidebar">${svg('side')}</button></div>
    <form class="sb-search">${svg('search', 15)}<input placeholder="Search coin or word" autocomplete="off"><kbd>/</kbd></form>
    <div class="sb-live"><div class="sb-empty">Nothing live yet. Start a stream or track a play.</div></div>
    <div class="sb-sec">Features</div>
    <nav class="sb-nav">
      <a href="/" data-k="feed">${svg('feed')}Live feed</a>
      <a href="/streams.html" data-k="streams">${svg('streams')}Streams</a>
      <a href="/#plays" data-k="plays">${svg('plays')}Plays<span class="sb-n" data-n="plays"></span></a>
      <a href="#" data-k="kols">${svg('kols')}KOL wallets<span class="sb-n" data-n="kols"></span></a>
      <a href="/#playbook" data-k="book">${svg('book')}Playbook</a>
      <a href="/#alerts" data-k="alerts">${svg('bell')}Alerts<span class="sb-n" data-n="alerts"></span></a>
      <a href="/#keys" data-k="keys">${svg('key')}API keys<span class="sb-n" data-n="keys"></span></a>
    </nav>
    <div class="sb-foot">
      <div class="sb-wallets"><span>${svg('kols', 15)}</span><div><b class="sb-wa">—</b><small class="sb-wd">KOL wallets</small></div></div>
      <div class="sb-btns">
        <button class="ghost sb-import">Import</button>
        <button class="primary sb-cta">${page === 'streams' ? 'Add stream' : 'Scan tweet'}</button>
      </div>
    </div>`;
  document.body.prepend(sb);
  sb.querySelector(`[data-k="${page}"]`)?.classList.add('on');
  document.body.classList.add('shell');
  const fold = () => document.body.classList.toggle('sb-folded', store.get('sbFold', '0') === '1');
  fold();
  sb.querySelector('.sb-fold').onclick = () => { store.set('sbFold', store.get('sbFold', '0') === '1' ? '0' : '1'); fold(); };

  // Search: same as the Quick check box.
  sb.querySelector('.sb-search').onsubmit = e => {
    e.preventDefault();
    const v = sb.querySelector('.sb-search input').value.trim(); if (!v) return;
    if (typeof window.runLookup === 'function') { window.runLookup(v); document.getElementById('lookupOut')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    else location.href = '/?q=' + encodeURIComponent(v);
  };
  const kolBtn = () => document.querySelector('.kolp-toggle');
  sb.querySelector('[data-k="kols"]').onclick = e => { e.preventDefault(); kolBtn()?.click(); };
  sb.querySelector('.sb-import').onclick = () => {
    const p = document.querySelector('.kolp');
    if (p?.hidden) kolBtn()?.click();
    document.querySelector('.kolp-imp-btn')?.click();
  };
  sb.querySelector('.sb-cta').onclick = () => {
    const el = document.getElementById(page === 'streams' ? 'urlIn' : 'pasteText');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus();
  };
  const jump = id => { const el = document.getElementById(id); if (el) { el.closest('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; } };
  for (const [k, id] of [['book', 'playbook'], ['alerts', 'alerts']]) sb.querySelector(`[data-k="${k}"]`).addEventListener('click', e => { if (jump(id)) e.preventDefault(); });
  sb.querySelector('[data-k="keys"]').addEventListener('click', e => { if (typeof window.openKeys === 'function') { e.preventDefault(); window.openKeys(); } });
  const paintKeyCount = c => {
    const ks = c?.keys; if (!ks) return;
    const n = ['DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => ks[k]?.set).length;
    sb.querySelector('[data-n="keys"]').textContent = n + '/2';
  };
  sb.querySelector('[data-k="plays"]').addEventListener('click', e => {
    const t = document.querySelector('#tabs [data-f="plays"]'); if (t) { e.preventDefault(); t.click(); }
  });

  // Live list: running streams and tracked plays, newest first.
  const streams = new Map(), plays = new Map();
  let alerts = 0;
  function paintLive() {
    const ss = [...streams.values()].filter(s => !s.endedAt).sort((a, b) => b.startedAt - a.startedAt);
    const ps = [...plays.values()].filter(p => p.status !== 'done').sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
    const rows = [
      ...ss.map(s => `<a class="sb-it" href="/streams.html#${h(s.id)}" data-sid="${h(s.id)}">${window.srcAvatar(s.profile, s.label)}
        <div><b>${h(window.srcName(s.profile, s.label))}</b><small>${h(s.status || '')}</small></div><span class="sb-tag live">Live</span></a>`),
      ...ps.map(p => {
        const top = [...(p.deploys || [])].sort((a, b) => (b.vol?.real || 0) - (a.vol?.real || 0))[0];
        const img = top?.image ? { avatar: top.image, name: top.symbol } : null;
        return `<a class="sb-it" href="/#it-${h(p.itemId)}" data-play="${h(p.itemId)}">${window.srcAvatar(img || { name: p.author }, p.author)}
          <div><b>${top ? '$' + h(top.symbol) : '@' + h(p.author)}</b><small>${top ? h('@' + p.author + ' · ' + usd(top.marketCap) + ' · ' + p.deploys.length + ' deploys') : h((p.text || '').slice(0, 40))}</small></div><span class="sb-tag">${top ? h(top.orderLabel || 'Play') : 'Play'}</span></a>`;
      }),
    ];
    sb.querySelector('.sb-live').innerHTML = rows.length ? rows.join('') : '<div class="sb-empty">Nothing live yet. Start a stream or track a play.</div>';
    sb.querySelector('[data-n="plays"]').textContent = ps.length || '';
  }
  sb.querySelector('.sb-live').addEventListener('click', e => {
    const a = e.target.closest('[data-play]');
    if (a && page === 'feed') { const c = document.getElementById('it-' + a.dataset.play); if (c) { e.preventDefault(); c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
    const s = e.target.closest('[data-sid]');
    if (s && page === 'streams') { const el = document.querySelector(`.sess[data-sid="${CSS.escape(s.dataset.sid)}"]`); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
  });
  const paintKols = d => {
    if (!d || d.wallets == null) return;
    if (d.status === 'demo' && !d.wallets) { sb.querySelector('.sb-wa').textContent = 'Demo wallets'; sb.querySelector('.sb-wd').textContent = 'Import your Axiom list'; return; }
    sb.querySelector('.sb-wa').textContent = d.wallets ? `${d.active} active` : 'No wallets';
    sb.querySelector('.sb-wd').textContent = d.wallets ? `${d.dormant} dormant · ${d.wallets} tracked` : 'Import your Axiom list';
    sb.querySelector('[data-n="kols"]').textContent = d.wallets ? d.active : '';
  };

  // ---- status bar ----
  const bar = document.createElement('footer');
  bar.className = 'sbar';
  bar.innerHTML = `<span class="sbar-live"><i></i><b>Connecting…</b></span><span class="sbar-items"></span><span class="grow"></span>
    <a href="https://x.com" target="_blank" rel="noopener" class="sbar-l">X</a><span class="sbar-tg"></span><span class="sbar-l sbar-clock"></span>`;
  document.body.append(bar);
  let up = false, latency = null;
  const paintBar = () => {
    const l = bar.querySelector('.sbar-live');
    l.classList.toggle('bad', !up);
    l.querySelector('b').textContent = up ? `All services live${latency != null ? ' · ' + latency + 'ms' : ''}` : 'Server offline · retrying';
  };
  async function ping() {
    const t = performance.now();
    try { await fetch('/api/ping', { cache: 'no-store' }); latency = Math.round(performance.now() - t); up = true; } catch { up = false; }
    paintBar();
  }
  setInterval(ping, 10000); ping();
  setInterval(() => { bar.querySelector('.sbar-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }, 1000);
  const paintItems = (cfg, st, ss) => {
    const items = [];
    if (cfg) items.push(`Source <b>${h({ 'twitterapi.io': 'twitterapi.io', 'x-api': 'X API', 'bridge-only': 'X bridge', demo: 'Demo' }[cfg.provider] || cfg.provider || '—')}</b>`);
    if (st) items.push(`Bridge <b class="${st.bridgeLastSeen && Date.now() - st.bridgeLastSeen < 90000 ? 'ok' : ''}">${st.bridgeLastSeen && Date.now() - st.bridgeLastSeen < 90000 ? 'on' : 'off'}</b>`);
    if (ss) items.push(`Speech <b>${h(ss.stt === 'deepgram' ? 'Deepgram' : ss.stt === 'demo' ? 'Demo' : 'mic only')}</b>`, `Claude <b>${h(String(ss.judge || 'off').replace(/ \(.*/, ''))}</b>`);
    bar.querySelector('.sbar-items').innerHTML = items.map(x => `<span>${x}</span>`).join('');
    bar.querySelector('.sbar-tg').innerHTML = (cfg?.telegram ? '<span class="sbar-l">Telegram on</span>' : '') + (cfg?.discord ? '<span class="sbar-l">Discord on</span>' : '');
  };
  let C = null, ST = null, SS = null;

  es.addEventListener('open', () => { up = true; paintBar(); });
  es.addEventListener('error', () => { up = false; paintBar(); });
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    streams.clear(); plays.clear();
    for (const s of d.streams?.sessions || []) { const { segs, ...m } = s; streams.set(s.id, m); }
    for (const p of d.plays || []) plays.set(p.id, p);
    C = d.config; ST = d.status; SS = d.streams?.status; paintKeyCount(C);
    paintLive(); paintKols(d.kols); paintItems(C, ST, SS);
    up = true; paintBar();
  });
  es.addEventListener('stream-session', e => { const m = JSON.parse(e.data); streams.set(m.id, m); paintLive(); });
  es.addEventListener('stream-removed', e => { streams.delete(JSON.parse(e.data).id); paintLive(); });
  es.addEventListener('stream-status', e => { SS = JSON.parse(e.data); paintItems(C, ST, SS); });
  es.addEventListener('play', e => { const p = JSON.parse(e.data); plays.set(p.id, p); paintLive(); });
  es.addEventListener('play-removed', e => { plays.delete(JSON.parse(e.data).id); paintLive(); });
  es.addEventListener('kol-status', e => paintKols(JSON.parse(e.data)));
  es.addEventListener('status', e => { ST = JSON.parse(e.data); paintItems(C, ST, SS); });
  es.addEventListener('config', e => { C = JSON.parse(e.data); paintItems(C, ST, SS); paintKeyCount(C); });
  es.addEventListener('alert', () => { alerts++; sb.querySelector('[data-n="alerts"]').textContent = alerts; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { alerts = 0; sb.querySelector('[data-n="alerts"]').textContent = ''; } });

  // Mobile: the sidebar slides in from a header button.
  const menu = document.createElement('button');
  menu.className = 'ghost sb-menu';
  menu.innerHTML = svg('side');
  menu.title = 'Menu';
  menu.onclick = () => document.body.classList.toggle('sb-open');
  document.addEventListener('click', e => { if (document.body.classList.contains('sb-open') && !e.target.closest('.sb, .sb-menu')) document.body.classList.remove('sb-open'); });
  const addMenu = () => document.querySelector('.top')?.prepend(menu);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenu); else addMenu();

  // /?q=word from the sidebar search on another page
  const q = new URLSearchParams(location.search).get('q');
  if (q) window.addEventListener('load', () => setTimeout(() => window.runLookup?.(q), 300));
})();
