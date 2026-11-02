# Gold Prices

Installable mobile dashboard for global 24K gold, Egypt's iSagha selling price,
CBE USD/EGP and 1W / 1M / 3M / 6M gold history. Based on the original V8 page.

## Files

- `index.html` — dashboard and installation controls
- `assets/app.css` — original black/gold styling
- `assets/app.js` — pricing, conversion, history, local storage and freshness status
- `assets/pwa.js` — installation and app-update controls
- `manifest.webmanifest` — standalone mobile app metadata
- `service-worker.js` — versioned offline application shell
- `icons/` — SVG source, 192/512 PNGs, maskable icon and Apple touch icon
- `archive/24k-gold-mobile-v8.html` — unchanged original source

## Run locally

From this folder run `python3 -m http.server 8000`, then open
http://localhost:8000. Service workers require localhost or HTTPS.

## Installation

On Android Chrome use **Install App** when offered, or the browser's install menu.
On iPhone/iPad open the public URL in Safari, choose **Share → Add to Home Screen**.
The install button is hidden when already installed. Browsers control when native
installation is offered; see [MDN installation guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

## Offline, data and updates

After one successful online visit, the app shell works offline. Last-known prices
and history remain in local storage using V8's `gold24-v8` key. Offline/cached
readings are labelled and the oldest available price-fetch timestamp is shown.
Clearing browser storage removes these saved readings.

The service worker caches only explicitly listed app files. It never caches API
or proxy requests. The original gold, CBE, iSagha and XAUS routes and their fallbacks
are retained. Third-party availability and CORS policies can affect live readings.
History refreshes after six hours. The saved chart remains visible and usable while
fresh history loads in the background. History routes race for the first valid
response, with a 12-second timeout per route; losing requests are cancelled.
Chart labels show actual dates.

When changing an app file, bump `VERSION` in `service-worker.js` and update `SHELL`
if files are added. A new worker downloads a complete shell; the user can apply it
with **Update available · Reload**. Old application caches are then removed.

## Publishing

Push `main` to `git@github.com:wyfahmy/Gold-Prices.git`. Configure GitHub Pages to
publish from `main` and `/` (repository root). All asset paths and worker scope
are relative, including under `/Gold-Prices/`.

## Validation

Tested in local headless Chrome at a mobile viewport and `/Gold-Prices/` subpath:
manifest parsing; service worker activation; shell-only cache; deterministic gold,
EGP and FX conversion; all four chart ranges; no horizontal overflow; offline
reload with saved prices/chart; reconnection; and no JavaScript runtime errors.
Chrome's installability check reported only the automated incognito-context
restriction. Physical Android/iPhone installation still requires a device check.

To rerun: install Playwright locally (`npm install --no-save playwright` and
`npx playwright install chromium`), then run `node tests/pwa-smoke.cjs`.
Set `TEST_LIVE=1` to also check external feeds. `CHROME_PATH` can select a local
Chrome executable. All four real feeds passed during deployment validation.
