const CACHE = 'hod-tasks-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './firebase-config.js', './manifest.json', './icon.svg'];
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  const own = url.startsWith(self.location.origin);
  if (!own && !url.startsWith(FB)) return; // let Firebase/Google APIs go to network
  // Network first for app files (fresh when online), cache fallback offline.
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
