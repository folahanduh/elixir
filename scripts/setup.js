// Runs before `npm start` / `npm run demo`: installs npm packages when they're missing or when
// package.json changed (e.g. after an auto-update), so starting Elixir stays a single step.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');

// Safety net: update before the server starts, so a broken version can always be replaced by
// simply starting Elixir again (the server's own updater can't run if the server can't start).
function justUpdated() {
  // The server writes this right before it restarts into a new version: no need to check again.
  try { return Date.now() - Number(fs.readFileSync(path.join(root, 'data', '.just-updated'), 'utf8')) < 5 * 60000; } catch { return false; }
}
function wantsUpdate() {
  if (justUpdated()) return false;
  if (process.env.CI || process.env.ELIXIR_NO_UPDATE || process.argv.includes('--no-update')) return false;
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).autoUpdate !== false; } catch { return true; }
}
(async () => {
if (wantsUpdate()) {
  try {
    const up = require('../lib/update');
    const st = await up.check({ fresh: true, timeoutMs: 6000 }); // don't hold up the start on a slow connection
    if (st.behind) {
      console.log('  Updating Elixir before starting…');
      const r = await up.apply();
      console.log('  ' + (r.ok ? r.msg : 'Update skipped: ' + r.msg));
    }
  } catch (e) { console.log('  Update check failed: ' + e.message); }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const want = crypto.createHash('sha1').update(JSON.stringify([pkg.dependencies, pkg.optionalDependencies])).digest('hex');
const stamp = path.join(root, 'node_modules', '.elixir-deps');
let have = '';
try { have = fs.readFileSync(stamp, 'utf8').trim(); } catch {}
const missing = !fs.existsSync(path.join(root, 'node_modules', '@anthropic-ai', 'sdk'));
// One background install at a time: an install still running from a moment ago isn't started twice.
const lock = path.join(root, 'data', '.npm-installing');
let busy = false;
try { busy = Date.now() - fs.statSync(lock).mtimeMs < 10 * 60000; } catch {}
if ((missing || have !== want) && !busy) {
  // Elixir doesn't need these packages to open (Claude features and the bundled ffmpeg load when ready),
  // so install them in the background and let the page open straight away.
  console.log(missing ? '  First run: installing extra packages in the background…' : '  Updating packages in the background…');
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const log = fs.openSync(path.join(root, 'data', 'npm-install.log'), 'w');
    fs.writeFileSync(lock, String(Date.now()));
    // A small detached node process runs npm and writes the "installed" stamp when it finishes. (Before,
    // this script exited first, the stamp was never written, and every start ran npm install again.)
    const job = `const {spawnSync}=require('child_process'),fs=require('fs');
      const r=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['install','--no-audit','--no-fund','--loglevel=error'],{cwd:${JSON.stringify(root)},stdio:'inherit',shell:process.platform==='win32'});
      if(r.status===0){try{fs.mkdirSync(${JSON.stringify(path.dirname(stamp))},{recursive:true});fs.writeFileSync(${JSON.stringify(stamp)},${JSON.stringify(want)})}catch{}}
      try{fs.unlinkSync(${JSON.stringify(lock)})}catch{}`;
    const child = require('child_process').spawn(process.execPath, ['-e', job], { cwd: root, stdio: ['ignore', log, log], detached: true, windowsHide: true });
    child.unref();
    try { require('os').setPriority(child.pid, 10); } catch {} // low priority: never slows the computer down
  } catch {
    try { execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: root, stdio: 'inherit' }); fs.writeFileSync(stamp, want); } catch {}
  }
}
})();
