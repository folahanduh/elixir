// Auto-update from GitHub. Checked when Elixir starts and every time the page is opened or refreshed.
//   git checkout: git fetch + git pull --ff-only (never touches your own changes; reports them instead)
//   ZIP download: downloads the latest source and copies it over, keeping .env, config.json, data/, bin/
// Then Elixir restarts itself and the page reloads. Turn off with "autoUpdate": false in config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, '.elixir-version');
const KEEP = new Set(['.env', 'config.json', 'data', 'bin', 'node_modules', '.git', '.elixir-version']);
const isGit = () => fs.existsSync(path.join(ROOT, '.git'));

function slug() {
  try {
    const r = require('../package.json').repository || '';
    return String(typeof r === 'string' ? r : r.url || '').replace(/^github:/, '').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
  } catch { return ''; }
}

function git(args, timeout = 30000) {
  return new Promise(resolve => {
    // core.fileMode=false: a chmod +x on start.sh isn't a "local change"
    execFile('git', ['-c', 'core.fileMode=false', ...args], { cwd: ROOT, timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
  });
}

async function current() {
  if (isGit()) { const r = await git(['rev-parse', 'HEAD']); return r.ok ? r.out : null; }
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() || null; } catch { return null; }
}

let cache = null;
/** {current, latest, behind, method, error?} */
async function check({ fresh = false, timeoutMs = 45000 } = {}) {
  // git fetch is cheap, so every refresh really checks; ZIP installs ask the GitHub API (60 calls/hour limit).
  if (!fresh && cache && Date.now() - cache.at < (isGit() ? 5000 : 60000)) return cache.result;
  const repo = slug();
  let result;
  try {
    if (isGit()) {
      const f = await git(['fetch', '--quiet', 'origin', 'main'], timeoutMs);
      if (!f.ok) throw new Error('git fetch failed: ' + f.err.split('\n')[0]);
      const behind = Number((await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).out) || 0;
      const latest = (await git(['rev-parse', 'FETCH_HEAD'])).out;
      result = { method: 'git', current: await current(), latest, behind: behind > 0, commits: behind };
    } else {
      if (!repo) throw new Error('no repository in package.json');
      const r = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
        headers: { accept: 'application/vnd.github.sha', 'user-agent': 'elixir-updater' }, signal: AbortSignal.timeout(Math.min(10000, timeoutMs)),
      });
      if (!r.ok) throw new Error('GitHub ' + r.status);
      const latest = (await r.text()).trim();
      const cur = await current();
      result = { method: 'zip', current: cur, latest, behind: cur !== latest };
    }
  } catch (e) {
    result = { method: isGit() ? 'git' : 'zip', current: await current(), latest: null, behind: false, error: e.message };
  }
  cache = { at: Date.now(), result };
  return result;
}

function copyOver(src, dst) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (dst === ROOT && KEEP.has(ent.name)) continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyOver(s, d); }
    else { fs.copyFileSync(s, d); try { fs.chmodSync(d, fs.statSync(s).mode); } catch {} }
  }
}

/** Install the latest version. Returns {ok, msg}. */
async function apply() {
  let stashed = null;
  const st = await check({ fresh: true });
  if (st.error) return { ok: false, msg: st.error };
  if (!st.behind) return { ok: false, msg: 'already up to date' };
  if (st.method === 'git') {
    // Files people edit by hand (keys typed into .env.example, the example config, start scripts):
    // keep any keys in a git-ignored file, then put the tracked file back so the update can go through.
    const SAFE = ['.env.example', 'config.example.json', 'start.sh', 'start.command', 'start.bat', 'demo.bat', 'demo.command', 'package-lock.json'];
    let changed = (await git(['diff', '--name-only', 'HEAD'])).out.split('\n').map(l => l.trim()).filter(Boolean);
    const blocking = changed.filter(f => !SAFE.includes(f));
    if (blocking.length) {
      // Edits to Elixir's own files used to stop every update. Set them aside (git stash: nothing is lost) and go on.
      const r0 = await git(['stash', 'push', '-m', `Elixir auto-update ${new Date().toISOString().slice(0, 16)}: your edits`, '--', ...blocking]);
      if (!r0.ok) return { ok: false, msg: `you changed Elixir's own files (${blocking.slice(0, 3).join(', ')}) and they couldn't be set aside: ${r0.err.split('\n')[0]}` };
      stashed = blocking;
      changed = changed.filter(f => SAFE.includes(f));
    }
    if (changed.includes('.env.example')) {
      try { require('./keys').loadKeys(ROOT); } catch {} // copies any keys in it into .env first
      const kept = path.join(ROOT, '.env.example.local');
      try { fs.copyFileSync(path.join(ROOT, '.env.example'), kept); } catch {}
    }
    if (changed.length) await git(['checkout', '--', ...changed]);
    let r = await git(['merge', '--ff-only', 'FETCH_HEAD'], 60000);
    if (!r.ok && /fast-forward|diverg|unrelated/i.test(r.err)) {
      // The history on GitHub was rewritten (same files, re-signed commits). If what you have is exactly one
      // of its versions (no commits of your own), move onto the new history.
      const mine = (await git(['rev-parse', 'HEAD^{tree}'])).out;
      const theirs = (await git(['log', '--format=%T', 'FETCH_HEAD'], 60000)).out.split('\n');
      if (mine && theirs.includes(mine)) r = await git(['reset', '--hard', 'FETCH_HEAD'], 60000);
    }
    if (!r.ok) return { ok: false, msg: /overwritten|local changes|not possible/i.test(r.err) ? 'you have local changes to Elixir\'s files; run "git status" to see them' : r.err.split('\n')[0] };
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-update-'));
    try {
      const r = await fetch(`https://codeload.github.com/${slug()}/tar.gz/refs/heads/main`, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('download failed: HTTP ' + r.status);
      const tgz = path.join(tmp, 'src.tgz');
      fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
      await new Promise((res, rej) => execFile('tar', ['-xzf', tgz, '-C', tmp], { windowsHide: true }, e => (e ? rej(new Error('unpacking failed: ' + e.message)) : res())));
      const top = fs.readdirSync(tmp, { withFileTypes: true }).find(d => d.isDirectory());
      if (!top || !fs.existsSync(path.join(tmp, top.name, 'server.js'))) throw new Error('download looks wrong');
      copyOver(path.join(tmp, top.name), ROOT);
      fs.writeFileSync(VERSION_FILE, st.latest + '\n');
    } catch (e) {
      return { ok: false, msg: e.message };
    } finally {
      fs.rm(tmp, { recursive: true, force: true }, () => {});
    }
  }
  cache = null;
  return { ok: true, msg: `updated to ${String(st.latest).slice(0, 7)}${stashed ? ` (your edits to ${stashed.slice(0, 3).join(', ')} were set aside: "git stash list" / "git stash pop" to get them back)` : ''}` };
}

module.exports = { check, apply, current };
