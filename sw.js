const CACHE_NAME = "bot-cache-v1";
const urlsToCache = [
  './index.html',
  './manifest.json',
  'https://i.ibb.co/4JH0qZt/african-head.png'
  // Ajoute ici tes fichiers CSS/JS si tu veux offline complet
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => response || fetch(event.request))
  );
});