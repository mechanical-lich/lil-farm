// Service worker: makes the game installable and openable with no network.
//
// Every path here is relative, because GitHub Pages serves a project site from
// a subpath (https://user.github.io/lil-farm/). Relative URLs in a service
// worker resolve against the worker's own location, so this file works whether
// the game is at a domain root or nested under a repo name.
//
// ⚠ Bump CACHE_VERSION on every deploy. Assets are served cache-first, so
// without a bump a returning player keeps the old build indefinitely.

const CACHE_VERSION = 'lil-farm-v3';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './assets/tilemap_packed.png',
  './assets/town_tilemap_packed.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './js/main.js',
  './js/config.js',
  './js/state.js',
  './js/engine/events.js',
  './js/engine/rng.js',
  './js/engine/save.js',
  './js/engine/loop.js',
  './js/render/sprites.js',
  './js/render/renderer.js',
  './js/render/camera.js',
  './js/render/tilerender.js',
  './js/render/entityrender.js',
  './js/world/grid.js',
  './js/world/land.js',
  './js/world/tiledefs.js',
  './js/world/worldgen.js',
  './js/world/pathfind.js',
  './js/sim/tick.js',
  './js/sim/tasks.js',
  './js/sim/farmer.js',
  './js/sim/crops.js',
  './js/sim/animals.js',
  './js/sim/build.js',
  './js/sim/inventory.js',
  './js/sim/shop.js',
  './js/ui/input.js',
  './js/ui/toolbar.js',
  './js/ui/taskpanel.js',
  './js/ui/shoppanel.js',
  './js/ui/hud.js',
  './js/ui/toast.js',
  './js/ui/summary.js',
  './js/ui/settingspanel.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll fails the whole install if any one file 404s, which would leave
    // the game uninstallable for a typo. Take what we can get instead.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations go to the network first so a fresh deploy is picked up as soon
  // as there's a connection, and fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Everything else is versioned by CACHE_VERSION, so cache-first is safe and
  // keeps the game instant on a cold open.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_VERSION);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
