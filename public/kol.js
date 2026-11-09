// KOL wallet panel (top-left). Toggle with the "KOLs" button in the header. Shared by both pages.
(() => {
  const q = s => document.querySelector(s);
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => n == null ? '—' : '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
  const hhmmss = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const store = { get: (k, d) => { try { return localStorage.getItem('nr.' + k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('nr.' + k, v); } catch {} } };
  const post = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  const panel = document.createElement('aside');
  panel.className = 'kolp';
  panel.dataset.pop = 'kols'; panel.dataset.popLabel = 'KOL wallets'; panel.dataset.popSize = '600x460';
  panel.innerHTML = `
    <div class="kolp-head">
      <b>KOL wallets</b><span class="kolp-st">…</span>
      <label class="kolp-f" title="Only show buys"><input type="checkbox" class="kolp-buys"> buys</label>
      <button class="ghost small kolp-dorm-btn" title="Wallets with no transaction in the last month (hidden, re-checked in the background)">Dormant</button>
      <button class="ghost small kolp-imp-btn" title="Paste or drop your Axiom wallet export">Import</button>
      <button class="ghost small kolp-edit-btn">Edit</button>
      <button class="ghost small kolp-close" title="Hide panel">Hide</button>
    </div>
    <form class="kolp-edit" hidden>
      <textarea rows="6" spellcheck="false" placeholder="One per line:  emoji  name  wallet-address&#10;e.g.  🐸  kol_name  7xKX…Ab3d"></textarea>
      <div class="kolp-row"><label><input type="checkbox" class="kolp-on"> tracking on</label><span class="grow"></span><button class="ghost small kolp-cancel" type="button">Cancel</button><button class="small">Save</button></div>
      <div class="kolp-hint">Copy wallet addresses from GMGN / Kolscan / Cielo leaderboards. Needs SOLANA_WS_URL in .env (Helius free tier works).</div>
    </form>
    <form class="kolp-imp" hidden>
      <textarea rows="6" spellcheck="false" placeholder="Paste the Axiom export here (all batches at once is fine), or drop the .json / .txt file on this box."></textarea>
      <div class="kolp-row"><label title="Off: merge with the wallets you already have"><input type="checkbox" class="kolp-replace"> replace list</label><input type="file" class="kolp-file" accept=".json,.txt,application/json,text/plain"><span class="grow"></span><button class="ghost small kolp-imp-cancel" type="button">Cancel</button><button class="small">Import</button></div>
      <div class="kolp-hint">Keeps each wallet's name, emoji, highlight colour, groups and toast setting. Addresses are taken as-is, nothing retyped.</div>
    </form>
    <div class="kolp-dorm" hidden></div>
    <div class="kolp-list"><div class="kolp-empty">Waiting for KOL trades…</div></div>`;
  // Docked at the top-left of the page's main column (feed / sessions), not floating over it.
  const dock = document.querySelector('.feed-col, #sessions');
  if (dock) { panel.classList.add('docked'); dock.prepend(panel); } else document.body.appendChild(panel);

  // Header toggle
  const btn = document.createElement('button');
  btn.className = 'ghost kolp-toggle';
  btn.textContent = 'KOLs';
  btn.title = 'Show what tracked KOL wallets are buying';
  q('.top .actions')?.prepend(btn);

  const okey = document.body.dataset.page === 'streams' ? 'kolOpenStreams' : 'kolOpen';
  let open = store.get(okey, document.body.dataset.page === 'streams' ? '0' : '1') === '1';
  if (new URLSearchParams(location.search).get('popout') === 'kols') open = true; // popped out on its own: always shown
  let buysOnly = store.get('kolBuys', '0') === '1';
  const events = new Map();
  const paintOpen = () => { panel.hidden = !open; btn.classList.toggle('on', open); document.body.classList.toggle('kol-open', open); };
  paintOpen();
  btn.onclick = () => { open = !open; store.set(okey, open ? '1' : '0'); paintOpen(); };
  panel.querySelector('.kolp-close').onclick = () => { open = false; store.set(okey, '0'); paintOpen(); };
  panel.querySelector('.kolp-buys').checked = buysOnly;
  panel.querySelector('.kolp-buys').onchange = e => { buysOnly = e.target.checked; store.set('kolBuys', buysOnly ? '1' : '0'); render(); };

  // Edit wallets
  const form = panel.querySelector('.kolp-edit');
  panel.querySelector('.kolp-edit-btn').onclick = async () => {
    const r = await post('/api/kols/list');
    form.querySelector('textarea').value = r.list.map(k => `${k.emoji ? k.emoji + '  ' : ''}${k.name}  ${k.wallet}`).join('\n');
    form.querySelector('.kolp-on').checked = r.enabled;
    form.hidden = false;
  };
  panel.querySelector('.kolp-cancel').onclick = () => { form.hidden = true; };
  form.onsubmit = async e => {
    e.preventDefault();
    const wallets = form.querySelector('textarea').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const parts = l.split(/[\s,]+/);
      const wallet = parts.find(p => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) || '';
      const rest = parts.filter(p => p !== wallet);
      const emoji = rest[0] && !/[A-Za-z0-9]/.test(rest[0]) ? rest.shift() : '';
      return { emoji, name: rest.join(' '), wallet };
    }).filter(w => w.wallet);
    try { await post('/api/kols', { wallets, enabled: form.querySelector('.kolp-on').checked }); form.hidden = true; }
    catch (err) { panel.querySelector('.kolp-st').textContent = err.message; }
  };

  // Import (Axiom export)
  const imp = panel.querySelector('.kolp-imp');
  panel.querySelector('.kolp-imp-btn').onclick = () => { imp.hidden = !imp.hidden; form.hidden = true; };
  panel.querySelector('.kolp-imp-cancel').onclick = () => { imp.hidden = true; };
  const readFile = f => f && f.text().then(t => { imp.querySelector('textarea').value = t; });
  imp.querySelector('.kolp-file').onchange = e => readFile(e.target.files[0]);
  imp.addEventListener('dragover', e => e.preventDefault());
  imp.addEventListener('drop', e => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });
  imp.onsubmit = async e => {
    e.preventDefault();
    const st = panel.querySelector('.kolp-st');
    try {
      const r = await post('/api/kols/import', { text: imp.querySelector('textarea').value, replace: imp.querySelector('.kolp-replace').checked });
      st.textContent = r.imported ? `imported ${r.imported} wallets · ${r.list.length} total` : 'no wallets found in that text';
      if (r.imported) { imp.hidden = true; imp.querySelector('textarea').value = ''; }
    } catch (err) { st.textContent = err.message; }
  };

  // Dormant list
  let dormant = [];
  const dorm = panel.querySelector('.kolp-dorm');
  const ago = t => t == null ? 'no history' : Math.round((Date.now() - t) / 86400000) + 'd ago';
  const paintDorm = () => {
    dorm.innerHTML = `<div class="kolp-hint">Quiet for a month or more. Hidden and not streamed; checked every ~10 min and you get a BACK ONLINE alert when one moves.</div>` +
      (dormant.length ? dormant.slice(0, 400).map(k => `<div class="kolp-d"><span>${h(k.emoji)} ${h(k.name)}</span><span class="muted">${ago(k.lastActiveAt)}</span></div>`).join('') : '<div class="kolp-empty">No dormant wallets.</div>');
  };
  panel.querySelector('.kolp-dorm-btn').onclick = () => { dorm.hidden = !dorm.hidden; if (!dorm.hidden) paintDorm(); };
  const paintCounts = d => {
    if (d.wallets == null) return;
    panel.querySelector('.kolp-dorm-btn').textContent = `Dormant ${d.dormant}`;
    panel.querySelector('.kolp-st').title = `${d.active} active · ${d.dormant} dormant · ${d.wallets} total (${d.scanned} activity-checked)`;
  };

  // Status in the header: short, coloured (red on errors, green when live); the full text is in the tooltip.
  function setSt(s) {
    const el = panel.querySelector('.kolp-st');
    const bad = /error|fail|add a Solana/i.test(s || ''), ok = /^live/i.test(s || '');
    el.textContent = bad ? (/add a Solana/i.test(s) ? 'add a Solana RPC in API keys' : 'RPC error · retrying') : s;
    el.title = s || '';
    el.classList.toggle('bad', bad); el.classList.toggle('ok', ok);
    el.dataset.full = s || '';
  }
  function row(ev) {
    const side = ev.side ? ev.side.toUpperCase() : '···';
    const pending = ev.stage === 'processed';
    const lat = ev.blockTime && ev.seenAt >= ev.blockTime ? `+${((ev.seenAt - ev.blockTime) / 1000).toFixed(1)}s` : '';
    const coin = ev.symbol ? '$' + h(ev.symbol) : ev.mint ? h(ev.mint.slice(0, 6)) + '…' : '';
    const cluster = `<span class="x" title="${ev.clusterCount >= 2 ? h(ev.clusterCount + ' KOLs bought this: ' + (ev.clusterKols || []).join(', ')) : ''}">${ev.clusterCount >= 2 ? '×' + ev.clusterCount : ''}</span>`;
    const color = /^#[0-9a-f]{6}$/i.test(ev.color || '') ? ` style="color:${ev.color}"` : '';
    const back = ev.back ? `<span class="kolp-back" title="No transactions for ${ev.back.quietDays ?? '30+'} days before this">BACK ${ev.back.quietDays != null ? ev.back.quietDays + 'd' : ''}</span>` : '';
    return `<div class="kolp-ev ${h(ev.side || 'na')} ${pending ? 'pending' : ''} ${ev.clusterCount >= 2 ? 'clustered' : ''} ${ev.back ? 'is-back' : ''}" data-id="${h(ev.id)}">
      <span class="t">${hhmmss(ev.seenAt)}</span>
      <a class="k" href="https://solscan.io/account/${h(ev.wallet)}" target="_blank" rel="noopener" title="${h(ev.wallet)} · open on Solscan"${color}>${ev.emoji ? h(ev.emoji) + ' ' : ''}${h(ev.kol)}${back}</a>
      <span class="s">${side}</span>
      <span class="c">${pending ? `<span class="muted">${h(ev.venue)} · landing…</span>` : `<b data-word="${h(ev.symbol || '')}" title="${h(ev.name || ev.mint || '')}">${coin}</b>${ev.mint && ev.side === 'buy' ? qbHTML(ev.mint, ev.symbol) : ''}`}</span>
      ${cluster}
      <span class="n">${ev.sol ? solHTML(ev.sol.toFixed(2)) : ''}</span>
      <span class="n">${ev.marketCap ? 'mc ' + usd(ev.marketCap) : ''}</span>
      <span class="l">${ev.links?.gmgn ? `<a target="_blank" rel="noopener" href="${h(ev.links.gmgn)}">GMGN</a>` : ''}${ev.links?.axiom ? `<a target="_blank" rel="noopener" href="${h(ev.links.axiom)}">AX</a>` : ''}${ev.links?.solscan ? `<a target="_blank" rel="noopener" href="${h(ev.links.solscan)}" title="Transaction ${lat}">tx</a>` : ''}</span>
    </div>`;
  }

  let frame = 0;
  function render() { if (!frame) frame = setTimeout(() => { frame = 0; draw(); }, 250); } // at most 4 redraws a second
  function draw() {
    const list = [...events.values()].sort((a, b) => b.seenAt - a.seenAt).filter(e => !buysOnly || e.side === 'buy').slice(0, 30);
    const st = panel.querySelector('.kolp-st').dataset.full || '';
    const bad = /error|fail|add a Solana/i.test(st);
    const why = /checking/.test(st) ? `First run: checking which of your wallets traded recently (${h(st)}). Active ones go live as they're found.`
      : /add a Solana/i.test(st) ? 'Add a Solana RPC (a free Helius key works) under <b>API keys</b> to track wallets.'
      : bad ? `<b>Can't reach your Solana RPC.</b> ${h(st.replace(/^wallet check: /, ''))}<br>Check the Helius key under <b>API keys</b> (press Test).`
      : 'Waiting for KOL trades… The latest trades of your most active wallets load here in a moment.';
    panel.querySelector('.kolp-list').innerHTML = list.length ? list.map(row).join('') : `<div class="kolp-empty ${bad ? 'bad' : ''}">${why}</div>`;
  }

  const es = window.nrES || (window.nrES = new EventSource('/api/events'));
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data).kols;
    if (!d) return;
    events.clear();
    for (const ev of d.events) events.set(ev.id, ev);
    setSt(d.status);
    dormant = d.dormantList || [];
    paintCounts(d);
    render();
  });
  es.addEventListener('kol', e => {
    const ev = JSON.parse(e.data);
    events.set(ev.id, ev);
    while (events.size > 120) events.delete([...events.values()].sort((a, b) => a.seenAt - b.seenAt)[0].id);
    render();
  });
  es.addEventListener('kol-drop', e => { events.delete(JSON.parse(e.data).id); render(); });
  es.addEventListener('kol-status', e => { const d = JSON.parse(e.data); setSt(d.status); paintCounts(d); if (!events.size) render(); });

  // Click a coin: hand it to the page's own copy-and-check if it has one.
  panel.addEventListener('click', e => {
    const w = e.target.closest('[data-word]');
    if (!w || !w.dataset.word) return;
    if (typeof window.copyAndCheck === 'function') return window.copyAndCheck(w.dataset.word);
    navigator.clipboard?.writeText(w.dataset.word).catch(() => {});
    if (typeof window.runLookup === 'function') window.runLookup(w.dataset.word);
  });
})();
