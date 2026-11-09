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
    .card { max-height: calc(100vh - 16px); overflow: auto; }
    .sec { margin-top: 12px; font-size: 10.5px; font-weight: 700; letter-spacing: .07em; color: #5f6471; }
    .narr { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,.12); background: #16171c; }
    .narr b { font-size: 12.5px; } .narr span { color: #c9ccd5; font-size: 12.5px; line-height: 1.45; }
    .narr.g { border-color: rgba(47,209,139,.4); } .narr.g b { color: #2fd18b; }
    .narr.b { border-color: rgba(242,73,106,.45); } .narr.b b { color: #ff8da2; }
    .narr.m b { color: #f0b84a; }
    .reason { margin-top: 4px; color: #8b909c; font-size: 12px; line-height: 1.45; }
    .why { margin: 8px 0 0; color: #dfe1e7; font-size: 12.5px; line-height: 1.5; }
    .origin { display: block; margin-top: 8px; padding: 8px 10px; border-radius: 9px; background: rgba(124,109,255,.08); border: 1px solid rgba(124,109,255,.3); color: #dfe1e7; text-decoration: none; font-size: 12.5px; line-height: 1.45; }
    .origin span { display: block; font-size: 11.5px; font-weight: 600; color: #9a8fff; margin-bottom: 2px; }
    .tws { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .tw { display: block; padding: 7px 9px; border-radius: 8px; background: #0c0d10; border: 1px solid rgba(255,255,255,.07); color: #c9ccd5; text-decoration: none; font-size: 12px; line-height: 1.45; }
    .tw:hover { border-color: rgba(255,255,255,.16); } .tw.promo { opacity: .78; }
    .tw-h { display: flex; align-items: center; gap: 5px; margin-bottom: 2px; }
    .tw-h b { color: #fff; font-size: 12px; } .tw-h em { font-style: normal; font-size: 10.5px; color: #8b909c; } .tw-h i { font-style: normal; font-size: 10.5px; color: #5f6471; white-space: nowrap; }
    .tw-t { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    details summary { cursor: pointer; color: #9a8fff; font-size: 12px; margin: 2px 0 4px; } details .tw { margin-bottom: 6px; }
    .tgt { position: fixed; pointer-events: none; border: 2px solid #9a8fff; border-radius: 8px; box-shadow: 0 0 0 6px rgba(124,109,255,.18); background: rgba(124,109,255,.06); }
    .menu { position: fixed; min-width: 200px; padding: 5px; background: #111216; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; box-shadow: 0 14px 40px rgba(0,0,0,.6); display: flex; flex-direction: column; }
    .menu button { all: unset; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border-radius: 7px; color: #e4e5ea; font-size: 13px; cursor: pointer; }
    .menu button:hover { background: #1c1d23; }
    .menu kbd { margin-left: auto; font-size: 10.5px; color: #8b909c; font-family: inherit; }
    .hide { position: absolute; top: -4px; right: -10px; width: 17px; height: 17px; border-radius: 50%; background: #1c1d23; border: 1px solid rgba(255,255,255,.18); color: #c9ccd5; font-size: 12px; line-height: 15px; text-align: center; opacity: 0; transform: scale(.7); transition: opacity .15s, transform .15s; cursor: pointer; }
    .mx:hover .hide { opacity: 1; transform: none; }
    .hide:hover { background: #f2496a; border-color: #f2496a; color: #fff; }
    .sec .chip { margin-left: 6px; letter-spacing: 0; font-size: 10.5px; padding: 1px 7px; border-radius: 999px; }
    .chip.g { color: #04140d; background: #2fd18b; } .chip.b { color: #fff; background: #f2496a; } .chip.m { color: #1b1400; background: #f0b84a; }
    ul.risk { margin-top: 6px; padding: 8px 10px; border-radius: 9px; background: #16171c; border: 1px solid rgba(255,255,255,.12); }
    ul.risk li { padding-left: 14px; color: #dfe1e7; }
    ul.risk li::before { content: ""; position: absolute; left: 0; top: .55em; width: 7px; height: 7px; border-radius: 50%; background: #f0b84a; }
    ul.risk li.g::before { background: #2fd18b; } ul.risk li.b::before { background: #f2496a; }
    .rwait { display: flex; align-items: center; gap: 4px; margin-top: 6px; color: #8b909c; font-size: 12.5px; }
    .rwait i { width: 5px; height: 5px; border-radius: 50%; background: #9a8fff; animation: dot 1s infinite ease-in-out; flex: none; }
    .rwait i:nth-child(2) { animation-delay: .15s; } .rwait i:nth-child(3) { animation-delay: .3s; margin-right: 6px; }
    .hidelink { float: right; color: #5f6471; text-decoration: none; cursor: pointer; } .hidelink:hover { color: #ff8da2; }
    .card { display: flex; flex-direction: column; overflow: hidden; }
    .card .body { overflow: auto; flex: 1 1 auto; min-height: 0; margin-right: -6px; padding-right: 6px; }
    .x { z-index: 2; border-radius: 7px; top: 5px; right: 6px; width: 28px; height: 28px; }
    .x:hover { background: #1c1d23; }
    .card { resize: both; min-width: 260px; min-height: 140px; max-width: calc(100vw - 16px); }
    .card.moving { animation: none; user-select: none; box-shadow: 0 30px 80px rgba(0,0,0,.8), 0 0 0 1px rgba(124,109,255,.4); }
    .grip { position: absolute; top: 0; left: 0; right: 36px; height: 14px; cursor: move; display: flex; justify-content: center; align-items: center; touch-action: none; }
    .grip i { width: 34px; height: 4px; border-radius: 4px; background: rgba(255,255,255,.14); transition: background .15s; }
    .grip:hover i, .card.moving .grip i { background: #9a8fff; }
    @media (prefers-reduced-motion: reduce) { .legs, .legs .r { animation: none; } }
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
  <div class="mx" title="Elixir · tap or Alt+X: box a coin · hold and drag to move me · drag me onto a coin to research it · × or right-click: hide me">
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
    <span class="hide" title="Hide on every tab (Alt+Shift+X brings it back)">×</span>
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
    if (e.target.closest('.hide')) { e.preventDefault(); setHidden(true); return; }
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
    target(coinAt(e.clientX, e.clientY));
  });
  mx.addEventListener('pointerup', e => {
    if (!drag) return;
    clearTimeout(drag.hold);
    const { moved, t } = drag; drag = null;
    mx.classList.remove('drag', 'held');
    const tgt = tgtEl; target(null);
    if (moved && tgt) {                     // dropped onto a coin: stay there and research it
      const m = mx.getBoundingClientRect(), r = tgt.getBoundingClientRect();
      pos = { fx: m.left / window.innerWidth, fy: m.top <= 24 ? -1 : m.top / window.innerHeight }; apply(); savePos();
      ask({ text: textIn(r), mints: mintsIn(r) }, r);
      return;
    }
    if (moved) {
      const r = mx.getBoundingClientRect();
      pos = { fx: r.left / window.innerWidth, fy: r.top <= 24 ? -1 : r.top / window.innerHeight }; // dropped near the top: sits on the edge
      apply(); savePos();
    } else if (Date.now() - t < 350) start(); // a tap
  });
  // Right-click: back to its home spot on the top edge
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  mx.addEventListener('contextmenu', e => {
    e.preventDefault(); closeMenu();
    menu = document.createElement('div'); menu.className = 'menu';
    menu.innerHTML = '<button data-a="home">Back to my spot</button><button data-a="hide">Hide on every tab <kbd>Alt+Shift+X</kbd></button>';
    root.append(menu);
    Object.assign(menu.style, { left: Math.min(window.innerWidth - 210, e.clientX) + 'px', top: Math.min(window.innerHeight - 90, e.clientY + 6) + 'px' });
    menu.addEventListener('click', ev => { const a = ev.target.closest('[data-a]')?.dataset.a; closeMenu(); if (a === 'home') { pos = null; apply(); savePos(); close(); } if (a === 'hide') setHidden(true); });
    // (the shadow root is closed, so the page only sees our host element: check the menu's box instead)
    const away = ev => { const r = menu?.getBoundingClientRect(); if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) return; closeMenu(); document.removeEventListener('mousedown', away, true); };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  });
  // Alt+Shift+X can arrive twice (the browser shortcut and the key itself): one flip per press
  let lastFlip = 0;
  const flip = () => { if (Date.now() - lastFlip < 500) return; lastFlip = Date.now(); setHidden(!mx.classList.contains('hidden')); };
  function setHidden(on) { mx.classList.toggle('hidden', on); chrome.storage.local.set({ hidden: on }); if (on) close(); }
  // hidden/shown on one tab = on every tab
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.hidden) { mx.classList.toggle('hidden', Boolean(ch.hidden.newValue)); if (ch.hidden.newValue) close(); } });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'snip') { if (mx.classList.contains('hidden')) setHidden(false); start(); }
    if (msg?.type === 'toggle') flip();
  });
  // Fallback if the browser's shortcut is taken by something else
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (veil) endSnip(); else close(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.shiftKey && e.code === 'KeyX') { e.preventDefault(); flip(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyX') { e.preventDefault(); if (mx.classList.contains('hidden')) setHidden(false); start(); }
  }, true);

  // ---------- drag onto a coin ----------
  let tgtEl = null, tgtBox = null;
  const UNIT = 'article, li, tr, [role="row"], [role="listitem"], [class*="card"], [class*="Card"], [class*="row"], [class*="Row"], [class*="item"], a[href]';
  const COINISH = /\$[A-Za-z][A-Za-z0-9]{1,15}\b|[1-9A-HJ-NP-Za-km-z]{32,44}/;
  // The coin card / row under the pointer: the nearest card-like element (by tag/class) that names a coin,
  // else the biggest card-sized block around the pointer that names one.
  function coinAt(x, y) {
    const el = document.elementsFromPoint(x, y).find(e => e !== host && e !== document.body && e !== document.documentElement);
    if (!el) return null;
    const fits = u => { const r = u.getBoundingClientRect(); return r.width <= Math.min(900, window.innerWidth * 0.75) && r.height <= 240; };
    const coinish = u => COINISH.test(u.textContent.slice(0, 2000)) || [...u.querySelectorAll('a[href]'), u].some(a => /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(a.getAttribute?.('href') || ''));
    let best = null;
    for (let u = el; u && u !== document.body; u = u.parentElement) {
      if (!fits(u)) break;
      if (!coinish(u)) continue;
      if (u.matches(UNIT) && !u.matches('a[href]')) return u;     // a real card / row
      best = u;
    }
    return best;
  }
  // Held over a coin: start researching it before you let go (AI only if you stay on it for 0.7 s).
  let preT = [];
  function prefetch(el) {
    preT.forEach(clearTimeout); preT = [];
    if (!el) return;
    const r = el.getBoundingClientRect(), input = { text: textIn(r), mints: mintsIn(r) };
    if (!input.text && !input.mints.length) return;
    preT.push(setTimeout(() => { lensCall(input, 'quick'); lensCall(input, 'risk'); }, 200));
    preT.push(setTimeout(() => lensCall(input, 'full'), 700));
  }
  function target(el) {
    if (el === tgtEl) return;
    tgtEl = el;
    prefetch(el);
    if (!el) { tgtBox?.remove(); tgtBox = null; return; }
    if (!tgtBox) { tgtBox = document.createElement('div'); tgtBox.className = 'tgt'; root.prepend(tgtBox); }
    const r = el.getBoundingClientRect();
    Object.assign(tgtBox.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
  }

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
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|CANVAS|IFRAME|svg)$/i.test(c.tagName) || c === host) continue;
          const b = c.getBoundingClientRect();
          if (b.width && b.height && !hits(near, b)) continue; // a whole section away from the box
          walk(c);
        }
      }
    })(document.body);
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
    const call = stage => lensCall(input, stage);
    const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
    // All three at once (Elixir shares the work): quick = instant market read, risk = rug + holder checks,
    // full = X search + AI. Whichever is furthest along when it arrives is what you see.
    const RANK = { quick: 0, risk: 1, full: 2 };
    let shown = -1;
    const show = res => {
      if (id !== askId || !card) return;
      mx.classList.remove('thinking');
      if (!res) { if (shown < 0) fill('<div class="sum">Couldn\'t reach Elixir. Reload this tab and try again.</div>'); return; }
      if (!res.ok) { if (shown < 0) fill(`<div class="sum">${h(res.error)}</div>`); return; }
      if (!res.data.found) { if (shown < 0) { shown = 9; fill(`<div class="sum">${h(res.data.message)}</div>`); } return; }
      if (RANK[res.data.stage] <= shown) return;
      shown = RANK[res.data.stage]; render(res.data, res.base, secs());
    };
    call('quick').then(show);
    call('risk').then(show);
    call('full').then(res => { show(res); if (id === askId && card && !(res?.ok && res.data.found)) card.querySelector('.rwait.research')?.replaceChildren("The AI didn't answer in time. The read above stands."); });
  }
  const lensCall = (input, stage) => new Promise(resolve => chrome.runtime.sendMessage({ type: 'lens', input: { ...input, pageUrl: location.href, pageTitle: document.title, stage } }, res => resolve(chrome.runtime.lastError ? null : res)));
  // On a coin's own page (Axiom, DexScreener, GMGN, pump.fun…), research that coin in the background as soon as
  // you open it, so Alt+X answers at once: market + rug checks straight away, the AI write-up once you've
  // stayed on the page for 3 seconds. Nothing runs while the mascot is hidden.
  let pageCoin = '', pageT = [];
  function pagePrefetch() {
    const a = (location.pathname + location.search).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0] || '';
    if (a === pageCoin) return;
    pageCoin = a; pageT.forEach(clearTimeout); pageT = [];
    if (!a || mx.classList.contains('hidden')) return;
    const input = { text: '', mints: [a] };
    pageT.push(setTimeout(() => { lensCall(input, 'quick'); lensCall(input, 'risk'); }, 300));
    pageT.push(setTimeout(() => { if (pageCoin === a && !document.hidden && !mx.classList.contains('hidden')) lensCall(input, 'full'); }, 3000));
  }
  setInterval(pagePrefetch, 1000);
  setTimeout(pagePrefetch, 300);
  let askId = 0;
  const sec = ms => (ms == null ? '–' : ms < 50 ? 'instant' : (ms / 1000).toFixed(1) + 's');
  const tmg = r => (r.timing ? ` (coin ${sec(r.timing.find)} · checks ${sec(r.timing.checks)} · AI ${sec(r.timing.ai)})` : '');
  const NARR = { real: ['Real story', 'g'], unclear: ['Story unclear', 'm'], manufactured: ['Looks manufactured', 'b'] };
  const vsLaunch = m => (m == null ? '' : Math.abs(m) <= 1 ? 'at launch' : `${Math.abs(m) < 60 ? Math.abs(m) + 'm' : (Math.abs(m) / 60).toFixed(1) + 'h'} ${m < 0 ? 'before' : 'after'} launch`);
  const afterTxt = s => (Math.abs(s) < 90 ? Math.round(Math.abs(s)) + 's' : Math.abs(s) < 5400 ? Math.round(Math.abs(s) / 60) + 'm' : (Math.abs(s) / 3600).toFixed(1) + 'h');
  const fol = n => (!n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
  const safe = u => (/^https:\/\//.test(u || '') ? u : '#');
  /** Why it's moving: where it started, the tweets that led up to it, and whether the story is real. */
  function storyHTML(r) {
    const s = r.story;
    if (!s) return '';
    const [label, cls] = NARR[r.ai?.narrative?.verdict || s.verdict] || NARR.unclear;
    const o = s.origin, tw = s.tweets; // oldest first: how it built up
    const row = t => `<a class="tw ${t.promo ? 'promo' : ''}" href="${h(safe(t.url))}" target="_blank" rel="noopener"><span class="tw-h"><b>@${h(t.author)}</b>${t.followers ? `<em>${fol(t.followers)}</em>` : ''}${t.verified ? '<em>✓</em>' : ''}${t.vip ? '<em>tracked</em>' : ''}<span class="grow"></span><i>${h(vsLaunch(t.vsLaunchMin))}</i></span><span class="tw-t">${h(t.text)}</span></a>`;
    return `<div class="sec">WHY IT'S MOVING</div>
      <div class="narr ${cls}"><b>${label}</b><span>${h(r.ai?.narrative?.reason || s.reasons[0] || '')}</span></div>
      ${s.reasons.slice(1, 3).map(x => `<div class="reason">${h(x)}</div>`).join('')}
      ${r.ai?.why ? `<p class="why">${h(r.ai.why)}</p>` : ''}
      ${o ? `<a class="origin" href="${h(safe(o.url))}" target="_blank" rel="noopener"><span>Started from @${h(o.author)}${o.afterSec != null ? ` · coin launched ${h(afterTxt(o.afterSec))} after it` : ''}</span>${h(o.text)}</a>` : ''}
      ${tw.length ? `<div class="tws">${tw.slice(0, 4).map(row).join('')}${tw.length > 4 ? `<details><summary>${tw.length - 4} more</summary>${tw.slice(4).map(row).join('')}</details>` : ''}</div>` : ''}
      ${r.stage === 'quick' && !s.searched ? '<div class="reason">Searching X for more…</div>' : s.note && s.note !== 'no-key' ? `<div class="reason">${h(s.note)}</div>` : ''}`;
  }
  function render(r, base, secs) {
    const f = r.facts, v = r.ai || r.rules, lbl = { good: 'Looks good', mixed: 'Mixed', avoid: 'Avoid' }[v.verdict];
    const pts = (a, c) => (a || []).slice(0, 4).map(t => `<li class="${c}">${h(t)}</li>`).join('');
    const quick = r.stage !== 'full';
    const foot = quick ? (r.stage === 'quick' ? 'Checking rugs and holders…' : `Risk checked in ${h(secs)}s · researching…`)
      : `${r.ai ? `${h(r.ai.by || 'Claude')}'s verdict from live data · ${h(secs)}s${tmg(r)}.` : `Rule-based · ${h(secs)}s${tmg(r)} (add an Anthropic key in Elixir for an AI verdict).`} Not financial advice.`;
    fill(`<div class="head">${/^https:\/\//.test(f.image || '') ? `<img src="${h(f.image)}" alt="">` : ''}<div class="grow"><b>${f.symbol ? '$' + h(f.symbol) : 'Coin'}</b><div class="sub">${h(f.name || '')}${f.marketCap ? ' · mc ' + usd(f.marketCap) : ''}${f.liquidity ? ' · liq ' + usd(f.liquidity) : ''}</div></div><span class="v ${h(v.verdict)}">${lbl}<em>${h(r.rules.score)}</em></span></div>
      ${riskHTML(r)}
      <div class="sec">RESEARCH</div>
      ${quick && r.aiAvailable !== false ? `<div class="rwait research"><i></i><i></i><i></i>The AI is writing its take…</div>` : ''}${`
      ${r.ai?.headline ? `<div class="hl">${h(r.ai.headline)}</div>` : ''}<p class="sum">${h(v.summary)}</p><ul>${pts(v.good.filter(notRisk), 'g')}${pts(v.bad.filter(notRisk), 'b')}</ul>
      ${storyHTML(r)}
      ${r.rules.info?.length ? `<div class="info">${r.rules.info.slice(0, 3).map(h).join(' · ')}</div>` : ''}`}
      <div class="links"><a href="${h(base)}/whales.html?view=map&map=${encodeURIComponent(f.mint)}" target="_blank" rel="noopener">Open in Elixir</a><a href="${h(r.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${h(r.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><a href="${h(r.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a><a href="${h(r.links.solscan)}" target="_blank" rel="noopener">Solscan</a></div>
      <div class="foot">${foot}<a class="hidelink" data-hide>Hide mascot</a></div>`);
    card.querySelector('[data-hide]')?.addEventListener('click', () => setHidden(true));
  }
  // ---- risk first: rug checks + holders, in their own block at the top ----
  const RISKY = /rugged|authority|bundle|holds \d|Top 10 holders own|Rug checks clean|Spread out: top 10/i;
  const notRisk = t => !RISKY.test(t);
  function riskHTML(r) {
    const f = r.facts, k = f.risk, hd = f.holders;
    if (!k && !hd && r.stage === 'quick') return '<div class="sec">RISK</div><div class="rwait"><i></i><i></i><i></i>Checking mint / freeze authority, bundles, dev history, top holders…</div>';
    const flags = (k?.flags || []).map(x => { const [lvl, ...rest] = x.split(': '); return { lvl, label: rest.join(': ') }; });
    const highs = flags.filter(x => x.lvl === 'high').length;
    const hot = (hd?.top1 >= 15) || (hd?.top10 >= 45);
    const [chip, cls] = !k && !hd ? ['Unavailable', 'm'] : highs ? [`${highs} red flag${highs > 1 ? 's' : ''}`, 'b'] : flags.length || hot ? ['Some risk', 'm'] : ['Clean', 'g'];
    const rows = [
      ...flags.slice(0, 5).map(x => `<li class="${x.lvl === 'high' ? 'b' : 'm'}">${h(x.label)}</li>`),
      ...(k && !flags.length ? ['<li class="g">Mint & freeze authority revoked, no bundle or rug flags</li>'] : []),
      ...(hd ? [`<li class="${hot ? 'b' : hd.top10 <= 25 ? 'g' : 'm'}">Top holder ${hd.top1?.toFixed?.(1) ?? '?'}% · top 10 ${hd.top10?.toFixed?.(0) ?? '?'}%</li>`] : []),
      ...(f.liquidity != null ? [`<li class="${f.liquidity < 5000 ? 'b' : f.liquidity >= 50000 ? 'g' : 'm'}">Liquidity ${usd(f.liquidity)}</li>`] : []),
    ];
    return `<div class="sec">RISK <span class="chip ${cls}">${chip}</span></div><ul class="risk">${rows.join('') || '<li class="m">Rug check service didn\'t answer in time</li>'}</ul>`;
  }
  function openCard(html) {
    card?.remove();
    card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<div class="grip" title="Drag to move · drag the bottom-right corner to resize · double-click to put it back"><i></i></div><button class="x" title="Close (Esc)">×</button><div class="body">${html}</div>`;
    root.append(card);
    card.querySelector('.x').onclick = close;
    cardMovable(card);
    place();
  }
  function fill(html) {
    if (!card) openCard(html); else card.querySelector('.body').innerHTML = html;
    card.querySelectorAll('img').forEach(img => img.addEventListener('error', () => img.remove())); // no broken-image icons
    place();
  }
  // ---- the card: move it by its handle, resize it from the corner (remembered on every site) ----
  let cardBox = {};
  chrome.storage.local.get('cardBox', v => { cardBox = v.cardBox || {}; });
  const saveBox = () => chrome.storage.local.set({ cardBox });
  function cardMovable(c) {
    const grip = c.querySelector('.grip');
    let d = null, lastDown = 0;
    const reset = () => { cardBox = {}; saveBox(); c.style.width = ''; c.style.height = ''; c.style.maxHeight = ''; place(); };
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
      const y = clamp(e.clientY - d.oy, 0, window.innerHeight - 40);
      c.style.left = clamp(e.clientX - d.ox, 0, window.innerWidth - 60) + 'px'; c.style.top = y + 'px'; c.style.maxHeight = window.innerHeight - y - 8 + 'px';
    });
    grip.addEventListener('pointerup', () => {
      if (!d) return; d = null; c.classList.remove('moving');
      const r = c.getBoundingClientRect();
      cardBox.fx = r.left / window.innerWidth; cardBox.fy = r.top / window.innerHeight; saveBox();
    });
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
    if (cardBox.fx != null) {
      card.style.left = clamp(cardBox.fx * window.innerWidth, 0, window.innerWidth - Math.min(card.offsetWidth, 120)) + 'px';
      const top = clamp(cardBox.fy * window.innerHeight, 0, window.innerHeight - 140);
      card.style.top = top + 'px'; card.style.maxHeight = window.innerHeight - top - 8 + 'px';
      return;
    }
    const m = mx.getBoundingClientRect(), w = card.offsetWidth;
    let left = m.left - w - 10; if (left < 8) left = Math.min(window.innerWidth - w - 8, m.right + 10);
    let top = Math.max(8, m.top + 10); if (top + card.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - card.offsetHeight);
    card.style.left = left + 'px'; card.style.top = top + 'px';
  }
  function close() { card?.remove(); card = null; askId++; mx.style.transform = ''; mx.classList.remove('thinking'); }
})();
