const DEFAULTS = { enabled: true, sites: {}, bg: 12, text: 88, dimImages: false, autoDetect: true, sens: 75, adv: { bg: null, text: null, accent: null }, siteCfg: {} };
const LOOK = ['sens', 'bg', 'text', 'dimImages', 'adv']; // what "only this site" can change
const $ = (id) => document.getElementById(id);
let S = structuredClone(DEFAULTS);
let host = null;
let tabId = null;
let status = null;
let scope = 'all'; // which settings the sliders change: 'all' sites, or 'site' (only this one)

// what the Detection slider gives each fine value, when you haven't set it yourself (same math as content.js)
const derived = (sens) => ({
  bg: Math.round(((1 - (0.95 - sens / 100 * 0.65)) / 0.75) * 100),
  text: Math.round(((0.3 + sens / 100 * 0.4 - 0.2) / 0.6) * 100),
  accent: Math.round((sens <= 75 ? 0.75 : 0.75 * (100 - sens) / 25) * 100),
});
const own = () => (host && S.siteCfg[host]) || null;
const look = () => (scope === 'site' && own() ? { ...pickLook(S), ...own() } : pickLook(S)); // the values the sliders show
function pickLook(o) { const r = {}; for (const k of LOOK) r[k] = structuredClone(o[k]); return r; }

function save(patch) {
  Object.assign(S, patch);
  chrome.storage.local.set(patch);
  setTimeout(refreshStatus, 400);
}
// a change to the look: to all sites, or to this site's own settings
function saveLook(patch) {
  if (scope === 'site' && host) {
    const siteCfg = { ...S.siteCfg, [host]: { ...(own() || pickLook(S)), ...patch } };
    save({ siteCfg });
  } else save(patch);
}

function render() {
  $('enabled').checked = S.enabled;
  const L = look(), adv = L.adv || {}, d = derived(L.sens);
  $('sens').value = L.sens; $('sensOut').textContent = L.sens + '%';
  for (const [k, id] of [['bg', 'advBg'], ['text', 'advText'], ['accent', 'advAccent']]) {
    const v = adv[k] != null ? adv[k] : d[k];
    $(id).value = v; $(id + 'Out').textContent = v + '%';
    $(id).closest('.slider').classList.toggle('auto', adv[k] == null);
  }
  $('advReset').hidden = !['bg', 'text', 'accent'].some((k) => adv[k] != null);
  if (!['bg', 'text', 'accent'].some((k) => adv[k] == null)) $('advBox').open = true;
  $('bg').value = L.bg; $('bgOut').textContent = L.bg + '%';
  $('text').value = L.text; $('textOut').textContent = L.text + '%';
  $('dimImages').checked = L.dimImages;
  $('autoDetect').checked = S.autoDetect;
  $('host').textContent = host || 'Not available on this page';

  $('scopeSite').disabled = !host;
  $('scopeAll').setAttribute('aria-checked', String(scope === 'all'));
  $('scopeSite').setAttribute('aria-checked', String(scope === 'site'));
  $('scopeNote').textContent = scope === 'site' ? `Changes below apply to ${host} only.` : own() ? `${host} has its own settings: these don't change it.` : 'Changes below apply to every site.';
  $('siteReset').hidden = !(scope === 'site' && own());

  const site = $('site');
  site.disabled = !host || !S.enabled;
  const mode = host ? S.sites[host] : undefined;
  site.checked = !!host && mode !== 'off' && !(status && status.autoDark && mode !== 'on');

  let msg;
  if (!host) msg = "Not available here (Chrome pages, Web Store, or reload needed)";
  else if (!S.enabled) msg = 'Paused everywhere';
  else if (mode === 'off') msg = 'Off for this site';
  else if (!status) msg = 'Reload the page to activate';
  else if (status.autoDark) msg = 'Site already looks dark — skipped';
  else if (status.active) msg = own() ? 'Dark mode on · its own settings' : 'Dark mode on';
  else msg = 'Off';
  $('status').textContent = msg;
}

// The page's content script reports its own host, so the popup needs no "tabs" permission
// and never sees full URLs. No reply => a page Chrome doesn't let extensions run on.
async function refreshStatus() {
  status = null;
  if (tabId != null) {
    try { status = await chrome.tabs.sendMessage(tabId, { type: 'ldm-status' }, { frameId: 0 }); } catch { status = null; }
  }
  if (status && typeof status.host === 'string') host = status.host;
  render();
}

(async () => {
  const got = await chrome.storage.local.get(DEFAULTS);
  S = { ...structuredClone(DEFAULTS), ...got };
  if (!S.adv || typeof S.adv !== 'object') S.adv = { bg: null, text: null, accent: null };
  if (!S.siteCfg || typeof S.siteCfg !== 'object') S.siteCfg = {};
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) tabId = tab.id;
  await refreshStatus();
  if (own()) scope = 'site'; // a site with its own settings opens on them
  render();
})();

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));

$('site').addEventListener('change', (e) => {
  const sites = { ...S.sites };
  if (!e.target.checked) sites[host] = 'off';
  else if (status && status.autoDark) sites[host] = 'on'; // force on a site that looked dark
  else delete sites[host];
  save({ sites });
});

$('scopeAll').addEventListener('click', () => { scope = 'all'; render(); });
$('scopeSite').addEventListener('click', () => { if (host) { scope = 'site'; render(); } });
$('siteReset').addEventListener('click', () => { const siteCfg = { ...S.siteCfg }; delete siteCfg[host]; save({ siteCfg }); scope = 'all'; render(); });

let t = null;
for (const id of ['sens', 'bg', 'text']) {
  $(id).addEventListener('input', (e) => {
    const v = +e.target.value;
    $(id + 'Out').textContent = v + '%';
    if (id === 'sens') { const L = look(); L.sens = v; const adv = L.adv || {}, d = derived(v); for (const [k, i2] of [['bg', 'advBg'], ['text', 'advText'], ['accent', 'advAccent']]) if (adv[k] == null) { $(i2).value = d[k]; $(i2 + 'Out').textContent = d[k] + '%'; } }
    clearTimeout(t);
    t = setTimeout(() => saveLook({ [id]: v }), 150);
  });
}
for (const [k, id] of [['bg', 'advBg'], ['text', 'advText'], ['accent', 'advAccent']]) {
  $(id).addEventListener('input', (e) => {
    const v = +e.target.value;
    $(id + 'Out').textContent = v + '%';
    $(id).closest('.slider').classList.remove('auto');
    $('advReset').hidden = false;
    clearTimeout(t);
    t = setTimeout(() => saveLook({ adv: { ...(look().adv || {}), [k]: v } }), 150);
  });
}
$('advReset').addEventListener('click', () => { saveLook({ adv: { bg: null, text: null, accent: null } }); render(); });
$('dimImages').addEventListener('change', (e) => saveLook({ dimImages: e.target.checked }));
$('autoDetect').addEventListener('change', (e) => save({ autoDetect: e.target.checked }));
