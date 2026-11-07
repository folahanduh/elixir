// Coin filters in the style of Axiom's Pulse columns (New Pairs / Final Stretch / Graduated).
// The default preset is DVCES's:
//   New Pairs     – min $200 volume, max 5 min token age
//   Final Stretch – min $10,000 market cap, min $5,000 volume, max 30 min age
//   Graduated     – min 2 SOL fees paid
// DexScreener doesn't report fees paid, so the fee check shows as "unchecked" instead of guessing.

const DEFAULT_PRESETS = {
  dvces: {
    label: 'DVCES',
    newPairs: { maxAgeMin: 5, minVolume: 200 },
    finalStretch: { maxAgeMin: 30, minMcap: 10000, minVolume: 5000 },
    graduated: { minFeesSol: 2 },
  },
};

/** Still on the launchpad's bonding curve, or graduated to an AMM? Uses the pad's curve markers. */
function stageOf(d, pad) {
  if (!pad || !pad.curve) return 'unknown';
  const dexId = String(d.dexId || '').toLowerCase();
  const labels = (d.labels || []).map(l => String(l).toLowerCase());
  const onCurve = (pad.curve.dexIds || []).includes(dexId) || (pad.curve.labels || []).some(l => labels.includes(String(l).toLowerCase()));
  if (onCurve) return 'curve';
  const hasCurveRule = (pad.curve.dexIds || []).length || (pad.curve.labels || []).length;
  return hasCurveRule ? 'graduated' : 'unknown';
}

/**
 * @param {object} d   deploy/token: {createdAt, marketCap, volume (raw $), feesSol?, dexId, labels}
 * @param {object} pad launchpad config (with .curve markers)
 * @param {object} f   filter preset
 * @returns {{pass: boolean|null, stage: string, column: string|null, checks: {label:string, ok:boolean|null}[]}}
 */
function checkCoin(d, pad, f) {
  const ageMin = d.createdAt ? (Date.now() - d.createdAt) / 60000 : null;
  const vol = d.volume ?? 0;
  const mcap = d.marketCap ?? 0;
  const stage = stageOf(d, pad);
  const results = [];

  const np = f.newPairs;
  if (np && stage !== 'graduated') {
    const checks = [
      { label: `age ≤ ${np.maxAgeMin}m`, ok: ageMin == null ? null : ageMin <= np.maxAgeMin },
      { label: `vol ≥ $${np.minVolume}`, ok: vol >= np.minVolume },
    ];
    results.push({ column: 'New Pairs', checks });
  }
  const fs = f.finalStretch;
  if (fs && stage !== 'graduated') {
    const checks = [
      { label: `mcap ≥ $${fs.minMcap}`, ok: mcap >= fs.minMcap },
      { label: `vol ≥ $${fs.minVolume}`, ok: vol >= fs.minVolume },
      { label: `age ≤ ${fs.maxAgeMin}m`, ok: ageMin == null ? null : ageMin <= fs.maxAgeMin },
    ];
    results.push({ column: 'Final Stretch', checks });
  }
  const gr = f.graduated;
  if (gr && stage !== 'curve') {
    const checks = [
      { label: 'graduated', ok: stage === 'graduated' ? true : null },
      { label: `fees ≥ ${gr.minFeesSol} SOL`, ok: d.feesSol == null ? null : d.feesSol >= gr.minFeesSol },
    ];
    results.push({ column: 'Graduated', checks });
  }

  // A column passes when no check fails; any unknown (null) check makes it a "likely" pass.
  const scored = results.map(r => ({
    ...r,
    pass: r.checks.some(c => c.ok === false) ? false : r.checks.some(c => c.ok === null) ? null : true,
  }));
  const best = scored.find(r => r.pass === true) || scored.find(r => r.pass === null) || scored[0] || null;
  return {
    pass: best ? best.pass : false,
    stage,
    column: best ? best.column : null,
    checks: best ? best.checks : [],
    all: scored,
  };
}

function activePreset(cfg) {
  const f = cfg.filters || {};
  const presets = { ...DEFAULT_PRESETS, ...(f.presets || {}) };
  const key = f.active || 'dvces';
  return presets[key] ? { key, ...presets[key] } : null;
}

module.exports = { checkCoin, stageOf, activePreset, DEFAULT_PRESETS };
