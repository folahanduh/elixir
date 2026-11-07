// Runs before `npm start` / `npm run demo`: installs the npm packages once if they're missing,
// so starting Elixir is a single step. Safe to run every time (it's a no-op once installed).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');
const need = ['@anthropic-ai/sdk'].filter(p => !fs.existsSync(path.join(root, 'node_modules', p)));
const optional = !fs.existsSync(path.join(root, 'node_modules', 'ffmpeg-static'));
if (need.length || optional) {
  console.log('  First run: installing packages (about a minute)…');
  try { execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: root, stdio: 'inherit' }); }
  catch { console.log('  npm install had a problem. Elixir still starts; the Claude features or bundled ffmpeg may be missing.'); }
}
