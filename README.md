# Unflash (v1.5.1)

A small, self-made dark mode extension for Chrome. It works like Dark Reader's "dynamic" mode:
bright backgrounds become dark grey, dark text becomes light grey, and light borders become soft grey.
It works by rewriting the page's own CSS, so hover states and accent colors keep working.

## Install
1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `unflash` folder. (Coming from Local Dark: Chrome treats a folder in a new place as a new extension, so its settings start fresh. Load it from the same folder as before to keep them.)
   (If you had v1.0 installed, remove it first or click its reload button.)
4. Pin it from the puzzle-piece menu. Pages that were already open need a reload.

## Use
- Popup: turn it on or off everywhere or per site. **Detection** sets what counts as "light":
  0 = only pure white or black, 75 = default, 100 = also light tints and colored areas (accent buttons included).
  **Fine-tune detection** (v1.5) splits that into three sliders you can set on their own: which backgrounds get
  darkened, which text gets lightened, and which colored buttons and badges are kept. Each follows the Detection
  slider until you move it. Set the background shade and text brightness, dim images, and choose whether to skip
  sites that are already dark.
- **All sites / Only this site** (v1.5): give a site its own detection and look. A site with its own settings opens
  on them in the popup; one link puts it back on the settings for all sites.
- Moving a slider recolors the page in place (v1.5), so there's no flash of the light page while you drag.
- Shortcut: **Alt+Shift+D** toggles the current site (change it at `chrome://extensions/shortcuts`).

## Safety: local only
- **No network access at all.** The extension makes no requests, and the manifest's CSP sets
  `connect-src 'none'` so its own pages and worker *can't* make any, even by mistake.
- **One permission: `storage`.** There's no `tabs` permission, no host permissions, and no history or cookie access.
  The popup gets the site name from the page itself and never sees full URLs.
- **Reads colors only.** The script reads computed colors and CSS rules. It never reads page text,
  form fields or passwords.
- **No remote code and no `eval`.** Everything that runs is in this folder.
- **Settings are checked.** Stored values are validated before they're used in CSS, and generated CSS values
  that contain unexpected characters are rejected.
- **Hard to fingerprint.** Its style tags carry no marker attributes, and its state lives in Chrome's
  isolated content-script world, which pages can't see.
- **Only talks to itself.** Messages are accepted only from this extension.

## Speed
- It recolors CSS rules once per stylesheet instead of recoloring each element.
- The element sweep (for inline styles and CSS from other domains) runs in idle time, in small batches,
  and reads first, then writes, so the page restyles only once per batch.
- No white flash on load. The page goes dark the moment it starts loading, the top of the page
  is fixed in the last frame before Chrome first paints it, and content that streams in is fixed
  before it's drawn.
- Color conversions are cached, and the dark-site check doesn't force a page restyle.
- Changes that aren't about color are ignored, such as animations that update `style.transform` every frame.
- It does no polling in background tabs.
- v1.5: when every stylesheet on a page is readable, the CSS mirrors already handle it, so the element sweep only
  visits elements with colors of their own (inline styles, old color attributes, SVG). It looks at every element
  only when a page has stylesheets it can't read (another domain, constructed stylesheets, a cross-origin @import).
  On a big test page that cut its work by about two thirds.
- v1.5: CSS-in-JS libraries add rules one at a time; only the new rules are recolored and added to the mirror,
  instead of rebuilding it each time (about half the work). Borders are checked with one read per element instead
  of twelve, and per-frame style animations cost less.
- v1.5: very light tints (like #f0f0fe) used to come out dark blue, because HSL saturation explodes near white;
  saturation is now capped by the color's real chroma.

## Already-dark sites (v1.5)
"Skip sites that are already dark" looks at what's actually on screen: nine points across the window, each taking
the first solid background under it, instead of only the page's body. So a dark app whose body is transparent
counts as dark, and a white page with one dark banner doesn't. A page that says it's dark-only
(`<meta name="color-scheme" content="dark">`) counts as dark. It looks twice more after the page has loaded, for
sites that switch to their dark theme with a script or start with a splash screen.

## Images
Images and videos are never recolored. Some sites blend photos into a white page with
`mix-blend-mode: multiply`. That's invisible on white but turns photos nearly black on a dark page,
so the extension switches that blend off for images (v1.4).

## Trade-off of going local-only
Chrome doesn't let pages or extensions read stylesheets loaded from another domain (for example a CDN).
v1.0 re-downloaded those files; v1.1+ doesn't. Instead it fixes those elements directly, including their
`::before`/`::after` pseudo-elements (v1.2), and re-checks elements under the mouse or keyboard focus,
so their hover colors also come out dark.

## Files
- `content.js`: all the recoloring logic
- `background.js`: first-run defaults and the keyboard shortcut
- `popup.*`: settings UI
