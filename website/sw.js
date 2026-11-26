/* Network first for the site's own files: every visit gets what is deployed now,
   and the cached copy answers only when the network cannot. Answering from the
   cache first left each browser one visit behind every deploy. */
const CACHE = 'lasso-site-v6';
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

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Signups and anything on another origin always go to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/')) return;
  event.respondWith(networkFirst(request));
});
