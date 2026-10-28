// Unflash — content script.
// How it works (same idea as Dark Reader's "dynamic" mode, kept small):
//  1. For every stylesheet on the page, generate a "mirror" stylesheet with the same
//     selectors, containing only recolored color properties, inserted right after the
//     original. Because selectors/order/importance match, the cascade, :hover states etc.
//     keep working. CSS variables that hold colors are recolored too.
//  2. A sweep over the elements catches what stylesheets can't (inline styles, JS-set colors):
//     bright backgrounds -> dark grey, dark text -> light grey, bright borders -> soft grey.
//  3. A MutationObserver + light polling keep up with dynamic pages.
//
// Local-only by design: this script makes NO network requests, never reads page text or
// form data (only computed colors), and never sends messages anywhere except answering
// the extension's own popup. Cross-origin stylesheets (which pages can't read) are handled
// by the element sweep instead of being re-downloaded.
(() => {
  'use strict';
  // Content scripts run in an isolated world: this flag is invisible to the page.
  if (window.__localDark) return;
  window.__localDark = true;

  // adv: fine detection (null = follows the Detection slider): bg = darken backgrounds lighter than this,
  // text = lighten text darker than this, accent = keep colored areas (buttons, badges) darker than this.
  // siteCfg: a site's own look and detection, used instead of the global one there.
  const DEFAULTS = { enabled: true, sites: {}, bg: 12, text: 88, dimImages: false, autoDetect: true, sens: 75, adv: { bg: null, text: null, accent: null }, siteCfg: {} };
  const HOST = location.hostname || 'local-file';
  const ours = new WeakSet(); // our <style> nodes (no marker attribute => harder for pages to fingerprint)
  const isOurs = (n) => ours.has(n);

  let S = { ...DEFAULTS };
  let active = false;
  let autoDark = false;

  // ───────────────────────── color math ─────────────────────────
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const r1 = (x) => Math.round(x * 10) / 10;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => clamp(Math.round(v * 255), 0, 255));
  }

  // Perceptual lightness (CIE L*, 0..1) — better than HSL for "is this bright?"
  function lstar(r, g, b) {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return (y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16) / 100;
  }

  // Detection thresholds, driven by the "Detection" slider (0 = only pure white/black,
  // 100 = also mid-tone and colored areas). Values are perceptual lightness (L*, 0..1).
  const TH = { bgMin: 0.46, accentMax: 0.75, textMax: 0.6 };
  function updateThresholds() {
    const k = S.sens / 100, a = S.adv || {};
    TH.bgMin = a.bg != null ? 1 - a.bg / 100 * 0.75 : 0.95 - k * 0.65;   // 0: >=0.95   75: >=0.46   100: >=0.30
    TH.accentMax = a.accent != null ? a.accent / 100 : S.sens <= 75 ? 0.75 : 0.75 * (100 - S.sens) / 25; // above 75, darken accents too
    TH.textMax = a.text != null ? 0.2 + a.text / 100 * 0.6 : 0.3 + k * 0.4; // 0: <=0.30   75: <=0.60   100: <=0.70
  }

  const NEUTRAL_HUE = 220; // greys get a tiny cool tint: "nice" dark grey instead of flat black

  // role: 'bg' | 'text' | 'border' | 'icon'. Returns new [r,g,b] or null (leave as is).
  function transformRGB(r, g, b, role) {
    const L = lstar(r, g, b);
    const [h, s0] = rgbToHsl(r, g, b);
    // HSL saturation explodes near white and black (#f0f0fe reads as 87% saturated): cap it by the color's
    // real chroma, so a barely-tinted white becomes a barely-tinted grey instead of navy
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const s = Math.min(s0, chroma * 2.2);
    const grey = s < 0.12;
    const base = S.bg / 100, text = S.text / 100;
    let ns, nl;
    if (role === 'bg') {
      if (L < TH.bgMin) return null;                    // dark enough already (slider decides)
      if (s > 0.55 && L < TH.accentMax) return null;    // saturated accent (buttons, badges) — keep
      nl = base + (1 - L) * 0.25;                       // white -> base, light grey -> slightly lighter
      ns = grey ? 0.07 : s * 0.5;
    } else if (role === 'text') {
      if (L > TH.textMax) return null;                  // light enough already
      nl = grey ? text - L * 0.25 : Math.min(text, 0.8) - L * 0.1;
      ns = grey ? 0.06 : Math.min(1, s * 0.9);          // colored text (links) keeps its hue
    } else if (role === 'border') {
      if (L < TH.bgMin + 0.05) return null;
      nl = base + 0.1 + (1 - L) * 0.15;
      ns = grey ? 0.06 : s * 0.4;
    } else if (role === 'icon') {                       // SVG fill/stroke: only recolor grey/black ones
      if (L > TH.textMax || !grey) return null;
      nl = text - L * 0.25;
      ns = 0.06;
    } else return null;
    const out = hslToRgb(grey ? NEUTRAL_HUE : h, ns, clamp(nl, 0, 1));
    if (produced.size < 4000) produced.add(out.join(','));
    return out;
  }

  // Every color we output — lets us tell "we darkened this" from "the site was already dark"
  // without switching our styles off (which would force a full page restyle).
  const produced = new Set();
  function isProduced(r, g, b) {
    if (produced.has(`${r},${g},${b}`)) return true;
    for (const k of produced) { // hsl() round-trips can be off by one
      const [pr, pg, pb] = k.split(',');
      if (Math.abs(pr - r) <= 2 && Math.abs(pg - g) <= 2 && Math.abs(pb - b) <= 2) return true;
    }
    return false;
  }

  const toHex = (t) => '#' + t.map((v) => v.toString(16).padStart(2, '0')).join('');
  const cssRgb = (t) => `rgb(${t[0]}, ${t[1]}, ${t[2]})`;

  const NAMED = {
    white: [255, 255, 255], black: [0, 0, 0], whitesmoke: [245, 245, 245], snow: [255, 250, 250],
    ivory: [255, 255, 240], ghostwhite: [248, 248, 255], aliceblue: [240, 248, 255], azure: [240, 255, 255],
    seashell: [255, 245, 238], linen: [250, 240, 230], floralwhite: [255, 250, 240], oldlace: [253, 245, 230],
    mintcream: [245, 255, 250], honeydew: [240, 255, 240], lavenderblush: [255, 240, 245], beige: [245, 245, 220],
    cornsilk: [255, 248, 220], gainsboro: [220, 220, 220], lightgray: [211, 211, 211], lightgrey: [211, 211, 211],
    silver: [192, 192, 192], darkgray: [169, 169, 169], darkgrey: [169, 169, 169], gray: [128, 128, 128],
    grey: [128, 128, 128], dimgray: [105, 105, 105], dimgrey: [105, 105, 105], lightyellow: [255, 255, 224],
    lavender: [230, 230, 250], navy: [0, 0, 128],
  };
  const NAMED_ALT = Object.keys(NAMED).sort((a, b) => b.length - a.length).join('|');
  // Matches the *head* of rgb()/hsl() (channels only, so "/ alpha)" or ", a)" is preserved),
  // hex colors, and common light/grey named colors.
  const TOKEN_SRC =
    String.raw`(rgba?|hsla?)\(\s*(-?[\d.]+)(deg|turn|rad)?(\s*,\s*|\s+)(-?[\d.]+%?)(\s*,\s*|\s+)(-?[\d.]+%?)` +
    String.raw`|#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b` +
    String.raw`|(?<![\w-])(` + NAMED_ALT + String.raw`)(?![\w-])`;
  const TOKEN_RE = new RegExp(TOKEN_SRC, 'gi');

  function matchToRgb(m) {
    const [, fn, a, unit, , b, , c, hex, named] = m;
    if (fn) {
      const pct = (v, max) => (v.endsWith('%') ? (parseFloat(v) / 100) * max : parseFloat(v));
      if (fn.toLowerCase().startsWith('rgb')) return [pct(a, 255), pct(b, 255), pct(c, 255)].map((v) => clamp(Math.round(v), 0, 255));
      let h = parseFloat(a);
      if (unit === 'turn') h *= 360; else if (unit === 'rad') h = (h * 180) / Math.PI;
      return hslToRgb(h, clamp(parseFloat(b) / 100, 0, 1), clamp(parseFloat(c) / 100, 0, 1));
    }
    if (hex) {
      let x = hex;
      if (x.length <= 4) x = x.split('').map((ch) => ch + ch).join('');
      return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
    }
    return NAMED[named.toLowerCase()];
  }

  // Recolor every color token in a CSS value. Returns new string, or null if nothing changed.
  function transformValue(value, role) {
    if (!value || value.includes('url(')) return null;
    let changed = false;
    const out = value.replace(TOKEN_RE, (...m) => {
      const rgb = matchToRgb(m);
      const t = rgb && transformRGB(rgb[0], rgb[1], rgb[2], role);
      if (!t) return m[0];
      changed = true;
      const [, fn, , , s1, , s2, , hex] = m;
      if (fn) {
        if (fn.toLowerCase().startsWith('rgb')) return `${fn}(${t[0]}${s1}${t[1]}${s2}${t[2]}`;
        const [h, s, l] = rgbToHsl(...t);
        return `${fn}(${r1(h)}${s1}${r1(s * 100)}%${s2}${r1(l * 100)}%`;
      }
      const alpha = hex && hex.length === 8 ? hex.slice(6) : hex && hex.length === 4 ? hex[3] + hex[3] : '';
      return toHex(t) + alpha;
    });
    return changed ? out : null;
  }

  // Pages repeat the same few color strings thousands of times — cache results.
  const tCache = new Map();
  function tv(value, role) {
    const k = role + '|' + value;
    let r = tCache.get(k);
    if (r === undefined) {
      r = transformValue(value, role);
      if (tCache.size > 5000) tCache.clear();
      tCache.set(k, r);
    }
    return r;
  }

  // Defense in depth: anything we write into CSS must be a plain value.
  const SAFE_VALUE = /^[^{}<>;\\]*$/;

  function firstRgb(value) {
    TOKEN_RE.lastIndex = 0;
    const m = TOKEN_RE.exec(value);
    TOKEN_RE.lastIndex = 0;
    return m ? matchToRgb(m) : null;
  }

  function isSingleColor(value) {
    if (value.includes('var(')) return false;
    const marked = value.trim().replace(TOKEN_RE, '\u0000');
    return marked.split('\u0000').length === 2 && /^\u0000(\s*[,/]\s*[\d.]+%?)?\s*\)?$/.test(marked);
  }

  // ─────────────────── CSS variable role detection ───────────────────
  const PROP_ROLE = {
    'background-color': 'bg', 'background-image': 'bg', background: 'bg',
    color: 'text', '-webkit-text-fill-color': 'text', 'caret-color': 'text', 'text-decoration-color': 'text',
    'border-color': 'border', 'border-top-color': 'border', 'border-right-color': 'border',
    'border-bottom-color': 'border', 'border-left-color': 'border', border: 'border', 'border-top': 'border',
    'border-right': 'border', 'border-bottom': 'border', 'border-left': 'border', 'outline-color': 'border',
    outline: 'border', 'column-rule-color': 'border', fill: 'icon', stroke: 'icon',
  };
  // Longhands we actually emit overrides for
  const EMIT_ROLE = {
    'background-color': 'bg', 'background-image': 'bg', color: 'text', '-webkit-text-fill-color': 'text',
    'caret-color': 'text', 'text-decoration-color': 'text', 'border-top-color': 'border',
    'border-right-color': 'border', 'border-bottom-color': 'border', 'border-left-color': 'border',
    'outline-color': 'border', 'column-rule-color': 'border', fill: 'icon', stroke: 'icon',
  };
  const SHORTHANDS = ['background', 'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'outline'];

  const usage = new Map();   // --var -> Set(roles) where it's used
  const aliases = new Map(); // --b -> Set(--a) for "--a: var(--b)"
  const addSet = (map, k, v) => { let s = map.get(k); if (!s) map.set(k, (s = new Set())); s.add(v); };

  function scanStyle(style) {
    const check = (p, v) => {
      if (!v || v.indexOf('var(--') < 0) return;
      const names = [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
      if (p.startsWith('--')) { for (const n of names) addSet(aliases, n, p); return; }
      let role = PROP_ROLE[p];
      if (!role) return;
      if (role === 'icon') role = 'text';
      for (const n of names) addSet(usage, n, role);
    };
    for (let i = 0; i < style.length; i++) check(style[i], style.getPropertyValue(style[i]));
    for (const p of SHORTHANDS) check(p, style.getPropertyValue(p));
  }

  const scanned = new WeakSet(); // rules already looked at (CSS-in-JS sheets grow one rule at a time)
  function scanRules(rules) {
    for (const r of rules) {
      if (scanned.has(r)) continue;
      scanned.add(r);
      try {
        if (r.style) scanStyle(r.style);
        if (r instanceof CSSImportRule) { if (r.styleSheet) scanRules(r.styleSheet.cssRules); }
        else if (r.cssRules) scanRules(r.cssRules);
      } catch { /* cross-origin import etc. */ }
    }
  }

  function rolesOf(name, depth = 0, acc = new Set()) {
    const u = usage.get(name);
    if (u) u.forEach((r) => acc.add(r));
    if (depth < 4) { const al = aliases.get(name); if (al) al.forEach((a) => rolesOf(a, depth + 1, acc)); }
    return acc;
  }

  function pickRole(name, roles, rgb) {
    if (roles.size === 1) return [...roles][0];
    const n = name.toLowerCase();
    if (/(bg|background|surface|canvas|paper|card|panel|backdrop|popover|body|page|base|fill)/.test(n)) return 'bg';
    if (/(text|fg|foreground|font|ink|heading|title|link|content)/.test(n)) return 'text';
    if (/(border|divider|line|outline|separator|stroke|ring)/.test(n)) return 'border';
    return rgb && lstar(...rgb) > 0.5 ? 'bg' : 'text';
  }

  const RGB_CH = /^\s*(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})\s*$/;   // "255 255 255"
  const HSL_CH = /^\s*(-?[\d.]+)(deg)?\s+([\d.]+)%\s+([\d.]+)%\s*$/;               // "0 0% 100%" (shadcn)

  function transformVar(name, value) {
    const roles = rolesOf(name);
    const ch = value.match(RGB_CH), hs = !ch && value.match(HSL_CH);
    if (ch || hs) {
      if (!roles.size) return null; // channel triplets only when we've seen them used as colors
      const rgb = ch ? [+ch[1], +ch[3], +ch[5]] : hslToRgb(+hs[1], +hs[3] / 100, +hs[4] / 100);
      const t = transformRGB(...rgb, pickRole(name, roles, rgb));
      if (!t) return null;
      if (ch) return `${t[0]}${ch[2]}${t[1]}${ch[4]}${t[2]}`;
      const [h, s, l] = rgbToHsl(...t);
      return `${r1(h)}${hs[2] || ''} ${r1(s * 100)}% ${r1(l * 100)}%`;
    }
    if (!isSingleColor(value)) return null;
    const rgb = firstRgb(value);
    return transformValue(value, pickRole(name, roles, rgb));
  }

  // ─────────────────────── stylesheet mirroring ───────────────────────
  function transformDecls(style) {
    let out = '';
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      const v = style.getPropertyValue(p);
      if (!v) continue;
      let nv = null;
      if (p.startsWith('--')) nv = transformVar(p, v);
      else {
        const role = EMIT_ROLE[p];
        if (!role) continue;
        if (p === 'background-image' && !/gradient/i.test(v)) continue;
        nv = tv(v, role);
      }
      if (nv != null && SAFE_VALUE.test(nv)) out += `${p}:${nv}${style.getPropertyPriority(p) ? ' !important' : ''};`;
    }
    return out;
  }

  function prelude(rule) {
    if (rule instanceof CSSMediaRule) return '@media ' + rule.media.mediaText;
    if (rule instanceof CSSSupportsRule) return '@supports ' + rule.conditionText;
    if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) return '@layer ' + rule.name;
    if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) return '@container ' + rule.conditionText;
    const t = rule.cssText;
    return t.slice(0, t.indexOf('{')).trim();
  }

  // one recolored rule per top-level rule that needs one (as strings, so they can also be added one by one)
  function genList(rules) {
    const out = [];
    for (const rule of rules) { const t = genRules([rule]); if (t) out.push(t); }
    return out;
  }
  function genRules(rules) {
    let out = '';
    for (const rule of rules) {
      try {
        if (rule instanceof CSSStyleRule) {
          const d = transformDecls(rule.style);
          const inner = rule.cssRules && rule.cssRules.length ? genRules(rule.cssRules) : '';
          if (d || inner) out += `${rule.selectorText}{${d}${inner}}`;
        } else if (rule instanceof CSSImportRule) {
          let inner = '';
          try { if (rule.styleSheet) inner = genRules(rule.styleSheet.cssRules); } catch { markOpaque(); /* a cross-origin @import */ }
          const m = rule.media && rule.media.mediaText;
          if (inner) out += m ? `@media ${m}{${inner}}` : inner;
        } else if (typeof CSSNestedDeclarations !== 'undefined' && rule instanceof CSSNestedDeclarations) {
          out += transformDecls(rule.style);
        } else if (typeof CSSGroupingRule !== 'undefined' && rule instanceof CSSGroupingRule) {
          const inner = genRules(rule.cssRules);
          if (inner) out += `${prelude(rule)}{${inner}}`;
        }
        // @keyframes, @font-face, @page: skipped
      } catch { /* ignore odd rules */ }
    }
    return out;
  }

  function rulesOf(sheet) {
    try { return sheet.cssRules; } catch { return null; } // null => cross-origin (unreadable, by design)
  }

  const owners = new Map(); // <style>/<link> -> { mirror: HTMLStyleElement|null, count }
  const isOwner = (n) => n.nodeName === 'STYLE' || (n.nodeName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(n.rel || ''));

  function processOwner(owner) {
    if (!active || !owner.isConnected || isOurs(owner)) return;
    const sheet = owner.sheet;
    if (!sheet) {
      if (owner.nodeName === 'LINK') owner.addEventListener('load', () => queueOwner(owner), { once: true });
      if (!owners.has(owner)) owners.set(owner, { mirror: null, count: -1 });
      return;
    }
    const rules = rulesOf(sheet);
    if (!rules) { // cross-origin: leave it to the element sweep, no network access
      const rec = owners.get(owner) || { mirror: null, count: -1 };
      owners.set(owner, rec);
      // A stylesheet we can't read: the sweep looks at every element from now on (and, if this one
      // arrived after the first sweep, at the whole page again, the top part before it's painted).
      if (!rec.opaque) { rec.opaque = true; markOpaque(); }
      return;
    }
    const media = sheet.media && sheet.media.mediaText;
    const plain = !media || media === 'all';
    // CSS-in-JS (styled-components, emotion…) adds rules one by one at the end of the sheet: then only the new
    // rules are recolored and added to the mirror, instead of redoing the whole sheet for every new rule.
    const rec0 = owners.get(owner);
    if (plain && !sheet.disabled && rec0 && rec0.mirror && rec0.mirror.sheet && rec0.count > 0 && rules.length > rec0.count && rules[rec0.count - 1] === rec0.last) {
      const add = genList(Array.prototype.slice.call(rules, rec0.count));
      const ms = rec0.mirror.sheet;
      let okAll = true;
      for (const r of add) { try { ms.insertRule(r, ms.cssRules.length); } catch { okAll = false; break; } }
      if (okAll) { rec0.count = rules.length; rec0.last = rules[rules.length - 1]; if (rec0.mirror && owner.nextSibling !== rec0.mirror) owner.after(rec0.mirror); return; }
    }
    let css = sheet.disabled ? '' : genRules(rules);
    if (css && !plain) css = `@media ${media}{${css}}`;
    upsertMirror(owner, css, rules.length);
    const rec1 = owners.get(owner); if (rec1) rec1.last = rules.length ? rules[rules.length - 1] : null;
  }

  function upsertMirror(owner, css, count) {
    const rec = owners.get(owner) || { mirror: null, count: -1 };
    rec.count = count;
    if (!css) {
      if (rec.mirror) { rec.mirror.remove(); rec.mirror = null; }
    } else {
      if (!rec.mirror) { rec.mirror = document.createElement('style'); ours.add(rec.mirror); }
      if (rec.mirror.textContent !== css) rec.mirror.textContent = css;
      if (owner.nextSibling !== rec.mirror) owner.after(rec.mirror);
    }
    owners.set(owner, rec);
  }

  const ownerQueue = new Set();
  let ownerFlush = false;
  function queueOwner(o) {
    if (!active || isOurs(o)) return;
    ownerQueue.add(o);
    if (!ownerFlush) { ownerFlush = true; queueMicrotask(flushOwners); }
  }
  function flushOwners() {
    ownerFlush = false;
    const list = [...ownerQueue];
    ownerQueue.clear();
    for (const o of list) { const r = o.sheet && rulesOf(o.sheet); if (r) scanRules(r); } // learn var usage first
    list.forEach(processOwner);
  }

  const OWNER_SEL = 'style, link[rel~="stylesheet" i]';
  function processAllOwners() {
    document.querySelectorAll(OWNER_SEL).forEach((o) => { if (!isOurs(o)) queueOwner(o); });
  }

  // ───────────────────────── element sweep ─────────────────────────
  // When every stylesheet is readable, the mirrors already recolor everything they style: the sweep then only
  // needs elements with colors of their own (inline styles, old color attributes, SVG). Stylesheets we can't
  // read (another domain, adoptedStyleSheets, a cross-origin @import) switch it to every element.
  let opaque = false;
  const fullSweep = () => opaque; // (constructed stylesheets are noticed in startWalk and poll, which then call markOpaque)
  const hasAdopted = () => !!(document.adoptedStyleSheets && document.adoptedStyleSheets.length); // (a getter that copies the list: not called per element)
  const TARGET_SEL = '[style],[bgcolor],[color],[text],[fill],[stroke],font,svg,svg *';
  const isTarget = (el) => { try { return el.matches(TARGET_SEL); } catch { return true; } };
  function markOpaque() {
    if (opaque) return;
    opaque = true;
    enableHoverChecks();
    if (sweepReady) rewalk(); // everything may have changed color: look at the whole page now
  }
  const touched = new Map();     // el -> [[prop, oldValue, oldPriority], ...]
  const justWritten = new Set(); // ignore our own style-attribute mutations
  const sweepQueue = new Set();
  let sweepReady = false;
  let sweepScheduled = false;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'BR', 'TEMPLATE', 'SOURCE']);
  // Media is never recolored — only checked for blend modes (see below).
  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
  const MEDIA_SEL = 'img,video,canvas,picture,image';
  // Sites use "multiply" etc. on photos so they blend into a white page — a no-op on white.
  // On a dark background the same blend turns photos nearly black, so we switch it off.
  const BLEND_FIX = /^(multiply|darken)$/; // both leave a photo unchanged on white
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  const SYNC_LIMIT = 800;    // new content up to this size is fixed before the next paint (no white flash)
  const FIRST_FRAME = 1200;  // elements fixed synchronously right before the first paint (top of the page)

  // Run big jobs only when the browser is idle, so pages stay responsive.
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 250 })
    : (cb) => setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16);

  function queueSweep(node, deep) {
    if (!active || !sweepReady || node.nodeType !== 1) return;
    if (fullSweep()) {
      sweepQueue.add(node);
      if (deep && node.firstElementChild) for (const el of node.getElementsByTagName('*')) sweepQueue.add(el);
      return;
    }
    if (isTarget(node)) sweepQueue.add(node);
    if (deep && node.firstElementChild) for (const el of node.querySelectorAll(TARGET_SEL)) sweepQueue.add(el);
  }
  let walker = null; // lazy cursor for the initial full-page sweep
  const hasWork = () => sweepQueue.size > 0 || walker !== null;
  function scheduleSweep() {
    if (sweepScheduled || !hasWork()) return;
    sweepScheduled = true;
    idle(runSweep);
  }
  function takeBatch(n) {
    const batch = [];
    for (const el of sweepQueue) { sweepQueue.delete(el); batch.push(el); if (batch.length >= n) return batch; }
    while (walker && batch.length < n) {
      const el = walker.nextNode();
      if (!el) walker = null; else batch.push(el);
    }
    return batch;
  }
  function runSweep(deadline) {
    sweepScheduled = false;
    if (!active) { sweepQueue.clear(); walker = null; return; }
    do sweepBatch(takeBatch(150));
    while (hasWork() && deadline.timeRemaining() > 3);
    scheduleSweep();
  }
  // Called at the end of a mutation callback (a microtask, i.e. before the next paint).
  function flushSweep() {
    if (sweepQueue.size) {
      const batch = [];
      for (const el of sweepQueue) { sweepQueue.delete(el); batch.push(el); if (batch.length >= SYNC_LIMIT) break; }
      sweepBatch(batch); // runs in the mutation microtask, i.e. before the browser paints
    }
    scheduleSweep();     // anything left (and the initial walk) continues in idle time
  }

  function restoreEl(el) {
    const saved = touched.get(el);
    if (!saved) return;
    for (const [p, v, pr] of saved) { if (v) el.style.setProperty(p, v, pr); else el.style.removeProperty(p); }
    touched.delete(el);
    justWritten.add(el);
  }
  function applyEl(el, changes) {
    const saved = touched.get(el) || [];
    for (const [p, v] of changes) {
      saved.push([p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
      el.style.setProperty(p, v, 'important');
    }
    touched.set(el, saved);
    justWritten.add(el);
  }

  // Background, gradient and border fixes for one computed style.
  function boxChanges(cs, ch) {
    let v;
    if ((v = tv(cs.backgroundColor, 'bg'))) ch.push(['background-color', v]);
    const bi = cs.backgroundImage;
    if (bi !== 'none' && bi.includes('gradient') && (v = tv(bi, 'bg'))) ch.push(['background-image', v]);
    // most elements have no border at all: one shorthand read says so (instead of 12 per element)
    if (cs.borderStyle === 'none' || cs.borderWidth === '0px') return;
    const one = cs.borderColor; // all four sides alike (the usual case): one conversion
    if (!one.includes(') ') && cs.borderStyle.indexOf(' ') < 0 && cs.borderWidth.indexOf(' ') < 0) {
      if ((v = tv(one, 'border'))) for (const side of SIDES) ch.push([`border-${side.toLowerCase()}-color`, v]);
      return;
    }
    for (const side of SIDES) {
      if (cs[`border${side}Style`] !== 'none' && cs[`border${side}Width`] !== '0px' &&
          (v = tv(cs[`border${side}Color`], 'border'))) ch.push([`border-${side.toLowerCase()}-color`, v]);
    }
  }

  // ::before / ::after can't take inline styles, so their fixes go into one generated
  // stylesheet, targeted via an attribute whose name is random per page load
  // (no fixed marker a site could use to detect the extension).
  const PATTR = 'data-' + Math.random().toString(36).slice(2, 8);
  const pseudoRules = new Map(); // el -> css text
  let pseudoEl = null, pseudoDirty = false, pseudoSeq = 0;
  function flushPseudo() {
    if (!pseudoDirty) return;
    pseudoDirty = false;
    const css = [...pseudoRules.values()].join('');
    if (!pseudoEl) { if (!css) return; pseudoEl = makeStyle(''); }
    pseudoEl.textContent = css;
  }
  function clearPseudo(el) {
    if (pseudoRules.delete(el)) pseudoDirty = true;
  }

  function sweepBatch(els) {
    els = els.filter((el) => el.isConnected && el.style && !SKIP.has(el.nodeName.toUpperCase()) && !isOurs(el));
    if (!els.length) return;
    for (const el of els) { restoreEl(el); clearPseudo(el); } // write phase 0: undo our old fixes
    flushPseudo();
    const plans = [], pplans = [], maybeInherited = [], full = fullSweep();
    for (const el of els) {             // read phase (one style recalc for the whole batch)
      const cs = getComputedStyle(el);
      const ch = [];
      let v;
      if (BLEND_FIX.test(cs.mixBlendMode) && (MEDIA.has(el.nodeName.toUpperCase()) || el.querySelector(MEDIA_SEL))) {
        ch.push(['mix-blend-mode', 'normal']);
      }
      if (MEDIA.has(el.nodeName.toUpperCase())) { if (ch.length) plans.push([el, ch]); continue; }
      if (!(el instanceof SVGElement)) {
        boxChanges(cs, ch);
        const t = tv(cs.color, 'text');
        if (t) {
          const parent = el.parentElement;
          // Same color as the parent: probably inherited, so fixing the parent fixes this too.
          // Re-checked after the write phase in case it was set explicitly (e.g. body{color:#333}).
          if (!parent || getComputedStyle(parent).color !== cs.color) ch.push(['color', t]);
          else maybeInherited.push(el);
        }
        if (full) for (const p of PSEUDOS) {
          const ps = getComputedStyle(el, p);
          const c = ps.content;
          if (c === 'none' || c === 'normal') continue; // pseudo not rendered
          const pch = [];
          boxChanges(ps, pch);
          if (ps.color !== cs.color && (v = tv(ps.color, 'text'))) pch.push(['color', v]);
          if (pch.length) pplans.push([el, p, pch]);
        }
      } else {
        for (const p of ['fill', 'stroke']) {
          const val = cs.getPropertyValue(p);
          if (val && val !== 'none' && (v = tv(val, 'icon'))) ch.push([p, v]);
        }
      }
      if (ch.length) plans.push([el, ch]);
    }
    for (const [el, ch] of plans) applyEl(el, ch); // write phase
    if (maybeInherited.length) {                 // second pass: still dark now that parents are fixed?
      const late = [];
      for (const el of maybeInherited) { const t = tv(getComputedStyle(el).color, 'text'); if (t) late.push([el, t]); }
      for (const [el, t] of late) applyEl(el, [['color', t]]);
    }
    for (const [el, p, pch] of pplans) {
      let id = el.getAttribute(PATTR);
      if (!id) { id = String(++pseudoSeq); el.setAttribute(PATTR, id); }
      const decl = pch.filter(([, val]) => SAFE_VALUE.test(val)).map(([k, val]) => `${k}:${val}!important`).join(';');
      pseudoRules.set(el, (pseudoRules.get(el) || '') + `[${PATTR}="${id}"]${p}{${decl}}`);
      pseudoDirty = true;
    }
    flushPseudo();
  }
  const PSEUDOS = ['::before', '::after'];

  // Cross-origin CSS can't be mirrored, so its :hover/:focus colors aren't pre-darkened.
  // Re-check the element under the pointer (and a few ancestors), throttled to one per frame.
  let hoverOn = false, hoverRaf = 0, hoverEl = null;
  function recheckChain(el) {
    if (!active || !sweepReady) return;
    const list = [];
    for (let i = 0; el && el.nodeType === 1 && i < 4; i++, el = el.parentElement) list.push(el);
    sweepBatch(list);
  }
  function onPointer(e) {
    hoverEl = e.target;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const el = hoverEl;
      recheckChain(el);
      setTimeout(() => recheckChain(el), 300); // after hover transitions finish
    });
  }
  const HOVER_EVENTS = ['mouseover', 'mouseout', 'focusin', 'focusout'];
  function enableHoverChecks() {
    if (hoverOn) return;
    hoverOn = true;
    HOVER_EVENTS.forEach((t) => document.addEventListener(t, onPointer, { capture: true, passive: true }));
  }
  function disableHoverChecks() {
    if (!hoverOn) return;
    hoverOn = false;
    HOVER_EVENTS.forEach((t) => document.removeEventListener(t, onPointer, { capture: true }));
  }

  // ─────────────────────── base styles & lifecycle ───────────────────────
  let baseEl = null, preloadEl = null, observer = null, pollTimer = null;

  function makeStyle(css) {
    const s = document.createElement('style');
    ours.add(s);
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }
  function baseCss() {
    const bg = cssRgb(transformRGB(255, 255, 255, 'bg'));
    const fg = cssRgb(transformRGB(0, 0, 0, 'text'));
    // Zero-specificity default: the site's own (mirrored) html rules still win, so dark sites
    // keep their real background and the dark-site check above can see it.
    let css = `:where(html){background-color:${bg};color:${fg}}html{color-scheme:dark!important}`;
    if (S.dimImages) css += `img,video{filter:brightness(.85) contrast(1.05)!important}`;
    return css;
  }

  function parseRgba(str) {
    const m = str && str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }

  // Is the site already dark? Our mirrors only rewrite *bright* colors, so a dark background that isn't one
  // of our own outputs came from the site itself. It looks at what's actually on screen: a grid of points over
  // the viewport, each taking the first solid background under it (so a dark app shell over a transparent
  // body counts, and a white page with one dark banner doesn't). A page that declares it's dark-only
  // (<meta name="color-scheme" content="dark">) counts as dark. Returns true / false, or null if it can't tell yet.
  function looksDark() {
    const meta = document.querySelector('meta[name="color-scheme" i]');
    if (meta && /^\s*(only\s+)?dark\s*$/i.test(meta.content || '')) return true;
    const vw = innerWidth, vh = innerHeight;
    if (!vw || !vh || !document.body) return null;
    const solid = (el) => { for (; el && el.nodeType === 1; el = el.parentElement) { if (MEDIA.has(el.nodeName.toUpperCase())) return 'media'; const c = parseRgba(getComputedStyle(el).backgroundColor); if (c && c[3] >= 0.5) return c; } return null; };
    let dark = 0, light = 0, media = 0;
    for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
      const el = document.elementFromPoint(vw * fx, vh * fy);
      let c = el && solid(el);
      if (c === 'media') { media++; continue; }
      if (!c) c = parseRgba(getComputedStyle(document.body).backgroundColor);
      if (!c || c[3] < 0.5) c = parseRgba(getComputedStyle(document.documentElement).backgroundColor);
      if (!c || c[3] < 0.5) { light++; continue; } // nothing painted: the browser's white
      const L = lstar(c[0], c[1], c[2]);
      if (L < 0.3 && !isProduced(c[0], c[1], c[2])) dark++; else light++;
    }
    if (!dark && !light) return null; // only pictures and video so far
    return dark >= Math.max(2, Math.ceil((dark + light) * 0.6));
  }

  const COLORISH = /color|background|border|fill|stroke|outline/i;

  function onMutations(records) {
    if (!active) return;
    const seenAttr = new Set();
    for (const r of records) {
      const t = r.target;
      if (r.type === 'childList') {
        if (t.nodeName === 'STYLE' && !isOurs(t)) queueOwner(t); // CSS-in-JS appending text
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || isOurs(n)) continue;
          if (isOwner(n)) queueOwner(n);
          else if (n.firstElementChild && (n.getElementsByTagName('style').length || n.getElementsByTagName('link').length)) n.querySelectorAll(OWNER_SEL).forEach(queueOwner);
          if (sweepReady) queueSweep(n, true); // (while the page first loads, the first sweep covers it)
        }
        for (const n of r.removedNodes) {
          const rec = owners.get(n);
          if (rec && !n.isConnected) { if (rec.mirror) rec.mirror.remove(); owners.delete(n); }
        }
      } else if (r.type === 'attributes') {
        if (isOurs(t)) continue;
        const a = r.attributeName;
        if (a === 'style') {
          if (justWritten.has(t) || seenAttr.has(t)) continue;
          seenAttr.add(t);
          // pages animate style.transform/opacity every frame — only react to color changes
          if (!touched.has(t) && !COLORISH.test(t.getAttribute('style') || '')) continue;
          queueSweep(t, false);
        } else if (a === 'class') { if (!seenAttr.has(t)) { seenAttr.add(t); if (sweepReady && fullSweep()) queueSweep(t, false); else if (sweepReady && isTarget(t)) queueSweep(t, false); } }
        else if (isOwner(t)) queueOwner(t);
      }
    }
    justWritten.clear();
    flushSweep();
  }

  function poll() {
    if (!active || document.hidden) return; // no work in background tabs
    if (!opaque && sweepReady && hasAdopted()) markOpaque(); // constructed stylesheets can't be mirrored
    for (const [owner, rec] of owners) {
      if (!owner.isConnected) { if (rec.mirror) rec.mirror.remove(); owners.delete(owner); continue; }
      if (rec.mirror && owner.nextSibling !== rec.mirror) owner.after(rec.mirror); // page moved/removed our mirror
      if (rec.count >= 0) { // catch CSSOM insertRule() (styled-components & co. don't touch the DOM)
        const rules = owner.sheet && rulesOf(owner.sheet);
        if (rules && rules.length !== rec.count) queueOwner(owner);
      }
    }
    document.querySelectorAll(OWNER_SEL).forEach((o) => { if (!isOurs(o) && !owners.has(o)) queueOwner(o); });
    for (const el of pseudoRules.keys()) if (!el.isConnected) clearPseudo(el); // drop rules for removed elements
    flushPseudo();
  }

  function startWalk() {
    if (!opaque && hasAdopted()) { opaque = true; enableHoverChecks(); }
    if (fullSweep()) { sweepQueue.add(document.documentElement); walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT); }
    else { walker = null; for (const el of document.querySelectorAll(TARGET_SEL)) sweepQueue.add(el); }
    sweepBatch(takeBatch(FIRST_FRAME)); // the top of the page, before it is painted
    scheduleSweep();                    // the rest in idle time
  }
  const rewalk = startWalk;

  // Runs at the first animation frame — the last moment before the browser's first paint,
  // when render-blocking stylesheets have arrived — so the page is already fixed when it
  // first appears. (DOMContentLoaded is a fallback for background tabs, where rAF is paused.)
  let readyDone = false, readyRaf = 0;
  function onReady() {
    if (!active || readyDone) return;
    if (!document.body && document.readyState === 'loading') { readyRaf = requestAnimationFrame(onReady); return; }
    readyDone = true;
    cancelAnimationFrame(readyRaf);
    flushOwners(); // make sure every stylesheet seen so far is mirrored
    const forced = S.sites[HOST] === 'on';
    if (preloadEl) { preloadEl.remove(); preloadEl = null; }
    if (S.autoDetect && !forced && looksDark() === true) { stop(); autoDark = true; scheduleDarkChecks(); return; }
    sweepReady = true;
    startWalk(); // the whole page lazily (or just the elements with their own colors)
    if (S.autoDetect && !forced) scheduleDarkChecks();
  }
  // Pages that build themselves with scripts (app shells, a dark theme switched on after loading, a splash
  // screen) only show their real colors a moment later: look twice more, once the page has loaded.
  let darkChecks = [];
  function scheduleDarkChecks() {
    if (darkChecks.length) return;
    const check = () => {
      if (document.hidden || !S.autoDetect || S.sites[HOST] === 'on' || !shouldRun()) return;
      const d = looksDark();
      if (d === true && active) { stop(); autoDark = true; }
      else if (d === false && autoDark && !active) { autoDark = false; start(); }
    };
    const later = () => { darkChecks.push(setTimeout(check, 800), setTimeout(check, 3000)); };
    if (document.readyState === 'complete') later(); else window.addEventListener('load', later, { once: true });
    darkChecks.push(0);
  }

  function start() {
    active = true;
    autoDark = false;
    tCache.clear();
    produced.clear();
    if (earlyEl) { earlyEl.remove(); earlyEl = null; }
    readyDone = false;
    baseEl = makeStyle(baseCss());
    if (document.readyState === 'loading') {
      // avoid a white flash before the page's own CSS has been mirrored
      preloadEl = makeStyle(`body{background-color:${cssRgb(transformRGB(255, 255, 255, 'bg'))}!important}`);
    }
    observer = new MutationObserver(onMutations);
    observer.observe(document, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'media', 'rel', 'disabled'],
    });
    processAllOwners();
    pollTimer = setInterval(poll, 1500);
    if (document.readyState === 'loading') {
      readyRaf = requestAnimationFrame(onReady);
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else onReady();
  }

  function stop() {
    active = false;
    cancelAnimationFrame(readyRaf);
    if (earlyEl) { earlyEl.remove(); earlyEl = null; }
    sweepReady = false;
    opaque = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    disableHoverChecks();
    for (const rec of owners.values()) if (rec.mirror) rec.mirror.remove();
    owners.clear();
    ownerQueue.clear();
    sweepQueue.clear();
    walker = null;
    for (const el of [...touched.keys()]) restoreEl(el);
    justWritten.clear();
    if (baseEl) { baseEl.remove(); baseEl = null; }
    if (preloadEl) { preloadEl.remove(); preloadEl = null; }
    for (const el of pseudoRules.keys()) el.removeAttribute(PATTR);
    pseudoRules.clear();
    if (pseudoEl) { pseudoEl.remove(); pseudoEl = null; }
  }

  const shouldRun = () => S.enabled && S.sites[HOST] !== 'off';

  function apply() {
    for (const t of darkChecks) clearTimeout(t);
    darkChecks = [];
    stop();
    autoDark = false;
    if (shouldRun()) start();
  }
  // Only the look or the detection changed (a slider moved): recolor in place, without taking the dark styles
  // off first, so there's no flash of the light page while you drag.
  function retune() {
    if (!active) return apply();
    tCache.clear(); produced.clear();
    if (baseEl) baseEl.textContent = baseCss();
    for (const rec of owners.values()) rec.count = -1; // every mirror is made again with the new colors
    processAllOwners();
    if (sweepReady) { for (const el of pseudoRules.keys()) clearPseudo(el); flushPseudo(); for (const el of touched.keys()) sweepQueue.add(el); startWalk(); }
  }

  // Never trust stored values blindly: they end up inside generated CSS.
  const num = (x, lo, hi, d) => (x !== null && x !== '' && Number.isFinite(+x) ? clamp(Math.round(+x), lo, hi) : d);
  const advOf = (a) => { a = a && typeof a === 'object' ? a : {}; return { bg: num(a.bg, 0, 100, null), text: num(a.text, 0, 100, null), accent: num(a.accent, 0, 100, null) }; };
  function sanitize(v) {
    const out = {
      enabled: v.enabled !== false,
      sites: v.sites && typeof v.sites === 'object' ? v.sites : {},
      bg: num(v.bg, 4, 30, DEFAULTS.bg),
      text: num(v.text, 60, 100, DEFAULTS.text),
      dimImages: v.dimImages === true,
      autoDetect: v.autoDetect !== false,
      sens: num(v.sens, 0, 100, DEFAULTS.sens),
      adv: advOf(v.adv),
    };
    // this site's own look and detection, if it has one
    const own = v.siteCfg && typeof v.siteCfg === 'object' && v.siteCfg[HOST];
    if (own && typeof own === 'object') {
      out.bg = num(own.bg, 4, 30, out.bg); out.text = num(own.text, 60, 100, out.text); out.sens = num(own.sens, 0, 100, out.sens);
      out.adv = advOf(own.adv); if (typeof own.dimImages === 'boolean') out.dimImages = own.dimImages;
    }
    return out;
  }

  function load() {
    return new Promise((res) => {
      try { chrome.storage.local.get(DEFAULTS, (v) => { S = sanitize({ ...DEFAULTS, ...(v || {}) }); updateThresholds(); res(); }); }
      catch { res(); }
    });
  }

  // A slider moved: recolor in place. On / off, this site's switch or the dark-site check: start over.
  chrome.storage.onChanged.addListener((_ch, area) => {
    if (area !== 'local') return;
    const before = { run: shouldRun(), forced: S.sites[HOST] === 'on', auto: S.autoDetect };
    load().then(() => {
      if (before.run === shouldRun() && before.forced === (S.sites[HOST] === 'on') && before.auto === S.autoDetect && (active || autoDark)) { if (active) retune(); }
      else apply();
    });
  });
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (sender.id !== chrome.runtime.id) return; // only our own popup/worker
    if (msg && msg.type === 'ldm-status') send({ active, autoDark, host: HOST });
  });

  // Settings load asynchronously; don't let the page paint white meanwhile. Paint a dark
  // background right away with default colors — replaced by start(), or removed within a few
  // milliseconds if this site is switched off.
  let earlyEl = null;
  if (document.readyState === 'loading' && document.documentElement) {
    const bg = cssRgb(transformRGB(255, 255, 255, 'bg'));
    earlyEl = makeStyle(`html,body{background-color:${bg}!important}html{color-scheme:dark!important}`);
  }

  load().then(() => {
    if (shouldRun()) start();
    else if (earlyEl) { earlyEl.remove(); earlyEl = null; }
  });
})();
