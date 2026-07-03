// ═══════════════════════════════════════════════════════
// المودة للبرمجيات — Service Worker v4.1
// يتحكم في: Offline / Cache / Auto-update
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'mawada-v4-cache';
const CACHE_VERSION = '4.1.0';
const FULL_CACHE_NAME = `${CACHE_NAME}-${CACHE_VERSION}`;

// الملفات اللي تتخزن للعمل Offline
const STATIC_ASSETS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800;900&display=swap'
];

// ─── INSTALL ────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(FULL_CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(e => console.warn('[SW] Cache failed:', e)))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ───────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating v' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith(CACHE_NAME) && k !== FULL_CACHE_NAME)
            .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
  // إشعار الصفحات بالتحديث
  self.clients.matchAll().then(clients =>
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }))
  );
});

// ─── FETCH ──────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: Network first, no cache
  if (url.pathname.startsWith('/api/') || url.hostname.includes('railway.app') || url.hostname.includes('googleapis.com/drive')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', offline: true }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Google Fonts: Cache first
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(FULL_CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }))
    );
    return;
  }

  // App HTML: Network first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(FULL_CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── BACKGROUND SYNC ────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    console.log('[SW] Background sync triggered');
  }
});

// ─── PUSH NOTIFICATIONS ─────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'المودة للبرمجيات', {
      body: data.body || 'إشعار جديد',
      icon: data.icon || '/icon-192.png',
      badge: '/icon-72.png',
      dir: 'rtl',
      lang: 'ar',
      data: data
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      if (clientList.length) return clientList[0].focus();
      return clients.openWindow('/');
    })
  );
});
