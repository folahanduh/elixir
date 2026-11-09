// Bubble map: wallets as bubbles, connections as arrows. Used for a coin's holders (size = share of supply,
// colour = cluster) and for one wallet's connections (size = SOL moved, colour = relation).
// Plain canvas with a small force layout: drag bubbles, drag the background to pan, scroll to zoom,
// hover for details, click to select. Nodes can carry: r, color, t1/t2 (text), preFunded, fresh, center.
(() => {
  const COLORS = ['#a7b1ff', '#32d296', '#e7b54a', '#f2475f', '#4cc3d1', '#e879a6', '#f08a3c', '#9be15d', '#c3a6ff', '#5ec8ff', '#ffd166', '#ff8fa3'];
  const LINK = { funded: '#8f9bff', token: '#e7b54a', sol: '#4cc3d1', bundle: '#f2475f' };
  const DIRECTED = new Set(['funded', 'token', 'sol']);
  const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
  const hexA = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const colorOf = n => n.color || (n.kind === 'contract' ? '#565b68' : n.cluster ? COLORS[(n.cluster - 1) % COLORS.length] : '#5a5f6d');
  const SOL_IMG = new Image(); SOL_IMG.src = '/sol.svg';
  /** Text with the Solana mark in front, centred on (x, y). */
  function solText(ctx, txt, x, y, size) {
    const w = ctx.measureText(txt).width, iw = size * 1.15, gap = size * 0.3, total = iw + gap + w;
    if (SOL_IMG.complete && SOL_IMG.naturalWidth) ctx.drawImage(SOL_IMG, x - total / 2, y - size * 0.45, iw, size * 0.9);
    ctx.textAlign = 'left'; ctx.fillText(txt, x - total / 2 + iw + gap, y); ctx.textAlign = 'center';
    return total;
  }
  const solS = s => (s >= 1000 ? (s / 1000).toFixed(1) + 'K' : s >= 10 ? Math.round(s) : s >= 1 ? s.toFixed(1) : s.toFixed(2));

  window.BubbleMap = function BubbleMap(canvas, { onSelect = () => {}, onHover = () => {}, onOpen = () => {} } = {}) {
    const ctx = canvas.getContext('2d');
    let nodes = [], links = [], byId = new Map();
    let view = { k: 1, x: 0, y: 0 }, W = 0, H = 0, dpr = 1;
    let spread = 34, labelSet = new Set();
    let alpha = 0, raf = 0, hover = null, selected = null, drag = null, lastClick = { id: null, t: 0 };

    function size() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      draw();
    }
    new ResizeObserver(size).observe(canvas);

    /** Replace everything (keep = keep positions of nodes that stay, for "expand"). */
    function setData(d, { keep = false } = {}) {
      const old = keep ? byId : new Map();
      const maxPct = Math.max(1, ...d.nodes.map(n => n.pct || 0));
      const scale = 64 / Math.sqrt(maxPct);
      nodes = d.nodes.map((n, i) => {
        const o = old.get(n.id);
        const a = (i / d.nodes.length) * Math.PI * 2 * 3.1, rr = 40 + i * 4;
        const r = n.r != null ? n.r : n.kind === 'hub' ? 7 : Math.max(6, Math.sqrt(n.pct || 0) * scale);
        return { ...n, r, x: o ? o.x : (n.near && old.get(n.near) ? old.get(n.near).x + Math.cos(a) * 60 : Math.cos(a) * rr), y: o ? o.y : (n.near && old.get(n.near) ? old.get(n.near).y + Math.sin(a) * 60 : Math.sin(a) * rr), vx: 0, vy: 0 };
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      links = d.links.map(l => ({ ...l, s: byId.get(l.a), t: byId.get(l.b) })).filter(l => l.s && l.t);
      spread = d.spread || 34;
      if (!keep) { selected = null; view = { k: 1, x: 0, y: 0 }; } else if (selected) selected = byId.get(selected.id) || null;
      kick(keep ? 0.5 : 1);
    }
    const kick = (a = 0.6) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); };

    function tick() {
      const n = nodes.length;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2), min = a.r + b.r + 6;
          const f = (1100 * alpha) / d2;
          dx /= d; dy /= d;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
          if (d < min) { const p = (min - d) * 0.5; a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p; }
        }
      }
      for (const l of links) {
        const a = l.s, b = l.t;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const want = a.r + b.r + spread, k = ((d - want) / d) * 0.07 * alpha;
        a.vx += dx * k; a.vy += dy * k; b.vx -= dx * k; b.vy -= dy * k;
      }
      for (const a of nodes) {
        if (a === drag?.node || a.center) { a.vx = a.vy = 0; if (a.center && a !== drag?.node) { a.x *= 0.9; a.y *= 0.9; } continue; }
        a.vx *= 0.82; a.vy *= 0.82; a.x += a.vx; a.y += a.vy;
      }
      alpha *= 0.985;
    }
    function loop() {
      raf = 0;
      for (let i = 0; i < 3 && alpha > 0.005; i++) tick();
      draw();
      if (alpha > 0.005 || drag) raf = requestAnimationFrame(loop);
    }
    const toWorld = (sx, sy) => [(sx - W / 2) / view.k - view.x, (sy - H / 2) / view.k - view.y];

    function linked(a, b) { return links.some(l => (l.s === a && l.t === b) || (l.t === a && l.s === b)); }
    function dimmed(n) {
      if (!selected) return false;
      if (n === selected) return false;
      if (selected.cluster && n.cluster === selected.cluster) return false;
      return !linked(n, selected);
    }

    function arrow(x1, y1, x2, y2, r2, color, w) {
      const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
      const ex = x2 - ux * (r2 + 2), ey = y2 - uy * (r2 + 2), s = 7 / view.k;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ux * s - uy * s * 0.55, ey - uy * s + ux * s * 0.55); ctx.lineTo(ex - ux * s + uy * s * 0.55, ey - uy * s - ux * s * 0.55); ctx.closePath(); ctx.fill();
      void w;
    }

    function draw() {
      // amounts only on the selected wallet's 8 biggest lines, so they stay readable
      labelSet = new Set(selected ? links.filter(l => l.s === selected || l.t === selected).sort((a, b) => (b.sol || 0) - (a.sol || 0)).slice(0, 8) : []);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2 + view.x * view.k, H / 2 + view.y * view.k);
      ctx.scale(view.k, view.k);
      // links
      for (const l of links) {
        const off = dimmed(l.s) || dimmed(l.t);
        const c = LINK[l.type] || LINK.funded;
        const focus = selected && (l.s === selected || l.t === selected);
        ctx.globalAlpha = off ? 0.08 : focus ? 1 : 0.55;
        ctx.strokeStyle = c;
        ctx.lineWidth = Math.min(5, 1.2 + (l.sol ? Math.log10(1 + l.sol) : 0) + (l.type === 'bundle' ? 1 : 0)) / view.k;
        ctx.setLineDash(l.type === 'funded' && !l.sol ? [5 / view.k, 4 / view.k] : []);
        ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
        ctx.setLineDash([]);
        if (DIRECTED.has(l.type)) arrow(l.s.x, l.s.y, l.t.x, l.t.y, l.t.r, c);
        // amounts on the selected wallet's lines
        if (focus && (l.sol || l.mint) && labelSet.has(l)) {
          const mx = (l.s.x + l.t.x) / 2, my = (l.s.y + l.t.y) / 2;
          const txt = l.sol ? solS(l.sol) : 'token';
          ctx.font = `600 ${11 / view.k}px "IBM Plex Sans", system-ui`;
          const tw = ctx.measureText(txt).width + (l.sol ? 16 : 10) / view.k;
          ctx.fillStyle = '#0b0c10'; ctx.globalAlpha = 0.92;
          ctx.fillRect(mx - tw / 2, my - 9 / view.k, tw, 18 / view.k);
          ctx.globalAlpha = 1; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          if (l.sol) solText(ctx, txt, mx, my, 11 / view.k); else ctx.fillText(txt, mx, my);
        }
      }
      ctx.globalAlpha = 1;
      // bubbles (biggest first so small ones stay on top)
      for (const n of [...nodes].sort((a, b) => b.r - a.r)) {
        const c = colorOf(n), dim = dimmed(n), hot = n === selected || n === hover;
        ctx.globalAlpha = dim ? 0.15 : 1;
        if (n.kind === 'hub') {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fillStyle = '#0b0c0f'; ctx.fill();
          ctx.lineWidth = 2.5 / view.k; ctx.strokeStyle = c; ctx.stroke();
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.4, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
          continue;
        }
        // soft glow for connected / selected wallets
        if (!dim && (n.cluster || n.center || hot) && n.kind !== 'contract') { ctx.shadowColor = hexA(c, 0.6); ctx.shadowBlur = (hot ? 22 : 12) * Math.min(1.5, view.k); }
        const g = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.4, n.r * 0.1, n.x, n.y, n.r);
        if (n.kind === 'contract') { g.addColorStop(0, '#1d2027'); g.addColorStop(1, '#121419'); }
        else { g.addColorStop(0, hexA(c, 0.62)); g.addColorStop(0.65, hexA(c, 0.28)); g.addColorStop(1, hexA(c, 0.14)); }
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = (hot ? 2.6 : 1.5) / view.k;
        ctx.strokeStyle = hot ? '#fff' : n.kind === 'contract' ? '#4a4e5a' : hexA(c, 0.95);
        if (n.kind === 'contract') ctx.setLineDash([3 / view.k, 3 / view.k]);
        ctx.stroke(); ctx.setLineDash([]);
        if (n.center) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5 / view.k, 0, Math.PI * 2); ctx.strokeStyle = hexA(c, 0.7); ctx.lineWidth = 1.5 / view.k; ctx.stroke(); }
        // pre-funded: amber dashed ring
        if (n.preFunded) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / view.k, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 2 / view.k; ctx.setLineDash([4 / view.k, 3 / view.k]); ctx.stroke(); ctx.setLineDash([]);
        }
        // fresh wallet: green dot
        if (n.fresh && n.kind !== 'contract') {
          const a = -Math.PI / 4, bx = n.x + Math.cos(a) * n.r, by = n.y + Math.sin(a) * n.r;
          ctx.beginPath(); ctx.arc(bx, by, 4 / view.k, 0, Math.PI * 2); ctx.fillStyle = '#32d296'; ctx.fill();
          ctx.lineWidth = 1.5 / view.k; ctx.strokeStyle = '#07080a'; ctx.stroke();
        }
        // text
        const px = n.r * view.k;
        if (px >= 15) {
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = n.kind === 'contract' ? '#9a9eaa' : '#fff';
          ctx.font = `600 ${Math.min(16, Math.max(10, px / 2.6)) / view.k}px "IBM Plex Sans", system-ui`;
          ctx.fillText(n.t1 || '', n.x, n.y - (px >= 30 && n.t2 ? 6 / view.k : 0));
          if (px >= 30 && n.t2) {
            ctx.font = `500 ${10 / view.k}px "IBM Plex Sans", system-ui`;
            ctx.fillStyle = 'rgba(255,255,255,.72)';
            const t = String(n.t2), tt = t.length > 15 ? t.slice(0, 14) + '…' : t;
            if (n.t2Sol) solText(ctx, tt, n.x, n.y + 9 / view.k, 10 / view.k); else ctx.fillText(tt, n.x, n.y + 9 / view.k);
          }
        } else if (view.k >= 1.6 && n.t1) {
          ctx.font = `500 ${10 / view.k}px "IBM Plex Sans", system-ui`; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textAlign = 'center';
          ctx.fillText(n.t1, n.x, n.y + n.r + 10 / view.k);
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function nodeAt(sx, sy) {
      const [x, y] = toWorld(sx, sy);
      let best = null;
      for (const n of nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d <= Math.max(n.r, 7 / view.k) && (!best || n.r < best.r)) best = n; }
      return best;
    }
    const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', e => {
      const [sx, sy] = pos(e);
      drag = { node: nodeAt(sx, sy), sx, sy, vx: view.x, vy: view.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const [sx, sy] = pos(e);
      if (drag) {
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
        if (drag.node) { const [x, y] = toWorld(sx, sy); drag.node.x = x; drag.node.y = y; kick(0.25); }
        else { view.x = drag.vx + (sx - drag.sx) / view.k; view.y = drag.vy + (sy - drag.sy) / view.k; draw(); }
        return;
      }
      const n = nodeAt(sx, sy);
      if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); }
      onHover(n, sx, sy);
    });
    canvas.addEventListener('pointerup', () => {
      if (drag && !drag.moved) {
        const n = drag.node, now = Date.now();
        if (n && lastClick.id === n.id && now - lastClick.t < 350) onOpen(n); // double-click: open its connections
        lastClick = { id: n?.id || null, t: now };
        selected = n && n !== selected ? n : n || null;
        onSelect(selected); draw();
      }
      drag = null;
    });
    canvas.addEventListener('pointerleave', () => { hover = null; onHover(null); draw(); });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [wx, wy] = toWorld(sx, sy);
      view.k = Math.max(0.25, Math.min(5, view.k * Math.exp(-e.deltaY * 0.0015)));
      view.x = (sx - W / 2) / view.k - wx; view.y = (sy - H / 2) / view.k - wy;
      draw();
    }, { passive: false });

    return {
      setData,
      select(id) { selected = byId.get(id) || null; if (selected) { view.x = -selected.x; view.y = -selected.y; } draw(); return selected; },
      clear() { selected = null; draw(); },
      fit() { view = { k: 1, x: 0, y: 0 }; draw(); },
      colors: COLORS, linkColors: LINK,
    };
  };
})();
