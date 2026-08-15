'use strict';

const CACHE = 'nodepilot-v2';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      /* elimina solo le cache NodePilot obsolete e le vecchie cache homelab-* (migrazione), mai cache di altre app */
      Promise.all(keys.filter((k) => (k.startsWith('nodepilot-') || k.startsWith('homelab-')) && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* strategia:
   - /api/*: bypass completo del Service Worker (mai in cache);
   - navigazioni: network-first, fallback cache solo offline;
   - asset statici same-origin: stale-while-revalidate (risposta immediata
     dalla cache + aggiornamento in background, al reload successivo si usa
     la versione nuova);
   - richieste esterne: rete diretta. */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) {
          /* risposta immediata + revalidate in background */
          fetch(e.request).then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
          }).catch(() => {});
          return cached;
        }
        return fetch(e.request).then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        });
      })
    );
    return;
  }
  e.respondWith(fetch(e.request));
});
