// Elixir Mascot extension: hotkeys → the tab's mascot; research requests → the Elixir app on this PC.
// The extension talks only to http://localhost:8787 (your own Elixir). Nothing goes anywhere else.

const BASES = ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://penguin.linux.test:8787']; // last one: Chromebook Linux

// Put the mascot into a tab (pages opened before the extension was installed don't have it yet).
const canRun = url => /^(https?|file):/.test(url || '') && !/^https:\/\/chrome(webstore)?\.google\.com\//.test(url);
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return true; } catch { return false; }
}
// Send to the tab's mascot; if it isn't there yet, add it first.
async function tell(tab, msg) {
  if (!tab?.id || !canRun(tab.url)) return;
  try { await chrome.tabs.sendMessage(tab.id, msg); }
  catch { if (await inject(tab.id)) setTimeout(() => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}), 150); }
}
// Right after install / reload: add the mascot to every tab that's already open.
chrome.runtime.onInstalled.addListener(async () => {
  for (const t of await chrome.tabs.query({})) if (canRun(t.url)) inject(t.id);
});
chrome.commands.onCommand.addListener(async cmd => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tell(tab, { type: cmd });
});
chrome.action.onClicked.addListener(tab => tell(tab, { type: 'snip' }));

let lastGood = null;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'lens') return;
  (async () => {
    const order = lastGood ? [lastGood, ...BASES.filter(b => b !== lastGood)] : BASES; // the one that worked last time first
    for (const base of order) {
      try {
        const r = await fetch(base + '/api/lens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.input), signal: AbortSignal.timeout(45000) });
        const j = await r.json();
        lastGood = base;
        reply(r.ok ? { ok: true, data: j, base } : { ok: false, error: j.error || 'Elixir returned an error' });
        maybeUpdate(j.extVersion);
        return;
      } catch {}
    }
    reply({ ok: false, offline: true, error: 'Elixir isn\'t running. Start it (start.bat / start.sh), then try again.' });
  })();
  return true; // async reply
});

// ---------- auto-update ----------
// Elixir updates itself from GitHub, and that brings new extension files into its "extension" folder.
// When Elixir has a newer version than the one running, reload: Chrome then loads the new files, and the
// mascot is put back into every open tab (onInstalled above). Checked after each answer and every minute.
const newer = (a, b) => { const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let reloading = false;
function maybeUpdate(v) {
  if (reloading || !v || !newer(v, chrome.runtime.getManifest().version)) return;
  reloading = true;
  setTimeout(() => chrome.runtime.reload(), 400); // after the answer has been delivered
}
async function checkForUpdate() {
  const order = lastGood ? [lastGood, ...BASES.filter(b => b !== lastGood)] : BASES;
  for (const base of order) {
    try {
      const r = await fetch(base + '/api/ext-version', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      lastGood = base;
      return maybeUpdate((await r.json()).version);
    } catch {}
  }
}
chrome.alarms?.create('elixir-update', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(a => { if (a.name === 'elixir-update') checkForUpdate(); });
chrome.runtime.onStartup?.addListener(checkForUpdate);
checkForUpdate();
