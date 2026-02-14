const CACHE_NAME = 'ledgerlens-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap',
    'https://fonts.googleapis.com/icon?family=Material+Symbols+Rounded'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    // Network first for APIs, Cache first for assets
    if (event.request.url.includes('firestore') || event.request.url.includes('googleapis')) {
        return; // Let Firebase SDK handle its own networking/offline
    }

    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        ))
    );
});
