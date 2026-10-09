/* Bauteile Suchen service worker — cache shell for offline */
const CACHE = 'bauteile-suchen-v1-0';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/pnp.js',
  './js/calibration.js',
  './js/projectBsu.js',
  './js/bom.js',
  './vendor/jszip/jszip.min.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './favicon.svg',
  './favicon-32.png',
  './favicon-48.png',
  './apple-touch-icon.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function cachePut(req, res) {
  if (res && res.ok && new URL(req.url).origin === self.location.origin) {
    const clone = res.clone();
    caches.open(CACHE).then((c) => c.put(req, clone));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isHtml =
    req.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('.html');

  // Network-first for HTML so iPhone PWA drops stale topbar (e.g. old Öffnen button)
  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cachePut(req, res);
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html')),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          cachePut(req, res);
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});
