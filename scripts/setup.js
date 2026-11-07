// Runs before `npm start` / `npm run demo`: installs npm packages when they're missing or when
// package.json changed (e.g. after an auto-update), so starting Elixir stays a single step.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const want = crypto.createHash('sha1').update(JSON.stringify([pkg.dependencies, pkg.optionalDependencies])).digest('hex');
const stamp = path.join(root, 'node_modules', '.elixir-deps');
let have = '';
try { have = fs.readFileSync(stamp, 'utf8').trim(); } catch {}
const missing = !fs.existsSync(path.join(root, 'node_modules', '@anthropic-ai', 'sdk'));
if (missing || have !== want) {
  console.log(missing ? '  First run: installing packages (about a minute)…' : '  Updating packages…');
  try {
    execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: root, stdio: 'inherit' });
    fs.writeFileSync(stamp, want);
  } catch { console.log('  npm install had a problem. Elixir still starts; the Claude features or bundled ffmpeg may be missing.'); }
}
