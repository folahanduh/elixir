// Plays page: every play on its own card. The top coin live with its chart, then the 1st/2nd/3rd deploys.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => n == null ? '—' : '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
  const clock = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const ago = t => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 60 ? Math.round(s) + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
  const secs = s => s == null ? '' : s < 0 ? 'before' : s < 60 ? `+${s}s` : s < 3600 ? `+${Math.round(s / 60)}m` : `+${Math.round(s / 3600)}h`;

  const plays = new Map();
  let filter = 'active';
  const charts = new Set();      // plays whose chart is open
  let autoIds = new Set();       // took-off plays whose chart opens by itself (max 2)
  const closed = new Set();      // charts the user closed (don't auto-open again)

  const topOf = p => [...(p.deploys || [])].sort((a, b) => (b.vol?.real || 0) - (a.vol?.real || 0))[0] || null;
  const verdictOf = d => {
    if (!d) return ['none', 'No deploys yet'];
    const v5 = d.vol5m || 0, tr = d.trades5m || 0;
    if (v5 >= 10000 && tr >= 40) return ['up', 'Took off: real volume'];
    if (v5 >= 1500 || tr >= 15 || (d.vol?.real || 0) >= 5000) return ['mid', 'Getting volume'];
    return ['no', 'Deployed, no traction yet'];
  };
  const activated = p => { const v = verdictOf(topOf(p))[0]; return v === 'up' || v === 'mid'; };
  const ended = p => p.status && p.status !== 'tracking';

  function card(p) {
    const top = topOf(p);
    const [vk, vt] = verdictOf(top);
    const auto = autoIds.has(p.id); // only the top two auto-open: each chart is a whole web page
    const showChart = top && (charts.has(p.id) || auto);
    const pairId = top ? (top.pairAddress || top.address) : '';
    const src = p.source === 'stream' ? `${esc(p.author)} · stream` : `@${esc(p.author)}`;
    const deploys = [...(p.deploys || [])].sort((a, b) => (b.vol?.real || 0) - (a.vol?.real || 0)).slice(0, 6);
    return `<article class="pcard ${vk}" data-id="${esc(p.id)}">
      <div class="pc-src">
        <b>${src}</b><span class="muted">${clock(p.tweetAt)} · ${esc(ago(p.tweetAt))}</span>
        <span class="pc-st ${ended(p) ? 'done' : 'live'}">${ended(p) ? 'ended' : 'tracking'}</span>
        <span class="grow"></span>
        ${p.url ? `<a class="lk" href="${esc(p.url)}" target="_blank" rel="noopener">${p.source === 'stream' ? 'stream' : 'tweet'} ↗</a>` : ''}
      </div>
      <p class="pc-text">${esc((p.text || '').slice(0, 280))}</p>
      ${top ? `<div class="pc-coin">
        <span class="lc-img">${top.image ? `<img src="${esc(top.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc((top.symbol || '?').slice(0, 2))}</i></span>
        <div class="lc-main"><b>$${esc(top.symbol)}</b><span class="muted">${esc(top.name || '')} · ${esc(top.padLabel || '')} · ${esc(top.orderLabel || '')} deploy</span></div>
        <div class="lc-stat"><b>${usd(top.marketCap)}</b><span>mcap${top.change5m != null ? ` · <i class="${top.change5m >= 0 ? 'pos' : 'neg'}">${top.change5m >= 0 ? '+' : ''}${top.change5m}%</i> 5m` : ''}</span></div>
        <div class="lc-stat"><b>${usd(top.vol5m || 0)}</b><span>vol 5m · ${top.trades5m || 0} trades</span></div>
        <span class="lc-verdict ${vk}">${vt}</span>
        <span class="lc-links"><a class="lk" href="${esc(top.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a class="lk" href="${esc(top.links.gmgn)}" target="_blank" rel="noopener">GMGN</a>${top.links.pumpfun ? `<a class="lk" href="${esc(top.links.pumpfun)}" target="_blank" rel="noopener">pump.fun</a>` : ''}<button class="ghost small" data-chart="${esc(p.id)}">${showChart ? 'Hide chart' : 'Chart'}</button></span>
      </div>
      ${showChart ? `<iframe class="pc-chart" src="https://dexscreener.com/solana/${encodeURIComponent(pairId)}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=marketCap&interval=1" loading="lazy" title="Live chart"></iframe>` : ''}` : `<div class="pc-wait">Watching Pump, Bags, Raydium and Float for deploys of ${(p.terms || []).map(t => '“' + esc(t) + '”').join(', ') || 'this'}…</div>`}
      ${deploys.length > 1 ? `<table class="pc-deps"><thead><tr><th></th><th>Coin</th><th>Pad</th><th>Mcap</th><th>Real vol</th><th>Vol 5m</th><th></th></tr></thead><tbody>${deploys.map(d => `<tr>
        <td><span class="ord">${esc(d.orderLabel)}</span></td>
        <td><b>$${esc(d.symbol)}</b>${d.rugged ? ' <span class="rk rug">RUG</span>' : ''}</td>
        <td><span class="muted">${esc(d.padLabel)} ${esc(secs(d.afterTweetSec))}</span></td>
        <td class="num">${usd(d.marketCap)}</td>
        <td class="num">${usd(d.vol?.real)}</td>
        <td class="num">${usd(d.vol5m || 0)}</td>
        <td class="lks"><a class="lk" href="${esc(d.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a class="lk" href="${esc(d.links.gmgn)}" target="_blank" rel="noopener">GMGN</a></td>
      </tr>`).join('')}</tbody></table>` : ''}
    </article>`;
  }

  function render() {
    const all = [...plays.values()];
    $('#nActive').textContent = all.filter(activated).length || '';
    $('#nAll').textContent = all.length || '';
    $('#nEnded').textContent = all.filter(ended).length || '';
    const stat = (v, l, c = '') => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`;
    const tookOff = all.filter(p => verdictOf(topOf(p))[0] === 'up').length;
    $('#pills').innerHTML = stat(all.filter(activated).length, 'Activated', all.some(activated) ? 'up' : '') + stat(tookOff, 'Took off', tookOff ? 'up' : '')
      + stat(all.filter(p => !ended(p)).length, 'Tracking') + stat(all.reduce((n, p) => n + (p.deploys || []).length, 0), 'Deploys');
    let list = filter === 'active' ? all.filter(activated) : filter === 'ended' ? all.filter(ended) : all;
    // Took off first, then getting volume, newest first within each
    const rank = p => ({ up: 0, mid: 1, no: 2, none: 3 }[verdictOf(topOf(p))[0]]);
    list.sort((a, b) => rank(a) - rank(b) || (b.tweetAt || 0) - (a.tweetAt || 0));
    autoIds = new Set(list.filter(p => verdictOf(topOf(p))[0] === 'up' && !closed.has(p.id)).slice(0, 2).map(p => p.id));
    const box = $('#plays');
    // Keep open charts across re-renders: they'd reload (and flicker) otherwise.
    const keep = new Map([...box.querySelectorAll('.pc-chart')].map(f => [f.closest('.pcard').dataset.id, f]));
    box.innerHTML = list.length ? list.map(card).join('') : `<div class="empty">${filter === 'active'
      ? '<b>No activated plays yet.</b> A play starts when a tracked account tweets something coin-able, or a streamer says a name there\'s a coin for. It shows here once one of its coins gets real volume. See every play under <b>All</b>.'
      : 'No plays yet. Press <b>Track play</b> on any tweet in the feed to start one.'}</div>`;
    for (const [id, f] of keep) { const n = box.querySelector(`.pcard[data-id="${CSS.escape(id)}"] .pc-chart`); if (n && n.src === f.src) n.replaceWith(f); }
  }
  let t = null;
  const later = () => { if (!t) t = setTimeout(() => { t = null; render(); }, 250); };

  $('#plTabs').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; document.querySelectorAll('#plTabs button').forEach(x => x.classList.toggle('on', x === b)); render(); });
  $('#plays').addEventListener('click', e => {
    const b = e.target.closest('[data-chart]'); if (!b) return;
    const id = b.dataset.chart;
    const open = b.textContent.startsWith('Hide');
    if (open) { charts.delete(id); closed.add(id); } else { charts.add(id); closed.delete(id); }
    render();
  });

  const es = window.nrES;
  es.addEventListener('hello', e => { const d = JSON.parse(e.data); plays.clear(); for (const p of d.plays || []) plays.set(p.id, p); render(); $('#liveDot')?.classList.add('live'); });
  es.addEventListener('play', e => { const p = JSON.parse(e.data); plays.set(p.id, p); later(); });
  es.addEventListener('play-removed', e => { plays.delete(JSON.parse(e.data).id); later(); });
  setInterval(render, 30000); // keep "x ago" fresh
})();
