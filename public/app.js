// Elixir front end. Plain JS, no build step.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  config: null, status: null,
  items: new Map(),        // id -> item (with .dex = {word: result})
  filter: 'all',
  sound: lsGet('sound', '1') === '1',
  alertCount: 0,
};

function lsGet(k, d) { try { return localStorage.getItem('nr.' + k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem('nr.' + k, v); } catch {} }

// ---------- formatting ----------
const fmtUsd = n => n == null ? '—' : '$' + (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
const fmtAge = min => min == null ? '' : min < 60 ? Math.max(1, Math.round(min)) + 'm' : min < 1440 ? Math.round(min / 60) + 'h' : Math.round(min / 1440) + 'd';
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const xSearch = w => `https://x.com/search?q=${encodeURIComponent(w)}&f=live`;

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- server events ----------
function connect() {
  const es = window.nrES || (window.nrES = new EventSource('/api/events'));
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    state.config = d.config; state.status = d.status;
    $('#feed').innerHTML = ''; state.items.clear();
    state.plays.clear();
    for (const p of d.plays || []) state.plays.set(p.itemId, p);
    state.playStats = d.playStats; state.riskMemory = d.riskMemory; renderPlaybook();
    d.items.forEach(it => addItem(it, true));
    for (const p of d.plays || []) renderPlay(p);
    renderTrends(d.trends); renderPills();
    for (const ss of d.streams?.sessions || []) { streamState.set(ss.id, ss); (ss.segs || []).filter(x => x.highlight).slice(-15).forEach(addStreamMoment); }
    renderLiveStreams();
    $('#liveDot').classList.add('live');
    if (location.hash === '#keys' && !$('#settings').open) openKeys();
    if (location.hash === '#plays') $('#tabs [data-f="plays"]')?.click();
    if (['#alerts', '#playbook', '#kols'].includes(location.hash)) setTimeout(() => window.elixirGo?.(location.hash.slice(1)), 300);
    if (location.hash === '#settings' && !$('#settings').open) $('#settingsBtn').click();
  });
  es.addEventListener('item', e => addItem(JSON.parse(e.data))); // its play panel is drawn when the card lands
  es.addEventListener('play', e => { const p = JSON.parse(e.data); renderPlay(p); if (state.filter === 'plays') applyFilter(); });
  es.addEventListener('play-removed', e => removePlay(JSON.parse(e.data).id));
  es.addEventListener('risk-memory', e => { state.riskMemory = JSON.parse(e.data); renderPlaybook(); });
  es.addEventListener('stream-session', e => { const m = JSON.parse(e.data); streamState.set(m.id, m); renderLiveStreams(); });
  es.addEventListener('stream-removed', e => { streamState.delete(JSON.parse(e.data).id); renderLiveStreams(); });
  es.addEventListener('stream-seg', e => { const seg = JSON.parse(e.data); if (seg.highlight) addStreamMoment(seg); });
  es.addEventListener('dex', e => onDex(JSON.parse(e.data)));
  es.addEventListener('trends', e => renderTrends(JSON.parse(e.data)));
  es.addEventListener('alert', e => onAlert(JSON.parse(e.data)));
  es.addEventListener('status', e => { state.status = JSON.parse(e.data); renderPills(); });
  es.addEventListener('config', e => { state.config = JSON.parse(e.data); renderPills(); });
  es.onerror = () => { $('#liveDot').classList.remove('live'); renderPills(true); };
}

// Header stat tiles (value on top, label under), like a token header.
const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
function renderPills(disconnected) {
  const c = state.config || {}, s = state.status || {};
  const providerName = { 'twitterapi.io': 'twitterapi.io', 'x-api': 'X API', 'bridge-only': 'X bridge', demo: 'Demo' }[c.provider] || '—';
  const bridgeOn = s.bridgeLastSeen && Date.now() - s.bridgeLastSeen < 90_000;
  const plays = [...state.plays.values()].filter(p => p.status !== 'done');
  const deploys = plays.reduce((n, p) => n + (p.deploys || []).length, 0);
  const tweets = [...state.items.values()].filter(i => i.source !== 'stream').length;
  // Say plainly why tweets aren't arriving.
  const n = $('#feedNotice');
  if (n) {
    const rep = c.keys?._report;
    const where = rep ? (rep.files.length ? ` Elixir read ${rep.files.map(f => f.file + (f.names.length ? ' (' + f.names.slice(0, 6).join(', ') + ')' : ' (empty)')).join('; ')}.` : ' No .env file was found in the Elixir folder.') + (rep.notes?.length ? ' ' + rep.notes[0] + '.' : '') : '';
    const msg = c.provider === 'bridge-only' && !bridgeOn
      ? 'Tweets aren\'t being fetched: no twitterapi.io or X key is loaded.' + where + ' Restart Elixir after editing the file, or paste the key under API keys.'
      : s.lastPollError ? 'Tweet fetching is failing: ' + s.lastPollError
      : s.lastPollWarn ? 'Some accounts failed to load: ' + s.lastPollWarn : '';
    n.hidden = !msg || c.provider === 'demo';
    if (msg) n.innerHTML = `<span>${esc(msg)}</span><button class="ghost small" onclick="openKeys()">API keys</button>`;
  }
  $('#pills').innerHTML = [
    disconnected ? stat('Offline', 'server · retrying', 'bad') : '',
    stat(tweets, 'Tweets'),
    stat(plays.length, 'Plays', plays.length ? 'up' : ''),
    stat(deploys, 'Deploys', deploys ? 'up' : ''),
    stat(state.alertTotal || 0, 'Alerts'),
    stat(esc(providerName), c.provider === 'twitterapi.io' || c.provider === 'x-api'
      ? (s.lastPollError ? 'poll error' : 'polled ' + (s.lastPollAt ? ago(s.lastPollAt) + ' ago' : '…')) : 'Source', s.lastPollError ? 'bad' : ''),
  ].join('');
}
setInterval(() => renderPills(), 5000);

// ---------- feed ----------
function visible(it) {
  if (state.filter === 'all') return true;
  if (state.filter === 'hot') return it.vip || it.watch?.length || it.hot;
  if (state.filter === 'plays') return state.plays.has(it.id);
  return it.source === state.filter || (state.filter === 'x' && it.source === 'manual');
}

function highlight(text, cands, kws) {
  let html = esc(text);
  // Your keywords first, in their colours.
  for (const k of (kws || []).slice().sort((a, b) => b.word.length - a.word.length)) {
    const re = new RegExp('(' + esc(k.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + ')(?![^<]*>)', 'gi');
    html = html.replace(re, `<mark class="kw" style="--kc:${/^#[0-9a-f]{6}$/i.test(k.color) ? k.color : '#e7b54a'}">$1</mark>`);
  }
  if (kws?.length) return html;
  const words = (cands || []).filter(c => c.score >= 2 || c.watch).map(c => c.display.replace(/^[$#]/, '')).filter(w => w.length > 1)
    .sort((a, b) => b.length - a.length);
  if (!words.length) return html;
  const re = new RegExp('(?<![A-Za-z0-9])([$#]?)(' + words.map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])', 'gi');
  const watch = new Set((cands || []).filter(c => c.watch).map(c => c.word));
  return html.replace(re, (m, pre, w) => `<mark class="${watch.has(w.toLowerCase()) ? 'w' : ''}">${pre}${w}</mark>`);
}

function candChip(it, c) {
  const r = it.dex?.[c.word];
  const word = c.display.replace(/^[$#]/, '');
  let st = '<span class="st">…</span>', links = '';
  if (r?.error) st = `<span class="st err" title="${esc(r.error)}">err</span>`;
  else if (r) {
    if (r.status === 'none') st = `<span class="st none" title="No matching token on ${esc((state.config?.chains || []).join(', '))}">NO COIN</span>`;
    else {
      const t = r.top[0];
      st = `<span class="st ${r.status}" title="${r.count} matching token(s)">${r.status === 'fresh' ? 'NEW ' + fmtAge(r.newestAgeMin) : r.count + '×'} ${fmtUsd(t?.marketCap)}</span>`;
      if (t?.address) links += qbHTML(t.address, t.symbol);
      if (t?.links.gmgn) links += `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.gmgn)}">GMGN</a>`;
      if (t?.links.axiom) links += `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.axiom)}">Axiom</a>`;
      if (t?.links.dexscreener) links += `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.dexscreener)}">DS</a>`;
    }
  } else if (!(c.watch || c.score >= (it.source === 'stream' ? 3 : 2))) st = '';
  links += `<a class="lk" target="_blank" rel="noopener" href="${xSearch(word)}" title="Search this word on X (live)">X ↗</a>`;
  return `<span class="cand ${c.watch ? 'watch' : ''}" data-word="${esc(word)}"><span class="w" title="Click to copy, then paste into Axiom / GMGN search">${esc(c.display)}</span>${st}${links}</span>`;
}

// Strong candidates always show; plain lowercase words are capped at two so the row stays readable.
function chipsHTML(it) {
  let weak = 0;
  return (it.candidates || []).filter(c => c.score >= 2 || c.watch || weak++ < 2).map(c => candChip(it, c)).join('');
}

function cardHTML(it) {
  const initial = esc((it.author || '?')[0].toUpperCase());
  const av = it.avatar ? `<img src="${esc(it.avatar)}" alt="" loading="lazy">` : initial;
  const ms = it.latencyMs;
  const latTxt = ms == null ? '' : ms < 120000 ? `+${(ms / 1000).toFixed(1)}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m ago` : `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m ago`;
  const lat = ms != null ? `<span class="lat ${ms < 15000 ? 'fast' : ms > 60000 ? 'slow' : ''}" title="${ms < 120000 ? 'Delay between the tweet being posted and reaching you' : 'Loaded from the last 2 hours when Elixir started'}">${latTxt}</span>` : '';
  const who = it.source === 'stream'
    ? `<span class="handle">${esc(it.author)}</span><span class="badge stream">STREAM</span>`
    : `<a class="handle" href="https://x.com/${esc(it.author)}" target="_blank" rel="noopener">@${esc(it.author)}</a>`;
  const streamLink = (it.links || []).concat((it.text.match(/https?:\/\/\S+/g) || []))
    .find(u => /twitch\.tv\/|youtube\.com\/(watch|live|@)|youtu\.be\/|kick\.com\/|(x|twitter)\.com\/i\/(broadcasts|spaces)\//i.test(u));
  return `<div class="tw">
    <div class="meta">
      <span class="av">${it.source === 'stream' ? 'S' : av}</span>${who}
      ${it.vip ? '<span class="badge vip">VIP</span>' : ''}
      ${it.watch?.length ? '<span class="badge watch">WATCH</span>' : ''}
      <span class="spacer"></span>${lat}
      <time data-t="${it.receivedAt}">${clock(it.receivedAt)}</time>
      ${it.url ? `<a class="lk" href="${esc(it.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}
      <button class="ghost small trackbtn" data-track="${esc(it.id)}" title="Find the 1st/2nd/3rd deploys, rank by real volume, suggest tickers and vamps">Track play</button>
    </div>
    <div class="text">${highlight(it.text, it.candidates, it.kw)}</div>
    ${(it.media || []).length ? `<div class="media">${it.media.slice(0, 2).map(m => `<a href="${esc(m)}" target="_blank" rel="noopener"><img src="${esc(m)}" alt="" loading="lazy"></a>`).join('')}</div>` : ''}
    ${it.engagement && (it.engagement.likes || it.engagement.views) ? `<div class="eng muted small">${fmtNum(it.engagement.likes)} likes · ${fmtNum(it.engagement.reposts)} RT · ${fmtNum(it.engagement.views)} views</div>` : ''}
    ${streamLink ? `<div class="streamlink"><button class="ghost small" data-transcribe="${esc(streamLink)}" data-label="${esc(it.author)}">Transcribe stream</button><a class="lk" href="${esc(streamLink)}" target="_blank" rel="noopener">Open stream ↗</a></div>` : ''}
    <div class="chips">${chipsHTML(it)}</div></div><div class="pp-slot"></div>`;
}

// ---------- plays ----------
const fmtNum = n => n == null ? '0' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const fmtSec = s => s == null ? '?' : s < 0 ? 'before' : s < 90 ? `+${s}s` : s < 5400 ? `+${Math.round(s / 60)}m` : `+${Math.round(s / 3600)}h`;
state.plays = new Map();
state.playSort = lsGet('playSort', 'real');
state.showMode = lsGet('showMode', lsGet('filterOnly', '0') === '1' ? 'filter' : 'all'); // all | filter | safe | both
state.playStats = null;

// PASS: passes the filter preset · PASS?: passes, but a check couldn't be run (fees) · FAIL: fails
function filterBadge(f) {
  if (!f) return '';
  const tip = esc(f.checks.map(c => c.label + (c.ok === true ? ': yes' : c.ok === false ? ': no' : ': not checkable')).join(' · '));
  if (f.pass === true) return `<span class="fb ok" title="${tip}">PASS ${esc(f.preset)} · ${esc(f.column)}</span>`;
  if (f.pass === null) return `<span class="fb maybe" title="${tip}">PASS? ${esc(f.preset)} · ${esc(f.column)}${f.column === 'Graduated' ? ' (fees unchecked)' : ''}</span>`;
  if (f.passedAt) return `<span class="fb was" title="Passed ${esc(f.passedColumn)} at ${esc(clock(f.passedAt))}, fails now: ${tip}">PASSED ${esc(f.passedColumn)} earlier</span>`;
  return `<span class="fb no" title="${tip}">FAIL ${esc(f.preset)}</span>`;
}
const passesFilter = d => d.filter && (d.filter.pass !== false || d.filter.passedAt);

// Risk badge: rugged > high > medium > clean. Hover for every flag.
const isSafe = d => !d.rugged && d.risk && d.risk.level !== 'high';
function riskBadge(d) {
  if (d.rugged) return `<span class="rk rug" title="Market cap fell ${d.rugged.dropPct}% from its peak${d.rugged.pulled ? ' and liquidity was pulled' : ''}. Creator and bundle wallets saved to memory.">RUGGED −${d.rugged.dropPct}%</span>`;
  const r = d.risk;
  if (!r) return '<span class="rk na" title="Risk check running">risk …</span>';
  const tip = esc(r.flags.filter(f => f.level !== 'info').map(f => `${f.level.toUpperCase()}: ${f.label}${f.detail ? ' (' + f.detail + ')' : ''}`).join('\n') || 'No red flags found');
  if (r.level === 'high') return `<span class="rk high" title="${tip}">RISK · ${esc(r.headline)}</span>`;
  if (r.level === 'medium') return `<span class="rk med" title="${tip}">CAUTION · ${esc(r.headline)}</span>`;
  if (r.level === 'low') return `<span class="rk low" title="${tip}">CLEAN</span>`;
  return '';
}

// The top deploy, live: did the coin actually take off? Volume in the last 5 minutes decides it.
function liveCoinHTML(p, top) {
  if (!top) return '';
  const v5 = top.vol5m || 0, tr = top.trades5m || 0;
  const verdict = v5 >= 10000 && tr >= 40 ? ['up', 'Took off: real volume'] : v5 >= 1500 || tr >= 15 ? ['mid', 'Getting volume'] : ['no', 'Deployed, no traction yet'];
  const chartOpen = state.openCharts?.has(p.id);
  const pairId = top.pairAddress || top.address;
  return `<div class="livecoin">
    <span class="lc-img">${top.image || top.address ? `<img src="${esc(coinImg(top.address, top.image))}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc((top.symbol || '?').slice(0, 2))}</i></span>
    <div class="lc-main"><b>$${esc(top.symbol)}</b>${qbHTML(top.address, top.symbol)}<span class="muted">${esc(top.name || '')} · ${esc(top.padLabel || '')} · ${esc(top.orderLabel || '')} deploy</span></div>
    <div class="lc-stat"><b>${fmtUsd(top.marketCap)}</b><span>mcap${top.change5m != null ? ` · <i class="${top.change5m >= 0 ? 'pos' : 'neg'}">${top.change5m >= 0 ? '+' : ''}${top.change5m}%</i> 5m` : ''}</span></div>
    <div class="lc-stat"><b>${fmtUsd(v5)}</b><span>vol 5m · ${tr} trades</span></div>
    <span class="lc-verdict ${verdict[0]}">${verdict[1]}</span>
    <span class="lc-links"><a class="lk" target="_blank" rel="noopener" href="${esc(top.links.axiom)}">Axiom</a><a class="lk" target="_blank" rel="noopener" href="${esc(top.links.gmgn)}">GMGN</a>${top.links.pumpfun ? `<a class="lk" target="_blank" rel="noopener" href="${esc(top.links.pumpfun)}">pump.fun</a>` : ''}<button class="ghost small" data-chart="${esc(p.id)}">${chartOpen ? 'Hide chart' : 'Chart'}</button></span>
    ${chartOpen ? `<iframe class="lc-chart" src="https://dexscreener.com/solana/${encodeURIComponent(pairId)}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=marketCap&interval=1" loading="lazy" title="Live chart"></iframe>` : ''}
  </div>`;
}

function playPanelHTML(p) {
  let list = [...p.deploys].sort((a, b) => state.playSort === 'order' ? a.order - b.order : b.vol.real - a.vol.real);
  const passing = p.deploys.filter(passesFilter).length;
  const safe = p.deploys.filter(isSafe).length;
  const mode = state.showMode;
  if (mode === 'filter' || mode === 'both') list = list.filter(passesFilter);
  if (mode === 'safe' || mode === 'both') list = list.filter(isSafe);
  const top = list.length ? [...p.deploys].sort((a, b) => b.vol.real - a.vol.real)[0] : null;
  // The coin with the most real volume that isn't flagged high-risk or rugged.
  const topClean = [...p.deploys].filter(isSafe).sort((a, b) => b.vol.real - a.vol.real)[0];
  const ideas = p.aiIdeas || p.ideas || {};
  const expanded = state.expandedPlays?.has(p.id);
  const rows = list.slice(0, expanded ? list.length : 6).map(d => `
    <tr class="${top && d.address === top.address ? 'winner' : ''} ${d.vampOf ? 'vamped' : ''} ${d.rugged ? 'rugrow' : ''}">
      <td><span class="ord o${Math.min(d.order, 4)}">${esc(d.orderLabel)}</span></td>
      <td class="dcoin"><b data-word="${esc(d.symbol)}">$${esc(d.symbol)}</b><div class="muted small">${esc(d.name)}</div>
        ${topClean && d.address === topClean.address && topClean !== top ? '<span class="rk topclean" title="Most real volume among coins without high-risk flags">TOP CLEAN</span>' : ''}${riskBadge(d)}${filterBadge(d.filter)}${d.flags.filter(f => f !== 'OG').map(f => `<span class="flag">${esc(f)}</span>`).join('')}</td>
      <td><span class="pad" style="--c:${esc(d.padColor || '#888')}">${esc(d.padLabel)}</span><div class="muted small">${fmtSec(d.afterTweetSec)}</div></td>
      <td class="num">${fmtUsd(d.marketCap)}</td>
      <td class="num" title="${esc(d.vol.flags.join(', ') || 'looks organic')} · ${d.vol.trades} trades · avg $${d.vol.avgTrade ?? '?'}">
        <b>${fmtUsd(d.vol.real)}</b><div class="small q-${esc(d.vol.quality.split(' ')[0])}">${esc(d.vol.quality)}${d.vol.factor < 1 ? ` · raw ${fmtUsd(d.vol.raw)}` : ''}</div></td>
      <td class="lks"><a class="lk" target="_blank" rel="noopener" href="${esc(d.links.gmgn)}">GMGN</a><a class="lk" target="_blank" rel="noopener" href="${esc(d.links.axiom)}">Axiom</a>${d.links.pumpfun ? `<a class="lk" target="_blank" rel="noopener" href="${esc(d.links.pumpfun)}">pump</a>` : ''}</td>
    </tr>`).join('');
  const st = state.playStats;
  const hint = st && st.plays >= 3
    ? `Playbook (${st.plays} plays): winner pad ${Object.entries(st.padWins).sort((a, b) => b[1].pct - a[1].pct).slice(0, 2).map(([k, v]) => `${k} ${v.pct}%`).join(', ')} · winner was the ${Object.entries(st.orderWins).sort((a, b) => b[1].pct - a[1].pct)[0]?.[0] || '?'} deploy most often`
    : 'Playbook: learning from your plays. Stats appear after 3 finished plays.';
  // Real vamps = the name relaunched on a different launchpad. Same-pad repeats are just copies.
  const detected = p.deploys.filter(d => d.vampOf && d.vampOf.pad !== d.padLabel);
  const copies = p.deploys.filter(d => d.vampOf && d.vampOf.pad === d.padLabel).length;
  return `${liveCoinHTML(p, top)}
    <div class="pp-head">
      <b>PLAY</b><span class="muted small">${p.status === 'tracking' ? 'tracking' : esc(p.status)} · ${p.deploys.length} deploy${p.deploys.length === 1 ? '' : 's'}${p.lastPollAt ? ' · ' + clock(p.lastPollAt) : ''}</span>
      <span class="spacer"></span>
      <span class="seg"><button data-psort="real" class="${state.playSort === 'real' ? 'on' : ''}">Real vol</button><button data-psort="order" class="${state.playSort === 'order' ? 'on' : ''}">Deploy order</button></span>
      <select class="showsel" data-showmode title="Which deploys to show">
        <option value="all" ${mode === 'all' ? 'selected' : ''}>All ${p.deploys.length}</option>
        <option value="filter" ${mode === 'filter' ? 'selected' : ''}>${esc(state.config?.filter?.label || 'Filter')} pass ${passing}</option>
        <option value="safe" ${mode === 'safe' ? 'selected' : ''}>Low risk ${safe}</option>
        <option value="both" ${mode === 'both' ? 'selected' : ''}>Both ${p.deploys.filter(d => passesFilter(d) && isSafe(d)).length}</option>
      </select>
      <button class="ghost small" data-untrack="${esc(p.id)}" title="Stop tracking">Stop</button>
    </div>
    ${mode !== 'all' && p.deploys.length && !list.length ? `<div class="muted small pp-wait">No deploy matches this view yet.</div>` : ''}
    ${list.length ? `<table class="deploys"><thead><tr><th>Deploy</th><th>Coin</th><th>Pad</th><th>MCap</th><th>Real vol</th><th></th></tr></thead><tbody>${rows}</tbody></table>${list.length > 6 ? `<button class="ghost small more" data-expand="${esc(p.id)}">${expanded ? 'Show top 6' : `Show all ${list.length} deploys`}</button>` : ''}`
      : p.deploys.length ? '' : `<div class="muted small pp-wait">Watching Pump, Float, Bags and Raydium for deploys of ${p.terms.map(t => '“' + esc(t) + '”').join(', ')}…</div>`}
    ${p.preexisting.length ? `<div class="muted small pre">Already existed before the tweet: ${p.preexisting.map(d => `<a class="lk" target="_blank" rel="noopener" href="${esc(d.links.gmgn)}">$${esc(d.symbol)} ${esc(d.padLabel)} ${fmtUsd(d.marketCap)}</a>`).join(' ')}</div>` : ''}
    <div class="pp-grid">
      <div><h4>Ticker ideas ${p.aiIdeas ? '<span class="ai">by Claude</span>' : ''}</h4>
        <div class="pchips">${(ideas.tickers || []).map(t => `<span class="chip" data-word="${esc(t.ticker)}" title="${esc(t.why)}"><span class="w">$${esc(t.ticker)}</span></span>`).join('')}</div></div>
      <div><h4>Likely coin image</h4><ul class="ideas">${(ideas.images || []).slice(0, 3).map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>
    </div>
    ${ideas.narrative ? `<div class="narr">${esc(ideas.narrative)}</div>` : ''}
    ${imageRefsHTML(p)}
    <details class="vamp"${detected.length ? ' open' : ''}><summary>Vamp watch${detected.length ? ` · <b>${detected.length} vamp${detected.length === 1 ? '' : 's'} live</b>` : ''}</summary>
      ${copies ? `<div class="muted small" style="margin-top:6px">+ ${copies} same-launchpad cop${copies === 1 ? 'y' : 'ies'} (not counted as vamps)</div>` : ''}
      ${detected.length ? `<div class="vlive">${detected.map(d => `<div><b data-word="${esc(d.symbol)}">$${esc(d.symbol)}</b> on ${esc(d.padLabel)} vamps the ${esc(ordinalLabel(d.vampOf.order))} ($${esc(d.vampOf.symbol)}, ${esc(d.vampOf.pad)}) · real vol ${fmtUsd(d.vol.real)}</div>`).join('')}</div>` : ''}
      <ul class="vlist">${(ideas.vamps || []).map(v => `<li><b data-word="${esc(v.ticker)}">${esc(v.name)} · $${esc(v.ticker)}</b> <span class="pad mini">${esc(v.launchpad)}</span>
        <div class="muted small">${esc(v.angle)}</div><div class="small">Pairs with: ${esc(v.pairsWith)}</div></li>`).join('')}</ul>
    </details>
    <div class="muted small hint">${esc(hint)}</div>`;
}
// Visual references for the coin image: tweet photo, what deployers used, same-name coins,
// the subject on Wikipedia, meme templates, established coins. Claude's pick is outlined.
function imageRefsHTML(p) {
  const groups = [];
  if (p.media?.length) groups.push({ title: 'Tweet photo', items: p.media.slice(0, 2).map(u => ({ label: 'tweet photo', sub: '', image: u, url: u })) });
  const deps = [...p.deploys].filter(d => d.image).sort((a, b) => b.vol.real - a.vol.real).slice(0, 4);
  if (deps.length) groups.push({ title: 'What deployers used', items: deps.map(d => ({ label: '$' + d.symbol, sub: `${d.orderLabel} · ${d.padLabel}`, image: d.image, url: d.links.gmgn })) });
  for (const g of p.images?.groups || []) groups.push(g);
  if (!groups.length) return p.images ? '' : '<div class="muted small imgref">Searching coins, memes, animals and chains for image references…</div>';
  const pick = p.imagePick?.candidate?.image;
  const safeHref = u => (/^https:\/\//.test(u || '') ? esc(u) : '#');
  return `<div class="imgref"><h4>Image references ${p.imagePick ? '<span class="ai">pick by Claude</span>' : ''}</h4>
    ${p.imagePick ? `<div class="pick">Most likely: ${esc(p.imagePick.description)} <span class="muted">${esc(p.imagePick.why)}</span></div>` : ''}
    ${groups.map(g => `<div class="ir-g"><div class="ir-t">${esc(g.title)}</div><div class="ir-row">${g.items.map(it => `<a class="ir ${it.image === pick ? 'picked' : ''}" href="${safeHref(it.url)}" target="_blank" rel="noopener" title="${esc(it.label)}${it.sub ? ' · ' + esc(it.sub) : ''}"><img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${esc(it.label)}</span><small>${esc(it.sub || '')}</small></a>`).join('')}</div></div>`).join('')}
  </div>`;
}
const ordinalLabel = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

function renderPlay(p) {
  state.plays.set(p.itemId, p);
  const card = document.getElementById('it-' + p.itemId);
  if (!card) return;
  card.classList.add('has-play');
  const slot = card.querySelector('.pp-slot');
  slot.className = 'pp-slot play-panel';
  // Keep an open live chart across re-renders (the panel updates every few seconds; reloading the chart would flicker).
  const oldChart = slot.querySelector('.lc-chart');
  slot.innerHTML = playPanelHTML(p);
  const newChart = slot.querySelector('.lc-chart');
  if (oldChart && newChart && oldChart.src === newChart.src) newChart.replaceWith(oldChart);
  card.querySelector('.trackbtn').hidden = true;
}

function removePlay(id) {
  for (const [itemId, p] of state.plays) if (p.id === id) {
    state.plays.delete(itemId);
    const card = document.getElementById('it-' + itemId);
    if (card) { card.classList.remove('has-play'); const slot = card.querySelector('.pp-slot'); slot.className = 'pp-slot'; slot.innerHTML = ''; card.querySelector('.trackbtn').hidden = false; }
  }
}

function renderPlaybook() {
  const st = state.playStats;
  const box = $('#playbook');
  if (!box || !st) return;
  const bar = (k, v) => `<div class="pb-row"><span>${esc(k)}</span><div class="bar" style="width:${Math.max(4, v.pct)}%"></div><b>${v.pct}%</b></div>`;
  box.innerHTML = st.plays
    ? `<div class="small muted">${st.plays} finished plays · the coin with the most real volume was on:</div>${Object.entries(st.padWins).sort((a, b) => b[1].pct - a[1].pct).map(([k, v]) => bar(k, v)).join('')}
       <div class="small muted" style="margin-top:8px">…and was the deploy number:</div>${Object.entries(st.orderWins).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => bar(k, v)).join('')}
       <div class="small" style="margin-top:8px">Vamps ended up on top in <b>${st.vampWinPct}%</b> of plays · Float vamped a Pump coin in ${st.floatVamp.plays} play(s) and won ${st.floatVamp.won}.</div>`
    : '<span class="muted small">No finished plays yet. Every tracked play is logged, and after it ends (3h) this shows which launchpad and which deploy slot usually wins.</span>';
  box.innerHTML += `<ul class="notes">${(st.notes || []).map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
  const m = state.riskMemory;
  if (m) box.innerHTML += `<div class="rugmem"><div class="small"><b>Rug memory</b> · ${m.rugs} rugs logged · ${m.rugCreators} rugger dev wallet(s) · ${m.rugWallets} bundle/rug wallet(s)</div>
    <details><summary class="small muted">Import wallets or coins (e.g. from FlipDesk or your notes)</summary>
      <textarea id="rugImport" rows="4" placeholder="One per line. Examples:&#10;creator 7xKX…  (a dev wallet that rugged)&#10;mint CzLS…pump  (a rugged coin)&#10;9WzD…  (a bundler / rug wallet)"></textarea>
      <button class="ghost small" id="rugImportBtn">Import</button></details></div>`;
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-track]');
  if (t) { t.disabled = true; try { renderPlay(await api('/api/plays/track', { itemId: t.dataset.track })); } catch (err) { toast({ title: 'Could not track', text: err.message }); t.disabled = false; } return; }
  const u = e.target.closest('[data-untrack]');
  if (u) { await api('/api/plays/untrack', { id: u.dataset.untrack }); removePlay(u.dataset.untrack); return; }

  const ex = e.target.closest('[data-expand]');
  if (ex) {
    state.expandedPlays = state.expandedPlays || new Set();
    state.expandedPlays.has(ex.dataset.expand) ? state.expandedPlays.delete(ex.dataset.expand) : state.expandedPlays.add(ex.dataset.expand);
    for (const p of state.plays.values()) if (p.id === ex.dataset.expand) renderPlay(p);
    return;
  }
  const ps = e.target.closest('[data-psort]');
  if (ps) { state.playSort = ps.dataset.psort; lsSet('playSort', state.playSort); for (const p of state.plays.values()) renderPlay(p); return; }
  const tr = e.target.closest('[data-transcribe]');
  if (tr) {
    try { await api('/api/streams/start', { url: tr.dataset.transcribe, label: tr.dataset.label }); window.open('/streams.html', '_blank'); }
    catch (err) { toast({ title: 'Could not start the stream', text: err.message }); }
  }
});

// Cards are inserted in batches (one layout per frame) instead of one at a time.
const pendingCards = [];
let cardFrame = 0;
function addItem(it, quiet) {
  it.dex = it.dex || {};
  state.items.set(it.id, it);
  pendingCards.push([it, quiet]);
  if (!cardFrame) cardFrame = requestAnimationFrame(flushCards);
}
function flushCards() {
  cardFrame = 0;
  const batch = pendingCards.splice(0);
  if (!batch.length) return;
  const feed = $('#feed');
  const keepY = $('#pauseFeed').checked && window.scrollY > 120 ? window.scrollY : null;
  const before = keepY != null ? feed.scrollHeight : 0;
  const frag = document.createDocumentFragment();
  for (let i = batch.length - 1; i >= 0; i--) { const el = buildCard(...batch[i]); if (el) frag.appendChild(el); }
  feed.prepend(frag);
  if (keepY != null) window.scrollTo(0, keepY + (feed.scrollHeight - before));
  // Not paused: follow the newest tweet (matters most in a small pop-out window).
  else if (document.documentElement.classList.contains('pop-view') && !$('#pauseFeed').checked && !batch.every(([, q]) => q) && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  while (feed.children.length > 150) { const last = feed.lastElementChild; state.items.delete(last.id.slice(3)); last.remove(); }
  $('#feedEmpty').hidden = state.items.size > 0;
  for (const [it] of batch) { const p = state.plays.get(it.id); if (p && document.getElementById('it-' + it.id)) renderPlay(p); }
}
function buildCard(it, quiet) {
  if (!state.items.has(it.id)) return null;
  document.getElementById('it-' + it.id)?.remove();
  const el = document.createElement('article');
  el.className = `card ${it.source} ${it.vip ? 'vip' : ''} ${it.watch?.length ? 'watch' : ''} ${it.stale ? 'stale' : ''}`;
  el.id = 'it-' + it.id;
  el.innerHTML = cardHTML(it);
  el.hidden = !visible(it);
  if (quiet) el.style.animation = 'none';
  return el;
}

function onDex(d) {
  const it = state.items.get(d.itemId);
  if (!it) return;
  it.dex[d.word] = d;
  const el = document.getElementById('it-' + it.id);
  if (el) el.querySelector('.chips').innerHTML = chipsHTML(it);
}

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.filter = b.dataset.f;
  $('#tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  applyFilter();
});
function applyFilter() {
  let shown = 0;
  for (const it of state.items.values()) {
    const el = document.getElementById('it-' + it.id);
    if (el) { el.hidden = !visible(it); if (!el.hidden) shown++; }
  }
  const empty = $('#feedEmpty');
  if (state.filter === 'plays' && !shown) {
    empty.hidden = false;
    empty.innerHTML = '<b>No plays yet.</b> A play starts by itself when a tracked account tweets something coin-able and coins start deploying, or when a streamer says something there\'s a coin for. Press <b>Track play</b> on any tweet to start one yourself. Each play lists the 1st/2nd/3rd deploys ranked by real volume and pings at 20K/50K/100K.';
  } else if (state.filter === 'hot' && !shown) {
    empty.hidden = false; empty.textContent = 'No alerts in the feed yet.';
  } else {
    empty.hidden = state.items.size > 0;
    if (!empty.dataset.orig) empty.dataset.orig = empty.innerHTML; else empty.innerHTML = empty.dataset.orig;
  }
}

// Click a word: copy it (paste into Axiom / GMGN search) and run a quick check.
document.addEventListener('click', e => {
  const w = e.target.closest('.cand .w, .chip[data-word], .play-panel b[data-word]');
  if (!w) return;
  const word = (w.closest('[data-word]')?.dataset.word || w.textContent).replace(/^[$#]/, '');
  navigator.clipboard?.writeText(word).catch(() => {});
  const chip = w.closest('.cand'); if (chip) { chip.classList.add('copied'); setTimeout(() => chip.classList.remove('copied'), 900); }
  toast({ kind: 'fresh', title: `Copied “${word}”`, text: 'Paste it into Axiom or GMGN search.' }, 1600);
  runLookup(word);
});

// ---------- trends ----------
function renderTrends(list) {
  const box = $('#trends');
  list = (list || []).filter(t => t.count >= 2); // a word seen once isn't a trend
  if (!list?.length) { box.innerHTML = '<span class="muted">Words that keep coming up will appear here.</span>'; return; }
  const max = Math.max(...list.map(t => t.last5 || t.count), 1);
  box.innerHTML = list.slice(0, 15).map(t => `
    <div class="trend" data-word="${esc(t.word)}">
      <div><b>${esc(t.word)}</b><div class="bar" style="width:${Math.max(6, ((t.last5 || 0) / max) * 100)}%"></div></div>
      <span class="src">${t.sources.map(s => s === 'stream' ? 'stream' : s === 'x' ? 'X' : 'paste').join(' ')}${t.authors > 1 ? ' · ' + t.authors + ' accts' : ''}</span>
      <span class="n" title="mentions in last 5 min / 15 min">${t.last5}/${t.count}</span>
    </div>`).join('');
}
$('#trends').addEventListener('click', e => { const t = e.target.closest('.trend'); if (t) runLookup(t.dataset.word); });

// ---------- lookup ----------
function riskReportHTML(r) {
  const rows = r.flags.filter(f => f.level !== 'info').map(f => `<li class="rf ${esc(f.level)}"><b>${esc(f.level.toUpperCase())}</b> ${esc(f.label)}${f.detail ? `<span class="muted"> · ${esc(f.detail)}</span>` : ''}</li>`).join('');
  const info = r.flags.filter(f => f.level === 'info').map(f => `<li class="rf info">${esc(f.label)}${f.detail ? ' · ' + esc(f.detail) : ''}</li>`).join('');
  return `<div class="riskrep ${esc(r.level)}"><div class="rr-head"><b>${esc(r.level.toUpperCase())} RISK</b> <span class="muted">score ${r.score}/100 · ${esc(r.sources.join(', ') || 'no sources')}</span></div>
    ${r.bundle ? `<div class="small">Bundle: ${r.bundle.wallets} wallet(s), ${r.bundle.pct}% of supply in the creation block</div>` : ''}
    ${r.dev ? `<div class="small">Dev: bought ${r.dev.boughtPct}% · holds ${r.dev.holdPct ?? '?'}%${r.dev.soldPct != null ? ' · sold ' + r.dev.soldPct + '%' : ''}</div>` : ''}
    ${r.holders != null ? `<div class="small">Holders: ${r.holders}${r.top10Pct != null ? ' · top 10 hold ' + Math.round(r.top10Pct) + '%' : ''}</div>` : ''}
    <ul class="rflist">${rows || '<li class="rf low">No red flags found</li>'}${info}</ul></div>`;
}
async function runRisk(mint, target) {
  target.innerHTML = '<div class="verdict muted">Checking bundles, dev wallet, holders and rug memory…</div>';
  try { target.innerHTML = riskReportHTML(await api('/api/risk', { mint })); }
  catch (err) { target.innerHTML = `<div class="verdict" style="color:var(--hot)">Risk check failed: ${esc(err.message)}</div>`; }
}

async function runLookup(word) {
  word = word.trim().replace(/^[$#]/, '');
  if (!word) return;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) { $('#lookupInput').value = word; return runRisk(word, $('#lookupOut')); }
  $('#lookupInput').value = word;
  const out = $('#lookupOut');
  out.innerHTML = `<div class="verdict muted">Checking “${esc(word)}”…</div>`;
  try {
    const r = await api('/api/lookup', { word });
    if (r.error) throw new Error(r.error);
    const verdict = r.status === 'none'
      ? `<b style="color:var(--none)">No coin yet</b> for “${esc(word)}” on ${esc((state.config?.chains || []).join(', '))}. Watch for a launch.`
      : r.status === 'fresh'
        ? `<b style="color:var(--fresh)">Fresh:</b> newest launched ${fmtAge(r.newestAgeMin)} ago · ${r.count} match(es)`
        : `<b>${r.count} existing</b> token(s) · newest ${fmtAge(r.newestAgeMin)} old`;
    out.innerHTML = `<div class="verdict">${verdict} · <a href="${xSearch(word)}" target="_blank" rel="noopener">live X search ↗</a></div>` +
      r.top.map(t => `
        <div class="tok">
          <span class="nm">${esc(t.symbol)} <span class="muted small">${esc(t.name)} · ${esc(t.chain)}/${esc(t.dex)}</span></span>
          <span class="links">
            ${t.links.gmgn ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.gmgn)}">GMGN</a>` : ''}
            ${t.links.axiom ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.axiom)}">Axiom</a>` : ''}
            ${t.links.pumpfun ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.pumpfun)}">pump</a>` : ''}
            <a class="lk" target="_blank" rel="noopener" href="${esc(t.links.dexscreener)}">DS</a>
            <button class="ghost small" data-riskmint="${esc(t.address)}">Risk</button>
          </span>
          <span class="nums">${t.pad ? esc(t.pad) + ' · ' : ''}mcap ${fmtUsd(t.marketCap)} · liq ${fmtUsd(t.liquidityUsd)} · 5m vol ${fmtUsd(t.volume5m)} · 5m ${t.change5m ?? '—'}% · age ${t.createdAt ? fmtAge((Date.now() - t.createdAt) / 60000) : '?'}</span>
          ${t.filter ? `<span class="nums">${filterBadge(t.filter)}</span>` : ''}
          <div class="riskslot"></div>
        </div>`).join('');
  } catch (err) {
    out.innerHTML = `<div class="verdict" style="color:var(--hot)">Lookup failed: ${esc(err.message)}</div>`;
  }
}
$('#lookupForm').addEventListener('submit', e => { e.preventDefault(); runLookup($('#lookupInput').value); });
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#lookupInput').focus(); $('#lookupInput').select(); }
});

// ---------- alerts ----------
let audioCtx;
function beep(kind) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = { vip: [880, 1175], watch: [988, 1319, 988], fresh: [660, 990], open: [523, 784], back: [523, 659, 784], trend: [740, 740] }[kind] || [880];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.13;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.13);
    });
  } catch {}
}

function toast(a, ms = 7000) {
  const el = document.createElement('div');
  el.className = 'toast k-' + (a.kind || 'none');
  el.innerHTML = `<b>${esc(a.title)}</b><p>${a.author ? '@' + esc(a.author) + ': ' : ''}${esc((a.text || '').slice(0, 160))}</p>`;
  el.onclick = () => el.remove();
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 3) $('#toasts').lastElementChild.remove();
}

const recentAlerts = new Map();
function onAlert(a) {
  const key = a.kind + ':' + (a.word || a.itemId);
  if (recentAlerts.has(key) && Date.now() - recentAlerts.get(key) < 15000) return;
  recentAlerts.set(key, Date.now());
  const it = state.items.get(a.itemId); if (it) it.hot = true;
  const loud = a.important !== false;
  const mine = loud && (window.elixirClaimNoise ? window.elixirClaimNoise(a.title + '|' + a.at) : true);
  if (mine && Date.now() - (state.lastBeep || 0) > 8000) { state.lastBeep = Date.now(); beep(a.kind); }
  if (loud && !window.elixirQuietToasts) toast(a);
  if (a.important !== false) { state.alertCount++; } state.alertTotal = (state.alertTotal || 0) + 1;
  document.title = `(${state.alertCount}) Elixir`;
  if (mine && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(a.title, { body: (a.author ? '@' + a.author + ': ' : '') + (a.text || ''), tag: key });
    n.onclick = () => { window.focus(); if (a.url) window.open(a.url, '_blank'); };
  }
  const box = $('#alerts');
  box.querySelector('.placeholder')?.remove();
  const row = document.createElement('div');
  row.className = 'al k-' + a.kind + (loud ? '' : ' quiet');
  row.innerHTML = `<time>${clock(a.at)}</time><b>${esc(a.title)}</b><div class="muted">${a.author ? '@' + esc(a.author) + ': ' : ''}${esc((a.text || '').slice(0, 120))}</div>`;
  row.onclick = () => { const el = document.getElementById('it-' + a.itemId); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (a.word) runLookup(a.word); };
  box.prepend(row);
  while (box.children.length > 60) box.lastElementChild.remove();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.alertCount = 0; document.title = 'Elixir'; } });
$('#clearAlerts').onclick = () => { $('#alerts').innerHTML = '<span class="muted placeholder">No alerts yet.</span>'; };

const soundBtn = $('#soundBtn');
const paintSound = () => { soundBtn.innerHTML = state.sound ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>' : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>'; soundBtn.title = 'Alert sound: ' + (state.sound ? 'on' : 'off'); soundBtn.classList.toggle('off', !state.sound); };
paintSound();
soundBtn.onclick = () => { state.sound = !state.sound; lsSet('sound', state.sound ? '1' : '0'); paintSound(); beep('open'); };
$('#notifBtn').onclick = async () => {
  if (!('Notification' in window)) return toast({ title: 'Notifications not supported in this browser' });
  const p = await Notification.requestPermission();
  toast({ kind: p === 'granted' ? 'fresh' : '', title: p === 'granted' ? 'Desktop notifications on' : 'Notifications blocked', text: p === 'granted' ? 'You will get a popup when the tab is in the background.' : 'Allow them in your browser site settings.' });
};
$('#testBtn').onclick = () => api('/api/test-alert');

// ---------- paste ----------
$('#pasteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#pasteText').value.trim(); if (!text) return;
  await api('/api/ingest', { source: 'manual', text, author: $('#pasteAuthor').value.trim() || 'you' });
  $('#pasteText').value = '';
});

// ---------- stream moments (full view on /streams.html) ----------
const streamState = new Map(); // session id -> meta
function renderLiveStreams() {
  const live = [...streamState.values()].filter(s => !s.endedAt);
  $('#liveStreams').innerHTML = live.length
    ? live.map(s => `<a class="lsrc" href="/streams.html">${srcAvatar(s.profile, s.label, 22)}<b>${esc(srcName(s.profile, s.label))}</b><span class="muted">${esc(s.status)}</span></a>`).join('')
    : 'No streams running. <a href="/streams.html">Start one</a> or add channels to auto-watch.';
}
function addStreamMoment(seg) {
  const box = $('#streamMoments');
  box.querySelector('.placeholder')?.remove();
  let row = box.querySelector(`[data-id="${CSS.escape(seg.id)}"]`);
  if (!row) { row = document.createElement('div'); row.dataset.id = seg.id; box.prepend(row); }
  const s = streamState.get(seg.sid);
  const order = ['WATCH', 'COINABLE', 'CRYPTO', 'FUNNY', 'MEME', 'LOUD', 'HYPE', 'REPEAT'];
  const tags = (seg.tags || []).filter(t => order.includes(t)).sort((x, y) => order.indexOf(x) - order.indexOf(y));
  row.className = 'al k-' + (tags.includes('FUNNY') ? 'funny' : tags.includes('COINABLE') || tags.includes('WATCH') ? 'vip' : 'fresh');
  const kws = (seg.keywords || []).filter(k => ['coinable', 'watch', 'ai', 'repeat', 'meme'].includes(k.kind)).slice(0, 4);
  row.innerHTML = `<time>${clock(seg.t)}</time>${srcAvatar(s?.profile, s?.label, 18)}<b>${esc(srcName(s?.profile, s?.label || 'stream'))}</b>${seg.speakerName ? ' · ' + esc(seg.speakerName) : ''} ${tags.map(t => `<span class="tg ${esc(t)}">${esc(t)}</span>`).join(' ')}
    <div>${esc(seg.text.slice(0, 200))}</div>
    ${seg.ai?.why ? `<div class="muted">Claude: ${esc(seg.ai.why)}</div>` : ''}
    ${kws.length ? `<div class="chips">${kws.map(k => `<span class="chip" data-word="${esc(k.text)}"><span class="w">${esc(k.text)}</span></span>`).join('')}</div>` : ''}`;
  while (box.children.length > 40) box.lastElementChild.remove();
}

// ---------- settings ----------
$('#settingsBtn').onclick = () => {
  const c = state.config || {}, f = $('#settingsForm');
  $('#setAccN').textContent = (c.accounts || []).length + ' tracked';
  $('#setKwN').textContent = (c.keywords || []).length + ' keywords';
  f.ignore.value = (c.ignore || []).join(', ');
  f.pollSeconds.value = c.pollSeconds || 8;
  f.chains.value = (c.chains || []).join(', ');
  f.includeReplies.checked = !!c.includeReplies;
  f.openBrowser.checked = c.openBrowser !== false;
  f.notify.value = c.notify || 'important';
  const fp = c.filter || {};
  f.fLabel.value = fp.label || '';
  f.npAge.value = fp.newPairs?.maxAgeMin ?? ''; f.npVol.value = fp.newPairs?.minVolume ?? '';
  f.fsMcap.value = fp.finalStretch?.minMcap ?? ''; f.fsVol.value = fp.finalStretch?.minVolume ?? ''; f.fsAge.value = fp.finalStretch?.maxAgeMin ?? '';
  f.grFees.value = fp.graduated?.minFeesSol ?? '';
  $('#providerLine').textContent = {
    'twitterapi.io': 'Tweets: polling twitterapi.io.',
    'x-api': 'Tweets: polling the official X API.',
    'bridge-only': 'No API key set, so tweets come only from the X browser bridge or the paste box. Add a twitterapi.io or X key below to poll.',
    demo: 'Demo mode: tweets and market data are fake.',
  }[c.provider] || '';
  paintKeys();
  $('#settings').showModal();
};
$('#settingsForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  const f = e.target;
  state.config = await api('/api/config', {
    ignore: f.ignore.value,
    pollSeconds: f.pollSeconds.value, chains: f.chains.value, includeReplies: f.includeReplies.checked, openBrowser: f.openBrowser.checked, notify: f.notify.value,
    ...(state.resetFilter ? { filterReset: true } : { filter: { label: f.fLabel.value, npAge: f.npAge.value, npVol: f.npVol.value, fsMcap: f.fsMcap.value, fsVol: f.fsVol.value, fsAge: f.fsAge.value, grFees: f.grFees.value } }),
  });
  state.resetFilter = false;
  renderPills();
  toast({ kind: 'fresh', title: 'Settings saved' }, 2000);
});

// ---------- API keys ----------
const KEY_ROWS = [
  ['SOLANA_WS_URL', 'Solana RPC websocket', 'Optional: works on the free public RPC; Helius is faster for big wallet lists', 'https://dashboard.helius.dev', 'Free at Helius → paste your API key or the RPC URL', 'wss://mainnet.helius-rpc.com/?api-key=…'],
  ['SOLSCAN_API_KEY', 'Solscan Pro API', 'Whales: wallet names (exchanges, funds) and instant "funded by" lookups. Works without it, just slower and unlabelled', 'https://pro-api.solscan.io', 'Solscan → API plans → API key (Pro API, paid)', 'eyJhbGci…'],
  ['DEEPGRAM_API_KEY', 'Deepgram', 'Live stream transcription from a link', 'https://console.deepgram.com', 'Free credit → API Keys → Create', ''],
  ['ANTHROPIC_API_KEY', 'Anthropic (Claude)', 'Funny / meme-worthy judging, ticker & image ideas', 'https://console.anthropic.com/settings/keys', 'Pay per use → API Keys → Create', 'sk-ant-…'],
  ['TWITTERAPI_IO_KEY', 'twitterapi.io', 'Pull tweets by API (instead of the free browser bridge)', 'https://twitterapi.io', 'Paid · Dashboard → API key', ''],
  ['X_BEARER_TOKEN', 'X API bearer token', 'Official X API (also backs up twitterapi.io when it runs out)', 'https://developer.x.com/en/portal/dashboard', 'App → Keys and tokens → Bearer Token (not the API key/secret)', 'AAAAAAAAAAAAAAAAAAAAA…'],
  ['X_BEARER_TOKEN_2', 'Second X bearer token', 'Used when the first one hits its rate limit', 'https://developer.x.com/en/portal/dashboard', 'A bearer token from another X app or account', 'AAAAAAAAAAAAAAAAAAAAA…'],
  ['TELEGRAM_BOT_TOKEN', 'Telegram bot token', 'Pings on your phone', 'https://t.me/BotFather', 'Message @BotFather → /newbot', '123456:ABC…'],
  ['TELEGRAM_CHAT_ID', 'Telegram chat ID', 'Where the pings go', 'https://t.me/userinfobot', 'Message @userinfobot → copy your Id', ''],
  ['DISCORD_WEBHOOK_URL', 'Discord webhook', 'Pings in a Discord channel', 'https://support.discord.com/hc/en-us/articles/228383668', 'Channel settings → Integrations → Webhooks → New → Copy URL', 'https://discord.com/api/webhooks/…'],
];
function paintKeys(tests = {}) {
  const ks = state.config?.keys || {};
  const row = ([env, name, what, link, how, ph], compact) => {
    const st = ks[env] || {}, t = tests[env];
    const badge = t && t.ok === false ? `<span class="kb bad" title="${esc(t.msg)}">error</span>`
      : t && t.ok ? `<span class="kb ok">${esc(t.msg)}</span>` : st.set ? `<span class="kb ok">saved ${esc(st.hint)}</span>` : st.fallback ? `<span class="kb ok">${esc(st.fallback)}</span>` : '';
    if (compact) return `<div class="krow compact">
      <div class="kname"><b>${esc(name)}</b> ${badge}</div>
      <div class="kact"><button type="button" class="ghost small" data-change="${env}">Change</button><button type="button" class="ghost small" data-clear="${env}">Remove</button></div>
      <input type="password" autocomplete="off" spellcheck="false" data-key="${env}" placeholder="paste a new key to replace it" hidden>
      ${t && t.ok === false ? `<div class="kerr">${esc(t.msg)}</div>` : ''}
    </div>`;
    return `<div class="krow">
      <div class="kname"><b>${esc(name)}</b> ${badge}<small>${esc(what)}</small></div>
      <input type="password" autocomplete="off" spellcheck="false" data-key="${env}" placeholder="${esc(ph || 'paste key')}">
      <div class="khow"><a href="${link}" target="_blank" rel="noopener">Get key ↗</a><small>${esc(how)}</small></div>
      ${t && t.ok === false ? `<div class="kerr">${esc(t.msg)}</div>` : ''}
    </div>`;
  };
  const saved = KEY_ROWS.filter(r => ks[r[0]]?.set);
  const missing = KEY_ROWS.filter(r => !ks[r[0]]?.set);
  $('#keyRows').innerHTML =
    (saved.length ? `<div class="ksaved">${saved.map(r => row(r, true)).join('')}</div>` : '') +
    (missing.length ? `<details class="kmore"${saved.length ? '' : ' open'}><summary>${saved.length ? `Add another key <span class="muted">(${missing.length} optional)</span>` : 'Add your keys'}</summary>${missing.map(r => row(r, false)).join('')}</details>` : '');
}
async function keyCall(body, label) {
  $('#keyMsg').textContent = label;
  try {
    const r = await api('/api/keys', body);
    state.config = { ...state.config, keys: r.keys };
    paintKeys(r.tests);
    const bad = Object.entries(r.tests).filter(([, t]) => t.ok === false).length;
    $('#keyMsg').textContent = bad ? `${bad} key(s) didn't work: see the red line under them.` : Object.keys(r.tests).length ? 'Saved and working. No restart needed.' : 'Saved.';
    renderPills();
  } catch (err) { $('#keyMsg').textContent = err.message; }
}
$('#saveKeys').onclick = () => {
  const values = {};
  for (const i of document.querySelectorAll('#keyRows [data-key]')) if (i.value.trim()) values[i.dataset.key] = i.value.trim();
  if (!Object.keys(values).length) { $('#keyMsg').textContent = 'Paste at least one key first.'; return; }
  keyCall({ values }, 'Saving and testing…');
};
$('#keyRows').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#saveKeys').click(); } }); // Enter must not submit the settings form
$('#testTweets').onclick = async () => {
  $('#keyMsg').textContent = 'Fetching the last day of tweets from a few big accounts…';
  try {
    const r = await api('/api/tweets/test', {});
    $('#keyMsg').textContent = r.ok ? `Tweets work via ${r.provider}: got ${r.count} tweet(s)${r.sample?.[0] ? `, e.g. @${r.sample[0].author}: “${r.sample[0].text.slice(0, 60)}…”` : ''}. They're in your feed now.` : `Tweets don't work yet${r.provider ? ' (' + r.provider + ')' : ''}: ${r.error}`;
  } catch (err) { $('#keyMsg').textContent = err.message; }
};
$('#testKeys').onclick = () => keyCall({ test: Object.entries(state.config?.keys || {}).filter(([, v]) => v.set).map(([k]) => k) }, 'Testing…');
$('#keyRows').addEventListener('click', e => {
  const ch = e.target.closest('[data-change]');
  if (ch) { const i = ch.closest('.krow').querySelector('input'); i.hidden = false; i.focus(); return; }
  const b = e.target.closest('[data-clear]');
  if (b && confirm('Remove this key from .env?')) keyCall({ clear: [b.dataset.clear] }, 'Removing…');
});
// Sidebar "API keys" link and first run: /#keys opens straight to it.
function openKeys() { $('#settingsBtn').click(); setTimeout(() => $('#keyset').scrollIntoView({ block: 'start' }), 50); }
window.openKeys = openKeys;
window.addEventListener('hashchange', () => { if (location.hash === '#keys') openKeys(); if (location.hash === '#settings') $('#settingsBtn').click(); });

// keep relative times fresh
connect();

document.addEventListener('change', e => {
  const sel = e.target.closest('[data-showmode]');
  if (!sel) return;
  state.showMode = sel.value; lsSet('showMode', sel.value);
  for (const p of state.plays.values()) renderPlay(p);
});
document.addEventListener('click', async e => {
  const ch = e.target.closest('[data-chart]');
  if (ch) {
    state.openCharts = state.openCharts || new Set();
    const id = ch.dataset.chart;
    state.openCharts.has(id) ? state.openCharts.delete(id) : state.openCharts.add(id);
    const p = [...state.plays.values()].find(x => x.id === id); if (p) renderPlay(p);
    return;
  }
  const rb = e.target.closest('[data-riskmint]');
  if (rb) { const slot = rb.closest('.tok').querySelector('.riskslot'); runRisk(rb.dataset.riskmint, slot); return; }
  if (e.target.id === 'rugImportBtn') {
    try {
      const r = await api('/api/risk/import', { text: $('#rugImport').value });
      state.riskMemory = r.memory; renderPlaybook();
      toast({ kind: 'fresh', title: `Imported ${r.imported} line(s) into rug memory` }, 2500);
    } catch (err) { toast({ title: 'Import failed', text: err.message }); }
  }
});
