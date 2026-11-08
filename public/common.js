// Helpers shared by the Stream Monitor page: formatting, alert sound, toasts, coin lookup.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtUsd = n => n == null ? '—' : '$' + (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
const fmtAge = min => min == null ? '' : min < 60 ? Math.max(1, Math.round(min)) + 'm' : min < 1440 ? Math.round(min / 60) + 'h' : Math.round(min / 1440) + 'd';
const hms = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const xSearch = w => `https://x.com/search?q=${encodeURIComponent(w)}&f=live`;
function lsGet(k, d) { try { return localStorage.getItem('nr.' + k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem('nr.' + k, v); } catch {} }

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const ui = { sound: lsGet('sound', '1') === '1' };
let audioCtx;
function beep(kind) {
  if (!ui.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = { vip: [880, 1175], watch: [988, 1319, 988], fresh: [660, 990, 1320], open: [523, 784], trend: [740, 740], funny: [784, 988, 784, 988], moment: [660, 880] }[kind] || [880];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.12);
    });
  } catch {}
}

function toast(a, ms = 7000) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast k-' + (a.kind || 'none');
  el.innerHTML = `<b>${esc(a.title)}</b><p>${esc((a.text || '').slice(0, 180))}</p>`;
  el.onclick = () => el.remove();
  box.prepend(el);
  setTimeout(() => el.remove(), ms);
  while (box.children.length > 3) box.lastElementChild.remove();
}

function desktopNotify(a) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(a.title, { body: a.text || '', tag: a.kind + (a.segId || a.itemId || '') });
    n.onclick = () => window.focus();
  }
}

function setupHeaderButtons() {
  const sb = $('#soundBtn');
  const paint = () => { sb.innerHTML = ui.sound ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>' : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>'; sb.title = 'Alert sound: ' + (ui.sound ? 'on' : 'off'); sb.classList.toggle('off', !ui.sound); };
  paint();
  sb.onclick = () => { ui.sound = !ui.sound; lsSet('sound', ui.sound ? '1' : '0'); paint(); beep('open'); };
  $('#notifBtn').onclick = async () => {
    if (!('Notification' in window)) return toast({ title: 'Notifications not supported here' });
    const p = await Notification.requestPermission();
    toast({ kind: p === 'granted' ? 'fresh' : '', title: p === 'granted' ? 'Desktop notifications on' : 'Notifications blocked' });
  };
}

function coinLinks(t) {
  if (!t) return '';
  return (t.links.gmgn ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.gmgn)}">GMGN</a>` : '') +
    (t.links.axiom ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.axiom)}">Axiom</a>` : '') +
    (t.links.dexscreener ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.dexscreener)}">DS</a>` : '');
}

function coinStatus(r) {
  if (!r) return '<span class="st">…</span>';
  if (r.error) return `<span class="st err" title="${esc(r.error)}">err</span>`;
  if (r.status === 'none') return '<span class="st none">NO COIN</span>';
  const t = r.top?.[0];
  return `<span class="st ${r.status}">${r.status === 'fresh' ? 'NEW ' + fmtAge(r.newestAgeMin) : r.count + '×'} ${fmtUsd(t?.marketCap)}</span>`;
}

async function runLookup(word) {
  word = String(word).trim().replace(/^[$#]/, '');
  if (!word) return;
  $('#lookupInput').value = word;
  const out = $('#lookupOut');
  out.innerHTML = `<div class="verdict muted">Checking “${esc(word)}”…</div>`;
  try {
    const r = await api('/api/lookup', { word });
    const verdict = r.status === 'none' ? `<b style="color:var(--none)">No coin yet</b> for “${esc(word)}”. Watch for a launch.`
      : r.status === 'fresh' ? `<b style="color:var(--fresh)">Fresh:</b> newest launched ${fmtAge(r.newestAgeMin)} ago · ${r.count} match(es)`
        : `<b>${r.count} existing</b> token(s) · newest ${fmtAge(r.newestAgeMin)} old`;
    out.innerHTML = `<div class="verdict">${verdict} · <a href="${xSearch(word)}" target="_blank" rel="noopener">live X search ↗</a></div>` +
      r.top.map(t => `<div class="tok"><span class="nm">${esc(t.symbol)} <span class="muted small">${esc(t.name)} · ${esc(t.chain)}/${esc(t.dex)}</span></span>
        <span class="links">${coinLinks(t)}${t.links.pumpfun ? `<a class="lk" target="_blank" rel="noopener" href="${esc(t.links.pumpfun)}">pump</a>` : ''}</span>
        <span class="nums">${t.pad ? esc(t.pad) + ' · ' : ''}mcap ${fmtUsd(t.marketCap)} · liq ${fmtUsd(t.liquidityUsd)} · 5m vol ${fmtUsd(t.volume5m)} · age ${t.createdAt ? fmtAge((Date.now() - t.createdAt) / 60000) : '?'}</span>
        ${t.filter ? `<span class="nums">${t.filter.pass === true ? 'PASS' : t.filter.pass === null ? 'PASS?' : 'FAIL'} ${esc(t.filter.preset)} filter${t.filter.pass !== false ? ' · ' + esc(t.filter.column) : ''}</span>` : ''}</div>`).join('');
  } catch (e) {
    out.innerHTML = `<div class="verdict" style="color:var(--hot)">Lookup failed: ${esc(e.message)}</div>`;
  }
}

function setupLookup() {
  $('#lookupForm').addEventListener('submit', e => { e.preventDefault(); runLookup($('#lookupInput').value); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#lookupInput').focus(); $('#lookupInput').select(); }
  });
}

/** Click a highlighted word anywhere: copy it (to paste into Axiom / GMGN) and check it. */
function copyAndCheck(word) {
  navigator.clipboard?.writeText(word).catch(() => {});
  toast({ kind: 'fresh', title: `Copied “${word}”`, text: 'Paste it into Axiom or GMGN search.' }, 1600);
  runLookup(word);
}
