// sw.js — caches the app shell so Jobber's core UI (identity, profiles,
// Research vault) still opens with no network. P2P discovery obviously
// still needs a live connection, but nothing else does.

const CACHE_NAME = 'jobber-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/state.js',
  './js/ui-kit.js',
  './js/identity-ui.js',
  './js/profiles.js',
  './js/conversations.js',
  './js/discovery-ui.js',
  './js/research-ui.js',
  './js/message-router.js',
  './js/render.js',
  './js/db.js',
  './js/identity.js',
  './js/protocol.js',
  './js/p2p.js',
  './js/discovery.js',
  './js/matching.js',
  './js/llm.js',
  './js/extract.js',
  './js/research.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only manage same-origin app-shell requests; let CDN modules (Trystero,
  // WebLLM, fonts) and any P2P-related network traffic pass straight through.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
