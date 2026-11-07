// Finds ffmpeg and yt-dlp so stream capture works without installing anything by hand:
//   ffmpeg: the system one if present, otherwise the copy bundled by the ffmpeg-static npm package.
//   yt-dlp: the system one if present, otherwise the official standalone build downloaded once into ./bin
//           (kept up to date with `yt-dlp -U`, since sites change often).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin');
const works = (cmd, flag) => {
  try { return spawnSync(cmd, [flag], { stdio: 'ignore', timeout: 8000 }).status === 0; } catch { return false; }
};

let ff = null, yt = null;
function ffmpeg() {
  if (ff) return ff;
  if (works('ffmpeg', '-version')) return (ff = 'ffmpeg');
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return (ff = p); } catch {}
  return 'ffmpeg'; // missing: the caller reports "not installed"
}

const ytName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const ytLocal = path.join(BIN, ytName);
function ytdlp() {
  if (yt) return yt;
  if (works('yt-dlp', '--version')) return (yt = 'yt-dlp');
  if (fs.existsSync(ytLocal)) return (yt = ytLocal);
  return 'yt-dlp';
}

/** The official release asset for this computer. */
function ytAsset() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

/** Download yt-dlp if neither a system copy nor ./bin has one. Updates the local copy weekly. Never throws. */
async function ensureTools(log = console.log) {
  if (works('yt-dlp', '--version')) return;
  try {
    if (fs.existsSync(ytLocal)) {
      const age = Date.now() - fs.statSync(ytLocal).mtimeMs;
      if (age > 7 * 86400000) {
        const p = spawn(ytLocal, ['-U'], { stdio: 'ignore' });
        p.on('close', () => { try { fs.utimesSync(ytLocal, new Date(), new Date()); } catch {} });
        p.on('error', () => {});
      }
      return;
    }
    log('  Setting up yt-dlp for stream capture (one-time download)…');
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytAsset()}`, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1e6) throw new Error('download looks incomplete');
    fs.mkdirSync(BIN, { recursive: true });
    fs.writeFileSync(ytLocal + '.part', buf, { mode: 0o755 });
    fs.renameSync(ytLocal + '.part', ytLocal);
    yt = null;
    log('  yt-dlp ready.');
  } catch (e) {
    log(`  Couldn't download yt-dlp (${e.message}). Stream links need it: see README → Live streams.`);
  }
}

module.exports = { ffmpeg, ytdlp, ensureTools, works };
