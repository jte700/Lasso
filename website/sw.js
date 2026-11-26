/* Stale while revalidate for the site's own files: answer from the cache at once,
   fetch a fresh copy in the background, and serve that one next time. */
const CACHE = 'lasso-site-v5';
const SHELL = ['/', '/security/', '/benchmarks/', '/mcp/', '/loop/', '/assets/css/site.css', '/assets/css/trial.css', '/assets/css/pages.css', '/assets/css/showcase.css', '/assets/css/hero-quirks.css', '/assets/js/data.js', '/assets/js/core.js', '/assets/js/sheet.js', '/assets/js/ui.js', '/assets/js/film-picker.js', '/assets/js/film.js', '/assets/js/hero-quirks.js', '/assets/js/media.js', '/assets/js/carousel.js', '/assets/js/voice.js', '/assets/js/ascii-mascot.js', '/assets/js/mascot3d.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch((err) => {
      if (cached) return cached;
      throw err;
    });
  return cached || fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Signups and anything on another origin always go to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/')) return;
  event.respondWith(staleWhileRevalidate(request));
});
