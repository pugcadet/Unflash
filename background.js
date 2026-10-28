// Unflash — background service worker.
// Only handles first-run defaults and the keyboard shortcut. It makes no network requests
// (and couldn't: the manifest CSP sets connect-src 'none').

const DEFAULTS = { enabled: true, sites: {}, bg: 12, text: 88, dimImages: false, autoDetect: true, sens: 75, adv: { bg: null, text: null, accent: null }, siteCfg: {} };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const missing = {};
  for (const k of Object.keys(DEFAULTS)) if (!(k in cur)) missing[k] = DEFAULTS[k];
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'toggle-site') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;

  // Ask the page's content script for its host + state (so we need no "tabs" permission).
  let status = null;
  try { status = await chrome.tabs.sendMessage(tab.id, { type: 'ldm-status' }, { frameId: 0 }); } catch { return; }
  if (!status || typeof status.host !== 'string') return;

  const { sites = {} } = await chrome.storage.local.get('sites');
  const patch = {};
  if (status.active) sites[status.host] = 'off';
  else { sites[status.host] = 'on'; patch.enabled = true; }
  patch.sites = sites;
  await chrome.storage.local.set(patch);
});
