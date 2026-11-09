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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'lens') return;
  (async () => {
    for (const base of BASES) {
      try {
        const r = await fetch(base + '/api/lens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.input), signal: AbortSignal.timeout(45000) });
        const j = await r.json();
        return reply(r.ok ? { ok: true, data: j, base } : { ok: false, error: j.error || 'Elixir returned an error' });
      } catch {}
    }
    reply({ ok: false, offline: true, error: 'Elixir isn\'t running. Start it (start.bat / start.sh), then try again.' });
  })();
  return true; // async reply
});
