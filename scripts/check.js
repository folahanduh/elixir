// Smoke test used by CI (`npm run check`): syntax-check every file, run a few unit checks,
// then boot the server in demo mode on a spare port and load both pages.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git'].includes(f.name)) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(ROOT);
for (const f of files) execFileSync(process.execPath, ['--check', f]);
console.log(`syntax ok (${files.length} files)`);

// Wallet import: Axiom export with batch headers, duplicates and junk.
const { parseWalletList } = require('../lib/kols');
const A = n => (n + 'x'.repeat(44)).slice(0, 44).replace(/[0OIl]/g, 'x');
const list = parseWalletList(`===== BATCH 1 =====
[{"trackedWalletAddress":"${A('One')}","name":"Alpha","emoji":"👻","alertsOnToast":false,"groups":["Main"],"highlightColor":"#ff8800"}]
===== BATCH 2 =====
{"trackedWalletAddress":"${A('Two')}","name":"Beta","emoji":"🐸"},{"trackedWalletAddress":"${A('One')}","name":"Alpha 2"},{"trackedWalletAddress":"nope","name":"x"}`);
assert.equal(list.length, 2);
assert.equal(list.find(w => w.wallet === A('One')).name, 'Alpha 2');
assert.equal(list.find(w => w.wallet === A('One')).toast, false);
assert.equal(list.find(w => w.wallet === A('One')).color, '#ff8800');
console.log('wallet import ok');

// Word extraction.
const { extractCandidates } = require('../lib/extract');
const words = extractCandidates('my dog Sir Woofington just learned to skateboard $WOOF').map(c => c.display.replace(/^\$/, '').toLowerCase());
assert(words.includes('woof') && words.some(w => w.includes('woofington')), 'extract: ' + words.join(','));
console.log('extraction ok');

// Boot the demo server on a spare port and load the pages.
const port = 18000 + Math.floor(Math.random() * 1000);
const tmpCfg = !fs.existsSync(path.join(ROOT, 'config.json'));
const srv = spawn(process.execPath, ['server.js', '--demo'], { cwd: ROOT, env: { ...process.env, PORT: String(port), NO_OPEN: '1', DEMO_TWEETS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const done = code => { srv.kill(); if (tmpCfg) try { fs.unlinkSync(path.join(ROOT, 'config.json')); } catch {} process.exit(code); };
setTimeout(() => { console.error('server did not start in 15 s'); done(1); }, 15000).unref();
srv.stdout.on('data', async d => {
  if (!String(d).includes('Elixir →')) return;
  try {
    for (const p of ['/api/ping', '/', '/streams.html', '/shell.js', '/kol.js', '/logo.svg', '/logo-512.png', '/settings.html', '/settings.js', '/settings.css', '/plays.html', '/plays.js', '/plays.css', '/whales.html', '/whales.js', '/whales.css', '/bubblemap.js']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 200, p);
    }
    console.log('server ok');
    done(0);
  } catch (e) { console.error(e.message); done(1); }
});
