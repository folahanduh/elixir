// Elixir mascot on every tab: sits on the top edge of the page, legs dangling. Alt+X (or click it) →
// box a coin → it asks the Elixir app on your PC and shows a Good / Mixed / Avoid verdict right there.
(() => {
  if (window.top !== window) return;                                        // not inside iframes
  // Elixir has its own mascot: just tell its pages the extension is here (so they can say so), then stop.
  if (/^(localhost|127\.0\.0\.1|penguin\.linux\.test):8787$/.test(location.host)) { document.documentElement.setAttribute('data-elixir-ext', chrome.runtime.getManifest().version); return; }
  if (document.getElementById('elixir-mascot-host')) return;

  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => (n == null ? '' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));
  const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  const host = document.createElement('div');
  host.id = 'elixir-mascot-host';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .mx { position: fixed; left: var(--x, calc(100vw - 170px)); top: var(--y, -4px); width: var(--s, 46px); height: calc(var(--s, 46px) * 1.45); cursor: grab; user-select: none; filter: drop-shadow(0 4px 10px rgba(91, 77, 240, .45)); transition: filter .2s, transform .45s cubic-bezier(.3, 1.4, .5, 1); }
    .mx:hover { filter: drop-shadow(0 6px 16px rgba(124, 109, 255, .75)); }
    .mx.drag { cursor: grabbing; transition: none; }
    .mx.held { scale: 1.12; filter: drop-shadow(0 10px 18px rgba(91, 77, 240, .6)); }
    .mx.held .legs { animation-duration: .5s; }
    .mx.float:not(.drag) { animation: bob 3.2s ease-in-out infinite; }
    @keyframes bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -5px; } }
    .mx svg { width: 100%; height: 100%; overflow: visible; display: block; }
    .legs { transform-origin: 32px 58px; animation: swing 2.4s ease-in-out infinite; }
    .legs .r { animation: swing2 2.4s ease-in-out infinite; transform-origin: 37px 58px; }
    @keyframes swing { 0%, 100% { transform: rotate(4deg); } 50% { transform: rotate(-4deg); } }
    @keyframes swing2 { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(8deg); } }
    .pupils, .face { transition: transform .12s ease-out; }
    .mx { transform-origin: 50% 12%; transition: filter .2s, transform .45s cubic-bezier(.3, 1.4, .5, 1), rotate .25s ease-out; }
    .eyes { transform-origin: 32px 33px; transition: transform .07s; }
    .mx.blink .eyes { transform: scaleY(.1); }
    .mx.thinking .pupils { animation: think 1.1s ease-in-out infinite; }
    @keyframes think { 0%, 100% { transform: translate(-2px, -1.5px); } 50% { transform: translate(2px, -1.5px); } }
    .mx.hidden { display: none; }
    .veil { position: fixed; inset: 0; cursor: crosshair; background: rgba(5, 6, 10, .32); }
    .hint { position: fixed; top: 70px; left: 50%; transform: translateX(-50%); background: #111216; color: #9ba2b4; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 8px 14px; font-size: 12.5px; pointer-events: none; box-shadow: 0 10px 30px rgba(0,0,0,.5); white-space: nowrap; }
    .hint b { color: #fff; margin-right: 8px; }
    .box { position: fixed; border: 1.5px solid #9a8fff; background: rgba(124, 109, 255, .12); border-radius: 6px; }
    .card { position: fixed; width: min(360px, calc(100vw - 16px)); background: #111216; color: #ededf0; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 22px 60px rgba(0,0,0,.7), 0 0 0 1px rgba(124,109,255,.15); padding: 14px 16px 12px; font-size: 13px; line-height: 1.5; animation: pop .18s ease-out; }
    @keyframes pop { from { opacity: 0; transform: scale(.96) translateY(4px); } }
    .x { position: absolute; top: 6px; right: 8px; width: 26px; height: 26px; border: 0; background: none; color: #8b909c; font-size: 18px; cursor: pointer; }
    .x:hover { color: #fff; }
    .head { display: flex; align-items: center; gap: 10px; padding-right: 22px; }
    .head img { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; }
    .grow { flex: 1; min-width: 0; }
    .head b { font-size: 16px; }
    .sub { color: #8b909c; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .v { flex: none; display: inline-flex; flex-direction: column; align-items: center; font-weight: 700; font-size: 12px; padding: 5px 9px; border-radius: 9px; line-height: 1.15; }
    .v em { font-style: normal; font-size: 10.5px; opacity: .75; }
    .v.good { color: #04140d; background: #2fd18b; } .v.mixed { color: #1b1400; background: #f0b84a; } .v.avoid { color: #fff; background: #f2496a; }
    .hl { margin-top: 10px; font-weight: 600; font-size: 14px; }
    .sum { margin: 8px 0; color: #dfe1e7; }
    ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    li { position: relative; padding-left: 16px; color: #c9ccd5; font-size: 12.5px; }
    li.g::before { content: "+"; color: #2fd18b; position: absolute; left: 0; font-weight: 700; }
    li.b::before { content: "−"; color: #f2496a; position: absolute; left: 0; font-weight: 700; }
    .info { margin-top: 8px; color: #8b909c; font-size: 12px; }
    .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12.5px; }
    .links a { color: #9a8fff; text-decoration: none; } .links a:hover { text-decoration: underline; }
    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); color: #5f6471; font-size: 11.5px; }
    .wait { display: flex; align-items: center; gap: 5px; color: #8b909c; padding: 4px 22px 4px 0; }
    .wait i { width: 6px; height: 6px; border-radius: 50%; background: #9a8fff; animation: dot 1s infinite ease-in-out; }
    .wait i:nth-child(2) { animation-delay: .15s; } .wait i:nth-child(3) { animation-delay: .3s; margin-right: 6px; }
    @keyframes dot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; transform: translateY(-3px); } }
    @media (prefers-reduced-motion: reduce) { .legs, .legs .r { animation: none; } }
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
  <div class="mx" title="Elixir · tap or Alt+X: box a coin · hold and drag to move me · right-click: back to the top">
    <svg viewBox="0 0 64 92" aria-hidden="true">
      <defs>
        <linearGradient id="b" x1="20" y1="2" x2="44" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#c3cbff"/><stop offset=".4" stop-color="#8b86ff"/><stop offset=".78" stop-color="#5b4df0"/><stop offset="1" stop-color="#3a2bc4"/></linearGradient>
        <linearGradient id="l" x1="32" y1="30" x2="32" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6f63ff"/><stop offset="1" stop-color="#2c1f9e"/></linearGradient>
        <clipPath id="c"><path d="M32 1C29.5 4.5 13 22 13 37a19 19 0 0 0 38 0C51 22 34.5 4.5 32 1Z"/></clipPath>
      </defs>
      <g class="legs"><path d="M27 54 L25 80" stroke="#3a2bc4" stroke-width="3.2" stroke-linecap="round"/><ellipse cx="24.5" cy="82" rx="4" ry="2.6" fill="#2c1f9e"/>
        <g class="r"><path d="M37 54 L39 80" stroke="#3a2bc4" stroke-width="3.2" stroke-linecap="round"/><ellipse cx="39.5" cy="82" rx="4" ry="2.6" fill="#2c1f9e"/></g></g>
      <path d="M32 1C29.5 4.5 13 22 13 37a19 19 0 0 0 38 0C51 22 34.5 4.5 32 1Z" fill="url(#b)"/>
      <g clip-path="url(#c)"><path d="M8 43c7-4 13 2.5 21-1s12-6 27-1v22H8z" fill="url(#l)" opacity=".85"/></g>
      <path d="M23 15c-3 4.5-5.4 9.5-5.6 14.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".6"/>
      <g class="face"><g class="eyes"><ellipse cx="25" cy="32.5" rx="6.1" ry="6.9" fill="#fff"/><ellipse cx="39" cy="32.5" rx="6.1" ry="6.9" fill="#fff"/>
        <g class="pupils"><circle cx="25" cy="33" r="2.9" fill="#120d3a"/><circle cx="39" cy="33" r="2.9" fill="#120d3a"/><circle cx="26.1" cy="31.7" r="1" fill="#fff"/><circle cx="40.1" cy="31.7" r="1" fill="#fff"/></g></g>
      <path d="M29 43q3 2.2 6 0" fill="none" stroke="#120d3a" stroke-width="1.6" stroke-linecap="round"/></g>
      <path d="M32 1C29.5 4.5 13 22 13 37a19 19 0 0 0 38 0C51 22 34.5 4.5 32 1Z" fill="none" stroke="#211a7a" stroke-opacity=".5" stroke-width="1.3"/>
    </svg>
  </div>`;
  document.documentElement.append(host); // on <html>: a transformed <body> can't drag it off-screen
  const mx = root.querySelector('.mx'), pupils = root.querySelector('.pupils'), face = root.querySelector('.face');

  // Size follows the window: smaller windows get a smaller mascot, still sitting on the top edge.
  const size = () => { const w = window.innerWidth; mx.style.setProperty('--s', (w < 600 ? 28 : w < 1000 ? 36 : 46) + 'px'); };
  size(); window.addEventListener('resize', size);
  // Where it sits: anywhere you drop it (saved as a share of the window, so it survives resizing).
  let pos = null; // {fx, fy} or null = home (top edge, right side)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function apply() {
    const w = mx.offsetWidth || 46, hh = mx.offsetHeight || 66;
    let x, y;
    if (pos) { x = pos.fx * window.innerWidth; y = pos.fy < 0 ? -4 : pos.fy * window.innerHeight; }
    else { x = window.innerWidth - 120 - w; y = -4; }
    x = clamp(x, 0, window.innerWidth - w); y = clamp(y, -4, window.innerHeight - hh);
    mx.style.setProperty('--x', x + 'px'); mx.style.setProperty('--y', y + 'px');
    mx.classList.toggle('float', y > 24); // near the top edge it sits, elsewhere it floats
  }
  const savePos = () => chrome.storage.local.set({ pos });
  chrome.storage.local.get(['pos', 'hidden'], v => { if (v.pos && typeof v.pos.fx === 'number') pos = v.pos; if (v.hidden) mx.classList.add('hidden'); apply(); });
  window.addEventListener('resize', apply);
  apply();

  // Eyes follow the mouse, it blinks now and then
  let raf = 0, mouse = null;
  document.addEventListener('mousemove', e => { mouse = [e.clientX, e.clientY]; if (!raf) raf = requestAnimationFrame(look); }, { passive: true });
  function look() {
    raf = 0;
    if (!mouse || mx.classList.contains('thinking')) return;
    const r = mx.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.35;
    const dx = mouse[0] - cx, dy = mouse[1] - cy, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, k = Math.min(1, d / 220), p = Math.max(0.45, k);
    pupils.style.transform = `translate(${(ux * 3.1 * p).toFixed(2)}px, ${(uy * 3.1 * p).toFixed(2)}px)`;   // eyes look at the cursor
    face.style.transform = `translate(${(ux * 1.8 * k).toFixed(2)}px, ${(uy * 1.3 * k).toFixed(2)}px)`;  // the face turns a little
    mx.style.rotate = `${Math.max(-10, Math.min(10, dx / 28)).toFixed(1)}deg`;                         // and it tilts its head
  }
  (function blink() { setTimeout(() => { mx.classList.add('blink'); setTimeout(() => mx.classList.remove('blink'), 140); blink(); }, 2600 + Math.random() * 3800); })();

  // Hold it and drag it anywhere on the screen. A quick tap starts boxing; double-click sends it home.
  let drag = null;
  mx.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = mx.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, t: Date.now(), moved: false };
    drag.hold = setTimeout(() => drag && mx.classList.add('held'), 220); // picked up
    mx.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  mx.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) { drag.moved = true; mx.classList.add('drag', 'held'); close(); }
    if (!drag.moved) return;
    const w = mx.offsetWidth, hh = mx.offsetHeight;
    const x = clamp(e.clientX - drag.ox, 0, window.innerWidth - w), y = clamp(e.clientY - drag.oy, -4, window.innerHeight - hh);
    mx.style.setProperty('--x', x + 'px'); mx.style.setProperty('--y', y + 'px');
    mx.classList.toggle('float', y > 24);
  });
  mx.addEventListener('pointerup', e => {
    if (!drag) return;
    clearTimeout(drag.hold);
    const { moved, t } = drag; drag = null;
    mx.classList.remove('drag', 'held');
    if (moved) {
      const r = mx.getBoundingClientRect();
      pos = { fx: r.left / window.innerWidth, fy: r.top <= 24 ? -1 : r.top / window.innerHeight }; // dropped near the top: sits on the edge
      apply(); savePos();
    } else if (Date.now() - t < 350) start(); // a tap
  });
  // Right-click: back to its home spot on the top edge
  mx.addEventListener('contextmenu', e => { e.preventDefault(); pos = null; apply(); savePos(); close(); });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'snip') { mx.classList.remove('hidden'); start(); }
    if (msg?.type === 'toggle') { mx.classList.toggle('hidden'); chrome.storage.local.set({ hidden: mx.classList.contains('hidden') }); if (mx.classList.contains('hidden')) close(); }
  });
  // Fallback if the browser's shortcut is taken by something else
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (veil) endSnip(); else close(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyX') { e.preventDefault(); start(); }
  }, true);

  // ---------- boxing ----------
  let veil = null, box = null, from = null, card = null;
  function start() {
    if (veil) return;
    close();
    const sel = window.getSelection(), text = sel && String(sel).trim();
    if (text && text.length >= 2) {
      const r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      sel.removeAllRanges();
      return ask({ text, mints: mintsIn(r) }, r);
    }
    veil = document.createElement('div'); veil.className = 'veil';
    veil.innerHTML = '<div class="hint"><b>Box a coin</b>drag over a ticker, CA or coin card · Esc to cancel</div>';
    root.append(veil);
    veil.addEventListener('mousedown', e => { from = [e.clientX, e.clientY]; box = document.createElement('div'); box.className = 'box'; veil.append(box); draw(e); });
    veil.addEventListener('mousemove', e => { if (from) draw(e); });
    veil.addEventListener('mouseup', e => {
      if (!from) return;
      const r = { left: Math.min(from[0], e.clientX), top: Math.min(from[1], e.clientY), right: Math.max(from[0], e.clientX), bottom: Math.max(from[1], e.clientY) };
      from = null; endSnip();
      if (r.right - r.left < 8 && r.bottom - r.top < 8) { const el = document.elementFromPoint(r.left, r.top); const u = el?.closest('article, li, tr, a, [role="row"], [class*="card"], [class*="row"]') || el; if (u) Object.assign(r, u.getBoundingClientRect().toJSON()); }
      ask({ text: textIn(r), mints: mintsIn(r) }, r);
    });
  }
  const draw = e => Object.assign(box.style, { left: Math.min(from[0], e.clientX) + 'px', top: Math.min(from[1], e.clientY) + 'px', width: Math.abs(e.clientX - from[0]) + 'px', height: Math.abs(e.clientY - from[1]) + 'px' });
  function endSnip() { veil?.remove(); veil = null; box = null; }
  const hits = (r, a) => a && r && a.right >= r.left && a.left <= r.right && a.bottom >= r.top && a.top <= r.bottom;
  function textIn(r) {
    const out = [], range = document.createRange();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.nodeValue.trim() && !n.parentElement?.closest('script,style,noscript') ? 1 : 2) });
    let n, seen = 0;
    while ((n = w.nextNode()) && seen++ < 30000) { range.selectNodeContents(n); if (hits(r, range.getBoundingClientRect())) out.push(n.nodeValue.trim()); if (out.join(' ').length > 3000) break; }
    return out.join(' ').replace(/\s+/g, ' ');
  }
  function mintsIn(r) {
    if (!r) return [];
    const out = [];
    document.querySelectorAll('a[href], [data-address], [data-mint], [data-token]').forEach(el => {
      if (!hits(r, el.getBoundingClientRect())) return;
      const v = (el.getAttribute('href') || '') + ' ' + (el.dataset.address || '') + ' ' + (el.dataset.mint || '') + ' ' + (el.dataset.token || '');
      for (const m of v.match(B58) || []) if (!out.includes(m)) out.push(m);
    });
    return out.slice(0, 10);
  }

  // ---------- ask Elixir + the speech bubble ----------
  function ask(input, rect) {
    if (!input.text && !input.mints.length && !/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(location.href)) return;
    mx.classList.add('thinking');
    if (rect) { const m = mx.getBoundingClientRect(); mx.style.transform = `translate(${Math.min(window.innerWidth - 60, rect.right + 12) - m.left}px, ${Math.max(0, rect.top - 10) - m.top}px) scale(1.2)`; }
    openCard('<div class="wait"><i></i><i></i><i></i>Researching…</div>');
    const id = ++askId, t0 = performance.now();
    const call = stage => new Promise(resolve => chrome.runtime.sendMessage({ type: 'lens', input: { ...input, pageUrl: location.href, stage } }, res => resolve(chrome.runtime.lastError ? null : res)));
    const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
    // 1) quick answer straight away
    call('quick').then(res => {
      if (id !== askId) return;
      mx.classList.remove('thinking');
      if (!res) return fill('<div class="sum">Couldn\'t reach Elixir. Reload this tab and try again.</div>');
      if (!res.ok) return fill(`<div class="sum">${h(res.error)}</div>`);
      if (!res.data.found) return fill(`<div class="sum">${h(res.data.message)}</div>`);
      render(res.data, res.base, secs());
      // 2) full answer (rug + holder checks, AI) replaces it
      call('full').then(full => { if (id === askId && card && full?.ok && full.data.found) render(full.data, full.base, secs()); });
    });
  }
  let askId = 0;
  function render(r, base, secs) {
    const f = r.facts, v = r.ai || r.rules, lbl = { good: 'Looks good', mixed: 'Mixed', avoid: 'Avoid' }[v.verdict];
    const pts = (a, c) => (a || []).slice(0, 4).map(t => `<li class="${c}">${h(t)}</li>`).join('');
    const foot = r.stage === 'quick' ? `Answered in ${h(secs)}s · checking rugs, holders and writing the AI verdict…`
      : `${r.ai ? `Claude's verdict from live data · ${h(secs)}s.` : `Rule-based · ${h(secs)}s (add an Anthropic key in Elixir for an AI verdict).`} Not financial advice.`;
    fill(`<div class="head">${/^https:\/\//.test(f.image || '') ? `<img src="${h(f.image)}" alt="">` : ''}<div class="grow"><b>${f.symbol ? '$' + h(f.symbol) : 'Coin'}</b><div class="sub">${h(f.name || '')}${f.marketCap ? ' · mc ' + usd(f.marketCap) : ''}${f.liquidity ? ' · liq ' + usd(f.liquidity) : ''}</div></div><span class="v ${h(v.verdict)}">${lbl}<em>${h(r.rules.score)}</em></span></div>
      ${r.ai?.headline ? `<div class="hl">${h(r.ai.headline)}</div>` : ''}<p class="sum">${h(v.summary)}</p><ul>${pts(v.good, 'g')}${pts(v.bad, 'b')}</ul>
      ${r.rules.info?.length ? `<div class="info">${r.rules.info.slice(0, 3).map(h).join(' · ')}</div>` : ''}
      <div class="links"><a href="${h(base)}/whales.html?view=map&map=${encodeURIComponent(f.mint)}" target="_blank" rel="noopener">Open in Elixir</a><a href="${h(r.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${h(r.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${h(r.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a><a href="${h(r.links.solscan)}" target="_blank" rel="noopener">Solscan</a></div>
      <div class="foot">${foot}</div>`);
  }
  function openCard(html) {
    card?.remove();
    card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<button class="x" title="Close (Esc)">×</button><div class="body">${html}</div>`;
    root.append(card);
    card.querySelector('.x').onclick = close;
    place();
  }
  function fill(html) {
    if (!card) openCard(html); else card.querySelector('.body').innerHTML = html;
    card.querySelectorAll('img').forEach(img => img.addEventListener('error', () => img.remove())); // no broken-image icons
    place();
  }
  function place() {
    if (!card) return;
    const m = mx.getBoundingClientRect(), w = card.offsetWidth;
    let left = m.left - w - 10; if (left < 8) left = Math.min(window.innerWidth - w - 8, m.right + 10);
    let top = Math.max(8, m.top + 10); if (top + card.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - card.offsetHeight);
    card.style.left = left + 'px'; card.style.top = top + 'px';
  }
  function close() { card?.remove(); card = null; askId++; mx.style.transform = ''; mx.classList.remove('thinking'); }
})();
