// ═══════════════════════════════════════════════════════
// المودة للبرمجيات — Service Worker
// GitHub Pages Version
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'mawada-v4.1';

const ASSETS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800;900&display=swap'
];

// Install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activate - حذف الكاش القديم
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
  // إشعار بالتحديث
  self.clients.matchAll().then(clients =>
    clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }))
  );
});

// Fetch - Network first, fallback to cache
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Google Fonts: Cache first
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached ||
        fetch(e.request).then(res => {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        })
      )
    );
    return;
  }

  // App: Network first
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
