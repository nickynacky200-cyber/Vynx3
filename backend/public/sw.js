// Bump this whenever static files change, so old installs pick up the new
// version instead of serving stale cached HTML/CSS/JS forever.
const CACHE_VERSION = 'vynx-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/feed.html',
  '/chats.html',
  '/chat.html',
  '/group-new.html',
  '/notifications.html',
  '/search.html',
  '/profile.html',
  '/people.html',
  '/new-post.html',
  '/capture.html',
  '/css/style.css',
  '/js/api.js',
  '/js/firebase-config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('push', (event) => {
  let data = { title: 'Vynx', body: 'You have a new notification', url: '/notifications.html' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* fall back to defaults if the payload isn't JSON */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      const existing = clientsList.find((c) => c.url.includes(targetUrl));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, Firebase, or socket.io traffic — those must
  // always hit the network so auth, messages, and posts stay live.
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('googleapis.com')
  ) {
    return;
  }

  // Uploaded media (posts, avatars, chat attachments) — network first,
  // falling back to cache only if it was already fetched before, since
  // these grow unbounded and shouldn't be pre-cached in the app shell.
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell (HTML/CSS/JS): cache first for speed, refresh in the
  // background so the next load picks up any change.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
