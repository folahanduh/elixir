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
  mx.title = 'Ask Elixir (tap or Alt+X): box a coin and I\'ll tell you if it looks good · hold and drag to move me · × or right-click: hide me';
  mx.innerHTML = SVG + '<span class="mx-hide" title="Hide the mascot (Alt+Shift+X to bring it back)" aria-label="Hide mascot">×</span>';
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
  let drag = null, swallowUntil = 0, targetEl = null; // swallowUntil: ignore the click that a drag/hold ends with (only that one)
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
    prefetch(el);
  }
  // Held over a coin: start researching it before you let go, so the answer is ready on drop
  // (market + rug checks after 0.2 s; Claude's write-up only if you stay on it for 0.7 s).
  let preT = [];
  function prefetch(el) {
    preT.forEach(clearTimeout); preT = [];
    if (!el) return;
    const r = el.getBoundingClientRect(), input = { text: textIn(r), mints: mintsIn(r) };
    if (!input.text && !input.mints.length) return;
    preT.push(setTimeout(() => { lensCall(input, 'quick').catch(() => {}); lensCall(input, 'risk').catch(() => {}); }, 200));
    preT.push(setTimeout(() => lensCall(input, 'full').catch(() => {}), 700));
  }
  mx.addEventListener('pointerdown', e => {
    if (e.target.closest('.mx-hide')) { e.preventDefault(); e.stopPropagation(); swallowUntil = Date.now() + 400; setHidden(true); return; }
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
      applyPos(); swallowUntil = Date.now() + 400;
      ask({ text: textIn(r), mints: mintsIn(r) }, r);
      return;
    }
    if (moved) {
      const r = mx.getBoundingClientRect();
      pos = { fx: r.left / window.innerWidth, fy: r.top / window.innerHeight };
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
      applyPos(); swallowUntil = Date.now() + 400;           // the click that follows a drag isn't a tap
    } else if (Date.now() - t >= 350) swallowUntil = Date.now() + 400; // held and let go: just put it down
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
    if (Date.now() < swallowUntil) return;
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
  // What text is inside the box? Walks the page but skips whole sections that are nowhere near it,
  // so it stays quick on big pages (Axiom, DexScreener).
  function textIn(r) {
    const out = [], range = document.createRange(), near = { left: r.left - 150, right: r.right + 150, top: r.top - 150, bottom: r.bottom + 150 };
    let len = 0, n = 0;
    (function walk(el) {
      for (let c = el.firstChild; c && len < 3000 && n < 40000; c = c.nextSibling) {
        n++;
        if (c.nodeType === 3) {
          const v = c.nodeValue.trim();
          if (!v) continue;
          range.selectNodeContents(c);
          if (hits(r, range.getBoundingClientRect())) { out.push(v); len += v.length + 1; }
        } else if (c.nodeType === 1) {
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|CANVAS|IFRAME|svg)$/i.test(c.tagName) || c.matches('.mascot, .mx-card, .mx-veil, .mx-menu')) continue;
          const b = c.getBoundingClientRect();
          if (b.width && b.height && !hits(near, b)) continue; // a whole section away from the box
          walk(c);
        }
      }
    })(document.body);
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
    const call = stage => lensCall(input, stage);
    const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
    // All three at once (the server shares the work): quick = instant market read, risk = rug + holder checks,
    // full = X search + Claude. Whichever is furthest along when it arrives is what you see.
    const RANK = { quick: 0, risk: 1, full: 2 };
    const pendingOf = r => Boolean(r.facts?.checking?.bundle || r.facts?.checking?.holders);
    let shown = -1, polls = 0;
    const show = r => {
      if (id !== askId || !card) return;
      mx.classList.remove('thinking');
      if (!r.found) { if (shown < 0) { shown = 99; fill(`<div class="mx-msg">${h(r.message)}</div>`); } return; }
      const key = RANK[r.stage] * 10 + (pendingOf(r) ? 0 : 5);
      if (key > shown) { shown = key; render(r, secs()); }
      // bundle scan / holders still running: ask again until they're in (the answer then updates itself)
      if (r.stage === 'full' && pendingOf(r) && polls++ < 10) setTimeout(() => { if (id === askId && card) call('full').then(show).catch(() => {}); }, 2000);
    };
    call('quick').then(show).catch(e => { if (id === askId && shown < 0) { mx.classList.remove('thinking'); fill(`<div class="mx-msg">${h(e.message)}</div>`); } });
    call('risk').then(show).catch(() => {});
    call('full').then(show).catch(() => { if (id === askId && card) card.querySelector('.mx-ai-wait')?.replaceChildren("Claude didn't answer in time. The read above stands."); });
  }
  let hovT = 0, hovEl = null;
  document.addEventListener('mouseover', e => {
    if (mx.hidden || drag) return;
    const u = e.target.closest?.(UNIT);
    if (u === hovEl) return;
    hovEl = u; clearTimeout(hovT);
    if (!u || u.closest('.mx-card')) return;
    hovT = setTimeout(() => {
      if (hovEl !== u || coinUnderPointer(e.clientX, e.clientY) !== u) return;
      const r = u.getBoundingClientRect();
      if (r.height > 260) return;
      const input = { text: textIn(r), mints: mintsIn(r) };
      if (input.text || input.mints.length) { lensCall(input, 'quick').catch(() => {}); lensCall(input, 'risk').catch(() => {}); }
    }, 350);
  }, { passive: true });
  const lensCall = (input, stage) => fetch('/api/lens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, stage }) })
    .then(async res => { const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Research failed'); return j; });
  let askId = 0;
  // Where the time went: finding the coin, the rug + holder checks, the AI write-up (0 = reused)
  const sec = ms => (ms == null ? '–' : ms < 50 ? 'instant' : (ms / 1000).toFixed(1) + 's');
  const tmg = r => (r.timing ? ` (coin ${sec(r.timing.find)} · checks ${sec(r.timing.checks)} · AI ${sec(r.timing.ai)})` : '');
  const NARR = { real: ['Real story', 'g'], unclear: ['Story unclear', 'm'], manufactured: ['Looks manufactured', 'b'], unknown: ['Story not checked', 'm'] };
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
    const row = t => t.via === 'chain' ? `<a class="mx-tw chain" href="${h(/^https:\/\//.test(t.url || '') ? t.url : '#')}" target="_blank" rel="noopener"><span class="mx-tw-h"><b>${h(t.author)}</b> <em>on-chain</em><span class="grow"></span><i>${h(vsLaunch(t.vsLaunchMin))}</i></span><span class="mx-tw-t">${h(t.text)}</span></a>` : `<a class="mx-tw ${t.promo ? 'promo' : ''}" href="${h(/^https:\/\//.test(t.url || '') ? t.url : '#')}" target="_blank" rel="noopener"><span class="mx-tw-h"><b>@${h(t.author)}</b>${t.followers ? ` <em>${fol(t.followers)}</em>` : ''}${t.verified ? ' <em>✓</em>' : ''}${t.vip ? ' <em>tracked</em>' : ''}<span class="grow"></span><i>${h(vsLaunch(t.vsLaunchMin))}</i></span><span class="mx-tw-t">${h(t.text)}</span></a>`;
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
    const quick = r.stage !== 'full';
    const foot = quick ? `<span class="mx-live"><i></i>${r.stage === 'quick' ? 'Checking rugs and holders' : `Risk checked in ${h(secs)}s · researching`}…</span>`
      : `${r.ai ? `${h(r.ai.by || 'Claude')}'s verdict from live data · ${h(secs)}s${tmg(r)}.` : r.aiAvailable ? `Rule-based (Claude was unavailable) · ${h(secs)}s${tmg(r)}.` : `Rule-based · ${h(secs)}s. Add an Anthropic key in API keys for a written AI verdict.`} Not financial advice.`;
    fill(`<div class="mx-head">
        <img src="${h(window.coinImg ? window.coinImg(f.mint, f.image) : f.image || '')}" alt="" onerror="this.remove()">
        <div class="grow"><b>${f.symbol ? '$' + h(f.symbol) : 'Coin'}</b>${window.qbHTML ? window.qbHTML(f.mint, f.symbol) : ''}<div class="mx-sub">${h(f.name || '')}${f.marketCap ? ' · mc ' + usd(f.marketCap) : ''}${f.liquidity ? ' · liq ' + usd(f.liquidity) : ''}</div></div>
        <span class="mx-verdict ${verdict}">${lbl}<em>${r.rules.score}</em></span></div>
      ${riskHTML(r)}
      <div class="mx-sec">RESEARCH</div>
      ${quick && r.aiAvailable !== false ? `<div class="mx-research-wait mx-ai-wait"><span></span><span></span><span></span> Claude is writing its take…</div>` : ''}${`
      ${r.ai?.headline ? `<div class="mx-hl">${h(r.ai.headline)}</div>` : ''}
      <p class="mx-sum">${h(v.summary)}</p>
      <ul class="mx-pts">${pts(v.good.filter(notRisk), 'g')}${pts(v.bad.filter(notRisk), 'b')}</ul>
      ${storyHTML(r)}
      ${r.rules.info?.length ? `<div class="mx-info">${r.rules.info.slice(0, 3).map(h).join(' · ')}</div>` : ''}`}
      <div class="mx-links"><a href="#" data-map="${h(f.mint)}" data-mxmap="${h(f.mint)}">Bubble map</a><a href="${h(r.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${h(r.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${h(r.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a><a href="${h(r.links.solscan)}" target="_blank" rel="noopener">Solscan</a></div>
      <div class="mx-foot">${foot}<a href="#" class="mx-hidelink" data-mxhide>Hide mascot</a></div>`);
  }
  // ---- risk first: rug checks + holders, in their own block at the top ----
  const RISKY = /rugged|authority|bundle|holds \d|Top 10 holders own|Rug checks clean|Spread out: top 10/i;
  const notRisk = t => !RISKY.test(t);
  function riskHTML(r) {
    const f = r.facts, k = f.risk, hd = f.holders, chk = f.checking || {};
    if (!k && !hd && r.stage === 'quick') return `<div class="mx-sec">RISK</div><div class="mx-research-wait"><span></span><span></span><span></span> Checking mint / freeze authority, the launch block for bundles and snipers, the dev's bag, top holders…</div>`;
    const flags = (k?.flags || []).map(x => { const [lvl, ...rest] = x.split(': '); return { lvl, label: rest.join(': ') }; });
    const sn = f.snipers, kols = f.trackedWallets?.kolBuys || 0;
    const reds = flags.filter(x => x.lvl === 'high').length + (f.chart?.natural === false && !flags.some(x => /bundle/i.test(x.label)) ? 1 : 0) + (sn?.wallets >= 5 ? 1 : 0);
    const hot = (hd?.top1 >= 15) || (hd?.top10 >= 45);
    const scanning = f.bundleScan === 'running' || chk.holders;
    // "Clean" only when everything was actually checked and nothing was found
    const [chip, cls] = reds ? [`${reds} red flag${reds > 1 ? 's' : ''}`, 'b'] : scanning ? ['Checking…', 'm'] : !k && !hd ? ['Unavailable', 'm']
      : f.bundleScan !== 'done' ? ['Not fully checked', 'm'] : flags.length || hot || sn?.wallets >= 3 ? ['Some risk', 'm'] : ['Clean', 'g'];
    const li = (c, t) => `<li class="${c}">${t}</li>`;
    const rows = [
      ...(f.chart?.natural === false ? [li('b', `<b>Not a natural chart:</b> ${h(f.chart.why.slice(0, 3).join('; '))}`)] : []),
      ...flags.slice(0, 5).map(x => li(x.lvl === 'high' ? 'b' : 'm', h(x.label))),
      ...(k && !flags.some(x => /mint authority|freeze/i.test(x.label)) && !k.failed ? [li('g', 'Mint &amp; freeze authority revoked')] : []),
      ...(f.bundleScan === 'running' ? [li('m wait', 'Scanning the launch block for bundles…')] : f.bundleScan === 'done' && f.bundle && f.bundle.wallets < 2 && f.bundle.pct < 5 ? [li('g', `No bundle in the launch block${f.bundle.wallets ? ` (${f.bundle.wallets} other wallet, ${f.bundle.pct}%)` : ''}`)] : f.bundleScan === 'unavailable' ? [li('m', "Bundle check didn't finish: not checked")] : []),
      ...(sn ? [sn.wallets >= 3 ? li('b', `${sn.wallets} snipers in the first ${sn.secs}s (${sn.sol.toFixed(1)} SOL)`) : li('g', `No sniper rush (${sn.wallets} wallet${sn.wallets === 1 ? '' : 's'} in the first ${sn.secs}s)`)] : []),
      ...(f.dev?.holdPct != null && !flags.some(x => /dev/i.test(x.label)) ? [li(f.dev.holdPct >= 5 ? 'm' : 'g', `Dev holds ${f.dev.holdPct}%${f.dev.soldPct != null && f.dev.boughtPct >= 0.5 ? ` (sold ${f.dev.soldPct}% of the launch buy)` : ''}`)] : []),
      ...(f.chart?.natural === true ? [li('g', 'Chart looks natural: no bundle, sniper rush or bot buys')] : []),
      ...(chk.holders && !hd ? [li('m wait', 'Counting top holders…')] : hd ? [li(hot ? 'b' : hd.top10 <= 25 ? 'g' : 'm', `${hd.top1 != null ? `Top holder ${hd.top1.toFixed(1)}% · ` : ''}Top 10 hold ${hd.top10?.toFixed?.(0) ?? '?'}%${f.holderCount ? ` · ${f.holderCount.toLocaleString('en')} holders` : ''}`)] : []),
      li(kols ? 'g' : 'm', kols ? `${kols} buy${kols > 1 ? 's' : ''} from your KOL wallets (${h((f.trackedWallets.kolNames || []).join(', '))})` : 'No tracked KOL wallets in it'),
      ...(f.bondingCurvePct != null && !f.graduated ? [li('m', `On ${h(f.launchpad || 'the launchpad')}'s bonding curve · ${Math.round(f.bondingCurvePct)}% to graduation`)] : []),
      ...(f.liquidity != null ? [li(f.liquidity < 5000 ? 'b' : f.liquidity >= 50000 ? 'g' : 'm', `Liquidity ${usd(f.liquidity)}`)] : []),
    ];
    return `<div class="mx-sec">RISK <span class="mx-chip ${cls}">${chip}</span></div><ul class="mx-risk">${rows.join('')}</ul>`;
  }

  function openCard(html) {
    closeCard(true);
    card = document.createElement('div');
    card.className = 'mx-card';
    card.innerHTML = `<div class="mx-grip" title="Drag to move · drag the bottom-right corner to resize · double-click to put it back"><i></i></div><button type="button" class="mx-x" title="Close (Esc)">×</button><div class="mx-body">${html}</div>`;
    document.body.append(card);
    card.querySelector('.mx-x').onclick = () => closeCard();
    cardMovable(card);
    place();
  }
  function fill(html) { if (!card) openCard(html); else { card.querySelector('.mx-body').innerHTML = html; place(); } }
  // ---- the card: move it by its handle, resize it from the corner (remembered) ----
  const CARD_KEY = 'nr.mascot.card';
  let cardBox = {};
  try { cardBox = JSON.parse(localStorage.getItem(CARD_KEY)) || {}; } catch {}
  const saveBox = () => { try { localStorage.setItem(CARD_KEY, JSON.stringify(cardBox)); } catch {} };
  function cardMovable(c) {
    const grip = c.querySelector('.mx-grip');
    let d = null, lastDown = 0;
    const reset = () => { cardBox = {}; saveBox(); c.style.height = ''; c.style.maxHeight = ''; place(); };
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (Date.now() - lastDown < 350) { lastDown = 0; e.preventDefault(); return reset(); } // double-click: back next to the mascot
      lastDown = Date.now();
      const r = c.getBoundingClientRect();
      d = { ox: e.clientX - r.left, oy: e.clientY - r.top };
      grip.setPointerCapture(e.pointerId); c.classList.add('moving'); e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if (!d) return;
      const x = clamp(e.clientX - d.ox, 0, window.innerWidth - 60), y = clamp(e.clientY - d.oy, 0, window.innerHeight - 40);
      Object.assign(c.style, { left: x + 'px', top: y + 'px', maxHeight: window.innerHeight - y - 8 + 'px' });
    });
    grip.addEventListener('pointerup', () => {
      if (!d) return; d = null; c.classList.remove('moving');
      const r = c.getBoundingClientRect();
      cardBox.fx = r.left / window.innerWidth; cardBox.fy = r.top / window.innerHeight; saveBox();
    });
    // the browser's resize corner sets an inline size: keep it
    let rt = 0;
    new ResizeObserver(() => {
      if (!c.style.height || !c.isConnected) return;
      clearTimeout(rt); rt = setTimeout(() => { cardBox.w = c.offsetWidth; cardBox.h = c.offsetHeight; saveBox(); }, 200);
    }).observe(c);
  }
  function place() {
    if (!card) return;
    if (cardBox.w) card.style.width = clamp(cardBox.w, 260, window.innerWidth - 16) + 'px';
    if (cardBox.h) card.style.height = clamp(cardBox.h, 140, window.innerHeight - 16) + 'px';
    if (cardBox.fx != null) {                     // you put it somewhere: it stays there
      const w = card.offsetWidth;
      const top = clamp(cardBox.fy * window.innerHeight, 0, window.innerHeight - 140);
      Object.assign(card.style, { left: clamp(cardBox.fx * window.innerWidth, 0, window.innerWidth - Math.min(w, 120)) + 'px', top: top + 'px', maxHeight: window.innerHeight - top - 8 + 'px' });
      return;
    }
    const m = mx.getBoundingClientRect(), w = cardBox.w ? card.offsetWidth : Math.min(360, window.innerWidth - 16);
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
    if (e.target.closest('[data-mxhide]')) { e.preventDefault(); setHidden(true); return; }
    const a = e.target.closest('[data-mxmap]');
    if (!a || document.body.dataset.page === 'whales') return;
    e.preventDefault(); e.stopPropagation();
    location.href = '/whales.html?view=map&map=' + encodeURIComponent(a.dataset.mxmap);
  }, true);
  window.addEventListener('resize', place);
})();
