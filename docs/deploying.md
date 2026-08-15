# Deploying to GitHub Pages

The game is plain static files with no build step, so deploying is just serving
the repository. It's already set up to work from a project subpath like
`https://mechanical-lich.github.io/lil-farm/`.

## Before you deploy

1. **Set `TESTING` to `false` in `js/config.js`.**
   While it's `true` a new farm starts with $2000, 500 wood, 300 stone and 25 of
   every seed, which skips most of the game. The debug line reads
   `⚠ TESTING START` whenever it's on.
2. **Bump `CACHE_VERSION` in `sw.js`** (`lil-farm-v2` → `v3`, and so on).
   Assets are served cache-first, so without a bump anyone who has already
   opened the game keeps the old build indefinitely — **including people using
   the plain web page**, not just those who installed it. The service worker
   registers for every visitor; installing to the home screen changes where the
   game launches from, not how it caches.

   With a bump, the sequence is: the browser always revalidates `sw.js` itself,
   the new worker installs and claims the page, and the game reloads itself once
   so the player lands on the new build. Without a bump none of that happens.
3. `npm test` — 135 headless tests, no dependencies.

## Turning Pages on

In the repo: **Settings → Pages → Build and deployment**.

- Source: **Deploy from a branch**
- Branch: **`main`**, folder: **`/ (root)`**

> ⚠ **Do not choose the `/docs` folder.** GitHub offers it as a source and this
> repo has a `docs/` directory, but it holds the design and plan documents, not
> the game. Picking it publishes the documentation and no game.

First publish takes a minute or two. After that a push to `main` redeploys.

## Why it works on a subpath

A project site is served from `/<repo-name>/`, not the domain root, so anything
starting with `/` would break. Everything here is relative on purpose:

- `index.html` references `css/`, `js/`, `icons/` and `manifest.json` relatively.
- `sprites.js` loads `assets/…` relative to the page.
- `manifest.json` uses `"start_url": "./"` and `"scope": "./"`.
- `sw.js` precaches `./…` paths, which resolve against the worker's own
  location, and is registered as `sw.js` rather than `/sw.js`.

`.nojekyll` is present so GitHub serves the files as-is rather than running them
through Jekyll.

## Installing on the phone

Open the Pages URL in Safari → Share → **Add to Home Screen**.

This matters beyond convenience. Safari clears script-writable storage for sites
that go unvisited for a stretch, and a home-screen web app is treated more
durably than an ordinary tab — so **installing is the main thing protecting the
save**. Once installed the game opens full-screen with no browser chrome, and
works with no connection.

## Local development

`node tools/devserver.mjs 8146`, then open `http://localhost:8146/`.

The service worker **deliberately does not register on localhost**, because
serving assets cache-first means an edited file keeps showing its old version
until the cache is cleared. Any worker left over from a previous test is
unregistered automatically on a plain local load.

To exercise the installable build locally, load `http://localhost:8146/?sw=1`.

## Regenerating the icons

`node tools/make-icons.mjs` redraws `icons/` from the barn in the farm
tilesheet. It decodes and encodes PNG directly through Node's `zlib`, so there
are still no dependencies. Re-run it if the barn art changes.
