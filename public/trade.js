// Quick buy: a ⚡ button beside every ticker. One click → Elixir builds the swap (Jupiter, or PumpPortal for
// brand-new pump coins) → your wallet (Phantom / Solflare / Backpack) pops up → you approve → it lands.
// Elixir never sees your private key; every trade is approved in your wallet.
(() => {
  const LS = 'nr.trade', LS_POS = 'nr.trade.pos';
  const DEF = { amount: 0.5, presets: [0.1, 0.5, 1, 2], slippage: 15, priority: 'turbo', maxSol: 5, maxImpact: 35, walletName: null, show: true };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  let S = { ...DEF, ...load(LS, {}) };
  let bought = load(LS_POS, []); // mints you quick-bought (positions list)
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); localStorage.setItem(LS_POS, JSON.stringify(bought.slice(0, 30))); } catch {} };
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  };
  const sol = v => (window.solHTML ? window.solHTML(v) : v + ' SOL');

  // ---------- toasts (own, so every page has them) ----------
  function note(title, sub = '', kind = '', ms = 6000) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.append(box); }
    const d = document.createElement('div');
    d.className = 'toast tq ' + kind;
    d.innerHTML = `<b>${title}</b>${sub ? `<p>${sub}</p>` : ''}`;
    box.prepend(d);
    if (ms) setTimeout(() => d.remove(), ms);
    return d;
  }

  // ---------- wallets ----------
  const wallets = () => [
    ['Phantom', window.phantom?.solana?.isPhantom ? window.phantom.solana : null, 'https://phantom.com/download'],
    ['Solflare', window.solflare?.isSolflare ? window.solflare : null, 'https://solflare.com/download'],
    ['Backpack', window.backpack?.isBackpack ? window.backpack : null, 'https://backpack.app/download'],
  ];
  let provider = null, pubkey = null, balance = null;
  async function connect(name, quiet = false) {
    const w = wallets().find(x => x[0] === name);
    if (!w || !w[1]) { if (!quiet) note(`${name} isn't installed in this browser`, `<a href="${w?.[2] || '#'}" target="_blank" rel="noopener">Get ${h(name)}</a>, then reload this page.`, 'k-watch'); return; }
    try {
      const r = await w[1].connect(quiet ? { onlyIfTrusted: true } : undefined);
      const pk = r?.publicKey || w[1].publicKey;
      if (!pk) throw new Error('No wallet address');
      provider = w[1]; pubkey = pk.toString(); S.walletName = name; save();
      provider.on?.('accountChanged', p => { pubkey = p ? p.toString() : null; refreshBalance(); paint(); });
      provider.on?.('disconnect', () => { provider = null; pubkey = null; paint(); });
      refreshBalance();
      if (!quiet) note(`${name} connected`, short(pubkey), 'k-fresh', 2500);
    } catch (e) { if (!quiet) note('Wallet not connected', h(e.message || 'Cancelled'), 'k-watch'); }
    paint();
  }
  async function disconnect() { try { await provider?.disconnect?.(); } catch {} provider = null; pubkey = null; S.walletName = null; save(); paint(); }
  async function refreshBalance() { if (!pubkey) return; try { balance = (await post('/api/trade/balance', { wallet: pubkey })).sol; } catch {} paint(); }
  setInterval(refreshBalance, 30000);

  // solana-web3.js (bundled in Elixir) is only loaded the first time you trade.
  let web3P = null;
  const web3 = () => web3P || (web3P = new Promise((ok, bad) => {
    if (window.solanaWeb3) return ok(window.solanaWeb3);
    const s = document.createElement('script'); s.src = '/vendor/solana-web3-1.98.4.min.js';
    s.onload = () => ok(window.solanaWeb3); s.onerror = () => { web3P = null; bad(new Error('Could not load the Solana library')); };
    document.head.append(s);
  }));

  // ---------- trading ----------
  const busy = new Set();
  async function trade(side, mint, sym, opts = {}) {
    if (!pubkey || !provider) { openMenu(); note('Connect a wallet first', 'Then the ⚡ buttons buy in one click.', 'k-watch'); return; }
    const key = side + mint;
    if (busy.has(key)) return;
    busy.add(key);
    const label = sym ? '$' + h(sym) : short(mint);
    const what = side === 'buy' ? `Buying ${label} with ${sol(opts.amount)}` : `Selling ${opts.pct}% of ${label}`;
    const t = note(what + '…', 'Building the trade', 'k-open', 0);
    try {
      const r = await post('/api/trade/build', { wallet: pubkey, mint, side, amountSol: opts.amount, pct: opts.pct, slippagePct: S.slippage, priority: S.priority, maxSol: S.maxSol, maxImpactPct: S.maxImpact });
      t.querySelector('p').innerHTML = `Approve in ${h(S.walletName)} · via ${h(r.via)}${r.priceImpactPct != null ? ` · impact ${r.priceImpactPct.toFixed(1)}%` : ''}`;
      const W = await web3();
      const tx = W.VersionedTransaction.deserialize(Uint8Array.from(atob(r.tx), c => c.charCodeAt(0)));
      const sent = await provider.signAndSendTransaction(tx);
      const sig = typeof sent === 'string' ? sent : sent?.signature;
      if (!sig) throw new Error('The wallet didn\'t return a transaction');
      t.querySelector('b').innerHTML = what + ' · sent';
      t.querySelector('p').innerHTML = `Waiting for it to land… <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>`;
      for (let i = 0; i < 60; i++) {
        await new Promise(x => setTimeout(x, 1000));
        const st = await post('/api/trade/status', { sig }).catch(() => ({ state: 'pending' }));
        if (st.state === 'failed') throw Object.assign(new Error('Failed on-chain'), { html: `Failed on-chain: ${h(st.err || 'unknown')} · <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>` });
        if (st.state === 'confirmed' || st.state === 'processed') {
          t.remove();
          note(side === 'buy' ? `Bought ${label}` : `Sold ${opts.pct}% of ${label}`, `<a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">View on Solscan</a>`, 'k-fresh', 8000);
          if (side === 'buy' && !bought.includes(mint)) { bought.unshift(mint); save(); }
          refreshBalance(); if (menu) paintPositions();
          return;
        }
      }
      throw Object.assign(new Error('Not confirmed after a minute'), { html: `Not confirmed after a minute. Check <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>.` });
    } catch (e) {
      t.remove();
      const msg = String(e?.message || e);
      note(/reject|cancel|declin|denied/i.test(msg) ? 'Cancelled in your wallet' : (side === 'buy' ? 'Buy failed' : 'Sell failed'), e?.html || h(msg), 'k-watch', 9000);
    } finally { busy.delete(key); }
  }

  // ⚡ buttons: anywhere on any page
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-qb]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    trade('buy', b.dataset.qb, b.dataset.sym || '', { amount: Number(S.amount) });
  }, true);
  const amountTxt = () => String(+Number(S.amount).toFixed(3));
  const paintButtons = () => document.querySelectorAll('.qb .qb-a').forEach(el => { el.textContent = amountTxt(); });

  // ---------- wallet menu (status bar) ----------
  const bar = document.querySelector('.sbar');
  const slot = document.createElement('span');
  slot.className = 'sbar-w';
  (bar?.querySelector('.sbar-sol') || bar?.lastChild)?.before(slot);
  let menu = null;
  function paint() {
    if (!slot.isConnected) return;
    slot.innerHTML = pubkey
      ? `<button type="button" class="wbtn on" title="Wallet · quick buy settings">${balance != null ? sol(balance.toFixed(2)) : ''}<span>${h(short(pubkey))}</span><em>⚡${amountTxt()}</em></button>`
      : `<button type="button" class="wbtn" title="Connect a wallet for one-click buys">Connect wallet</button>`;
    if (menu) {
      if ((pubkey ? 'on' : 'off') !== menuState) paintMenu();
      else { const b = menu.querySelector('.wm-bal'); if (b && balance != null) b.innerHTML = sol(balance.toFixed(3)); }
    }
  }
  let menuState = null;
  slot.addEventListener('click', e => { if (e.target.closest('.wbtn')) { menu ? closeMenu() : openMenu(); } });
  function openMenu() {
    if (menu) return;
    menu = document.createElement('div');
    menu.className = 'wmenu';
    document.body.append(menu);
    paintMenu();
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
  }
  const outside = e => { if (menu && !menu.contains(e.target) && !slot.contains(e.target)) closeMenu(); };
  function closeMenu() { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside); }
  function place() { const r = slot.getBoundingClientRect(); menu.style.left = Math.max(8, Math.min(window.innerWidth - 348, r.left)) + 'px'; menu.style.bottom = (window.innerHeight - r.top + 8) + 'px'; }
  function paintMenu() {
    menuState = pubkey ? 'on' : 'off';
    if (!pubkey) {
      menu.innerHTML = `<div class="wm-h"><b>Connect a wallet</b><span>For one-click ⚡ buys. Your key never leaves your wallet; you approve every trade there.</span></div>
        <div class="wm-list">${wallets().map(([n, p, url]) => p ? `<button type="button" class="ghost" data-wconnect="${n}">${n}</button>` : `<a class="wm-get" href="${url}" target="_blank" rel="noopener">Get ${n} ↗</a>`).join('')}</div>`;
    } else {
      menu.innerHTML = `<div class="wm-h"><b>${h(S.walletName)} · ${h(short(pubkey))}</b><span><span class="wm-bal">${balance != null ? sol(balance.toFixed(3)) : '…'}</span> <a href="https://solscan.io/account/${h(pubkey)}" target="_blank" rel="noopener">Solscan</a> · <a href="#" data-wdisc>Disconnect</a></span></div>
        <div class="wm-sec">QUICK BUY AMOUNT</div>
        <div class="wm-row">${S.presets.map(p => `<button type="button" class="ghost small ${Number(S.amount) === p ? 'on' : ''}" data-wamt="${p}">${sol(p)}</button>`).join('')}<input type="number" min="0.01" step="0.01" value="${h(S.amount)}" data-wset="amount" title="Custom amount"></div>
        <div class="wm-grid">
          <label>Slippage <span><input type="number" min="0.5" max="50" step="0.5" value="${h(S.slippage)}" data-wset="slippage">%</span></label>
          <label>Speed <select data-wset="priority"><option value="turbo"${S.priority === 'turbo' ? ' selected' : ''}>Turbo (max ◎0.005 fee)</option><option value="fast"${S.priority === 'fast' ? ' selected' : ''}>Fast (max ◎0.001 fee)</option></select></label>
          <label>Max buy <span><input type="number" min="0.01" step="0.1" value="${h(S.maxSol)}" data-wset="maxSol">SOL</span></label>
          <label>Max price impact <span><input type="number" min="1" max="100" step="1" value="${h(S.maxImpact)}" data-wset="maxImpact">%</span></label>
        </div>
        <label class="wm-chk"><input type="checkbox" data-wset="show"${S.show !== false ? ' checked' : ''}> Show ⚡ buttons beside tickers</label>
        <div class="wm-sec">POSITIONS</div><div class="wm-pos"><span class="muted small">Loading…</span></div>
        <div class="wm-sec">SEND</div>
        <div class="wm-send">
          <div class="wm-row"><select data-send="asset">${assetOptions()}</select><input data-send="mint" placeholder="Coin CA" value="${h(send.mint)}"${send.asset === 'other' ? '' : ' hidden'}></div>
          <input data-send="to" placeholder="Recipient wallet address" value="${h(send.to)}" list="wm-recents" autocomplete="off" spellcheck="false">
          <datalist id="wm-recents">${recents().map(r => `<option value="${h(r)}">`).join('')}</datalist>
          <div class="wm-row"><input data-send="amount" placeholder="Amount" inputmode="decimal" value="${h(send.amount)}"><button type="button" class="ghost small" data-sendmax>Max</button><button type="button" class="small" data-sendreview>Review</button></div>
          <div class="wm-review"></div>
        </div>
        <div class="wm-foot">Routes through Jupiter. Brand-new pump.fun coins Jupiter can't route yet go through PumpPortal, which charges a fee per trade.</div>`;
      paintPositions();
    }
    place();
  }
  // ---------- send SOL or a coin to another wallet (Phantom approves) ----------
  const send = { asset: 'SOL', mint: '', to: '', amount: '' };
  let lastPositions = [];
  const recents = () => load('nr.trade.to', []);
  const addRecent = a => { const r = [a, ...recents().filter(x => x !== a)].slice(0, 8); try { localStorage.setItem('nr.trade.to', JSON.stringify(r)); } catch {} };
  const assetOptions = () => `<option value="SOL"${send.asset === 'SOL' ? ' selected' : ''}>SOL</option>` + lastPositions.map(p => `<option value="${h(p.mint)}"${send.asset === p.mint ? ' selected' : ''}>${p.symbol ? '$' + h(p.symbol) : h(short(p.mint))}</option>`).join('') + `<option value="other"${send.asset === 'other' ? ' selected' : ''}>Other coin (paste CA)…</option>`;
  const sendMint = () => (send.asset === 'SOL' ? null : send.asset === 'other' ? send.mint.trim() : send.asset);
  /** "1.5" with 6 decimals → 1500000n, exactly (no float rounding). */
  const toRaw = (str, dec) => {
    const m = String(str).trim().match(/^(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[1] && !m[2])) return null;
    return BigInt((m[1] || '0') + (m[2] || '').padEnd(dec, '0').slice(0, dec));
  };
  let pending = null; // reviewed send waiting for "Send with wallet"
  async function review() {
    const box = menu.querySelector('.wm-review');
    const say = (html, cls = 'bad') => { box.className = 'wm-review ' + cls; box.innerHTML = html; };
    pending = null;
    const to = send.to.trim();
    if (to === pubkey) return say('That\'s your own wallet.');
    const mint = sendMint();
    if (send.asset === 'other' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || '')) return say('Paste the coin\'s CA.');
    say('Checking…', '');
    let rc;
    try { rc = await post('/api/trade/recipient', { address: to }); } catch (e) { return say(h(e.message)); }
    if (!rc.ok) return say(h(rc.why));
    if (!mint) {
      const raw = toRaw(send.amount, 9);
      if (!raw || raw <= 0n) return say('Enter an amount.');
      if (balance != null && Number(raw) / 1e9 > balance - 0.001) return say(`That's more than you can send (balance ${sol(balance.toFixed(4))}, keep ~0.001 for fees).`);
      if (rc.fresh && raw < 890880n) return say('A brand-new wallet needs at least 0.00089 SOL to exist. Send a bit more.');
      pending = { kind: 'sol', to, raw, label: sol(send.amount) };
    } else {
      let ta;
      try { ta = await post('/api/trade/token-accounts', { wallet: pubkey, mint }); } catch (e) { return say(h(e.message)); }
      const src = ta.accounts[0];
      if (!src) return say('You don\'t hold this coin.');
      const raw = toRaw(send.amount, src.decimals);
      if (!raw || raw <= 0n) return say('Enter an amount.');
      if (raw > BigInt(src.amount)) return say(`You only have ${src.ui.toLocaleString()} in one account.`);
      const sym = lastPositions.find(p => p.mint === mint)?.symbol;
      pending = { kind: 'token', to, raw, mint, src, label: `${h(send.amount)} ${sym ? '$' + h(sym) : h(short(mint))}` };
    }
    say(`Send <b>${pending.label}</b> to <code>${h(short(to))}</code>${rc.note ? `<div class="muted small">${h(rc.note)}</div>` : ''}<div class="muted small">${h(to)}</div>
      <div class="wm-row"><button type="button" class="small" data-sendgo>Send with ${h(S.walletName)}</button><button type="button" class="ghost small" data-sendcancel>Cancel</button></div>`, 'ok');
  }
  async function doSend() {
    const p = pending; pending = null;
    if (!p) return;
    const t = note(`Sending ${p.label}…`, 'Approve in ' + h(S.walletName), 'k-open', 0);
    try {
      const W = await web3();
      const { blockhash } = await post('/api/trade/blockhash', {});
      const from = new W.PublicKey(pubkey), to = new W.PublicKey(p.to);
      const ixs = [W.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), W.ComputeBudgetProgram.setComputeUnitLimit({ units: p.kind === 'sol' ? 2000 : 80000 })];
      if (p.kind === 'sol') ixs.push(W.SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: p.raw }));
      else {
        const mint = new W.PublicKey(p.mint), prog = new W.PublicKey(p.src.program), ATA = new W.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const dest = W.PublicKey.findProgramAddressSync([to.toBytes(), prog.toBytes(), mint.toBytes()], ATA)[0];
        // Create the recipient's account for this coin if they don't have one (no-op if they do)
        ixs.push(new W.TransactionInstruction({ programId: ATA, data: Uint8Array.from([1]), keys: [
          { pubkey: from, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: W.SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: prog, isSigner: false, isWritable: false }] }));
        const data = new Uint8Array(10); data[0] = 12; new DataView(data.buffer).setBigUint64(1, p.raw, true); data[9] = p.src.decimals; // TransferChecked
        ixs.push(new W.TransactionInstruction({ programId: prog, data, keys: [
          { pubkey: new W.PublicKey(p.src.address), isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }] }));
      }
      const tx = new W.VersionedTransaction(new W.TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
      const sent = await provider.signAndSendTransaction(tx);
      const sig = typeof sent === 'string' ? sent : sent?.signature;
      if (!sig) throw new Error('The wallet didn\'t return a transaction');
      addRecent(p.to);
      t.querySelector('p').innerHTML = `Waiting for it to land… <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>`;
      for (let i = 0; i < 60; i++) {
        await new Promise(x => setTimeout(x, 1000));
        const st = await post('/api/trade/status', { sig }).catch(() => ({ state: 'pending' }));
        if (st.state === 'failed') throw Object.assign(new Error('Failed'), { html: `Failed on-chain: ${h(st.err || '')} · <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>` });
        if (st.state === 'confirmed' || st.state === 'processed') {
          t.remove();
          note(`Sent ${p.label}`, `to ${h(short(p.to))} · <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>`, 'k-fresh', 9000);
          send.amount = ''; refreshBalance(); if (menu) { paintMenu(); }
          return;
        }
      }
      throw Object.assign(new Error('Not confirmed'), { html: `Not confirmed after a minute. Check <a href="https://solscan.io/tx/${h(sig)}" target="_blank" rel="noopener">Solscan</a>.` });
    } catch (e) {
      t.remove();
      const msg = String(e?.message || e);
      note(/reject|cancel|declin|denied/i.test(msg) ? 'Cancelled in your wallet' : 'Send failed', e?.html || h(msg), 'k-watch', 9000);
    }
  }

  async function paintPositions() {
    const box = menu?.querySelector('.wm-pos');
    if (!box || !pubkey) return;
    if (!bought.length) { box.innerHTML = '<span class="muted small">Coins you quick-buy show here, with sell buttons.</span>'; return; }
    try {
      const { positions } = await post('/api/trade/positions', { wallet: pubkey, mints: bought });
      lastPositions = positions;
      const sel = menu?.querySelector('[data-send="asset"]'); if (sel) sel.innerHTML = assetOptions();
      if (!menu) return;
      box.innerHTML = positions.length ? positions.map(p => `<div class="wm-p"><img src="${h(window.coinImg ? window.coinImg(p.mint) : '')}" alt="" onerror="this.remove()"><b>${p.symbol ? '$' + h(p.symbol) : h(short(p.mint))}</b><span class="muted">${p.ui >= 1e6 ? (p.ui / 1e6).toFixed(2) + 'M' : p.ui >= 1e3 ? (p.ui / 1e3).toFixed(1) + 'K' : p.ui.toFixed(2)}${p.marketCap ? ' · mc $' + (p.marketCap >= 1e6 ? (p.marketCap / 1e6).toFixed(2) + 'M' : (p.marketCap / 1e3).toFixed(1) + 'K') : ''}</span><span class="grow"></span><button type="button" class="ghost small" data-wsell="${h(p.mint)}" data-pct="50" data-sym="${h(p.symbol || '')}">Sell 50%</button><button type="button" class="ghost small" data-wsell="${h(p.mint)}" data-pct="100" data-sym="${h(p.symbol || '')}">Sell all</button></div>`).join('')
        : '<span class="muted small">No open positions from your quick buys.</span>';
    } catch (e) { box.innerHTML = `<span class="muted small">${h(e.message)}</span>`; }
  }
  document.addEventListener('click', e => {
    if (!menu || !menu.contains(e.target)) return;
    const c = e.target.closest('[data-wconnect]'); if (c) { connect(c.dataset.wconnect); return; }
    if (e.target.closest('[data-wdisc]')) { e.preventDefault(); disconnect(); closeMenu(); return; }
    const a = e.target.closest('[data-wamt]'); if (a) { S.amount = Number(a.dataset.wamt); save(); paint(); paintButtons(); return; }
    const s = e.target.closest('[data-wsell]'); if (s) { trade('sell', s.dataset.wsell, s.dataset.sym, { pct: Number(s.dataset.pct) }); }
    if (e.target.closest('[data-sendreview]')) { review(); return; }
    if (e.target.closest('[data-sendgo]')) { doSend(); menu.querySelector('.wm-review').innerHTML = ''; return; }
    if (e.target.closest('[data-sendcancel]')) { pending = null; menu.querySelector('.wm-review').innerHTML = ''; return; }
    if (e.target.closest('[data-sendmax]')) {
      const mint = sendMint();
      if (!mint) send.amount = balance != null ? String(Math.max(0, Math.floor((balance - 0.002) * 1e6) / 1e6)) : '';
      else { const p = lastPositions.find(x => x.mint === mint); if (p) send.amount = String(p.ui); }
      const el = menu.querySelector('[data-send="amount"]'); if (el) el.value = send.amount;
    }
  });
  document.addEventListener('input', e => {
    const el = e.target.closest?.('[data-send]');
    if (!el || !menu?.contains(el)) return;
    send[el.dataset.send] = el.value;
    if (el.dataset.send === 'asset') { const m = menu.querySelector('[data-send="mint"]'); if (m) m.hidden = el.value !== 'other'; }
    pending = null; const r = menu.querySelector('.wm-review'); if (r) r.innerHTML = '';
  });
  document.addEventListener('change', e => {
    const el = e.target.closest?.('[data-wset]');
    if (!el || !menu?.contains(el)) return;
    const k = el.dataset.wset;
    S[k] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Math.max(0, Number(el.value) || DEF[k]);
    save(); paint(); paintButtons();
    if (k === 'show') document.documentElement.classList.toggle('qb-off', S.show === false);
  });
  document.documentElement.classList.toggle('qb-off', S.show === false);

  paint();
  // Reconnect silently to the wallet you used last time (Phantom remembers trusted sites).
  if (S.walletName) setTimeout(() => connect(S.walletName, true), 600);
})();
