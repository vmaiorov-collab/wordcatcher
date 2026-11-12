// Offline shell for the installed app. Network first, so a new version shows up at once;
// the cache is used only when there is no connection. Articles and translations are not cached.
const CACHE = 'wordcatcher-shell-v1';
const READABILITY = 'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js';
const SHELL = ['./', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', READABILITY];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const own = u.origin === location.origin && !u.pathname.includes('/api/');
  if (!own && r.url !== READABILITY) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(r);
      if (fresh.ok) cache.put(r, fresh.clone());
      return fresh;
    } catch (err) {
      // a shared link opens "./?text=…": offline it is still the same page
      const hit = await cache.match(r, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
