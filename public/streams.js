// Stream Monitor page.
const S = {
  config: null,
  status: null,
  sessions: new Map(), // id -> meta + {segs: Map, el}
  pingOnly: false,
  local: null,         // tab capture / mic running in this browser: {id, kind, stop()}
};

// ---------- server events ----------
function connect() {
  const es = window.nrES || (window.nrES = new EventSource('/api/events'));
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    S.config = d.config;
    S.status = d.streams.status;
    $('#sessions').querySelectorAll('.sess').forEach(x => x.remove());
    $('#moments').innerHTML = '<span class="muted placeholder">Highlights from every stream land here.</span>';
    S.sessions.clear();
    for (const s of d.streams.sessions) { upsertSession(s); for (const seg of s.segs || []) upsertSeg(seg, true); }
    paintPills(); paintWatch(); paintSens(); paintUpcoming(d.streams.status.upcoming);
    $('#liveDot').classList.add('live');
  });
  es.addEventListener('config', e => { S.config = JSON.parse(e.data); paintWatch(); });
  es.addEventListener('stream-status', e => { S.status = JSON.parse(e.data); paintPills(); paintWatch(); });
  es.addEventListener('stream-session', e => upsertSession(JSON.parse(e.data)));
  es.addEventListener('stream-removed', e => { const s = S.sessions.get(JSON.parse(e.data).id); s?.el.remove(); S.sessions.delete(s?.id); emptyState(); });
  es.addEventListener('stream-seg', e => upsertSeg(JSON.parse(e.data)));
  es.addEventListener('stream-live', e => {
    const d = JSON.parse(e.data);
    const s = S.sessions.get(d.id); if (!s) return;
    const el = s.el.querySelector('.live-line');
    if (!d.text) { el.innerHTML = '<span class="muted">listening…</span>'; return; }
    el.innerHTML = `${spkChip(s, d.speaker)}<span class="lt">${gaps(esc(d.text))}</span>${d.pausing ? '<span class="gap pausing" title="Speaker paused">…</span>' : ''}`;
  });
  es.addEventListener('stream-levels', e => paintLevels(JSON.parse(e.data)));
  es.addEventListener('stream-clip', e => addClip(JSON.parse(e.data)));
  es.addEventListener('stream-upcoming', e => paintUpcoming(JSON.parse(e.data)));
  es.addEventListener('alert', e => onAlert(JSON.parse(e.data)));
  es.onerror = () => $('#liveDot').classList.remove('live');
}

function paintPills() {
  const st = S.status || {};
  const t = st.tools || {};
  const nt = $('#sttNotice'); if (nt) nt.hidden = st.stt !== 'browser-only';
  const fn = $('#ffNotice'); if (fn) { fn.hidden = !st.ffmpegHelp || st.stt === 'demo'; fn.textContent = st.ffmpegHelp ? 'Stream links can\'t be captured: ' + st.ffmpegHelp + '.' : ''; }
  const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const live = [...S.sessions.values()].filter(s => !s.endedAt);
  const lines = live.reduce((n, s) => n + (s.count || 0), 0), hl = live.reduce((n, s) => n + (s.highlights || 0), 0);
  $('#pills').innerHTML = [
    stat(live.length, 'Streams live', live.length ? 'up' : ''),
    stat(lines, 'Lines heard'),
    stat(hl, 'Highlights', hl ? 'up' : ''),
    stat(st.stt === 'deepgram' ? 'Deepgram' : st.stt === 'demo' ? 'Demo' : 'Browser', 'Speech', st.stt === 'browser-only' ? 'warn' : 'ok'),
    stat(String(st.judge || 'off').startsWith('on') ? 'On' : st.judge === 'demo' ? 'Demo' : 'Off', 'Claude judge', String(st.judge).startsWith('on') || st.judge === 'demo' ? 'ok' : ''),
    st.stt === 'demo' || (t.ffmpeg && t.ytdlp) ? '' : stat('Missing', 'ffmpeg · yt-dlp', 'bad'),
  ].join('');
}

// Transcript times are your local clock time; 12-hour clocks (with AM/PM) need a wider column.
if (clock(Date.now()).length > 8) document.documentElement.classList.add('clock12');

// ---------- sessions ----------
function emptyState() { $('#noSessions').hidden = S.sessions.size > 0; }

function upsertSession(m) {
  let s = S.sessions.get(m.id);
  if (!s) {
    s = { ...m, segs: new Map() };
    s.el = document.createElement('article');
    s.el.className = 'sess';
    s.el.dataset.sid = m.id;
    s.el.dataset.pop = 'stream-' + m.id; s.el.dataset.popLabel = m.label || 'Stream'; s.el.dataset.popSize = '680x820';
    s.el.innerHTML = `
      <div class="sess-head">
        <span class="sess-av"></span><h3><span class="nm"></span><span class="plat"></span><span class="rec"></span></h3>
        <span class="st"></span><span class="grow"></span>
        <span class="muted small elapsed"></span>
        <button class="ghost small watch" hidden>Watch</button>
        <a class="lk open" target="_blank" rel="noopener">open ↗</a>
        <button class="ghost small clipnow" hidden title="Clip the last ~30 seconds">Clip</button>
        <button class="ghost small collapse" title="Fold this stream away. It keeps transcribing and pinging">Hide</button>
        <button class="small restart" hidden title="Start transcribing this stream again">Start again</button>
        <div class="more">
          <button class="ghost small more-btn" title="More" aria-haspopup="menu">⋯</button>
          <div class="more-menu" role="menu" hidden>
            <button class="m-pop" role="menuitem" data-popbtn="stream-${esc(m.id)}" data-size="680x820" data-label="${esc(m.label || 'Stream')}">Pop out</button>
            <button class="m-stop" role="menuitem">Stop transcribing</button>
            <button class="m-remove" role="menuitem">Remove from page</button>
          </div>
        </div>
      </div>
      <div class="player" hidden></div>
      <div class="meters"><div class="vu" title="Live audio level"><i></i></div><span class="chatrate"></span></div>
      <div class="speakers"></div>
      <div class="live-line"><span class="muted">waiting for speech…</span></div>
      <div class="sess-tools">
        <label><input type="checkbox" class="hlonly"> highlights only</label>
        <label title="Keep the newest line in view at the top"><input type="checkbox" class="follow" checked> follow live</label>
        <span class="counts"></span><span class="judge"></span>
      </div>
      <div class="transcript"></div>`;
    // Hide = fold the card (keeps running). Stopping lives in the ⋯ menu; a stopped stream can be started again.
    const folded = () => { try { return JSON.parse(localStorage.getItem('nr.folded') || '[]'); } catch { return []; } };
    const setFolded = on => { try { const f = new Set(folded()); on ? f.add(s.url || s.id) : f.delete(s.url || s.id); localStorage.setItem('nr.folded', JSON.stringify([...f].slice(-50))); } catch {} };
    const paintFold = on => { s.el.classList.toggle('folded', on); s.el.querySelector('.collapse').textContent = on ? 'Show' : 'Hide'; };
    paintFold(folded().includes(m.url || m.id));
    s.el.querySelector('.collapse').onclick = () => { const on = !s.el.classList.contains('folded'); paintFold(on); setFolded(on); };
    const menu = s.el.querySelector('.more-menu');
    s.el.querySelector('.more-btn').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', () => { menu.hidden = true; });
    s.el.querySelector('.m-stop').onclick = () => {
      menu.hidden = true;
      if (S.local?.id === s.id) S.local.stop();
      api('/api/streams/stop', { id: s.id });
    };
    s.el.querySelector('.m-remove').onclick = () => {
      menu.hidden = true;
      if (!s.endedAt) { if (S.local?.id === s.id) S.local.stop(); api('/api/streams/stop', { id: s.id }).then(() => api('/api/streams/remove', { id: s.id })).catch(() => {}); }
      else api('/api/streams/remove', { id: s.id });
    };
    s.el.querySelector('.restart').onclick = async () => {
      if (!s.url) return showErr('This was a tab or mic capture: start it again from the buttons above.');
      try {
        await api('/api/streams/start', { url: s.url, label: s.label, kind: 'url' });
        api('/api/streams/remove', { id: s.id }).catch(() => {});
      } catch (err) { showErr(err.message); }
    };
    s.el.querySelector('.watch').onclick = () => toggleWatch(s);
    s.el.querySelector('.clipnow').onclick = () => requestClip(s.id, { at: Date.now() - 8000 });
    s.el.querySelector('.hlonly').onchange = e => s.el.querySelector('.transcript').classList.toggle('hl-only', e.target.checked);
    const kp = $('#sessions > .kolp'); if (kp) kp.after(s.el); else $('#sessions').prepend(s.el); // KOL panel stays on top
    S.sessions.set(m.id, s);
  }
  const renamed = JSON.stringify(s.speakers || {}) !== JSON.stringify(m.speakers || {}) || JSON.stringify(s.pingSpeakers || []) !== JSON.stringify(m.pingSpeakers || []);
  Object.assign(s, m, { segs: s.segs, el: s.el });
  s.el.querySelector('.speakers').innerHTML = speakersBar(s);
  if (renamed) for (const seg of s.segs.values()) upsertSeg(seg, true);
  const live = !s.endedAt;
  s.el.classList.toggle('ended', !live);
  s.el.querySelector('.rec').classList.toggle('on', live && /live|receiving|listening/.test(s.status));
  s.el.querySelector('.nm').textContent = srcName(s.profile, s.label);
  s.el.querySelector('.nm').title = s.profile?.handle ? '@' + s.profile.handle : '';
  s.el.querySelector('.sess-av').innerHTML = srcAvatar(s.profile, s.label, 36);
  paintPills();
  s.el.querySelector('.plat').textContent = s.platform || s.kind;
  const st = s.el.querySelector('.st');
  st.textContent = s.status;
  st.className = 'st ' + (/error|missing|not installed|failed|exited|ERROR/i.test(s.status) ? 'bad' : /live|listening|receiving/.test(s.status) ? 'live' : '');
  const open = s.el.querySelector('.open');
  const e = s.embed;
  open.hidden = !(e && e.open);
  if (e && e.open) { open.href = e.open; open.textContent = { twitch: 'Open on Twitch ↗', youtube: 'Open on YouTube ↗', x: 'Open on X ↗', kick: 'Open on Kick ↗' }[e.kind] || 'open ↗'; }
  s.el.querySelector('.watch').hidden = !(e && e.src);
  s.el.querySelector('.clipnow').hidden = !s.canClip || Boolean(s.endedAt);
  for (const c of (m.clips || []).slice().reverse()) addClip(c, true);
  s.el.querySelector('.restart').hidden = live;
  s.el.querySelector('.m-stop').hidden = !live;
  s.el.querySelector('.collapse').hidden = !live;
  s.el.querySelector('.clipnow').hidden = !s.canClip || !live;
  s.el.querySelector('.counts').textContent = `${s.count} lines · ${s.highlights} highlights`;
  s.el.querySelector('.judge').textContent = s.judge ? '· Claude: ' + s.judge : '';
  s.el.querySelector('.elapsed').dataset.t = s.startedAt;
  emptyState();
}

setInterval(() => {
  for (const s of S.sessions.values()) {
    const el = s.el.querySelector('.elapsed');
    el.textContent = hms(((s.endedAt || Date.now()) - s.startedAt) / 1000);
  }
}, 1000);

function paintLevels(levels) {
  for (const [id, l] of Object.entries(levels)) {
    const s = S.sessions.get(id); if (!s) continue;
    if (l.db != null) {
      const pct = Math.max(0, Math.min(100, (l.db + 60) / 60 * 100));
      s.el.querySelector('.vu i').style.width = pct + '%';
      s.el.querySelector('.vu').classList.toggle('shout', l.db > -10);
    }
    if (l.chat) s.el.querySelector('.chatrate').innerHTML = `chat ${Number(l.chat.perSec).toFixed(1)}/s · <b>${Number(l.chat.laughPerSec).toFixed(1)}</b> laughs/s`;
  }
}

// ---------- speakers ----------
const SPK_COLORS = ['#8fb6ff', '#f2c464', '#5fdcaa', '#f39ac0', '#b8a4ff', '#f5a35c', '#6fd3e0', '#c9cbd3']; // soft, readable on black
const spkName = (s, sp) => sp == null ? '' : (s.speakers?.[sp]?.name || `Speaker ${sp + 1}`);
function spkChip(s, sp) {
  if (sp == null) return '';
  const pinged = !s.pingSpeakers?.length || s.pingSpeakers.includes(sp);
  return `<span class="spk ${pinged ? '' : 'muted-spk'}" style="--c:${SPK_COLORS[sp % SPK_COLORS.length]}" data-spk="${sp}" data-sid="${esc(s.id)}" title="Click to name this speaker">${esc(spkName(s, sp))}</span>`;
}
// Stutters / pauses inside a line show as a dim "…".
const gaps = html => html.replace(/ … /g, ' <span class="gap" title="pause">…</span> ');

function speakersBar(s) {
  const entries = Object.entries(s.speakers || {}).map(([k, v]) => [Number(k), v]);
  if (!entries.length) return s.diarize ? '<span class="muted small">Speakers appear as they talk. Click a name to rename it.</span>' : '';
  const total = entries.reduce((a, [, v]) => a + (v.talk || 0), 0) || 1;
  return entries.sort((a, b) => a[0] - b[0]).map(([sp, v]) => `<span class="spk-item">${spkChip(s, sp)}<span class="pct">${Math.round((v.talk || 0) / total * 100)}%</span>
    <label title="Ping for this speaker. If none are ticked, every speaker pings."><input type="checkbox" data-pingspk="${sp}" data-sid="${esc(s.id)}" ${s.pingSpeakers?.includes(sp) ? 'checked' : ''}> ping</label></span>`).join('');
}

// ---------- transcript lines ----------
function markText(text, keywords) {
  let html = esc(text);
  const ks = (keywords || []).filter(k => k.text && k.text.length > 1).sort((a, b) => b.text.length - a.text.length);
  if (!ks.length) return html;
  const kind = new Map(ks.map(k => [k.text.toLowerCase(), k.kind]));
  const re = new RegExp('(?<![A-Za-z0-9])(' + ks.map(k => reEsc(esc(k.text))).join('|') + ')(?![A-Za-z0-9])', 'gi');
  return html.replace(re, m => `<mark class="k ${esc(kind.get(m.toLowerCase()) || 'name')}" data-word="${m}">${m}</mark>`);
}

function tagsHTML(seg) {
  const order = ['WATCH', 'COINABLE', 'CRYPTO', 'FUNNY', 'MEME', 'LOUD', 'HYPE', 'REPEAT', 'MEMEABLE'];
  return (seg.tags || []).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(t => `<span class="tg ${esc(t)}">${esc(t)}</span>`).join('');
}

function coinsHTML(seg) {
  return Object.entries(seg.dex || {}).map(([w, r]) => `<span class="coin"><b data-word="${esc(w)}">${esc(w)}</b>${coinStatus(r)}${coinLinks(r.top?.[0])}<a class="lk" target="_blank" rel="noopener" href="${xSearch(w)}" title="Search this word on X (live)">X ↗</a></span>`).join('');
}

function aiHTML(seg) {
  if (!seg.ai) return '';
  return `<span class="ai-note">Claude: ${esc(seg.ai.why)} <span class="sc">funny ${seg.ai.funny} · meme ${seg.ai.meme} · crypto ${seg.ai.crypto}</span></span>`;
}

// Coins named after what was said: tiny image, ticker, market cap, age, and where to open them.
const mc$ = n => n == null ? '' : '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n));
const age$ = m => m == null ? '' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
function walletCoinsHTML(seg) {
  if (seg.walletNote && !seg.walletCoins?.length) return `<div class="cm-note">${esc(seg.walletNote)}</div>`;
  if (!seg.walletCoins?.length) return '';
  return `<div class="cmatch"><div class="cm-head">In their wallet</div>${seg.walletCoins.map(c => cmRow(c)).join('')}</div>`;
}
function cmRow(c) {
  return `<div class="cm">
    <span class="cm-img">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc((c.symbol || '?').slice(0, 2))}</i></span>
    <b class="cm-t" data-word="${esc(c.symbol || '')}" title="${esc(c.name || '')}">$${esc(c.symbol || '?')}</b>
    ${c.name ? `<span class="cm-n">${esc(c.name)}</span>` : ''}
    <span class="cm-mc">${esc(mc$(c.marketCap))}</span>
    <span class="cm-age">${c.bought ? `bought ${c.sol ? esc(c.sol.toFixed(2)) + ' SOL ' : ''}${esc(age$(c.ageMin))} ago` : `${esc(age$(c.ageMin))}${c.pad ? ' · ' + esc(c.pad) : ''}`}</span>
    <span class="cm-l"><a href="${esc(c.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${esc(c.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><button type="button" class="cm-fomo" data-ca="${esc(c.mint)}" title="Copy the contract address and open Fomo">Fomo</button>${c.links.tx ? `<a href="${esc(c.links.tx)}" target="_blank" rel="noopener" title="The buy transaction">tx</a>` : ''}</span>
  </div>`;
}
function coinMatchHTML(seg) {
  if (!seg.coinMatches?.length) return '';
  return `<div class="cmatch">${seg.coinMatches.map(f => f.coins.map(c => `<div class="cm">
    <span class="cm-img">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc((c.symbol || '?').slice(0, 2))}</i></span>
    <b class="cm-t" data-word="${esc(c.symbol || '')}" title="${esc(c.name || '')}">$${esc(c.symbol || '?')}</b>
    <span class="cm-n">${esc(c.name || '')}</span>
    <span class="cm-mc">${esc(mc$(c.marketCap))}</span>
    <span class="cm-age">${esc(age$(c.ageMin))}${c.pad ? ' · ' + esc(c.pad) : ''}</span>
    <span class="cm-l"><a href="${esc(c.links.axiom)}" target="_blank" rel="noopener">Axiom</a><a href="${esc(c.links.gmgn)}" target="_blank" rel="noopener">GMGN</a><button type="button" class="cm-fomo" data-ca="${esc(c.mint)}" title="Copy the contract address and open Fomo">Fomo</button></span>
  </div>`).join('')).join('')}</div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('.cm-fomo'); if (!b) return;
  const ca = b.dataset.ca;
  navigator.clipboard?.writeText(ca).catch(() => {});
  const tpl = S.config?.links?.fomo;
  window.open(tpl ? tpl.replace('{mint}', encodeURIComponent(ca)) : 'https://fomo.family', '_blank', 'noopener');
  toast({ kind: 'fresh', title: 'Contract address copied', text: 'Paste it in Fomo to open the coin.' }, 3000);
});

function lineHTML(seg) {
  const extra = seg.highlight ? `<div class="meta2">${tagsHTML(seg)}<span class="score">${seg.score}</span>${seg.reasons?.length ? `<span class="why">${esc(seg.reasons.slice(0, 2).join(' · '))}</span>` : ''}${seg.notes?.length ? `<span class="why">chat: ${esc(seg.notes[seg.notes.length - 1])}</span>` : ''}</div>${seg.ai ? `<div class="meta2">${aiHTML(seg)}</div>` : ''}${seg.dex && Object.keys(seg.dex).length ? `<div class="meta2">${coinsHTML(seg)}</div>` : ''}` : '';
  const s = S.sessions.get(seg.sid);
  const tools = `<span class="ln-tools">${s?.canClip ? `<button class="ghost small" data-clipseg="${esc(seg.id)}" title="Clip this moment">clip</button>` : ''}${seg.highlight ? `<button class="ghost small" data-playseg="${esc(seg.id)}" title="Track as a play: deploys, tickers, vamps">track</button>` : ''}</span>`;
  const chip = s ? spkChip(s, seg.speaker) : '';
  return `<span class="ts" title="${esc(hms(seg.offset))} into the stream">${esc(clock(seg.t))}</span><div><div class="tx">${chip}${gaps(markText(seg.text, [...(seg.keywords || []), ...(seg.coinMatches || []).map(f => ({ text: f.phrase, kind: 'coinable' }))]))}${tools}</div>${walletCoinsHTML(seg)}${coinMatchHTML(seg)}${extra}</div>`;
}

function upsertSeg(seg, quiet) {
  const s = S.sessions.get(seg.sid); if (!s) return;
  const isNew = !s.segs.has(seg.id);
  s.segs.set(seg.id, seg);
  const box = s.el.querySelector('.transcript');
  let el = box.querySelector(`[data-id="${CSS.escape(seg.id)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = seg.id;
    // Newest line on top: what's being said now is always in view, no scrolling.
    box.prepend(el);
    while (box.children.length > 600) box.lastElementChild.remove();
    if (isNew) s.el.querySelector('.live-line').innerHTML = '<span class="cursor"></span>';
  }
  const mainTag = ['WATCH', 'COINABLE', 'FUNNY', 'CRYPTO'].find(t => seg.tags?.includes(t)) || '';
  el.className = `ln ${seg.highlight ? 'hl' : ''} ${mainTag} ${seg.pinged ? 'pinged' : ''}`;
  el.innerHTML = lineHTML(seg);
  if (!quiet && seg.highlight && isNew) el.classList.add('flash');
  if (s.el.querySelector('.follow').checked) box.scrollTop = 0;
  else if (isNew && box.scrollTop > 0) box.scrollTop += el.offsetHeight; // reading older lines: don't let them jump
  if (seg.highlight) upsertMoment(seg, s);
  const hl = [...s.segs.values()].filter(x => x.highlight).length;
  s.el.querySelector('.counts').textContent = `${s.segs.size} lines · ${hl} highlights`;
}

// ---------- watch & clips ----------
function toggleWatch(s) {
  const box = s.el.querySelector('.player');
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; s.el.querySelector('.watch').textContent = 'Watch'; return; }
  const f = document.createElement('iframe');
  f.src = s.embed.src;
  f.allow = 'autoplay; fullscreen; picture-in-picture';
  f.allowFullscreen = true;
  box.appendChild(f);
  box.hidden = false;
  s.el.querySelector('.watch').textContent = 'Hide player';
}

async function requestClip(id, opts) {
  toast({ kind: 'fresh', title: 'Clipping…', text: 'It waits a few seconds so the clip includes what came after.' }, 3500);
  try { await api('/api/streams/clip', { id, ...opts }); } catch (e) { toast({ title: 'Clip failed', text: e.message }); }
}

function addClip(c, quiet) {
  const box = $('#clips');
  if (box.querySelector(`[data-clip="${CSS.escape(c.id)}"]`)) return;
  box.querySelector('.placeholder')?.remove();
  const el = document.createElement('div');
  el.className = 'clip';
  el.dataset.clip = c.id;
  el.innerHTML = `<button class="ghost small">Play</button><div><b>${esc(c.label)}</b> <span class="muted small">${clock(c.at)} · ${hms(c.offset)}</span><div class="small">${esc(c.title)}</div>
    <div class="tags">${(c.tags || []).map(t => `<span class="tg ${esc(t)}">${esc(t)}</span>`).join('')}</div></div>
    <a class="lk" href="${esc(c.url)}" download title="Download">⬇</a>`;
  el.querySelector('button').onclick = () => playClip(c);
  box.prepend(el);
  if (!quiet) { el.classList.add('new'); if (!$('#clipPlayer').src) playClip(c, true); }
}

function playClip(c, muted) {
  const v = $('#clipPlayer');
  v.hidden = false; $('#clipTitle').hidden = false;
  $('#clipTitle').textContent = `${c.label} · ${clock(c.at)} · ${c.title}`;
  v.src = c.url; v.muted = Boolean(muted);
  v.play().catch(() => {});
  v.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- moments column ----------
function upsertMoment(seg, s) {
  const box = $('#moments');
  box.querySelector('.placeholder')?.remove();
  let el = box.querySelector(`[data-id="${CSS.escape(seg.id)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = seg.id;
    el.onclick = e => {
      if (e.target.closest('a,[data-word]')) return;
      const row = s.el.querySelector(`.ln[data-id="${CSS.escape(seg.id)}"]`);
      s.el.querySelector('.follow').checked = false;
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.classList.remove('flash'); void row?.offsetWidth; row?.classList.add('flash');
    };
    box.prepend(el);
    while (box.children.length > 150) box.lastElementChild.remove();
  }
  el.className = 'mo ' + (seg.pinged ? 'pinged' : '');
  el.hidden = S.pingOnly && !seg.pinged;
  el.innerHTML = `
    <div class="mo-top">${srcAvatar(s.profile, s.label, 20)}<b>${esc(srcName(s.profile, s.label))}</b>${seg.speaker != null ? spkChip(s, seg.speaker) : ''}<span title="${esc(hms(seg.offset))} into the stream">${clock(seg.t)}</span><span class="grow"></span><span class="score">score ${seg.score}${seg.pinged ? ' · pinged' : ''}</span></div>
    <div class="txt">${gaps(markText(seg.text, seg.keywords))}</div>
    <div class="tags">${tagsHTML(seg)}</div>
    ${seg.ai ? `<div class="meta2" style="margin-top:4px">${aiHTML(seg)}</div>` : seg.reasons?.length ? `<div class="why small muted" style="margin-top:4px">${esc(seg.reasons.slice(0, 2).join(' · '))}</div>` : ''}
    ${seg.notes?.length ? `<div class="why small muted">chat: ${esc(seg.notes[seg.notes.length - 1])}</div>` : ''}
    ${seg.dex && Object.keys(seg.dex).length ? `<div class="tags" style="margin-top:6px">${coinsHTML(seg)}</div>` : ''}`;
}

$('#pingOnly').onchange = e => {
  S.pingOnly = e.target.checked;
  for (const el of $('#moments').querySelectorAll('.mo')) el.hidden = S.pingOnly && !el.classList.contains('pinged');
};

// Click a speaker name → rename inline.
document.addEventListener('click', e => {
  const chip = e.target.closest('.spk[data-spk]');
  if (!chip || chip.querySelector('input')) return;
  e.stopPropagation();
  const s = S.sessions.get(chip.dataset.sid); if (!s) return;
  const sp = Number(chip.dataset.spk);
  const input = document.createElement('input');
  input.className = 'spk-input';
  input.value = spkName(s, sp);
  chip.textContent = '';
  chip.appendChild(input);
  input.focus(); input.select();
  const save = async () => {
    const name = input.value.trim();
    if (name && name !== spkName(s, sp)) { try { await api('/api/streams/speaker', { id: s.id, speaker: sp, name }); } catch {} }
    else chip.textContent = spkName(s, sp);
  };
  input.onkeydown = ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = spkName(s, sp); input.blur(); } };
  input.onblur = save;
}, true);
document.addEventListener('change', e => {
  const cb = e.target.closest('[data-pingspk]');
  if (cb) api('/api/streams/speaker', { id: cb.dataset.sid, speaker: Number(cb.dataset.pingspk), ping: cb.checked }).catch(() => {});
});

document.addEventListener('click', async e => {
  const cs = e.target.closest('[data-clipseg]');
  if (cs) { const seg = [...S.sessions.values()].map(s => s.segs.get(cs.dataset.clipseg)).find(Boolean); if (seg) requestClip(seg.sid, { segId: seg.id }); return; }
  const ps = e.target.closest('[data-playseg]');
  if (ps) {
    try { await api('/api/plays/track', { itemId: 'seg-' + ps.dataset.playseg }); toast({ kind: 'fresh', title: 'Tracking as a play', text: 'See it on the Feed page under Plays.' }); }
    catch (err) { toast({ title: 'Could not track', text: err.message }); }
    return;
  }
  const w = e.target.closest('[data-word]');
  if (w && !e.target.closest('a')) copyAndCheck(w.dataset.word);
});

// ---------- alerts ----------
const seenAlerts = new Map();
function onAlert(a) {
  if (a.source !== 'stream' && a.source !== 'kol') return; // tweet alerts show on the Feed page
  const key = a.title;
  if (Date.now() - (seenAlerts.get(key) || 0) < 15000) return;
  seenAlerts.set(key, Date.now());
  if (a.important === false) return; // quiet alerts are listed on the Feed page only
  const mine = window.elixirClaimNoise ? window.elixirClaimNoise(a.title + '|' + a.at) : true;
  if (mine && Date.now() - (window.__lastBeep || 0) > 8000) { window.__lastBeep = Date.now(); beep(a.kind); }
  if (!window.elixirQuietToasts) toast(a);
  if (mine) desktopNotify(a);
}

// ---------- start: link ----------
function showErr(msg) { const el = $('#addErr'); el.textContent = msg; el.hidden = !msg; }
$('#startForm').addEventListener('submit', async e => {
  e.preventDefault();
  showErr('');
  try {
    await api('/api/streams/start', { url: $('#urlIn').value.trim(), label: $('#labelIn').value.trim(), kind: 'url' });
    $('#urlIn').value = ''; $('#labelIn').value = '';
  } catch (err) { showErr(err.message); }
});

// ---------- start: share a tab's audio ----------
async function startTab() {
  showErr('');
  if (S.local) return showErr('Already capturing in this browser. Stop that one first.');
  let media;
  try {
    media = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include',
    });
  } catch { return showErr('Tab sharing was cancelled.'); }
  const track = media.getAudioTracks()[0];
  media.getVideoTracks().forEach(t => t.stop());
  if (!track) return showErr('No audio came through. Pick a Chrome Tab and tick "Also share tab audio".');
  const label = (track.label && !/^(System|Tab) Audio$/i.test(track.label) ? track.label : '') || $('#labelIn').value.trim() || 'Shared tab';
  let sess;
  try { sess = await api('/api/streams/start', { kind: 'tab', label }); } catch (err) { track.stop(); return showErr(err.message); }

  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const tap = new AudioWorkletNode(ctx, 'pcm-tap');
  const mute = ctx.createGain(); mute.gain.value = 0; // keep the graph running without playing audio twice
  src.connect(tap).connect(mute).connect(ctx.destination);
  let buf = new Int16Array(1600), n = 0, alive = true; // 100 ms chunks keep latency low
  tap.port.onmessage = ev => {
    const f = ev.data;
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      buf[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (n === buf.length) {
        const chunk = buf; buf = new Int16Array(1600); n = 0;
        fetch(`/api/streams/${sess.id}/audio`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chunk.buffer })
          .then(r => { if (r.status === 410 && alive) stop(); }).catch(() => {});
      }
    }
  };
  const stop = () => {
    if (!alive) return; alive = false;
    track.stop(); ctx.close().catch(() => {});
    api('/api/streams/stop', { id: sess.id }).catch(() => {});
    S.local = null; $('#tabBtn').textContent = 'Share tab audio';
  };
  track.onended = stop;
  S.local = { id: sess.id, kind: 'tab', stop };
  $('#tabBtn').textContent = 'Stop tab capture';
}
$('#tabBtn').onclick = () => (S.local?.kind === 'tab' ? S.local.stop() : startTab());

// ---------- start: free browser mic ----------
async function startMic() {
  showErr('');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return showErr('This browser has no speech recognition. Use Chrome or Edge.');
  if (S.local) return showErr('Already capturing in this browser. Stop that one first.');
  let sess;
  try { sess = await api('/api/streams/start', { kind: 'browser', label: $('#labelIn').value.trim() || 'Mic' }); } catch (err) { return showErr(err.message); }
  let on = true, lastInterim = 0, rec;
  const langMap = { en: 'en-US', multi: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN' };
  const post = (text, final) => fetch(`/api/streams/${sess.id}/text`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, final }) }).catch(() => {});
  const run = () => {
    rec = new SR();
    rec.continuous = true; rec.interimResults = true;
    rec.lang = langMap[S.config?.streams?.language] || 'en-US';
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript.trim();
        if (!txt) continue;
        if (e.results[i].isFinal) post(txt, true);
        else if (Date.now() - lastInterim > 250) { lastInterim = Date.now(); post(txt, false); }
      }
    };
    rec.onerror = e => { if (/not-allowed|service-not-allowed/.test(e.error)) { showErr('Microphone blocked. Allow mic access for localhost.'); stop(); } };
    rec.onend = () => { if (on) setTimeout(run, 200); }; // Chrome stops every minute or so
    rec.start();
  };
  const stop = () => { on = false; rec?.stop(); api('/api/streams/stop', { id: sess.id }).catch(() => {}); S.local = null; $('#micBtn').textContent = 'Use mic (free)'; };
  run();
  S.local = { id: sess.id, kind: 'browser', stop };
  $('#micBtn').textContent = 'Stop mic';
}
$('#micBtn').onclick = () => (S.local?.kind === 'browser' ? S.local.stop() : startMic());

// ---------- auto-watch & sensitivity ----------
// ---------- upcoming (scheduled) streams ----------
let upcomingList = [];
const until = t => {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'starting';
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return 'in ' + (d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`);
};
const when = t => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function paintUpcoming(list) {
  if (list) upcomingList = list;
  const el = $('#upcoming');
  if (!el) return;
  el.innerHTML = upcomingList.length ? upcomingList.map(u => `
    <a class="upc ${u.startAt - Date.now() < 3600000 ? 'soon' : ''}" href="${esc(u.url)}" target="_blank" rel="noopener">
      ${srcAvatar(u.profile, u.label, 30)}
      <div><b>${esc(u.title)}</b><small>${esc(srcName(u.profile, u.label))} · ${esc(when(u.startAt))}</small></div>
      <span class="upc-t">${esc(until(u.startAt))}</span>
    </a>`).join('') : '<span class="muted small">Nothing scheduled yet. Announced YouTube streams from your channels appear here.</span>';
}
setInterval(() => paintUpcoming(), 30000);

const shortSrc = u => { try { const x = new URL(u); const seg = x.pathname.split('/').filter(Boolean)[0] || ''; return x.hostname.replace(/^www\./, '').replace(/\.(com|tv)$/, '') + (seg ? ' · ' + seg : ''); } catch { return u; } };
function paintWatch() {
  const list = S.status?.watch || S.config?.streams?.watch || [];
  $('#watchList').innerHTML = list.length ? list.map((w, i) => `
    <div class="wl" title="${w.checkedAt ? 'checked ' + clock(w.checkedAt) : 'not checked yet'}">
      ${srcAvatar(w.profile, w.label || w.url, 28)}
      <div title="${esc(w.url)}"><b>${esc(w.label || w.profile?.name || w.url)}</b>${w.live ? ' <span class="livetag">Live</span>' : ''}<div class="u">${esc(shortSrc(w.url))}</div></div>
      <button type="button" class="ghost small wl-wallet ${w.wallet ? 'on' : ''}" data-wallet="${i}" title="${w.wallet ? 'Wallet: ' + esc(w.wallet) : 'Link this streamer\'s wallet: when they say “the coin I\'m in”, Elixir shows what they bought'}">${w.wallet ? 'wallet ✓' : '+ wallet'}</button>
      <label title="Start transcribing automatically when it goes live"><input type="checkbox" data-auto="${i}" ${w.auto !== false ? 'checked' : ''}> auto</label>
      <button class="ghost small wl-x" data-del="${i}" title="Remove">×</button>
    </div>`).join('') : '<span class="muted small">No channels yet.</span>';
}
async function saveWatch(list) {
  const r = await api('/api/streams/settings', { watch: list.map(w => ({ url: w.url, label: w.label, auto: w.auto, ...(w.wallet ? { wallet: w.wallet } : {}) })) });
  S.status = r.status; paintWatch();
}
$('#watchList').addEventListener('click', e => {
  const wb = e.target.closest('[data-wallet]');
  if (wb) {
    const list = (S.config?.streams?.watch || []).slice(), i = Number(wb.dataset.wallet);
    const v = prompt('Solana wallet address for ' + (list[i]?.label || 'this streamer') + ' (leave empty to unlink):', list[i]?.wallet || '');
    if (v === null) return;
    const addr = v.trim();
    if (addr && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return toast({ title: 'That doesn\'t look like a Solana wallet address' });
    list[i] = { ...list[i], wallet: addr || undefined };
    saveWatch(list);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const list = (S.config?.streams?.watch || []).slice(); list.splice(Number(del.dataset.del), 1); saveWatch(list);
});
$('#watchList').addEventListener('change', e => {
  const a = e.target.closest('[data-auto]'); if (!a) return;
  const list = (S.config?.streams?.watch || []).map((w, i) => i === Number(a.dataset.auto) ? { ...w, auto: a.checked } : w);
  saveWatch(list);
});
$('#watchForm').addEventListener('submit', e => {
  e.preventDefault();
  let url = $('#watchUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const list = (S.config?.streams?.watch || []).concat([{ url, label: $('#watchLabel').value.trim(), auto: true }]);
  $('#watchUrl').value = ''; $('#watchLabel').value = '';
  saveWatch(list).catch(err => showErr(err.message));
});

function paintSens() {
  const st = S.config?.streams || {};
  $('#hlScore').value = st.highlightScore ?? 4;
  $('#pingScore').value = st.pingScore ?? 8;
  $('#langSel').value = st.language || 'en';
}
$('#saveSens').onclick = async () => {
  await api('/api/streams/settings', { highlightScore: $('#hlScore').value, pingScore: $('#pingScore').value, language: $('#langSel').value });
  toast({ kind: 'fresh', title: 'Saved', text: 'Applies to new lines and new streams.' }, 2000);
};

setupHeaderButtons();
setupLookup();
connect();
