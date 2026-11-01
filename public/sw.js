// Minimal service worker: makes the app installable. It does not cache anything,
// so every visit always gets the latest version and live data.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
