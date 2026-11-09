// Elixir mascot: the logo with eyes, top-right. Click it, box (or highlight) anything on the page,
// and it researches the coin in it and tells you if it looks good, mixed or worth avoiding.
(() => {
  if (document.documentElement.classList.contains('pop-view')) return;
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const usd = n => (n == null ? '' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));

  // ---------- the mascot ----------
  const SVG = `<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
    <defs>
      <linearGradient id="mx-b" x1="20" y1="6" x2="44" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#c3cbff"/><stop offset=".4" stop-color="#8b86ff"/><stop offset=".78" stop-color="#5b4df0"/><stop offset="1" stop-color="#3a2bc4"/></linearGradient>
      <linearGradient id="mx-l" x1="32" y1="34" x2="32" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6f63ff"/><stop offset="1" stop-color="#2c1f9e"/></linearGradient>
      <clipPath id="mx-c"><path d="M32 4.5C29.5 8 13 25.5 13 40.5a19 19 0 0 0 38 0C51 25.5 34.5 8 32 4.5Z"/></clipPath>
    </defs>
    <path d="M32 4.5C29.5 8 13 25.5 13 40.5a19 19 0 0 0 38 0C51 25.5 34.5 8 32 4.5Z" fill="url(#mx-b)"/>
    <g clip-path="url(#mx-c)"><path d="M8 47c7-4 13 2.5 21-1s12-6 27-1v22H8z" fill="url(#mx-l)" opacity=".85"/><circle cx="24" cy="54" r="1.8" fill="#fff" opacity=".45"/><circle cx="40" cy="57" r="1.2" fill="#fff" opacity=".4"/></g>
    <path d="M23 19c-3 4.5-5.4 9.5-5.6 14.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".6"/>
    <g class="mx-face">
      <g class="mx-eyes">
        <ellipse cx="25" cy="36.5" rx="6.1" ry="6.9" fill="#fff"/><ellipse cx="39" cy="36.5" rx="6.1" ry="6.9" fill="#fff"/>
        <g class="mx-pupils"><circle cx="25" cy="37" r="2.9" fill="#120d3a"/><circle cx="39" cy="37" r="2.9" fill="#120d3a"/><circle cx="26.1" cy="35.7" r="1" fill="#fff"/><circle cx="40.1" cy="35.7" r="1" fill="#fff"/></g>
      </g>
      <path class="mx-mouth" d="M29 47q3 2.2 6 0" fill="none" stroke="#120d3a" stroke-width="1.6" stroke-linecap="round"/>
    </g>
    <path d="M32 4.5C29.5 8 13 25.5 13 40.5a19 19 0 0 0 38 0C51 25.5 34.5 8 32 4.5Z" fill="none" stroke="#211a7a" stroke-opacity=".5" stroke-width="1.3"/>
  </svg>`;
  const mx = document.createElement('button');
  mx.type = 'button';
  mx.className = 'mascot';
  mx.title = 'Ask Elixir (tap or Alt+X): box a coin and I\'ll tell you if it looks good · hold and drag to move me · right-click: back to the header';
  mx.innerHTML = SVG;
  const home = document.querySelector('.top');
  if (!home) return;
  home.append(mx);
  const pupils = mx.querySelector('.mx-pupils'), face = mx.querySelector('.mx-face');

  // Eyes follow the mouse; blink now and then.
  let raf = 0, mouse = null;
  document.addEventListener('mousemove', e => { mouse = [e.clientX, e.clientY]; if (!raf) raf = requestAnimationFrame(look); }, { passive: true });
  function look() {
    raf = 0;
    if (!mouse || mx.classList.contains('thinking')) return;
    const r = mx.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.58;
    const dx = mouse[0] - cx, dy = mouse[1] - cy, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, k = Math.min(1, d / 220), p = Math.max(0.45, k);
    pupils.style.transform = `translate(${(ux * 3.1 * p).toFixed(2)}px, ${(uy * 3.1 * p).toFixed(2)}px)`;   // eyes look at the cursor
    face.style.transform = `translate(${(ux * 1.8 * k).toFixed(2)}px, ${(uy * 1.3 * k).toFixed(2)}px)`;  // the face turns a little
    mx.style.rotate = `${Math.max(-10, Math.min(10, dx / 28)).toFixed(1)}deg`;                         // and it tilts its head
  }
  (function blink() { setTimeout(() => { mx.classList.add('blink'); setTimeout(() => mx.classList.remove('blink'), 140); blink(); }, 2600 + Math.random() * 3800); })();

  // ---------- snipping ----------
  let veil = null, box = null, start = null;
  // Hold it and drag it anywhere on the screen; double-click puts it back in the header.
  const POS_KEY = 'nr.mascot.pos';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let pos = null; try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch {}
  function applyPos() {
    // Out of the header while it's free: the header's blur effect would otherwise pin it inside the header.
    if (!pos) { mx.classList.remove('free', 'float'); mx.style.removeProperty('--x'); mx.style.removeProperty('--y'); if (mx.parentNode !== home) home.append(mx); return; }
    if (mx.parentNode !== document.body) document.body.append(mx);
    const w = mx.offsetWidth || 40, hh = mx.offsetHeight || 44;
    const x = clamp(pos.fx * window.innerWidth, 0, window.innerWidth - w), y = clamp(pos.fy * window.innerHeight, 0, window.innerHeight - hh);
    mx.classList.add('free'); mx.style.setProperty('--x', x + 'px'); mx.style.setProperty('--y', y + 'px');
  }
  applyPos(); window.addEventListener('resize', applyPos);
  let drag = null, swallowClick = false, targetEl = null;
  // The coin card / row under the pointer while you drag the mascot (it lights up; drop = research)
  const UNIT = '.rd-it, .card, .whev, .whhot, .kolp-ev, .bm-card, .bm-coin, .pcard, .cm, .cand, .livecoin, .al, .mo, .bm-row, .hrow, .bm-buy, .wm-p';
  function coinUnderPointer(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === mx || mx.contains(el) || el.closest('.mx-card, .mx-menu')) continue;
      const u = el.closest(UNIT);
      if (!u) continue;
      if (u.querySelector('[data-qb], [data-rd], [data-map], [data-copy], img[src*="/img/coin/"]') || /\$[A-Za-z]{2,}|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(u.textContent)) return u;
      return null;
    }
    return null;
  }
  function target(el) {
    if (el === targetEl) return;
    targetEl?.classList.remove('mx-target'); targetEl = el; el?.classList.add('mx-target');
  }
  mx.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = mx.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, t: Date.now(), moved: false };
    drag.hold = setTimeout(() => drag && mx.classList.add('held'), 220);
    mx.setPointerCapture(e.pointerId);
  });
  mx.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
      drag.moved = true; mx.classList.add('free', 'dragging', 'held'); if (card) closeCard();
      if (mx.parentNode !== document.body) { document.body.append(mx); mx.setPointerCapture(e.pointerId); }
    }
    if (!drag.moved) return;
    const w = mx.offsetWidth, hh = mx.offsetHeight;
    mx.style.setProperty('--x', clamp(e.clientX - drag.ox, 0, window.innerWidth - w) + 'px');
    mx.style.setProperty('--y', clamp(e.clientY - drag.oy, 0, window.innerHeight - hh) + 'px');
    target(coinUnderPointer(e.clientX, e.clientY));
  });
  mx.addEventListener('pointerup', () => {
    if (!drag) return;
    clearTimeout(drag.hold);
    const { moved, t } = drag; drag = null;
    mx.classList.remove('dragging', 'held');
    const tgt = targetEl; target(null);
    if (moved && tgt) {                           // dropped on a coin: research it
      const r = tgt.getBoundingClientRect();
      const rr = mx.getBoundingClientRect();
      pos = { fx: rr.left / window.innerWidth, fy: rr.top / window.innerHeight };
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
      applyPos(); swallowClick = true;
      ask({ text: textIn(r), mints: mintsIn(r) }, r);
      return;
    }
    if (moved) {
      const r = mx.getBoundingClientRect();
      pos = { fx: r.left / window.innerWidth, fy: r.top / window.innerHeight };
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
      applyPos(); swallowClick = true;           // the click that follows a drag isn't a tap
    } else if (Date.now() - t >= 350) swallowClick = true; // held and let go: just put it down
  });
  // Right-click: a small menu (back home / hide)
  const goHome = () => { pos = null; try { localStorage.removeItem(POS_KEY); } catch {} applyPos(); closeCard(); };
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  mx.addEventListener('contextmenu', e => {
    e.preventDefault(); closeMenu();
    menu = document.createElement('div'); menu.className = 'mx-menu';
    menu.innerHTML = '<button type="button" data-a="home">Back to my spot</button><button type="button" data-a="hide">Hide mascot <kbd>Alt+Shift+X</kbd></button>';
    document.body.append(menu);
    Object.assign(menu.style, { left: Math.min(window.innerWidth - 200, e.clientX) + 'px', top: Math.min(window.innerHeight - 90, e.clientY + 6) + 'px' });
    menu.onclick = ev => { const a = ev.target.closest('[data-a]')?.dataset.a; closeMenu(); if (a === 'home') goHome(); if (a === 'hide') setHidden(true); };
    setTimeout(() => document.addEventListener('mousedown', ev => { if (menu && !menu.contains(ev.target)) closeMenu(); }, { once: true }), 0);
  });
  // Hidden: gone from every page until Alt+Shift+X or "Show mascot" in the status bar
  const showLink = document.createElement('a');
  showLink.href = '#'; showLink.className = 'sbar-l mx-show'; showLink.textContent = 'Show mascot'; showLink.title = 'Bring the mascot back (Alt+Shift+X)';
  showLink.onclick = e => { e.preventDefault(); setHidden(false); };
  function setHidden(on) {
    mx.hidden = on; if (on) closeCard();
    try { localStorage.setItem('nr.mascot.hidden', on ? '1' : '0'); } catch {}
    const bar = document.querySelector('.sbar');
    if (on && bar && !showLink.isConnected) bar.querySelector('.sbar-zoom')?.before(showLink); else if (!on) showLink.remove();
  }
  try { if (localStorage.getItem('nr.mascot.hidden') === '1') setTimeout(() => setHidden(true), 0); } catch {}

  mx.addEventListener('click', () => {
    if (swallowClick) { swallowClick = false; return; }
    if (card) return closeCard();
    // Something already highlighted? Research that straight away.
    const sel = window.getSelection();
    const text = sel && String(sel).trim();
    if (text && text.length >= 2) {
      const r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const mints = mintsIn(r);
      sel.removeAllRanges();
      return ask({ text, mints }, r);
    }
    snip();
  });
  function snip() {
    veil = document.createElement('div');
    veil.className = 'mx-veil';
    // Without the browser extension the mascot can only read this Elixir page; say so.
    const ext = document.documentElement.hasAttribute('data-elixir-ext');
    veil.innerHTML = `<div class="mx-hint"><b>Box a coin</b>drag over a ticker, CA, or card · or click one · Esc to cancel<span class="mx-scope ${ext ? 'on' : ''}">${ext ? 'Extension on: Alt+X works on every website too.' : 'Scanning this Elixir page only. To use me on X, Axiom, DexScreener and every other site, load the <b>extension</b> folder in chrome://extensions (see README).'}</span></div>`;
    document.body.append(veil);
    mx.classList.add('active');
    veil.addEventListener('mousedown', e => { start = [e.clientX, e.clientY]; box = document.createElement('div'); box.className = 'mx-box'; veil.append(box); draw(e); });
    veil.addEventListener('mousemove', e => { if (start) draw(e); });
    veil.addEventListener('mouseup', e => {
      if (!start) return;
      const x1 = Math.min(start[0], e.clientX), y1 = Math.min(start[1], e.clientY), x2 = Math.max(start[0], e.clientX), y2 = Math.max(start[1], e.clientY);
      start = null;
      endSnip();
      let rect = { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1 };
      // A click (no drag): take the card / row under the cursor
      if (rect.width < 8 && rect.height < 8) {
        const el = document.elementFromPoint(x1, y1);
        const unit = el?.closest('.rd-it, .card, .whev, .whhot, .kolp-ev, .bm-card, .bm-coin, .pcard, .cm, .cand, .livecoin, .al, .mo, .bm-row, .hrow, .bm-buy, tr') || el;
        if (unit) rect = unit.getBoundingClientRect();
      }
      const text = textIn(rect);
      ask({ text, mints: mintsIn(rect) }, rect);
    });
  }
  const draw = e => { const x1 = Math.min(start[0], e.clientX), y1 = Math.min(start[1], e.clientY); Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: Math.abs(e.clientX - start[0]) + 'px', height: Math.abs(e.clientY - start[1]) + 'px' }); };
  function endSnip() { veil?.remove(); veil = null; box = null; mx.classList.remove('active'); }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (veil) endSnip(); else if (card) closeCard(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyX' && e.shiftKey) { e.preventDefault(); setHidden(!mx.hidden); return; }
    // Alt+X: box a coin (or research the highlighted text) without reaching for the mouse
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyX' && !e.shiftKey) { e.preventDefault(); if (mx.hidden) setHidden(false); if (!veil) mx.click(); }
  });

  const hits = (r, a) => a && r && a.right >= r.left && a.left <= r.right && a.bottom >= r.top && a.top <= r.bottom;
  /** All visible text inside the box. */
  function textIn(r) {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.nodeValue.trim() && !n.parentElement.closest('.mascot, .mx-card, .mx-veil, script, style') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const range = document.createRange();
    let n, seen = 0;
    while ((n = walker.nextNode()) && seen < 20000) {
      seen++;
      range.selectNodeContents(n);
      if (hits(r, range.getBoundingClientRect())) out.push(n.nodeValue.trim());
      if (out.join(' ').length > 3000) break;
    }
    return out.join(' ').replace(/\s+/g, ' ');
  }
  /** Coin addresses the page attached to things inside the box (buttons, links, data attributes). */
  function mintsIn(r) {
    if (!r) return [];
    const out = [];
    document.querySelectorAll('[data-qb], [data-rd], [data-map], [data-copy], [data-rdmap], [data-trace-coin], a[href*="/token/"], a[href*="/meme/"], a[href*="/coin/"], a[href*="dexscreener.com/solana/"], img[src*="/img/coin/"]').forEach(el => {
      if (!hits(r, el.getBoundingClientRect())) return;
      const v = el.dataset.qb || el.dataset.rd || el.dataset.map || el.dataset.rdmap || el.dataset.traceCoin || el.dataset.copy || el.getAttribute('href') || el.getAttribute('src') || '';
      for (const m of v.match(B58) || []) if (!out.includes(m)) out.push(m);
    });
    return out.slice(0, 10);
  }

  // ---------- research + the speech bubble ----------
  let card = null;
  async function ask(input, rect) {
    if (!input.text && !input.mints.length) return;
    mx.classList.add('thinking', 'out');
    // hop over next to what you boxed
    if (rect) {
      const x = Math.min(window.innerWidth - 60, rect.right + 12), y = Math.max(8, rect.top - 6);
      const hr = mx.getBoundingClientRect();
      mx.style.transform = `translate(${x - hr.left}px, ${y - hr.top}px) scale(1.25)`;
    }
    openCard('<div class="mx-wait"><span></span><span></span><span></span> Researching…</div>');
    const id = ++askId, t0 = performance.now();
    const call = stage => fetch('/api/lens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, stage }) })
      .then(async res => { const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Research failed'); return j; });
    // 1) quick answer (market data + what Elixir already knows): on screen in a fraction of a second
    try {
      const q = await call('quick');
      if (id !== askId) return;
      mx.classList.remove('thinking');
      if (!q.found) return fill(`<div class="mx-msg">${h(q.message)}</div>`);
      render(q, ((performance.now() - t0) / 1000).toFixed(1));
    } catch (e) { if (id === askId) { mx.classList.remove('thinking'); fill(`<div class="mx-msg">${h(e.message)}</div>`); } return; }
    // 2) full answer (rug + holder checks, Claude's write-up) replaces it when ready
    try {
      const f = await call('full');
      if (id !== askId || !card) return;
      if (f.found) render(f, ((performance.now() - t0) / 1000).toFixed(1));
    } catch {}
  }
  let askId = 0;
  const NARR = { real: ['Real story', 'g'], unclear: ['Story unclear', 'm'], manufactured: ['Looks manufactured', 'b'] };
  const vsLaunch = m => (m == null ? '' : Math.abs(m) <= 1 ? 'at launch' : `${Math.abs(m) < 60 ? Math.abs(m) + 'm' : (Math.abs(m) / 60).toFixed(1) + 'h'} ${m < 0 ? 'before' : 'after'} launch`);
  const afterTxt = s => (Math.abs(s) < 90 ? Math.round(Math.abs(s)) + 's' : Math.abs(s) < 5400 ? Math.round(Math.abs(s) / 60) + 'm' : (Math.abs(s) / 3600).toFixed(1) + 'h');
  const fol = n => (!n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
  /** Why it's moving: where it started, the tweet trail, and whether the story is real. */
  function storyHTML(r) {
    const s = r.story;
    if (!s) return '';
    const nv = r.ai?.narrative?.verdict || s.verdict, [label, cls] = NARR[nv] || NARR.unclear;
    const reason = r.ai?.narrative?.reason || s.reasons[0] || '';
    const o = s.origin;
    const tw = s.tweets; // oldest first: how it built up
    const row = t => `<a class="mx-tw ${t.promo ? 'promo' : ''}" href="${h(/^https:\/\//.test(t.url || '') ? t.url : '#')}" target="_blank" rel="noopener"><span class="mx-tw-h"><b>@${h(t.author)}</b>${t.followers ? ` <em>${fol(t.followers)}</em>` : ''}${t.verified ? ' <em>✓</em>' : ''}${t.vip ? ' <em>tracked</em>' : ''}<span class="grow"></span><i>${h(vsLaunch(t.vsLaunchMin))}</i></span><span class="mx-tw-t">${h(t.text)}</span></a>`;
    return `<div class="mx-sec">WHY IT'S MOVING</div>
      <div class="mx-narr ${cls}"><b>${label}</b><span>${h(reason)}</span></div>
      ${s.reasons.slice(1, 3).map(x => `<div class="mx-reason">${h(x)}</div>`).join('')}
      ${r.ai?.why ? `<p class="mx-why">${h(r.ai.why)}</p>` : ''}
      ${o ? `<a class="mx-origin" href="${h(/^https:\/\//.test(o.url || '') ? o.url : '#')}" target="_blank" rel="noopener"><span>Started from @${h(o.author)}${o.afterSec != null ? ` · coin launched ${h(afterTxt(o.afterSec))} after it` : ''}</span>${h(o.text)}</a>` : ''}
      ${tw.length ? `<div class="mx-tws">${tw.slice(0, 4).map(row).join('')}${tw.length > 4 ? `<details class="mx-more"><summary>${tw.length - 4} more</summary>${tw.slice(4).map(row).join('')}</details>` : ''}</div>` : ''}
      ${r.stage === 'quick' && !s.searched ? '<div class="mx-reason">Searching X for more…</div>' : s.note && s.note !== 'no-key' ? `<div class="mx-reason">${h(s.note)}</div>` : ''}`;
  }
  function render(r, secs) {
    const f = r.facts, v = r.ai || r.rules;
    const verdict = v.verdict;
    mx.dataset.mood = verdict;
    const lbl = { good: 'Looks good', mixed: 'Mixed', avoid: 'Avoid' }[verdict];
    const pts = (arr, cls) => (arr || []).slice(0, 4).map(t => `<li class="${cls}">${h(t)}</li>`).join('');
    const quick = r.stage === 'quick';
    const foot = quick ? `<span class="mx-live"><i></i>Answered in ${h(secs)}s · checking rugs, holders${r.aiAvailable !== false ? ' and writing the AI verdict' : ''}…</span>`
      : `${r.ai ? `Claude's verdict from live data · ${h(secs)}s.` : r.aiAvailable ? `Rule-based (Claude was unavailable) · ${h(secs)}s.` : `Rule-based · ${h(secs)}s. Add an Anthropic key in API keys for a written AI verdict.`} Not financial advice.`;
    fill(`<div class="mx-head">
        <img src="${h(window.coinImg ? window.coinImg(f.mint, f.image) : f.image || '')}" alt="" onerror="this.remove()">
        <div class="grow"><b>${f.symbol ? '$' + h(f.symbol) : 'Coin'}</b>${window.qbHTML ? window.qbHTML(f.mint, f.symbol) : ''}<div class="mx-sub">${h(f.name || '')}${f.marketCap ? ' · mc ' + usd(f.marketCap) : ''}${f.liquidity ? ' · liq ' + usd(f.liquidity) : ''}</div></div>
        <span class="mx-verdict ${verdict}">${lbl}<em>${r.rules.score}</em></span></div>
      ${r.ai?.headline ? `<div class="mx-hl">${h(r.ai.headline)}</div>` : ''}
      <p class="mx-sum">${h(v.summary)}</p>
      <ul class="mx-pts">${pts(v.good, 'g')}${pts(v.bad, 'b')}</ul>
      ${storyHTML(r)}
      ${r.rules.info?.length ? `<div class="mx-info">${r.rules.info.slice(0, 3).map(h).join(' · ')}</div>` : ''}
      <div class="mx-links"><a href="#" data-map="${h(f.mint)}" data-mxmap="${h(f.mint)}">Bubble map</a><a href="${h(r.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${h(r.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${h(r.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a><a href="${h(r.links.solscan)}" target="_blank" rel="noopener">Solscan</a></div>
      <div class="mx-foot">${foot}</div>`);
  }
  function openCard(html) {
    closeCard(true);
    card = document.createElement('div');
    card.className = 'mx-card';
    card.innerHTML = `<button type="button" class="mx-x" title="Close (Esc)">×</button><div class="mx-body">${html}</div>`;
    document.body.append(card);
    card.querySelector('.mx-x').onclick = () => closeCard();
    place();
  }
  function fill(html) { if (!card) openCard(html); else { card.querySelector('.mx-body').innerHTML = html; place(); } }
  function place() {
    if (!card) return;
    const m = mx.getBoundingClientRect(), w = Math.min(360, window.innerWidth - 16);
    card.style.width = w + 'px';
    let left = m.left - w - 10, top = m.top;
    if (left < 8) left = Math.min(window.innerWidth - w - 8, m.right + 10);
    const hgt = card.offsetHeight;
    if (top + hgt > window.innerHeight - 40) top = Math.max(8, window.innerHeight - 40 - hgt);
    Object.assign(card.style, { left: left + 'px', top: top + 'px' });
  }
  function closeCard(keepMascot) {
    card?.remove(); card = null;
    if (!keepMascot) askId++; // a late answer for a closed card is dropped
    if (!keepMascot) { mx.style.transform = ''; mx.classList.remove('out', 'thinking'); delete mx.dataset.mood; }
  }
  // "Bubble map" from the card: on the map page map it here, elsewhere open the map page.
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-mxmap]');
    if (!a || document.body.dataset.page === 'whales') return;
    e.preventDefault(); e.stopPropagation();
    location.href = '/whales.html?view=map&map=' + encodeURIComponent(a.dataset.mxmap);
  }, true);
  window.addEventListener('resize', place);
})();
