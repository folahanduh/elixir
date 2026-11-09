// Elixir Mascot extension: hotkeys → the tab's mascot; research requests → the Elixir app on this PC.
// The extension talks only to http://localhost:8787 (your own Elixir). Nothing goes anywhere else.

const BASES = ['http://localhost:8787', 'http://127.0.0.1:8787'];

chrome.commands.onCommand.addListener(async cmd => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: cmd }).catch(() => {});
});
chrome.action.onClicked.addListener(tab => { if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'snip' }).catch(() => {}); });

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
