// Keywords: your own words (with colour, partial/full-word match, mute, pin) plus built-in detectors
// ($TICKER mentions, "quoted text", AI-predicted names). Matching runs on every tweet and stream line.

const PALETTE = ['#e7b54a', '#32d296', '#a7b1ff', '#f2475f', '#4cc3d1', '#e879a6', '#f08a3c', '#c3cbff'];
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Turn whatever is stored (old plain watchlist strings, or keyword objects) into keyword objects. */
function normalizeKeywords(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((k, i) => {
    const o = typeof k === 'string' ? { word: k } : { ...k };
    o.word = norm(o.word).slice(0, 60);
    if (!o.word || seen.has(o.word)) return;
    seen.add(o.word);
    out.push({
      word: o.word,
      match: o.match === 'partial' ? 'partial' : 'word',
      color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : PALETTE[i % PALETTE.length],
      muted: Boolean(o.muted),
      pinned: Boolean(o.pinned),
      note: String(o.note || '').slice(0, 200),
    });
  });
  return out;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Which keywords appear in the text. Partial: anywhere ("coin" in "memecoin"); word: whole word/phrase. */
function keywordHits(text, keywords) {
  const t = String(text || '').toLowerCase();
  const hits = [];
  for (const k of keywords || []) {
    const ok = k.match === 'partial' ? t.includes(k.word) : new RegExp(`(^|[^a-z0-9])${esc(k.word).replace(/ /g, '\\s+')}([^a-z0-9]|$)`).test(t);
    if (ok) hits.push(k);
  }
  return hits;
}

const DEFAULT_BUILTINS = { cashtag: true, quoted: true, ai: false };

module.exports = { normalizeKeywords, keywordHits, PALETTE, DEFAULT_BUILTINS, norm };
