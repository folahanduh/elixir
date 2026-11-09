// Whales page: live whale moves (fresh-wallet funding, early buys, deploys), the trace tool,
// your whale list and the rules.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => n == null ? '' : '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
  const toast = window.toast || ((a, ms = 2000) => {
    const box = $('#toasts'); if (!box) return;
    const d = document.createElement('div'); d.className = 'toast ' + (a.kind || ''); d.textContent = a.title;
    box.append(d); setTimeout(() => d.remove(), ms);
  });
  const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
  const clock = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  const ago = t => { if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 172800 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  // A wallet chip: name if known, short address otherwise. Click = trace it.
  const chip = (w, name) => `<a class="wa ${name && name !== short(w) && !/^fresh /.test(name) ? 'named' : ''}" data-trace="${esc(w)}" title="${esc(w)} · click to trace">${esc(name && name !== short(w) ? name : short(w))}</a>`;

  let events = [], filter = 'all', solscan = false;
  let radarSection = () => '';
  // Bubble map on its own (sidebar → Bubble map): just the map, full height.
  const MAP_VIEW = new URLSearchParams(location.search).get('view') === 'map';
  if (MAP_VIEW) {
    document.documentElement.classList.add('view-map');
    document.title = 'Bubble map · Elixir';
    const t = document.querySelector('.ptitle b'), st = document.querySelector('.ptitle small');
    if (t) t.textContent = 'Bubble map';
    if (st) st.textContent = 'Who holds a coin, which wallets are connected, who funded them';
  }

  // ---------- live moves ----------
  function evHTML(e) {
    if (e.kind === 'volume') return hotHTML(e);
    const kind = { buy: 'BUY', deploy: 'DEPLOY', fund: 'FUNDED' }[e.kind] || e.kind;
    const chain = (e.chain || []).map(c => chip(c.wallet, c.name)).join('<span class="ar">→</span>');
    const ageH = e.pairCreatedAt ? (e.at - e.pairCreatedAt) / 3600000 : null;
    const coin = e.mint ? `<div class="whcoin">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<b>${e.symbol ? '$' + esc(e.symbol) : esc(short(e.mint))}</b>
      ${e.name ? `<span class="muted">${esc(e.name)}</span>` : ''}${e.marketCap ? `<span>mc ${usd(e.marketCap)}</span>` : ''}
      <span class="muted">${ageH == null ? 'no market yet' : ageH < 1 ? Math.max(0, Math.round(ageH * 60)) + 'm old' : ageH.toFixed(1) + 'h old'}</span>
      <span class="lks"><a href="${esc(e.links?.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${esc(e.links?.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${esc(e.links?.dexscreener)}" target="_blank" rel="noopener">Chart</a><a href="#" data-map="${esc(e.mint)}">Bubble map</a></span></div>
      <div class="ca"><span>CA</span><code>${esc(e.mint)}</code><button class="ghost small cp" data-copy="${esc(e.mint)}">Copy</button></div>` : '';
    const what = e.kind === 'fund' ? `<span class="muted">sent ${solHTML(e.sol.toFixed(1))} to a fresh wallet ${chip(e.to, '')}</span>` : '';
    return `<div class="whev ${esc(e.kind)}"><span class="whk">${kind}</span>
      <div class="whmain"><div class="whchain">${chain}</div>${what}${coin}</div>
      <div class="whside">${e.sol && e.kind !== 'fund' ? `<span class="sol">${solHTML(e.sol.toFixed(2))}</span>` : e.kind === 'fund' ? `<span class="sol">${solHTML(e.sol.toFixed(1))}</span>` : ''}<span title="${esc(new Date(e.at).toLocaleString())}">${clock(e.at)}</span><span class="lks"><a href="${esc(e.links?.tx)}" target="_blank" rel="noopener">tx</a></span></div></div>`;
  }
  /** Big whale volume into a brand-new coin: the CA, front and centre. */
  function hotHTML(e) {
    const ageH = e.pairCreatedAt ? (e.at - e.pairCreatedAt) / 3600000 : null;
    return `<div class="whhot">
      <div class="hh-top">${e.image ? `<img src="${esc(e.image)}" alt="" onerror="this.remove()">` : ''}<div class="grow"><span class="whk">WHALE VOLUME</span> <b>${e.symbol ? '$' + esc(e.symbol) : 'New coin'}</b> ${e.name ? `<span class="muted">${esc(e.name)}</span>` : ''}
        <div class="muted small">${ageH == null ? 'no market yet' : ageH < 1 ? Math.max(0, Math.round(ageH * 60)) + 'm old' : ageH.toFixed(1) + 'h old'}${e.marketCap ? ' · mc ' + usd(e.marketCap) : ''} · ${clock(e.at)}</div></div>
        <div class="hh-sol">${solHTML(Math.round(e.sol).toLocaleString())}<span>from ${(e.wallets || []).length} tracked wallet${(e.wallets || []).length > 1 ? 's' : ''}</span></div></div>
      <div class="ca big"><span>CA</span><code>${esc(e.mint)}</code><button class="small cp" data-copy="${esc(e.mint)}">Copy CA</button></div>
      <div class="hh-w">${(e.wallets || []).slice(0, 6).map(w => `${chip(w.wallet, w.name)} <span class="muted">${w.sol.toFixed(1)}</span>`).join(' · ')}</div>
      <div class="lks"><a href="${esc(e.links?.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${esc(e.links?.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${esc(e.links?.dexscreener)}" target="_blank" rel="noopener">Chart</a><a href="#" data-map="${esc(e.mint)}">Bubble map</a></div>
    </div>`;
  }
  let frame = 0;
  const render = () => { if (!frame) frame = setTimeout(() => { frame = 0; draw(); }, 200); };
  function draw() {
    // Whale volume from the last 6 hours stays pinned on top, newest first, one card per coin.
    const best = new Map();
    for (const e of events) if (e.kind === 'volume' && Date.now() - e.at < 6 * 3600000 && (!best.has(e.mint) || e.sol > best.get(e.mint).sol)) best.set(e.mint, e);
    const hot = [...best.values()].sort((a, b) => b.at - a.at);
    $('#whHot').innerHTML = hot.map(hotHTML).join('');
    const list = events.filter(e => (filter === 'all' ? e.kind !== 'volume' : e.kind === filter)).slice(0, 120);
    $('#whMoves').innerHTML = list.length ? list.map(evHTML).join('') : `<div class="whempty">${events.length ? 'Nothing of this kind yet.' : `<b>No whale moves yet.</b><br>
      When a whale (or a KOL wallet) sends a big amount of SOL to a brand-new wallet, Elixir follows that wallet. If it then buys a coin that's only hours old, or deploys one, it shows here and pings you.
      Add the wallets you want to follow on the right, or trace a coin's first buyers to find them.`}</div>`;
    $('#whPills').innerHTML = ['volume', 'buy', 'deploy', 'fund'].map(k => `<span class="pill"><b>${events.filter(e => e.kind === k && Date.now() - e.at < 86400000).length}</b> ${{ volume: 'whale volume', buy: 'early buys', deploy: 'deploys', fund: 'fundings' }[k]} · 24h</span>`).join('');
  }
  $('#whTabs').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; $('#whTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); };

  // ---------- trace ----------
  async function trace(q, opts = {}) {
    q = String(q || '').trim();
    const m = q.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (!m) { $('#whTrace').innerHTML = '<div class="tnote">Paste a Solana wallet or coin address.</div>'; return; }
    $('#whQ').value = m[0];
    $('#whTrace').innerHTML = `<div class="spin">Reading the chain… ${opts.coin ? 'a coin\'s first buyers take 10–30 s' : 'usually a few seconds'}${solscan ? '' : ' (faster with a Solscan key)'}</div>`;
    try {
      const r = await post('/api/whales/trace', { q: m[0], ...opts });
      $('#whTrace').innerHTML = r.type === 'coin' ? coinHTML(r) : walletHTML(r);
    } catch (e) { $('#whTrace').innerHTML = `<div class="tnote">${esc(e.message)}</div>`; }
  }
  function walletHTML(r) {
    if (!r.steps?.length) return '<div class="tnote">Nothing found for that wallet.</div>';
    const steps = r.steps.map((s, i) => `<div class="tstep ${s.known ? 'known' : ''}">
      <div>${i ? '<span class="muted small">funded by </span>' : ''}${chip(s.wallet, s.name)}${s.label ? `<span class="tag">${esc(s.label)}</span>` : ''}${(s.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        <span class="lks" style="margin-left:8px"><a href="https://solscan.io/account/${esc(s.wallet)}" target="_blank" rel="noopener">Solscan</a><a href="https://gmgn.ai/sol/address/${esc(s.wallet)}" target="_blank" rel="noopener">GMGN</a></span></div>
      <div class="meta">${s.txs != null ? `${esc(s.txs)} transactions` : ''}${s.txs !== '50+' && s.txs != null && s.txs <= 10 ? ' · <b style="color:var(--vip)">fresh wallet</b>' : ''}${s.fundedBy ? ` · first funded ${s.fundSol ? solHTML(s.fundSol.toFixed(2)) + ' ' : ''}${ago(s.fundAt)}${s.fundTx ? ` · <a href="https://solscan.io/tx/${esc(s.fundTx)}" target="_blank" rel="noopener">tx</a>` : ''}` : ''}${s.oldWallet ? ' · old wallet with thousands of transactions: first funder not looked up (add a Solscan key)' : ''}</div></div>`).join('');
    const last = r.steps[r.steps.length - 1];
    const end = last.known ? `Trail ends at a wallet you know: <b>${esc(last.name)}</b>.` : last.fundedBy ? 'Stopped after 4 hops. Click the last wallet to keep going.' : 'No earlier funder found.';
    return `<div class="tsteps">${steps}</div><p class="tnote">${end} Click any wallet to trace from it, or name it: <a href="#" data-label="${esc(r.wallet)}">name this wallet</a> · <a href="#" data-watch="${esc(r.wallet)}">watch as whale</a></p>`;
  }
  function coinHTML(r) {
    if (!r.buyers?.length) return `<div class="tnote">No early buys found in the first ${r.txsRead} transactions of this coin.</div>`;
    const rows = r.buyers.map((b, i) => `<tr><td>${i + 1}</td><td>${chip(b.wallet, b.name)}${b.fresh ? ' <span class="tag">fresh</span>' : ''}${b.known ? ' <span class="tag">known</span>' : ''}</td>
      <td class="num">${b.sol.toFixed(2)}</td><td>${b.fundedBy ? chip(b.fundedBy, b.funderName) + (b.funderKnown ? ' <span class="tag">known</span>' : '') : '<span class="muted">—</span>'}</td><td class="muted">${clock(b.firstAt)}</td></tr>`).join('');
    const groups = (r.shared || []).map(g => `<div class="tgroup"><b>${g.wallets.length} of the top buyers were funded by the same wallet</b> ${chip(g.funder, g.name)}: one group buying through several wallets.</div>`).join('');
    return `<div class="tnote" style="margin:0 0 8px">${r.creator ? `Created by ${chip(r.creator, r.creatorName)} ${ago(r.createdAt)} · ` : ''}biggest buyers in the first ${r.txsRead} transactions</div>
      <table class="tbuyers"><thead><tr><th>#</th><th>Buyer</th><th class="num"><i class="sol-i" title="SOL"></i></th><th>Funded by</th><th>First buy</th></tr></thead><tbody>${rows}</tbody></table>${groups}
      <p class="tnote">Click a buyer or funder to trace it. A funder you recognise (a whale, a KOL, the team) is the signal; add them under Whales you watch.</p>`;
  }
  $('#whTraceForm').onsubmit = e => { e.preventDefault(); trace($('#whQ').value); };
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-trace]');
    if (t) { e.preventDefault(); return trace(t.dataset.trace, { wallet: true }); }
    const c = e.target.closest('[data-trace-coin]');
    if (c) { e.preventDefault(); return trace(c.dataset.traceCoin, { coin: true }); }
    const l = e.target.closest('[data-label]');
    if (l) { e.preventDefault(); const name = prompt('Name for this wallet (e.g. "Binance hot wallet", "team")'); if (name != null) { await post('/api/whales', { op: 'label', wallet: l.dataset.label, name }); toast({ kind: 'fresh', title: 'Named' }, 1500); } return; }
    const w = e.target.closest('[data-watch]');
    if (w) { e.preventDefault(); const name = prompt('Name for this whale') || ''; paintList(await post('/api/whales', { op: 'add', text: `${name} ${w.dataset.watch}` })); toast({ kind: 'fresh', title: 'Watching it' }, 1500); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { paintList(await post('/api/whales', { op: 'remove', wallet: rm.dataset.rm })); }
  });

  // ---------- whale list + rules ----------
  function paintList(d) {
    solscan = d.solscan;
    const ws = d.whales || [];
    $('#whCount').textContent = ws.length ? `${ws.length} · ${d.followed || 0} fresh wallets followed` : '';
    $('#whList').innerHTML = ws.length ? ws.map(w => `<div class="whw">${chip(w.wallet, w.name)}<span class="addr">${esc(short(w.wallet))}</span><span class="grow"></span><button class="ghost small" data-rm="${esc(w.wallet)}">Remove</button></div>`).join('')
      : '<div class="whempty">No whales added yet. Your KOL wallets are already watched for big transfers to fresh wallets.</div>';
    const s = d.settings || {};
    const f = $('#whRules');
    for (const k of ['minSol', 'bigSol', 'minBuySol', 'volumeSol', 'maxAgeHours', 'followHours']) if (document.activeElement !== f[k]) f[k].value = s[k];
    f.watchKols.checked = s.watchKols !== false; f.enabled.checked = s.enabled !== false;
    $('#whKeyHint').innerHTML = d.solscan ? 'Solscan key set: wallet names and funders come straight from Solscan.'
      : 'Tip: a <a href="/#keys">Solscan API key</a> adds names (exchanges, funds) and finds the first funder of old wallets instantly. Everything works without it, using your Helius RPC.';
    if (d.status) $('#whStatus').textContent = d.status;
  }
  let saveT = null;
  $('#whRules').addEventListener('input', () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      const f = $('#whRules');
      const body = { op: 'settings', watchKols: f.watchKols.checked, enabled: f.enabled.checked };
      for (const k of ['minSol', 'bigSol', 'minBuySol', 'volumeSol', 'maxAgeHours', 'followHours']) body[k] = Number(f[k].value);
      paintList(await post('/api/whales', body));
      toast({ kind: 'fresh', title: 'Saved' }, 1200);
    }, 600);
  });
  $('#whAddBtn').onclick = () => { $('#whAdd').hidden = !$('#whAdd').hidden; };
  $('#whAddCancel').onclick = () => { $('#whAdd').hidden = true; };
  $('#whAdd').onsubmit = async e => {
    e.preventDefault();
    const text = $('#whAdd textarea').value;
    if (!text.split(/\s+/).some(isAddr)) return toast({ title: 'No wallet address found' }, 2000);
    paintList(await post('/api/whales', { op: 'add', text }));
    $('#whAdd textarea').value = ''; $('#whAdd').hidden = true;
  };

  // ---------- bubble map: a coin's holders, or one wallet's connections ----------
  const ROLE = { center: '#a7b1ff', funder: '#ffb547', out: '#32d296', in: '#4cc3d1', known: '#e879a6', contract: '#565b68' };
  const solN = s => (s >= 1000 ? (s / 1000).toFixed(1) + 'K' : s >= 10 ? Math.round(s).toLocaleString() : s >= 1 ? s.toFixed(2) : s.toFixed(3));
  const solS = s => s == null ? '—' : solHTML(solN(s));
  const pctS = p => (p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3)) + '%';
  const dur = ms => { const m = Math.abs(ms) / 60000; return m < 1 ? Math.round(Math.abs(ms) / 1000) + 's' : m < 90 ? Math.round(m) + 'm' : m < 2880 ? (m / 60).toFixed(1) + 'h' : Math.round(m / 1440) + 'd'; };
  const when = t => t ? `${new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} · ${ago(t)}` : '—';
  const copyBtn = (v, label = 'Copy') => `<button class="ghost small cp" data-copy="${esc(v)}">${label}</button>`;
  let mapData = null, mapping = null;

  /** Text and badges on each bubble, per mode. */
  function decorate(d) {
    if (d.type === 'wallet') {
      const max = Math.max(1, ...d.nodes.map(n => n.vol || 0));
      return {
        nodes: d.nodes.map(n => {
          const role = n.role === 'center' ? 'center' : n.program ? 'contract' : n.known && n.role !== 'center' ? 'known' : n.role;
          return { ...n, center: n.role === 'center', kind: n.program ? 'contract' : 'holder', color: ROLE[role] || '#5a5f6d',
            r: n.role === 'center' ? 46 : Math.max(9, 12 + Math.sqrt((n.vol || 0) / max) * 40),
            t1: n.label || (n.name && n.name !== short(n.id) ? n.name : short(n.id)), t2: n.solBalance != null ? solN(n.solBalance) : '', t2Sol: n.solBalance != null };
        }),
        links: d.links, spread: 90,
      };
    }
    return {
      nodes: d.nodes.map(n => ({ ...n, t1: n.kind === 'hub' ? '' : pctS(n.pct || 0), t2: n.label || (n.name && n.name !== short(n.wallet) ? n.name : n.kind === 'hub' ? '' : '#' + n.rank) })),
      links: d.links,
    };
  }
  const bm = window.BubbleMap($('#bm'), {
    onSelect: n => paintSide(n),
    onOpen: n => { if (n && n.kind !== 'contract') mapIt(n.id, { kind: 'wallet' }); },
    onHover: (n, x, y) => {
      const tip = $('#bmTip');
      if (!n || !mapData) { tip.hidden = true; return; }
      tip.innerHTML = cardHTML(n, true);
      tip.hidden = false;
      const wrap = $('.bm-wrap').getBoundingClientRect();
      tip.style.left = Math.min(x + 16, wrap.width - 300) + 'px'; tip.style.top = Math.min(y + 16, wrap.height - 230) + 'px';
    },
  });

  /** The wallet card: hover tooltip (compact) and the selected panel (full). */
  function cardHTML(n, compact) {
    const d = mapData, coin = d.type !== 'wallet';
    const title = n.kind === 'hub' ? 'Shared funder' : n.label || (n.name && n.name !== short(n.wallet) ? n.name : coin ? 'Holder #' + n.rank : n.role === 'center' ? 'This wallet' : short(n.wallet));
    const badges = [n.role === 'center' && 'searched', n.known && 'known', n.preFunded && 'pre-funded', n.fresh && 'fresh wallet', n.kind === 'contract' && 'pool / program', n.cluster && 'cluster ' + n.cluster,
      n.role === 'funder' && `funder · hop ${n.hop}`, n.role === 'out' && 'received from it', n.role === 'in' && 'sent to it'].filter(Boolean);
    const row = (k, v) => v == null || v === '' ? '' : `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
    const launch = d.createdAt;
    const stats = [
      coin && n.kind !== 'hub' && row('Holds', `${pctS(n.pct || 0)} of supply`),
      row('SOL balance', n.solBalance != null ? solS(n.solBalance) : null),
      n.kind === 'hub' && row('Funded', `${n.funds} top holders${n.sent ? ' · ' + solS(n.sent) : ''}`),
      n.fundedBy && row('Funded by', `<a href="#" data-bmsel="${esc(n.fundedBy)}" data-open="${esc(n.fundedBy)}">${esc(n.funderName || short(n.fundedBy))}</a>${n.fundSol ? ' · ' + solS(n.fundSol) : ''}`),
      n.fundedAt && row('Funded', when(n.fundedAt) + (launch && coin ? ` · <span class="${n.preFunded ? 'amber' : ''}">${n.fundedAt <= launch ? dur(launch - n.fundedAt) + ' before launch' : dur(n.fundedAt - launch) + ' after launch'}</span>` : '')),
      coin && n.firstBuyAt && row('First buy', `${n.boughtAfterLaunchSec != null ? (n.boughtAfterLaunchSec <= 0 ? 'in the launch block' : dur(n.boughtAfterLaunchSec * 1000) + ' after launch') : when(n.firstBuyAt)}${n.firstBuySol ? ' · ' + solS(n.firstBuySol) : ''}`),
      row('Wallet age', n.firstSeen ? dur(Date.now() - n.firstSeen) + ' (first tx ' + new Date(n.firstSeen).toLocaleDateString() + ')' : n.txs === '1000+' || n.txs === '100+' ? 'old, busy wallet' : null),
      row('Transactions', n.txs != null ? String(n.txs) : null),
      row('Last active', n.lastSeen ? ago(n.lastSeen) : null),
      !coin && n.vol && n.role !== 'center' && row('SOL moved with it', solS(n.vol)),
    ].filter(Boolean).join('');
    if (compact) return `<div class="ct"><b>${esc(title)}</b>${badges.map(b => `<span class="bdg">${esc(b)}</span>`).join('')}</div>${stats}<div class="a">${esc(n.wallet)}</div><div class="muted small">click for details · double-click to open its connections</div>`;
    const ls = d.links.filter(l => l.a === n.id || l.b === n.id);
    const nm = w => { const x = d.nodes.find(y => y.id === w); return x ? (x.label || x.name || short(w)) : short(w); };
    const what = { funded: 'funded', token: 'token', sol: '<i class="sol-i" title="SOL sent" style="margin:0"></i>', bundle: 'same-tx buy' };
    const conns = ls.slice(0, 20).map(l => {
      const out = l.a === n.id, o = out ? l.b : l.a;
      return `<div class="cn"><span class="lt ${esc(l.type)}">${what[l.type] || l.type}</span><span class="dir">${l.type === 'bundle' ? '↔' : out ? '→' : '←'}</span><a href="#" data-bmsel="${esc(o)}">${esc(nm(o))}</a><span class="grow"></span><span class="muted">${l.sol ? solS(l.sol) : ''}${l.count > 1 ? ` · ${l.count}×` : ''}${l.last ? ' · ' + ago(l.last) : ''}</span></div>`;
    }).join('');
    return `<div class="bm-card">
      <div class="ct"><b>${esc(title)}</b>${badges.map(b => `<span class="bdg ${b === 'pre-funded' ? 'amber' : b === 'fresh wallet' ? 'green' : ''}">${esc(b)}</span>`).join('')}</div>
      <div class="addr"><code>${esc(n.wallet)}</code>${copyBtn(n.wallet)}</div>
      <div class="kvs">${stats}</div>
      ${ls.length ? `<div class="bm-sec">CONNECTIONS (${ls.length})</div>${conns}` : `<div class="muted">${coin ? 'No links to other top holders found.' : 'No connections found in its recent transactions.'}</div>`}
      <div class="btns"><button class="small" data-open="${esc(n.wallet)}">Open its connections</button><a class="lk" href="https://solscan.io/account/${esc(n.wallet)}" target="_blank" rel="noopener">Solscan</a><a class="lk" href="https://gmgn.ai/sol/address/${esc(n.wallet)}" target="_blank" rel="noopener">GMGN</a><a class="lk" href="#" data-watch="${esc(n.wallet)}">Watch</a><a class="lk" href="#" data-label="${esc(n.wallet)}">Name</a></div>
    </div>`;
  }

  function paintSide(sel) {
    const d = mapData;
    if (!d) {
      $('#bmSide').innerHTML = `<div class="bm-guide">
        <div class="bm-sec">HOW TO READ IT</div>
        <div class="g"><i style="background:#a7b1ff"></i><div><b>Same colour = one group</b><span>Connected by a shared funder, by funding each other, by passing the token, or by buying in the same transaction.</span></div></div>
        <div class="g"><i class="ring"></i><div><b>Amber ring = pre-funded</b><span>Got its SOL in the 3 days before launch. A lot of supply in amber is a planned launch.</span></div></div>
        <div class="g"><i style="background:#2fd18b"></i><div><b>Green dot = fresh wallet</b><span>Only a few transactions ever. Made for this coin.</span></div></div>
        <div class="g"><i class="dash"></i><div><b>Dashed = pool or curve</b><span>Liquidity, not a person. Never grouped.</span></div></div>
        <div class="bm-sec">TRY IT</div>
        <span class="muted">Paste a coin from <a href="/plays.html">Plays</a> or a KOL's wallet. Hover any bubble for its card, click for full details, double-click to open its connections.</span>
      </div>`;
      return;
    }
    let html = '';
    if (d.type === 'wallet') {
      const center = d.nodes.find(n => n.role === 'center') || {};
      const c = k => d.nodes.filter(n => n.role === k).length;
      html += `<div class="bm-coin"><div class="grow"><b>${esc(d.name && d.name !== short(d.wallet) ? d.name : 'Wallet')}</b><div class="addr"><code>${esc(d.wallet)}</code>${copyBtn(d.wallet)}</div></div></div>
        <div class="bm-sum"><div><b>${solS(center.solBalance)}</b><span>balance</span></div><div><b>${c('funder')}</b><span>funders up the trail</span></div>
        <div><b>${c('out')}</b><span>wallets it sent to</span></div><div><b>${c('in')}</b><span>wallets that sent to it</span></div></div>
        <div class="bm-legend2"><span><i style="background:${ROLE.center}"></i>this wallet</span><span><i style="background:${ROLE.funder}"></i>funded it</span><span><i style="background:${ROLE.out}"></i>it sent to</span><span><i style="background:${ROLE.in}"></i>sent to it</span><span><i style="background:${ROLE.known}"></i>known</span></div>`;
      if (sel) html += cardHTML(sel, false);
      if (d.buys?.length) html += `<div class="bm-sec">COINS IT BOUGHT LATELY</div>` + d.buys.map(b => `<div class="bm-buy">${b.image ? `<img src="${esc(b.image)}" alt="" onerror="this.remove()">` : ''}<div class="grow"><b>${b.symbol ? '$' + esc(b.symbol) : esc(short(b.mint))}</b> <span class="muted">${solS(b.sol)} · ${ago(b.at)}${b.marketCap ? ' · mc ' + usd(b.marketCap) : ''}</span><div class="addr"><code>${esc(b.mint)}</code>${copyBtn(b.mint, 'Copy CA')}</div></div><a class="lk" href="#" data-map="${esc(b.mint)}">Map</a></div>`).join('');
      html += `<div class="bm-sec">WALLETS</div>` + d.nodes.filter(n => n.role !== 'center').sort((a, b) => (b.vol || 0) - (a.vol || 0)).map(n => `<div class="bm-row ${sel === n ? 'on' : ''}" data-bmsel="${esc(n.id)}"><span class="dot" style="background:${ROLE[n.program ? 'contract' : n.known ? 'known' : n.role] || '#5a5f6d'}"></span><span class="grow">${esc(n.label || n.name)}${n.fresh ? ' <span class="muted">· fresh</span>' : ''}</span><span class="pct">${n.vol ? solS(n.vol) : ''}</span></div>`).join('');
      $('#bmSide').innerHTML = html;
      return;
    }
    const col = c => bm.colors[(c - 1) % bm.colors.length];
    const top10 = d.nodes.filter(n => n.kind === 'holder').slice(0, 10).reduce((s, n) => s + n.pct, 0);
    const big = d.clusters[0];
    html += `<div class="bm-coin">${d.image ? `<img src="${esc(d.image)}" alt="" onerror="this.remove()">` : ''}<div class="grow"><b>${d.symbol ? '$' + esc(d.symbol) : 'Coin'}</b> ${d.name ? `<span class="muted">${esc(d.name)}</span>` : ''}<div class="muted small">${d.holderCount.toLocaleString()} holders${d.partial ? '+' : ''}${d.marketCap ? ' · mc ' + usd(d.marketCap) : ''}${d.createdAt ? ' · launched ' + ago(d.createdAt) : ''}</div><div class="addr"><code>${esc(d.mint)}</code>${copyBtn(d.mint, 'Copy CA')}</div></div></div>
      <div class="bm-sum">
        <div class="${d.clusteredPct >= 20 ? 'warn' : ''}"><b>${pctS(d.clusteredPct)}</b><span>held by connected wallets</span></div>
        <div class="${big && big.pct >= 10 ? 'warn' : ''}"><b>${big ? pctS(big.pct) : '—'}</b><span>biggest cluster${big ? ` (${big.wallets.length} wallets)` : ''}</span></div>
        <div class="${d.preFundedPct >= 15 ? 'warn' : ''}"><b>${pctS(d.preFundedPct || 0)}</b><span>pre-funded wallets (${d.preFundedCount || 0})</span></div>
        <div><b>${pctS(top10)}</b><span>top 10 · ${pctS(d.contractPct)} in pools</span></div>
      </div>
      <div class="lks"><a href="https://axiom.trade/meme/${esc(d.mint)}" target="_blank" rel="noopener">Axiom</a><a href="https://gmgn.ai/sol/token/${esc(d.mint)}" target="_blank" rel="noopener">GMGN</a><a href="https://solscan.io/token/${esc(d.mint)}#holders" target="_blank" rel="noopener">Solscan</a><a href="#" data-trace-coin="${esc(d.mint)}">Early buyers</a></div>`;
    if (sel) html += cardHTML(sel, false);
    html += radarSection(d.mint);
    html += `<div class="bm-sec">CLUSTERS</div>` + (d.clusters.length ? d.clusters.slice(0, 12).map(c => `<div class="bm-row ${sel && sel.cluster === c.id ? 'on' : ''}" data-bmsel="${esc(c.wallets[0])}"><span class="dot" style="background:${col(c.id)}"></span><span class="grow">Cluster ${c.id} · ${c.wallets.length} wallets${c.hubs.length ? ' · shared funder' : ''}</span><span class="pct">${pctS(c.pct)}</span></div>`).join('') : `<div class="muted">No connected holders found among the top ${d.shown}.</div>`);
    html += `<div class="bm-sec">HOLDERS</div>` + d.nodes.filter(n => n.kind !== 'hub').map(n => `<div class="bm-row ${sel === n ? 'on' : ''}" data-bmsel="${esc(n.id)}"><span class="dot" style="background:${n.kind === 'contract' ? '#2a2d35' : n.cluster ? col(n.cluster) : '#3b3f4b'}"></span><span class="grow">#${n.rank} ${esc(n.label || n.name)}${n.preFunded ? ' <span class="amber">· pre-funded</span>' : n.fresh ? ' <span class="muted">· fresh</span>' : ''}</span><span class="pct">${pctS(n.pct)}</span></div>`).join('');
    $('#bmSide').innerHTML = html;
  }

  async function mapIt(q, opts = {}) {
    const m = String(q || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (!m) return toast({ title: 'Paste a coin (CA) or a wallet address' }, 2000);
    $('#bmQ').value = m[0];
    mapping = m[0];
    $('#bmEmpty').hidden = true;
    let prog = $('.bm-prog'); if (!prog) { prog = document.createElement('div'); prog.className = 'bm-prog'; $('.bm-wrap').append(prog); }
    prog.hidden = false; prog.textContent = 'Reading the chain…';
    try {
      const d = await post('/api/whales/map', { q: m[0], top: Number($('#bmTop').value), ...opts });
      if (mapping !== m[0]) return;
      mapData = d;
      bm.setData(decorate(d));
      paintSide(null);
      history.replaceState(null, '', '?' + (MAP_VIEW ? 'view=map&' : '') + 'map=' + m[0]);
    } catch (e) { toast({ title: e.message }, 4000); if (!mapData) $('#bmEmpty').hidden = false; }
    finally { if (mapping === m[0]) { prog.hidden = true; mapping = null; } }
  }
  $('#bmForm').onsubmit = e => { e.preventDefault(); mapIt($('#bmQ').value); };
  document.addEventListener('click', e => {
    const s = e.target.closest('[data-bmsel]');
    if (s && !e.target.closest('[data-open]')) { e.preventDefault(); const n = bm.select(s.dataset.bmsel); if (n) paintSide(n); return; }
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); mapIt(o.dataset.open, { kind: 'wallet' }); return; }
    const a = e.target.closest('[data-map]');
    if (a) { e.preventDefault(); mapIt(a.dataset.map, { kind: 'coin' }); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); navigator.clipboard?.writeText(c.dataset.copy).then(() => { const t = c.textContent; c.textContent = 'Copied'; setTimeout(() => { c.textContent = t; }, 1200); }).catch(() => {}); }
  });

  paintSide(null);

  // ---------- live ----------
  const es = window.nrES || (window.nrES = new EventSource('/api/events'));
  // ---------- live watchlist (launch radar) ----------
  const radarItems = new Map();
  let rdFilter = 'all', rdSel = null, solUsd = null;
  const solTxt = s => solHTML(s >= 100 ? Math.round(s).toLocaleString() : s >= 10 ? s.toFixed(1) : s.toFixed(2));
  const age = t => { const m = Math.max(0, (Date.now() - t) / 60000); return m < 1 ? Math.round(m * 60) + 's' : m < 90 ? Math.round(m) + 'm' : (m / 60).toFixed(1) + 'h'; };
  const initialOf = it => esc((it.symbol || '?')[0]);
  function rdHTML(it) {
    const rate = it.solUsd || solUsd;
    const usdIn = it.inSol && rate ? ' · ' + usd(it.inSol * rate) : '';
    const big = it.source === 'pool' ? `<b>${usd(it.liqUsd || 0)}</b><span>liquidity</span>` : `<b>${solTxt(it.inSol || 0)}</b><span>big money in${usdIn}</span>`;
    const meta = it.source === 'pool'
      ? [it.vol5mUsd ? usd(it.vol5mUsd) + ' vol 5m' : null, it.buyersCount != null ? it.buyersCount + ' buyers 5m' : null].filter(Boolean).join(' · ')
      : [it.devSol ? `dev ${solTxt(it.devSol)}` : 'dev bought nothing', `${it.bigBuys} big buy${it.bigBuys === 1 ? '' : 's'}`, `${it.wallets} wallet${it.wallets === 1 ? '' : 's'}`].join(' · ');
    const pic = it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" data-fallback="${initialOf(it)}">` : `<i>${initialOf(it)}</i>`;
    return `<div class="rd-it ${it.hot ? 'hot' : ''} ${rdSel === it.mint ? 'sel' : ''}" data-rd="${esc(it.mint)}">
      <div class="rd-top">${pic}
        <div class="grow"><div class="rd-name"><b>${it.symbol ? '$' + esc(it.symbol) : 'Unnamed'}</b>${it.hot ? '<span class="rd-major">MAJOR</span>' : ''}</div>
          <div class="rd-sub">${esc(it.name || '')}${it.name ? ' · ' : ''}${esc(it.pad || '')} · ${age(it.createdAt)} old${it.mcUsd ? ' · mc ' + usd(it.mcUsd) : ''}</div></div>
        <div class="rd-sol">${big}</div></div>
      <div class="rd-meta">${meta}</div>
      <div class="rd-ca"><code>${esc(it.mint)}</code><button type="button" class="ghost small cp" data-copy="${esc(it.mint)}">Copy CA</button></div>
      <div class="lks"><a href="#" data-rdmap="${esc(it.mint)}">Map holders</a><a href="https://axiom.trade/meme/${esc(it.mint)}" target="_blank" rel="noopener">Axiom</a><a href="https://gmgn.ai/sol/token/${esc(it.mint)}" target="_blank" rel="noopener">GMGN</a>${it.source !== 'pool' ? `<a href="https://pump.fun/coin/${esc(it.mint)}" target="_blank" rel="noopener">pump.fun</a>` : ''}${it.twitter && /^https:\/\//.test(it.twitter) ? `<a href="${esc(it.twitter)}" target="_blank" rel="noopener">X</a>` : ''}</div>
    </div>`;
  }
  let rdFrame = 0;
  const rdRender = () => { if (!rdFrame) rdFrame = setTimeout(() => { rdFrame = 0; rdDraw(); }, 300); };
  function rdDraw() {
    const all = [...radarItems.values()].sort((a, b) => (Number(b.hot) - Number(a.hot)) || (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
    const list = all.filter(it => rdFilter === 'all' || (rdFilter === 'hot' && it.hot) || (rdFilter === 'dev' && it.why === 'dev') || (rdFilter === 'pool' && it.source === 'pool')).slice(0, 80);
    $('#rdList').innerHTML = list.length ? list.map(rdHTML).join('') : `<div class="rd-empty">${all.length ? 'Nothing of this kind right now.' : '<b>Watching new launches.</b> A coin shows up here when big money goes into it in its first minutes: a big dev buy, big buys piling in (small buys ignored), or a new pool opened with big liquidity. Click one to map its holders.'}</div>`;
    // broken coin pictures fall back to the first letter
    $('#rdList').querySelectorAll('img[data-fallback]').forEach(img => { img.onerror = () => { const i = document.createElement('i'); i.textContent = img.dataset.fallback; img.replaceWith(i); }; });
  }
  async function rdOpen(mint) {
    rdSel = mint; rdDraw();
    try { const d = await post('/api/radar', { mint }); if (d && d.mint) radarItems.set(mint, { ...radarItems.get(mint), ...d }); } catch {}
    mapIt(mint, { kind: 'coin' });
  }
  $('#rdList').addEventListener('click', e => {
    if (e.target.closest('a[target], [data-copy]')) return;
    const m = e.target.closest('[data-rdmap]') || e.target.closest('[data-rd]');
    if (!m) return;
    e.preventDefault();
    rdOpen(m.dataset.rdmap || m.dataset.rd);
  });
  $('#rdTabs').onclick = e => { const b = e.target.closest('[data-rf]'); if (!b) return; rdFilter = b.dataset.rf; $('#rdTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); rdDraw(); };
  $('#rdRulesBtn').onclick = () => { $('#rdRules').hidden = !$('#rdRules').hidden; };
  const RD_KEYS = ['minBuySol', 'watchSol', 'devSol', 'alertSol', 'windowMin', 'poolUsd', 'poolVolUsd'];
  const paintRules = s => { if (!s) return; const f = $('#rdRules'); for (const k of RD_KEYS) if (document.activeElement !== f[k]) f[k].value = s[k]; f.enabled.checked = s.enabled !== false; };
  let rdSaveT = null;
  $('#rdRules').addEventListener('input', () => {
    clearTimeout(rdSaveT);
    rdSaveT = setTimeout(async () => {
      const f = $('#rdRules'), body = { op: 'settings', enabled: f.enabled.checked };
      for (const k of RD_KEYS) body[k] = Number(f[k].value);
      try { const d = await post('/api/radar', body); paintRules(d.settings); toast({ kind: 'fresh', title: 'Saved' }, 1200); } catch {}
    }, 600);
  });
  /** In the map's side panel: the wallets that put the big money in (for a coin from the watchlist). */
  radarSection = mint => {
    const it = radarItems.get(mint);
    if (!it || !it.buyers?.length) return '';
    return '<div class="bm-sec">BIG MONEY IN · FIRST MINUTES</div>' + it.buyers.slice(0, 15).map(b => `<div class="bm-row" data-open="${esc(b.wallet)}" title="Open this wallet's connections"><span class="dot" style="background:${b.dev ? '#f0b84a' : '#7c6dff'}"></span><span class="grow">${b.dev ? '<b>Dev</b> · ' : ''}${esc(short(b.wallet))}${b.buys > 1 ? ` <span class="muted">· ${b.buys} buys</span>` : ''}</span><span class="pct">${solTxt(b.sol)}</span></div>`).join('');
  };
  setInterval(() => { if (radarItems.size) rdDraw(); }, 15000); // keep the ages fresh
  es.addEventListener('radar', e => { const it = JSON.parse(e.data); radarItems.set(it.mint, { ...radarItems.get(it.mint), ...it }); if (it.solUsd) solUsd = it.solUsd; rdRender(); });
  es.addEventListener('radar-status', e => { const d = JSON.parse(e.data); $('#rdSt').textContent = d.status; if (d.solUsd) solUsd = d.solUsd; });
  post('/api/radar', {}).then(d => { for (const it of d.items || []) radarItems.set(it.mint, it); solUsd = d.solUsd; $('#rdSt').textContent = d.status; paintRules(d.settings); rdDraw(); }).catch(() => rdDraw());

  es.addEventListener('hello', e => { const d = JSON.parse(e.data).whales; if (!d) return; events = d.events || []; $('#whStatus').textContent = d.status; render(); });
  es.addEventListener('whale', e => { const ev = JSON.parse(e.data); events = [ev, ...events.filter(x => !(x.id === ev.id && x.kind === ev.kind))].slice(0, 300); render(); });
  es.addEventListener('whale-status', e => { $('#whStatus').textContent = JSON.parse(e.data).status; });
  es.addEventListener('whale-map-progress', e => {
    const p = JSON.parse(e.data), el = $('.bm-prog');
    if (el && !el.hidden && p.mint === mapping) el.textContent = p.total ? `${p.step}… ${p.done}/${p.total}` : p.step + '…';
  });
  post('/api/whales', {}).then(d => { paintList(d); if (!events.length) { events = d.events || []; render(); } }).catch(() => {});
  render();
  const qs = new URLSearchParams(location.search);
  if (qs.get('trace')) trace(qs.get('trace'));
  if (qs.get('map')) mapIt(qs.get('map'));
})();
