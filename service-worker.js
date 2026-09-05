// service-worker.js
//
// Cache les assets statiques de l'application pour un fonctionnement hors
// ligne des fonctions locales déjà disponibles (§7). Ne met JAMAIS en cache
// les échanges P2P ni les réponses des relais Nostr — uniquement les
// fichiers statiques de l'app elle-même. Chemins toujours relatifs à la
// portée du service worker, pour fonctionner sous un sous-chemin GitHub
// Pages (§6).

const CACHE_NAME = 'jobmatch-static-v3';
const SCOPE = self.registration.scope;

const STATIC_ASSETS = [
  '',
  'index.html',
  'manifest.webmanifest',
  'src/ui/style.css',
  'src/app/main.js',
  'src/ui/render.js',
  'src/config/matching.js',
  'src/core/parser/documentParser.js',
  'src/core/extraction/heuristicExtractor.js',
  'src/core/extraction/buildProfile.js',
  'src/core/normalization/normalize.js',
  'src/core/scoring/scoreEngine.js',
  'src/core/matching/matchEngine.js',
  'src/core/validation/schema.js',
  'src/p2p/protocol.js',
  'src/p2p/trystero.js',
  'src/p2p/discovery.js',
  'src/storage/idb.js',
  'src/storage/identity.js',
  'src/storage/profiles.js',
  'src/storage/cache.js',
  'src/storage/chat.js',
  'src/storage/blocklist.js',
  'src/llm/provider.js',
  'src/llm/webllm.js',
  'src/llm/prompts.js',
  'src/worker/llm.worker.js',
  'src/models/catalog.js',
].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter les requêtes réseau P2P / relais / CDN de modèle :
  // uniquement le même-origine, assets statiques de l'app.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && STATIC_ASSETS.includes(event.request.url)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
