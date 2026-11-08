// Bubble map: holders as bubbles (area = share of supply), connected wallets joined by lines and coloured
// as one cluster. Plain canvas with a small force layout: drag bubbles, drag the background to pan,
// scroll to zoom, hover for details, click to select a cluster.
(() => {
  const COLORS = ['#a7b1ff', '#32d296', '#e7b54a', '#f2475f', '#4cc3d1', '#e879a6', '#f08a3c', '#9be15d', '#c3a6ff', '#5ec8ff', '#ffd166', '#ff8fa3'];
  const LINK = { funded: 'rgba(167,177,255,.55)', token: 'rgba(231,181,74,.7)', sol: 'rgba(76,195,209,.65)', bundle: 'rgba(242,71,95,.8)' };
  const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
  const colorOf = n => (n.kind === 'contract' ? '#2a2d35' : n.cluster ? COLORS[(n.cluster - 1) % COLORS.length] : '#3b3f4b');

  window.BubbleMap = function BubbleMap(canvas, { onSelect = () => {}, onHover = () => {} } = {}) {
    const ctx = canvas.getContext('2d');
    let nodes = [], links = [], byId = new Map();
    let view = { k: 1, x: 0, y: 0 }, W = 0, H = 0, dpr = 1;
    let alpha = 0, raf = 0, hover = null, selected = null, drag = null;

    function size() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      draw();
    }
    new ResizeObserver(size).observe(canvas);

    function setData(d) {
      const maxPct = Math.max(1, ...d.nodes.map(n => n.pct || 0));
      // Area ∝ share: radius ∝ √pct, scaled so the biggest holder is ~70px.
      const scale = 64 / Math.sqrt(maxPct);
      nodes = d.nodes.map((n, i) => {
        const a = (i / d.nodes.length) * Math.PI * 2 * 3.1, rr = 40 + i * 4;
        return { ...n, r: n.kind === 'hub' ? 5 : Math.max(5, Math.sqrt(n.pct || 0) * scale), x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0 };
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      links = d.links.map(l => ({ ...l, s: byId.get(l.a), t: byId.get(l.b) })).filter(l => l.s && l.t);
      selected = null; view = { k: 1, x: 0, y: 0 };
      kick(1);
    }
    const kick = (a = 0.6) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); };

    function tick() {
      const n = nodes.length;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        // pull to the middle; clustered bubbles less, so clusters can sit apart
        a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2), min = a.r + b.r + 4;
          // repulsion
          const f = (900 * alpha) / d2;
          dx /= d; dy /= d;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
          // no overlaps
          if (d < min) { const p = (min - d) * 0.5; a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p; }
        }
      }
      for (const l of links) {
        const a = l.s, b = l.t;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const want = a.r + b.r + 18, k = ((d - want) / d) * 0.08 * alpha;
        a.vx += dx * k; a.vy += dy * k; b.vx -= dx * k; b.vy -= dy * k;
      }
      for (const a of nodes) {
        if (a === drag?.node) { a.vx = a.vy = 0; continue; }
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

    const toScreen = (x, y) => [W / 2 + (x + view.x) * view.k, H / 2 + (y + view.y) * view.k];
    const toWorld = (sx, sy) => [(sx - W / 2) / view.k - view.x, (sy - H / 2) / view.k - view.y];

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2 + view.x * view.k, H / 2 + view.y * view.k);
      ctx.scale(view.k, view.k);
      const focus = selected?.cluster || null;
      const dim = n => (focus && n.cluster !== focus && n !== selected) || (selected && !selected.cluster && n !== selected && !links.some(l => (l.s === selected && l.t === n) || (l.t === selected && l.s === n)));
      // lines
      for (const l of links) {
        const off = dim(l.s) && dim(l.t);
        ctx.strokeStyle = LINK[l.type] || LINK.funded;
        ctx.globalAlpha = off ? 0.12 : 1;
        ctx.lineWidth = (l.type === 'bundle' ? 2.2 : 1.4) / view.k;
        ctx.setLineDash(l.type === 'funded' ? [4 / view.k, 3 / view.k] : []);
        ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      // bubbles, biggest first so small ones stay visible on top
      for (const n of [...nodes].sort((a, b) => b.r - a.r)) {
        const c = colorOf(n);
        ctx.globalAlpha = dim(n) ? 0.18 : 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (n.kind === 'hub') { ctx.fillStyle = '#0b0c0f'; ctx.fill(); ctx.lineWidth = 2 / view.k; ctx.strokeStyle = c; ctx.stroke(); continue; }
        ctx.fillStyle = n.kind === 'contract' ? '#16181d' : hexA(c, 0.28); ctx.fill();
        ctx.lineWidth = (n === selected || n === hover ? 2.5 : 1.4) / view.k;
        ctx.strokeStyle = n === selected || n === hover ? '#fff' : n.kind === 'contract' ? '#4a4e5a' : c;
        if (n.kind === 'contract') ctx.setLineDash([3 / view.k, 3 / view.k]);
        ctx.stroke(); ctx.setLineDash([]);
        // label: % inside big bubbles, name under it if it fits
        const px = n.r * view.k;
        if (px >= 16) {
          ctx.fillStyle = n.kind === 'contract' ? '#8a8e9a' : '#fff';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = `600 ${Math.min(15, Math.max(10, px / 2.6)) / view.k}px "IBM Plex Sans", system-ui`;
          ctx.fillText((n.pct >= 10 ? n.pct.toFixed(1) : n.pct.toFixed(2)) + '%', n.x, n.y - (px >= 30 ? 6 / view.k : 0));
          if (px >= 30) {
            ctx.font = `500 ${10 / view.k}px "IBM Plex Sans", system-ui`;
            ctx.fillStyle = 'rgba(255,255,255,.7)';
            const label = n.label || (n.name && n.name !== short(n.wallet) ? n.name : '#' + n.rank);
            ctx.fillText(label.length > 14 ? label.slice(0, 13) + '…' : label, n.x, n.y + 9 / view.k);
          }
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

    function nodeAt(sx, sy) {
      const [x, y] = toWorld(sx, sy);
      let best = null;
      for (const n of nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d <= Math.max(n.r, 6 / view.k) && (!best || n.r < best.r)) best = n; }
      return best;
    }
    const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', e => {
      const [sx, sy] = pos(e);
      const n = nodeAt(sx, sy);
      drag = { node: n, sx, sy, vx: view.x, vy: view.y, moved: false };
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
      if (drag && !drag.moved) { selected = drag.node && drag.node !== selected ? drag.node : null; onSelect(selected); draw(); }
      drag = null;
    });
    canvas.addEventListener('pointerleave', () => { hover = null; onHover(null); draw(); });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [wx, wy] = toWorld(sx, sy);
      view.k = Math.max(0.25, Math.min(5, view.k * Math.exp(-e.deltaY * 0.0015)));
      // keep the point under the cursor still
      view.x = (sx - W / 2) / view.k - wx; view.y = (sy - H / 2) / view.k - wy;
      draw();
    }, { passive: false });

    return {
      setData,
      select(id) { selected = byId.get(id) || null; if (selected) { view.x = -selected.x; view.y = -selected.y; } draw(); },
      fit() { view = { k: 1, x: 0, y: 0 }; draw(); },
      colors: COLORS, linkColors: LINK,
    };
  };
})();
