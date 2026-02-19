const CACHE_NAME = 'ledgerlens-v29';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/main.js',
    '/modules/config.js',
    '/modules/firebase-init.js',
    '/modules/state.js',
    '/modules/batch-state.js',
    '/modules/db.js',
    '/modules/camera.js',
    '/modules/ui.js',
    '/modules/sync.js',
    '/modules/utils.js',
    'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap',
    'https://fonts.googleapis.com/icon?family=Material+Symbols+Rounded'
];

self.addEventListener('install', (event) => {
    // Skip waiting so the new SW activates IMMEDIATELY
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    // Network first for APIs, Cache first for assets
    if (event.request.url.includes('firestore') ||
        event.request.url.includes('googleapis') ||
        event.request.url.includes('cloudfunctions.net')) {
        return; // Direct network for APIs
    }

    event.respondWith(
        // Network-first: try network, fall back to cache
        fetch(event.request)
            .then((response) => {
                // Cache the fresh response for offline use
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

self.addEventListener('activate', (event) => {
    // Claim all clients so the new SW controls them immediately
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});
