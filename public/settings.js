// Settings page: tracked X accounts and keywords.
(() => {
  const $ = s => document.querySelector(s);
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  const toast = (title, text = '') => {
    const el = document.createElement('div');
    el.className = 'toast k-fresh';
    el.innerHTML = `<b>${h(title)}</b>${text ? `<p>${h(text)}</p>` : ''}`;
    el.onclick = () => el.remove();
    $('#toasts').prepend(el);
    setTimeout(() => el.remove(), 3500);
  };
  const icon = {
    vip: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
    bell: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
    x: '<path d="M4 4l16 16M20 4 4 20"/>',
  };
  const svg = (k, on) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="${on && k === 'vip' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon[k]}</svg>`;
  const ibtn = (k, title, data, on = false) => `<button type="button" class="ib ${on ? 'on' : ''} ib-${k}" title="${h(title)}" ${data}>${svg(k, on)}</button>`;

  // ---------- section switching ----------
  const SECS = { accounts: ['Tracker', 'Accounts you follow on X'], keywords: ['Keywords', 'Words that ping you'] };
  function show(sec) {
    for (const s of Object.keys(SECS)) $('#sec-' + s).hidden = s !== sec;
    document.querySelectorAll('#stabs [data-sec]').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
    $('#secTitle').textContent = SECS[sec][0]; $('#secSub').textContent = SECS[sec][1];
    if (location.hash !== '#' + sec) history.replaceState(null, '', '#' + sec);
  }
  $('#stabs').addEventListener('click', e => { const b = e.target.closest('[data-sec]'); if (b) show(b.dataset.sec); });
  show(location.hash === '#keywords' ? 'keywords' : 'accounts');

  // ---------- accounts ----------
  let A = { accounts: [], groups: [] }, tab = 'all', limit = 50;
  async function loadAccounts(op = { op: 'list' }) { A = await api('/api/accounts', op); paintAccounts(); }
  const q = () => $('#accSearch').value.trim().replace(/^@/, '').toLowerCase();
  function paintAccounts() {
    const query = q();
    const all = A.accounts;
    $('#nAll').textContent = all.length; $('#nPreset').textContent = all.filter(a => a.preset).length; $('#nCustom').textContent = all.filter(a => !a.preset).length;
    $('#accCount').textContent = all.length.toLocaleString();
    $('#accList').hidden = tab === 'groups'; $('#groupList').hidden = tab !== 'groups';
    if (tab === 'groups') {
      $('#groupList').innerHTML = A.groups.map(g => `<div class="row">
        <div class="rmain"><b>${h(g.label)}</b><small>${g.active} of ${g.total} on · checked ${g.tier === 'fast' ? 'every cycle' : 'every 4th cycle'}</small></div>
        <label class="switch" title="Add or remove the whole group"><input type="checkbox" data-group="${h(g.id)}" ${g.active ? 'checked' : ''}><i></i></label>
      </div>`).join('');
      $('#accShowing').textContent = `${A.groups.length} preset groups`;
      $('#accWatching').textContent = `Watching ${all.length.toLocaleString()}`;
      return;
    }
    let list = all.filter(a => tab === 'all' || (tab === 'preset' ? a.preset : !a.preset));
    if (query) list = list.filter(a => a.handle.toLowerCase().includes(query) || (a.group || '').toLowerCase().includes(query));
    list.sort((a, b) => (b.pinned - a.pinned) || (b.vip - a.vip) || 0);
    const exact = query && /^[a-z0-9_]{1,15}$/.test(query) && !all.some(a => a.handle.toLowerCase() === query);
    const rows = list.slice(0, limit).map(a => `<div class="row ${a.muted ? 'is-muted' : ''}">
      <span class="av"><img src="https://unavatar.io/x/${h(a.handle)}?fallback=false" alt="" loading="lazy" onerror="this.remove()"><i>${h(a.handle.slice(0, 2).toUpperCase())}</i></span>
      <div class="rmain"><b><a href="https://x.com/${h(a.handle)}" target="_blank" rel="noopener">@${h(a.handle)}</a>${a.vip ? '<span class="chip vip">VIP</span>' : ''}${a.ping ? '<span class="chip ping">every tweet</span>' : ''}${a.muted ? '<span class="chip">muted</span>' : ''}${a.pinned ? '<span class="chip">pinned</span>' : ''}</b><small>${a.group ? h(a.group) : 'Added by you'}</small></div>
      <div class="ractions">
        ${ibtn('vip', a.vip ? 'VIP: every tweet pings. Click to turn off' : 'Make VIP: every tweet pings', `data-acc="${h(a.handle)}" data-act="vip"`, a.vip)}
        ${ibtn(a.muted ? 'mute' : 'bell', a.muted ? 'Muted: shown, never pings. Click for normal' : a.ping ? 'Every tweet and reply pings. Click to mute' : 'Normal: pings on important tweets. Click to ping on every tweet and reply', `data-acc="${h(a.handle)}" data-act="bell"`, a.ping || a.muted)}
        ${ibtn('pin', a.pinned ? 'Unpin' : 'Pin to the top', `data-acc="${h(a.handle)}" data-act="pinned"`, a.pinned)}
        ${ibtn('trash', 'Stop tracking', `data-acc="${h(a.handle)}" data-act="remove"`)}
      </div>
    </div>`);
    if (exact) rows.unshift(`<div class="row addrow"><span class="av add">+</span><div class="rmain"><b>Add @${h(query)}</b><small>Press Enter or click to start tracking</small></div><button type="button" data-addone="${h(query)}">Add</button></div>`);
    $('#accList').innerHTML = rows.join('') || `<div class="empty-row">${query ? 'No tracked account matches.' : 'No accounts yet. Search above or Import a list.'}</div>`;
    $('#accShowing').textContent = list.length > limit ? `Showing ${limit} of ${list.length.toLocaleString()}, search to find any account` : `Showing ${list.length.toLocaleString()}`;
    $('#accWatching').textContent = `Watching ${all.length.toLocaleString()}`;
  }
  $('#accTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; limit = 50; document.querySelectorAll('#accTabs button').forEach(x => x.classList.toggle('on', x === b)); paintAccounts(); });
  $('#accSearch').addEventListener('input', () => { limit = 50; paintAccounts(); });
  $('#accSearchForm').onsubmit = async e => {
    e.preventDefault();
    const v = $('#accSearch').value.trim(); if (!v) return;
    const before = A.accounts.length;
    await loadAccounts({ op: 'add', handles: v });
    const added = A.accounts.length - before;
    toast(added ? `Added ${added} account${added > 1 ? 's' : ''}` : 'Already tracked');
    $('#accSearch').value = ''; paintAccounts();
  };
  $('#accList').addEventListener('click', async e => {
    const one = e.target.closest('[data-addone]');
    if (one) { await loadAccounts({ op: 'add', handles: one.dataset.addone }); toast('Added @' + one.dataset.addone); $('#accSearch').value = ''; paintAccounts(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = A.accounts.find(x => x.handle === b.dataset.acc); if (!a) return;
    const act = b.dataset.act;
    if (act === 'remove') { await loadAccounts({ op: 'remove', handles: a.handle }); toast('Stopped tracking @' + a.handle); return; }
    if (act === 'bell') { // normal → every tweet → muted → normal
      const next = a.muted ? { muted: false, ping: false } : a.ping ? { ping: false, muted: true } : { ping: true, muted: false };
      await loadAccounts({ op: 'set', handle: a.handle, ...next });
      toast(next.ping ? `@${a.handle}: every tweet and reply pings` : next.muted ? `@${a.handle}: muted` : `@${a.handle}: normal`);
      return;
    }
    await loadAccounts({ op: 'set', handle: a.handle, [act]: !a[act] });
  });
  $('#accList').addEventListener('scroll', () => {}, { passive: true });
  window.addEventListener('scroll', () => {
    if (tab !== 'groups' && window.innerHeight + window.scrollY > document.body.scrollHeight - 300 && limit < A.accounts.length) { limit += 50; paintAccounts(); }
  }, { passive: true });
  $('#groupList').addEventListener('change', async e => {
    const c = e.target.closest('[data-group]'); if (!c) return;
    await loadAccounts({ op: 'group', id: c.dataset.group, on: c.checked });
    toast(c.checked ? 'Group added' : 'Group removed');
  });
  $('#accAddBtn').onclick = () => { $('#accSearch').focus(); };
  $('#accImportBtn').onclick = () => { $('#accImport').hidden = false; $('#accImport textarea').focus(); };
  $('#accImportCancel').onclick = () => { $('#accImport').hidden = true; };
  $('#accImportGo').onclick = async () => {
    const before = A.accounts.length;
    await loadAccounts({ op: 'add', handles: $('#accImport textarea').value });
    const added = A.accounts.length - before;
    $('#accImportMsg').textContent = `Added ${added} new account${added === 1 ? '' : 's'}.`;
    if (added) { $('#accImport textarea').value = ''; setTimeout(() => { $('#accImport').hidden = true; $('#accImportMsg').textContent = ''; }, 1500); }
  };
  $('#accExportBtn').onclick = () => {
    const blob = new Blob([A.accounts.map(a => '@' + a.handle).join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'elixir-accounts.txt'; a.click(); URL.revokeObjectURL(a.href);
  };

  // ---------- keywords ----------
  let K = { keywords: [], builtins: {}, palette: [] }, pick = null;
  async function loadKeywords(op = { op: 'list' }) { K = await api('/api/keywords', op); paintKeywords(); }
  const BUILTINS = [
    ['cashtag', '$TICKER', 'Every $mention from a tracked account (not $BTC/$ETH-type majors)', '#f08a3c'],
    ['quoted', '"Quoted text"', 'Phrases inside quotes: often the coin name', '#a7b1ff'],
    ['ai', 'AI predicted name', 'The name Claude predicts for a play (needs an Anthropic key)', '#32d296'],
  ];
  function paintKeywords() {
    $('#builtins').innerHTML = BUILTINS.map(([k, name, desc, color]) => `<div class="row">
      <span class="sw" style="--c:${color}"></span>
      <div class="rmain"><b>${h(name)}</b><small>${h(desc)}</small></div>
      <label class="switch"><input type="checkbox" data-builtin="${k}" ${K.builtins[k] ? 'checked' : ''}><i></i></label>
    </div>`).join('');
    const query = $('#kwSearch').value.trim().toLowerCase();
    const list = K.keywords.filter(k => !query || k.word.includes(query)).sort((a, b) => (b.pinned - a.pinned));
    $('#kwCount').textContent = K.keywords.length;
    $('#kwList').innerHTML = list.map(k => `<div class="row ${k.muted ? 'is-muted' : ''}" data-kw="${h(k.word)}">
      <span class="sw" style="--c:${h(k.color)}"></span>
      <div class="rmain"><b>${h(k.word)}${k.muted ? '<span class="chip">muted</span>' : ''}</b><small>${k.match === 'partial' ? 'Partial match' : 'Full word'} · ${k.scope === 'tweets' ? 'tweets only' : k.scope === 'streams' ? 'streams only' : 'tweets & streams'}</small></div>
      <div class="ractions">
        ${ibtn(k.muted ? 'mute' : 'bell', k.muted ? 'Muted: highlighted, never pings. Click to unmute' : 'Mute: keep highlighting, stop pinging', 'data-kact="muted"', k.muted)}
        ${ibtn('edit', 'Edit', 'data-kact="edit"')}
        ${ibtn('pin', k.pinned ? 'Unpin' : 'Pin to the top', 'data-kact="pinned"', k.pinned)}
        ${ibtn('trash', 'Delete', 'data-kact="remove"')}
      </div>
    </div>`).join('') || `<div class="empty-row">${query ? 'No keyword matches.' : 'No keywords yet. Add the words you want a ping for: coin names, people, memes.'}</div>`;
    $('#kwSwatches').innerHTML = K.palette.map(c => `<button type="button" class="swb ${c === pick ? 'on' : ''}" style="--c:${c}" data-color="${c}"></button>`).join('');
  }
  $('#builtins').addEventListener('change', e => { const c = e.target.closest('[data-builtin]'); if (c) loadKeywords({ op: 'builtin', key: c.dataset.builtin, on: c.checked }); });
  $('#kwSearch').addEventListener('input', paintKeywords);
  let editing = null;
  const openForm = (k = null) => {
    editing = k; pick = k?.color || K.palette[K.keywords.length % K.palette.length];
    $('#kwWord').value = k?.word || ''; $('#kwMatch').value = k?.match || 'word'; $('#kwScope').value = k?.scope || 'both'; $('#kwSave').textContent = k ? 'Save' : 'Add';
    $('#kwForm').hidden = false; paintKeywords(); $('#kwWord').focus();
  };
  $('#kwAddBtn').onclick = () => openForm();
  $('#kwCancel').onclick = () => { $('#kwForm').hidden = true; editing = null; };
  $('#kwSwatches').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) { pick = b.dataset.color; paintKeywords(); } });
  $('#kwForm').onsubmit = async e => {
    e.preventDefault();
    const word = $('#kwWord').value.trim(); if (!word) return;
    if (editing) await loadKeywords({ op: 'update', word: editing.word, patch: { word, match: $('#kwMatch').value, scope: $('#kwScope').value, color: pick } });
    else await loadKeywords({ op: 'add', word, match: $('#kwMatch').value, scope: $('#kwScope').value, color: pick });
    $('#kwForm').hidden = true; editing = null;
  };
  $('#kwList').addEventListener('click', async e => {
    const b = e.target.closest('[data-kact]'); if (!b) return;
    const k = K.keywords.find(x => x.word === b.closest('[data-kw]').dataset.kw); if (!k) return;
    const act = b.dataset.kact;
    if (act === 'edit') return openForm(k);
    if (act === 'remove') return loadKeywords({ op: 'remove', word: k.word });
    loadKeywords({ op: 'update', word: k.word, patch: { [act]: !k[act] } });
  });

  loadAccounts().catch(e => toast('Could not load accounts', e.message));
  loadKeywords().catch(e => toast('Could not load keywords', e.message));
})();
