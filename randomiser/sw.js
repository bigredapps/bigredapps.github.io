/*
 * Service worker: makes the app work offline and keeps it up to date.
 *
 * - On install it downloads the app files plus every game file and image into a cache.
 * - Afterwards every request goes to the network first (so edits show up straight away) and
 *   the cached copy is only used when the network is unavailable.
 */

// Bump this name to force every installed copy to throw away its old cache.
const CACHE_NAME = 'setup-shuffler-v2';

// The files the app itself needs to start.
const APP_SHELL_FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // cache: 'reload' skips the browser's HTTP cache so we never store a stale copy.
    for (const file of APP_SHELL_FILES) {
      await cache.put(file, await fetch(file, { cache: 'reload' }));
    }

    try {
      // Pre-cache every game listed in games/index.json, plus each image its JSON mentions
      // ("image": "..." entries), so every game works offline even if never opened before.
      const indexResponse = await fetch('games/index.json', { cache: 'reload' });
      await cache.put('games/index.json', indexResponse.clone());
      for (const gameFile of await indexResponse.json()) {
        const gameResponse = await fetch('games/' + gameFile, { cache: 'reload' });
        await cache.put('games/' + gameFile, gameResponse.clone());
        const gameJsonText = await gameResponse.text();
        for (const match of gameJsonText.matchAll(/"image"\s*:\s*"([^"]+)"/g)) {
          await cache.add('games/' + match[1]).catch(() => {}); // a missing image shouldn't break install
        }
      }
    } catch (error) {
      // If game files can't be fetched now, they will be cached as they are visited later.
    }

    self.skipWaiting(); // start using this new version straight away
  })());
});

// When a new version takes over, delete caches left behind by older versions.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))))
      .then(() => self.clients.claim()));
});

// Network first: try the server (revalidating with it), save a copy, and fall back to the cache offline.
self.addEventListener('fetch', event => {
  const request = event.request;
  const isSameSiteGet = request.method === 'GET' && new URL(request.url).origin === location.origin;
  if (!isSameSiteGet) return; // leave everything else to the browser

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) {
          const copy = response.clone(); // a response body can only be read once
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then(cachedResponse => cachedResponse || caches.match('index.html'))));
});
